import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProcess } from './cli-agent-process.js';
import { agentProviderError, defineAgentProvider } from './agent-provider.js';
import {
  cleanupStagingWorkspace,
  collectStagedChanges,
  createStagingWorkspace,
  refreshStagingBaseline
} from '../workspace/staging.js';

export const AGENT_EVENT_PROTOCOL_TURN_V1 = 'agent-turn-events-v1';
const PROFILE = 'cetamesh-task';
const CAPTURE_MAX = 2000;

function quoteToml(value) {
  return JSON.stringify(String(value));
}

function profileOverrides(stageRoot) {
  const key = `permissions.${PROFILE}`;
  const stage = path.resolve(stageRoot).replaceAll('\\', '/');
  return [
    `default_permissions=${quoteToml(PROFILE)}`,
    `${key}.extends=":workspace"`,
    `${key}.workspace_roots.${quoteToml(stage)}=true`,
    `${key}.filesystem.":root"="deny"`,
    `${key}.filesystem.":minimal"="read"`,
    `${key}.filesystem.":tmpdir"="deny"`,
    `${key}.filesystem.":slash_tmp"="deny"`,
    `${key}.filesystem.":workspace_roots"."."="write"`,
    `${key}.filesystem.":workspace_roots"."**/.env"="deny"`,
    `${key}.filesystem.":workspace_roots"."**/.env.*"="deny"`,
    `${key}.network.enabled=false`
  ];
}

/** Provider-owned flags are derived from codex --help / exec --help / exec resume --help. */
export function buildCodexExecArgs({ stageRoot, promptMode = 'fresh', threadId = null, model, reasoningEffort } = {}) {
  const args = [
    '--ask-for-approval', 'never',
    '-C', path.resolve(stageRoot)
  ];
  for (const override of profileOverrides(stageRoot)) args.push('--config', override);
  if (model) args.push('--model', String(model));
  if (reasoningEffort) args.push('--config', `model_reasoning_effort=${quoteToml(reasoningEffort)}`);
  args.push('exec', '--ignore-user-config', '--ignore-rules', '--strict-config');
  if (promptMode === 'resume' && threadId) args.push('resume', String(threadId));
  args.push('--json', '-');
  return args;
}

function inspectCodexCli(cli) {
  const version = cli.probe(['--version']);
  if (!version.available) return { available: false, reason: cli.executable() ? 'unsupported_cli' : 'not_installed', version: null };
  const top = cli.probe(['--help']);
  const exec = cli.probe(['exec', '--help']);
  const resume = cli.probe(['exec', 'resume', '--help']);
  const topHelp = `${top.stdout}\n${top.stderr}`;
  const execHelp = `${exec.stdout}\n${exec.stderr}`;
  const resumeHelp = `${resume.stdout}\n${resume.stderr}`;
  const supported = top.available && exec.available && /--config/.test(topHelp)
    && /--ask-for-approval/.test(topHelp) && /--cd/.test(topHelp)
    && /--json/.test(execHelp) && /--ignore-user-config/.test(execHelp)
    && /--ignore-rules/.test(execHelp) && /--strict-config/.test(execHelp);
  const resumeSupported = resume.available && /--json/.test(resumeHelp) && /\[SESSION_ID\]/i.test(resumeHelp);
  return {
    available: supported,
    reason: supported ? null : 'unsupported_cli',
    version: version.stdout.trim().slice(0, 100),
    supportsResume: resumeSupported
  };
}

function loginState(cli) {
  const result = cli.probe(['login', 'status'], { timeoutMs: 5000 });
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (!result.available) return false;
  return /logged in|authenticated/.test(text) && !/not logged in|not authenticated/.test(text);
}

