import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { agentProviderError, defineAgentProvider } from './agent-provider.js';
import { cleanupStagingWorkspace, collectStagedChanges, createStagingWorkspace, refreshStagingBaseline } from '../workspace/staging.js';

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function withTurnFailure(item, event, message, code = 'WORKSPACE_IMPORT_FAILED') {
  const failed = {
    ...event,
    data: { ...event.data, reason: { kind: 'error', error: { code, message } } }
  };
  return item?.type === 'event' ? { ...item, event: failed } : failed;
}

/** Preserve the DSH protocol while staging all Task writes for Capability Broker import. */
export function createStagedDshAgentProvider({ provider, resolveTaskWorkspace, listWorkspaceRoots = () => [],
  excludedRoots = [], stagingRoot = null, createStage = createStagingWorkspace,
  applyChanges, approvalStatus = () => null, cancelApproval = async () => ({ cancelled: false }), log = () => {} } = {}) {
  if (!provider || typeof provider.createSession !== 'function' || typeof provider.follow !== 'function') {
    throw agentProviderError('INVALID_PARAMS', 'A DSH Agent Provider is required for Task staging');
  }
  if (typeof resolveTaskWorkspace !== 'function' || typeof applyChanges !== 'function') {
    throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', 'DSH Task staging requires Task resolution and Capability Broker import');
  }
  const sessions = new Map();
  const baseCapabilities = provider.capabilities();

  function requireSession(sessionId) {
    const session = sessions.get(String(sessionId ?? ''));
    if (!session || session.closed) throw agentProviderError('SESSION_NOT_FOUND', 'DSH Task staging session is not available');
    return session;
  }

  async function waitForApproval(session, approvalId, signal) {
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    while (!session.closed && !session.cancelRequested && !signal?.aborted && Date.now() < deadline) {
      const state = approvalStatus(approvalId);
      if (state?.status && state.status !== 'pending') return state;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (session.cancelRequested || signal?.aborted) return { status: 'cancelled', code: 'IMPORT_CANCELLED' };
    return { status: 'expired', code: 'APPROVAL_EXPIRED' };
  }

  async function reconcileTurn(session, turn, signal) {
    let changeSet;
    try { changeSet = collectStagedChanges(session.stage); }
    catch (error) {
      return { ok: false, error: 'Workspace changed during DSH execution; reconcile before importing', code: error?.code ?? 'WORKSPACE_RECONCILIATION_REQUIRED' };
    }
    if (!changeSet.changes.length) return { ok: true };
    let result;
    try {
      result = await applyChanges({
        taskId: session.taskId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        provider: provider.id,
        requestId: `dsh-import-${crypto.randomUUID()}`,
        changes: changeSet.changes,
        summary: changeSet.summary
      });
    } catch (error) {
      return { ok: false, error: 'Capability Broker could not import the DSH result', code: error?.code ?? 'WORKSPACE_IMPORT_FAILED' };
    }
    if (result?.status === 'pending') {
      session.waitingForApproval = result.approvalId;
      const decision = await waitForApproval(session, result.approvalId, signal);
      session.waitingForApproval = null;
      if (decision.status !== 'completed') {
        if (decision.status === 'cancelled' || session.cancelRequested || session.closed || signal?.aborted) {
          await cancelApproval(result.approvalId);
        }
        return { ok: false, error: decision.status === 'rejected' ? 'Owner rejected the Workspace import' : 'Workspace import did not complete',
          code: decision.code ?? 'WORKSPACE_IMPORT_FAILED' };
      }
    } else if (result?.status !== 'completed') {
      return { ok: false, error: 'Capability Broker did not complete the DSH Workspace import', code: 'WORKSPACE_IMPORT_FAILED' };
    }
    try { refreshStagingBaseline(session.stage); }
    catch (error) {
      return { ok: false, error: 'DSH Workspace reconciliation failed after import', code: error?.code ?? 'WORKSPACE_RECONCILIATION_REQUIRED' };
    }
    session.lastImportedTurn = turn ?? null;
    return { ok: true };
  }

  function reconcileTurnOnce(session, turn, signal) {
    const key = String(turn?.turnId ?? turn?.id ?? turn ?? '').slice(0, 200);
    if (!key) return reconcileTurn(session, turn, signal);
    if (session.reconciledTurns.has(key)) return Promise.resolve({ ok: true, duplicate: true });
    const existing = session.reconciliationInFlight.get(key);
    if (existing) return existing;
    const pending = reconcileTurn(session, turn, signal).then(outcome => {
      if (outcome.ok) {
        session.reconciledTurns.add(key);
        while (session.reconciledTurns.size > 256) session.reconciledTurns.delete(session.reconciledTurns.values().next().value);
      }
      return outcome;
    }).finally(() => session.reconciliationInFlight.delete(key));
    session.reconciliationInFlight.set(key, pending);
    return pending;
  }

  return Object.freeze({
    ...defineAgentProvider({
      id: provider.id,
      label: provider.label,
      eventProtocol: provider.eventProtocol,
      capabilityExtras: {
        available: typeof baseCapabilities.available === 'boolean' ? baseCapabilities.available : null,
        version: baseCapabilities.version ?? null,
        reason: baseCapabilities.reason ?? null,
        contextUsage: baseCapabilities.contextUsage ?? null,
        rolloverStrategy: baseCapabilities.rolloverStrategy ?? null,
        displayName: 'DSH',
        workspaceBoundary: 'capability-broker',
        requiresSessionCleanup: true,
        supportsFreshSession: true,
        supportsResume: baseCapabilities.supportsResume === true
      },
      methods: {
        async createSession({ taskId, workspaceId, model, reasoningEffort, modelProvider } = {}) {
          if (!taskId || !workspaceId) throw agentProviderError('TASK_REQUIRED', 'DSH Task sessions require a Task and Workspace');
          const binding = await resolveTaskWorkspace({ taskId: String(taskId), workspaceId: String(workspaceId) });
          if (!binding?.task || binding.task.id !== String(taskId) || binding.task.workspaceId !== String(workspaceId)
            || binding.workspace?.id !== String(workspaceId) || typeof binding.workspace.root !== 'string') {
            throw agentProviderError('TASK_WORKSPACE_MISMATCH', 'DSH Task and Workspace binding is invalid');
          }
          const roots = await listWorkspaceRoots();
          const stage = await createStage({
            taskId: binding.task.id,
            workspaceId: binding.workspace.id,
            sourceRoot: binding.workspace.root,
            stagingRoot: stagingRoot ?? path.join(os.tmpdir(), 'CetaMesh', 'agent-staging'),
            additionalWorkspaceRoots: (Array.isArray(roots) ? roots : []).map(row => typeof row === 'string' ? row : row.root),
            excludedRoots
          });
          try {
            const created = await provider.createSession({ cwd: stage.root, model, reasoningEffort, modelProvider, purpose: 'coding' });
            if (!created?.sessionId) throw agentProviderError('PROVIDER_ERROR', 'DSH did not return a sessionId');
            sessions.set(created.sessionId, {
              id: created.sessionId,
              taskId: binding.task.id,
              workspaceId: binding.workspace.id,
              stage,
              waitingForApproval: null,
              cancelRequested: false,
              closed: false,
              lastImportedTurn: null,
              reconciledTurns: new Set(),
              reconciliationInFlight: new Map()
            });
            return { ...created, taskId: binding.task.id, workspaceId: binding.workspace.id, cwd: stage.root };
          } catch (error) {
            cleanupStagingWorkspace(stage);
            throw error;
          }
        },
        async send({ sessionId, content, mode } = {}) {
          const session = requireSession(sessionId);
          session.cancelRequested = false;
          return provider.send({ sessionId, content, mode });
        },
        async cancel({ sessionId } = {}) {
          const session = requireSession(sessionId);
          session.cancelRequested = true;
          const result = await provider.cancel({ sessionId });
          const approvalId = session.waitingForApproval;
          if (approvalId) {
            await cancelApproval(approvalId);
            return { ...(result ?? {}), approvalId, state: 'cancelled' };
          }
          return result;
        },
        async status({ sessionId } = {}) {
          const session = requireSession(sessionId);
          return { ...(await provider.status({ sessionId })), taskId: session.taskId, workspaceId: session.workspaceId,
            waitingForApproval: Boolean(session.waitingForApproval), approvalId: session.waitingForApproval };
        },
        async contextUsage({ sessionId } = {}) {
          requireSession(sessionId);
          return provider.contextUsage({ sessionId });
        },
        async resume({ sessionId } = {}) {
          requireSession(sessionId);
          return provider.resume({ sessionId });
        },
        async closeSession({ sessionId } = {}) {
          const session = requireSession(sessionId);
          session.closed = true;
          session.cancelRequested = true;
          let approvalError = null;
          if (session.waitingForApproval) {
            try { await cancelApproval(session.waitingForApproval); }
            catch (error) { approvalError = error; }
          }
          try { await provider.closeSession({ sessionId }); }
          finally {
            cleanupStagingWorkspace(session.stage);
            sessions.delete(session.id);
          }
          if (approvalError) throw agentProviderError('WORKSPACE_IMPORT_CANCEL_FAILED', 'Pending Workspace import approval could not be revoked');
          return { closed: true, provider: provider.id, sessionId };
        },
        async selectModel(params = {}) {
          requireSession(params.sessionId);
          return provider.selectModel(params);
        },
        async health(options = {}) {
          const health = await provider.health(options);
          return { ...health, provider: provider.id, taskEligible: health.ready === true && health.sessionCapable === true,
            workspaceBoundary: 'capability-broker' };
        },
        async *follow({ sessionId, signal, sinceSequence } = {}) {
          const session = requireSession(sessionId);
          for await (const item of provider.follow({ sessionId, signal, sinceSequence })) {
            const event = item?.type === 'event' ? item.event : item;
            if (event?.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
              const outcome = await reconcileTurnOnce(session, event.data?.turn, signal);
              if (!outcome.ok) {
                yield withTurnFailure(item, event, outcome.error, outcome.code);
                continue;
              }
            }
            yield item;
          }
        }
      }
    }),
    async shutdown() {
      for (const session of sessions.values()) {
        session.closed = true;
        session.cancelRequested = true;
        if (session.waitingForApproval) {
          try { await cancelApproval(session.waitingForApproval); }
          catch (error) { log(`DSH Workspace import approval cancellation failed: ${error?.code ?? 'APPROVAL_CANCEL_FAILED'}`); }
        }
        try { await provider.closeSession({ sessionId: session.id }); }
        catch (error) { log(`DSH session close failed: ${error?.code ?? 'PROVIDER_ERROR'}`); }
        try { cleanupStagingWorkspace(session.stage); }
        catch (error) { log(`DSH staging cleanup failed: ${error?.code ?? 'STAGING_CLEANUP_FAILED'}`); }
      }
      sessions.clear();
      await provider.shutdown?.();
    },
    _sessions: sessions
  });
}