function extractText(event) {
  const item = event?.item ?? event?.response_item ?? event?.data?.item;
  if (item?.type !== 'agent_message' || typeof item.text !== 'string') return '';
  return item.text;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens);
  const value = {};
  if (Number.isFinite(inputTokens) && inputTokens > 0) value.inputTokens = inputTokens;
  if (Number.isFinite(outputTokens) && outputTokens > 0) value.outputTokens = outputTokens;
  return Object.keys(value).length ? value : null;
}

function makeEvent(type, turn, data = {}) {
  return { type, data: { turn, ...data } };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCodexAgentProvider({ executable, cliProcess = null, resolveTaskWorkspace = null,
  listWorkspaceRoots = () => [], excludedRoots = [], stagingRoot = null, createStage = createStagingWorkspace,
  applyChanges = async () => { throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', 'Capability Broker import adapter is unavailable'); },
  approvalStatus = () => null, timeoutMs = 10 * 60 * 1000, log = () => {} } = {}) {
  const cli = cliProcess ?? new CliAgentProcess({ name: 'codex', executable });
  const inspection = inspectCodexCli(cli);
  const authenticated = inspection.available ? loginState(cli) : false;
  const sessions = new Map();
  const providerConfig = { model: null, reasoningEffort: null };

  function requireSession(sessionId) {
    const session = sessions.get(String(sessionId ?? ''));
    if (!session || session.closed) throw agentProviderError('SESSION_NOT_FOUND', 'Codex Task session is not available');
    return session;
  }

  function emit(session, event) {
    session.events.push(event);
    if (session.events.length > CAPTURE_MAX) session.events.splice(0, session.events.length - CAPTURE_MAX);
    const waiters = session.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  function emitTurnEnd(session, turn, kind, error = null, usage = null) {
    if (session.activeRun?.turnId !== turn) return;
    emit(session, makeEvent('turn/end', turn, {
      reason: { kind, ...(error ? { error } : {}), ...(usage ? { usage } : {}) }
    }));
    session.activeRun = null;
  }

  async function finalizeRun(session, run, result) {
    if (session.closed || session.activeRun !== run) return;
    if (result.timedOut) {
      session.lastRunStatus = 'timeout';
      session.lastError = { code: 'AGENT_TIMEOUT' };
      emitTurnEnd(session, run.turnId, 'error', 'Codex execution timed out');
      return;
    }
    if (result.cancelled) {
      session.lastRunStatus = 'cancelled';
      emitTurnEnd(session, run.turnId, 'aborted');
      return;
    }
    if (result.exitCode !== 0 || run.failed || !run.turnCompleted) {
      session.lastRunStatus = 'failed';
      session.lastError = { code: run.failed ? 'CODEX_TURN_FAILED' : 'PROVIDER_ERROR', exitCode: result.exitCode };
      emitTurnEnd(session, run.turnId, 'error', 'Codex execution failed');
      return;
    }
    let changeSet;
    try {
      changeSet = collectStagedChanges(session.stage);
    } catch (error) {
      session.lastRunStatus = 'reconciliation-required';
      session.lastError = { code: error?.code ?? 'WORKSPACE_RECONCILIATION_REQUIRED' };
      emitTurnEnd(session, run.turnId, 'error', 'Workspace changed during Codex execution; reconcile before importing');
      return;
    }
    let usage = run.usage ?? null;
    if (changeSet.changes.length) {
      let imported;
      try {
        imported = await applyChanges({
          taskId: session.taskId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          requestId: `codex-import-${crypto.randomUUID()}`,
          changes: changeSet.changes,
          summary: changeSet.summary
        });
      } catch (error) {
        session.lastRunStatus = 'import-failed';
        session.lastError = { code: error?.code ?? 'WORKSPACE_IMPORT_FAILED' };
        emitTurnEnd(session, run.turnId, 'error', 'Capability Broker could not import the Codex result');
        return;
      }
      if (imported?.status === 'pending') {
        session.waitingForApproval = imported.approvalId;
        session.lastRunStatus = 'waiting-for-approval';
        const outcome = await waitForImportApproval(session, imported.approvalId);
        session.waitingForApproval = null;
        if (outcome.status !== 'completed') {
          session.lastRunStatus = outcome.status;
          session.lastError = outcome.code ? { code: outcome.code } : null;
          emitTurnEnd(session, run.turnId, 'error', outcome.status === 'rejected'
            ? 'Owner rejected the Workspace import' : 'Workspace import did not complete');
          return;
        }
      } else if (imported?.status !== 'completed') {
        session.lastRunStatus = 'import-denied';
        emitTurnEnd(session, run.turnId, 'error', 'Capability Broker did not complete the Workspace import');
        return;
      }
      try { refreshStagingBaseline(session.stage); }
      catch (error) {
        session.lastRunStatus = 'reconciliation-required';
        session.lastError = { code: error?.code ?? 'WORKSPACE_RECONCILIATION_REQUIRED' };
        emitTurnEnd(session, run.turnId, 'error', 'Workspace reconciliation failed after import');
        return;
      }
    }
    session.lastUsage = usage;
    session.lastRunStatus = 'completed';
    if (run.text) {
      emit(session, makeEvent('assistant/message', run.turnId, {
        message: { content: [{ type: 'text', text: run.text }], ...(usage ? { usage } : {}) }
      }));
    }
    emitTurnEnd(session, run.turnId, 'completed', null, usage);
  }

  async function waitForImportApproval(session, approvalId) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!session.closed && Date.now() < deadline) {
      const status = approvalStatus(approvalId);
      if (status?.status && status.status !== 'pending') return status;
      await wait(250);
    }
    return { status: session.closed ? 'cancelled' : 'expired', code: 'APPROVAL_EXPIRED' };
  }

  function parseOutput(session, run, text) {
    run.pendingText += text;
    const lines = run.pendingText.split(/\r?\n/);
    run.pendingText = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { /* Ignore non-JSON CLI diagnostics between protocol records. */ continue; }
      if (event.type === 'thread.started') {
        if (typeof event.thread_id === 'string') session.threadId = event.thread_id;
      } else if (event.type === 'item.completed') {
        const value = extractText(event);
        if (value) {
          run.text = value.slice(0, 200_000);
          emit(session, makeEvent('assistant/chunk', run.turnId, { text: value.slice(0, 32_000) }));
        }
      } else if (event.type === 'turn.completed') {
        run.turnCompleted = true;
        run.usage = normalizeUsage(event.usage ?? event.data?.usage);
      } else if (event.type === 'turn.failed') {
        run.failed = true;
      }
    }
  }

  const contract = defineAgentProvider({
    id: 'codex',
    label: 'Codex',
    eventProtocol: AGENT_EVENT_PROTOCOL_TURN_V1,
    capabilityExtras: {
      available: inspection.available,
      version: inspection.version,
      reason: inspection.reason ?? null,
      health: authenticated ? 'ready' : inspection.available ? 'needs_auth' : 'unavailable',
      workspaceBoundary: 'staged-capability-broker',
      supportsFreshSession: true,
      supportsResume: inspection.supportsResume === true,
      contextUsage: { available: true, source: 'Codex exec JSONL usage events when emitted' },
      executionMode: 'task-staging'
    },
    methods: {
      async createSession({ taskId, workspaceId } = {}) {
        if (!inspection.available) throw agentProviderError('PROVIDER_UNAVAILABLE', 'Codex CLI is not installed or lacks the inspected exec interface');
        if (!authenticated) throw agentProviderError('PROVIDER_UNAVAILABLE', 'Codex needs authentication in its own secure configuration');
        if (!taskId || !workspaceId) throw agentProviderError('TASK_REQUIRED', 'Codex requires a Task and its bound Workspace');
        if (typeof resolveTaskWorkspace !== 'function') throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', 'Task Workspace resolver is unavailable');
        const binding = await resolveTaskWorkspace({ taskId: String(taskId), workspaceId: String(workspaceId) });
        if (!binding?.task || binding.task.id !== String(taskId) || binding.task.workspaceId !== String(workspaceId)
          || binding.workspace?.id !== String(workspaceId) || typeof binding.workspace.root !== 'string') {
          throw agentProviderError('TASK_WORKSPACE_MISMATCH', 'Codex Task and Workspace binding is invalid');
        }
        const registeredRoots = await listWorkspaceRoots();
        const stage = await createStage({
          taskId: binding.task.id,
          workspaceId: binding.workspace.id,
          sourceRoot: binding.workspace.root,
          stagingRoot: stagingRoot ?? path.join(os.tmpdir(), 'CetaMesh', 'agent-staging'),
          additionalWorkspaceRoots: (Array.isArray(registeredRoots) ? registeredRoots : []).map((row) => typeof row === 'string' ? row : row.root),
          excludedRoots
        });
        const id = crypto.randomUUID();
        sessions.set(id, {
          id,
          taskId: binding.task.id,
          workspaceId: binding.workspace.id,
          task: binding.task,
          stage,
          threadId: null,
          activeRun: null,
          waitingForApproval: null,
          lastRunStatus: 'idle',
          lastError: null,
          lastUsage: null,
          events: [],
          waiters: [],
          closed: false
        });
        return { sessionId: id, provider: 'codex', taskId: binding.task.id, workspaceId: binding.workspace.id, cwd: stage.root };
      },

      async send({ sessionId, content } = {}) {
        const session = requireSession(sessionId);
        if (session.activeRun) throw agentProviderError('TURN_BUSY', 'Codex Task session already has an active turn');
        const turnId = crypto.randomUUID();
        const prompt = [
          `[CetaMesh Task ${session.taskId}]`,
          `Workspace: ${session.workspaceId}`,
          `Task goal: ${session.task.goal}`,
          session.task.checkpoint?.summary ? `Checkpoint: ${session.task.checkpoint.summary}` : '',
          session.task.checkpoint?.nextAction ? `Next action: ${session.task.checkpoint.nextAction}` : '',
          'Work only in this isolated staging directory. CetaMesh will reconcile and import changes through its Capability Broker.',
          String(content ?? '')
        ].filter(Boolean).join('\n\n');
        const run = { turnId, pendingText: '', text: '', usage: null, turnCompleted: false, failed: false, handle: null };
        session.activeRun = run;
        session.lastRunStatus = 'running';
        emit(session, makeEvent('turn/start', turnId));
        const args = buildCodexExecArgs({
          stageRoot: session.stage.root,
          promptMode: session.threadId && inspection.supportsResume ? 'resume' : 'fresh',
          threadId: session.threadId,
          model: providerConfig.model,
          reasoningEffort: providerConfig.reasoningEffort
        });
        try {
          run.handle = cli.startSession({
            sessionId: `${session.id}:${turnId}`,
            cwd: session.stage.root,
            args,
            input: prompt,
            timeoutMs,
            env: { CODEX_HOME: process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.codex') },
            onStdout: (chunk) => parseOutput(session, run, chunk)
          });
        } catch (error) {
          session.activeRun = null;
          throw agentProviderError(error?.code === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'PROCESS_START_FAILED', 'Unable to start the Codex CLI process', { cause: error });
        }
        run.handle.done.then((result) => finalizeRun(session, run, result)).catch((error) => {
          if (session.activeRun === run) {
            session.lastRunStatus = 'failed';
            session.lastError = { code: error?.code ?? 'PROVIDER_ERROR' };
            emitTurnEnd(session, turnId, 'error', 'Codex process failed');
          }
        });
        return { accepted: true, provider: 'codex', sessionId, taskId: session.taskId, workspaceId: session.workspaceId, turnId };
      },

      async cancel({ sessionId } = {}) {
        const session = requireSession(sessionId);
        if (!session.activeRun?.handle) return { cancelled: false, reason: 'not-running', sessionId };
        return session.activeRun.handle.cancel();
      },

      async status({ sessionId } = {}) {
        const session = requireSession(sessionId);
        return {
          provider: 'codex', sessionId, taskId: session.taskId, workspaceId: session.workspaceId,
          running: Boolean(session.activeRun), waitingForApproval: Boolean(session.waitingForApproval),
          approvalId: session.waitingForApproval, lastRunStatus: session.lastRunStatus,
          errorCode: session.lastError?.code ?? null
        };
      },

      async contextUsage({ sessionId } = {}) {
        const session = requireSession(sessionId);
        return session.lastUsage
          ? { sessionId, provider: 'codex', available: true, usage: session.lastUsage }
          : { sessionId, provider: 'codex', available: false };
      },

      async resume({ sessionId } = {}) {
        const session = requireSession(sessionId);
        if (!inspection.supportsResume || !session.threadId) return { resumed: false, provider: 'codex', freshSessionRequired: true };
        return { resumed: true, provider: 'codex', sessionId, threadId: session.threadId };
      },

      async closeSession({ sessionId } = {}) {
        const session = requireSession(sessionId);
        if (session.activeRun?.handle) {
          session.activeRun.handle.cancel();
          await session.activeRun.handle.done.catch(() => {});
        }
        cleanupStagingWorkspace(session.stage);
        session.closed = true;
        for (const wake of session.waiters.splice(0)) wake();
        sessions.delete(session.id);
        return { closed: true, provider: 'codex', sessionId };
      },

      async selectModel({ sessionId, model, reasoningEffort } = {}) {
        requireSession(sessionId);
        if (model !== undefined) providerConfig.model = String(model || '') || null;
        if (reasoningEffort !== undefined) providerConfig.reasoningEffort = String(reasoningEffort || '') || null;
        return { sessionId, provider: 'codex', selected: { ...providerConfig } };
      },

      async health() {
        return {
          available: inspection.available,
          provider: 'codex',
          version: inspection.version,
          authenticated,
          status: authenticated ? 'ready' : inspection.available ? 'needs_auth' : 'unavailable',
          reason: inspection.reason ?? (authenticated ? null : 'needs_auth')
        };
      },

      async *follow({ sessionId, signal } = {}) {
        const session = requireSession(sessionId);
        while (!session.closed && !signal?.aborted) {
          if (session.events.length) {
            yield session.events.shift();
            continue;
          }
          await new Promise((resolve) => {
            const done = () => {
              signal?.removeEventListener('abort', done);
              session.waiters = session.waiters.filter((wake) => wake !== done);
              resolve();
            };
            session.waiters.push(done);
            signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted) done();
          });
        }
      }
    }
  });
  return Object.freeze({
    ...contract,
    configure(settings = {}) {
      const allowed = new Set(['model', 'reasoningEffort']);
      for (const key of Object.keys(settings ?? {})) {
        if (!allowed.has(key)) throw agentProviderError('INVALID_PARAMS', `Unsupported Codex setting: ${key}`);
      }
      if (settings.model !== undefined) providerConfig.model = String(settings.model || '') || null;
      if (settings.reasoningEffort !== undefined) providerConfig.reasoningEffort = String(settings.reasoningEffort || '') || null;
      return { provider: 'codex', configured: { ...providerConfig } };
    },
    async shutdown() {
      await cli.shutdown();
      for (const session of sessions.values()) {
        try { cleanupStagingWorkspace(session.stage); }
        catch (error) { log(`Codex staging cleanup failed: ${error?.code ?? 'STAGING_CLEANUP_FAILED'}`); }
        session.closed = true;
        for (const wake of session.waiters.splice(0)) wake();
      }
      sessions.clear();
      log('Codex Agent Provider 已关闭');
    },
    _inspection: { ...inspection, authenticated },
    _sessions: sessions
  });
}
