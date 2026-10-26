import crypto from 'node:crypto';
import { createApprovalOperations } from './operations.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside, canonicalizeRoot, assertSafeRootForm } from '../workspace/boundary.js';
import { safeFetch } from '../safe-fetch.js';
import { createCapabilityBroker } from './broker.js';
import { createCapabilityPolicy } from './policy.js';
import { createCapabilityApproval, requestFingerprint } from './approval.js';
import { OWNER_ACTOR, capabilityError } from './types.js';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { evidenceBinding, EVIDENCE_SOURCE_CAPABILITIES } from '../context/tool-evidence.js';
import { createNativeApprovalAdapter } from '../agent/native-approval-bridge.js';
import { canDispatchConfiguredNativeAgent } from '../agent/execution-security.js';

// Only this module can mark a failure as occurring before Agent side effects.
// Provider supplied error fields must never authorize an automatic replay.
const safeAgentPreflights = new WeakSet();
export const isSafeAgentDispatchPreflight = error => error && typeof error === 'object'
  && safeAgentPreflights.has(error);

export const WORKSPACE_CAPABILITIES = Object.freeze({
  'workspace.read': 'filesystem.read', 'workspace.write': 'filesystem.write',
  'workspace.file.search': 'filesystem.search', 'workspace.git.status': 'git.status',
  'workspace.git.diff': 'git.diff', 'workspace.git.commit': 'git.commit',
  'workspace.test.run': 'test.run', 'workspace.create': 'workspace.create',
  'workspace.apply': 'workspace.apply'
});

const MAX_AGENT_IMPORT_FILES = 500;
const MAX_AGENT_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_AGENT_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const SENSITIVE_IMPORT_SEGMENT = /^(?:\.git|\.codex|\.ssh|\.aws|\.azure|\.gnupg|\.cetamesh|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|private_keys|id_(?:rsa|ed25519|ecdsa)|known_hosts|authorized_keys)$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const stringField = description => ({ type: 'string', description });
const objectInput = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false
});
const WORKSPACE_TOOL_DESCRIPTORS = Object.freeze({
  'filesystem.read': ['Read a page of a file inside the authorized Workspace.', objectInput({ path: stringField('Workspace-relative file path.'),
    offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: 50000 },
    maxChars: { type: 'integer', minimum: 1, maximum: 50000 } }, ['path'])],
  'filesystem.write': ['Write text to a file inside the authorized Workspace. Owner approval is required.', objectInput({ path: stringField('Workspace-relative file path.'), content: stringField('Text to write.'), append: { type: 'boolean' }, expectedHash: stringField('SHA-256 of the existing file; null for a new file.') }, ['path', 'content'])],
  'filesystem.search': ['Search file names or contents inside the authorized Workspace.', objectInput({ query: stringField('Search text or file-name query.'), path: stringField('Optional Workspace-relative directory.'),
    offset: { type: 'integer', minimum: 0 }, maxResults: { type: 'integer', minimum: 1, maximum: 100 } }, ['query'])],
  'git.status': ['Read the current Git status for the authorized Workspace.', objectInput()],
  'git.diff': ['Read a bounded Git diff summary inside the authorized Workspace.', objectInput({ path: stringField('Optional Workspace-relative file path.'), statOnly: { type: 'boolean' } })],
  'git.commit': ['Create a Git commit in the authorized Workspace.', objectInput({ message: stringField('Commit message.') }, ['message'])],
  'test.run': ['Run an allowlisted test command in the authorized Workspace. Owner approval is required.', objectInput({ tool: stringField('Allowlisted test tool.'), args: { type: 'array', items: { type: 'string' }, maxItems: 40 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 } }, ['tool', 'args'])],
  'workspace.create': ['Register an explicitly selected local Workspace root. Owner approval is required.', objectInput({ root: stringField('Local directory selected by the Owner.'), name: stringField('Optional Workspace display name.') }, ['root'])],
  'workspace.apply': ['Import a staged Task Workspace change set. Owner approval is required.', objectInput({
    changes: { type: 'array', minItems: 1, maxItems: 500, items: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['write', 'delete'] },
        path: stringField('Workspace-relative file path.'),
        content: stringField('Replacement text for write actions.'),
        expectedHash: stringField('Hash of the source file when it was staged.'),
        hash: stringField('Hash of the staged file content.')
      }, required: ['action', 'path'], additionalProperties: false
    } },
    summary: { type: 'object' }
  }, ['changes'])]
});

/** Trusted in-process API. Public transports must use execute/executeWorkspace,
 * which bind the Owner identity; Agent/Extension grants never come from IPC. */
export function createCapabilityService({ stateDir, workspaceService, memoryService,
  taskRuntime, agentBroker, bindAgentSession, resumeAgentApproval = null, searchImpl = null, audit = () => {}, now,
  isolatedRunner = null, onTaskObservation = null, onOperation = () => {}, evidenceStore = null } = {}) {
  const file = stateDir ? path.join(stateDir, 'capability', 'task-grants.json') : null;
  let grants = file ? readJsonFile(file, { missing: {} }) : {};
  const provisioning = new Map();
  const workspaceProvisioning = new Map();
  const workspaceReadProvisioning = new Map();
  let taskHandoffGuard = () => false;
  const taskFollowConsumers = new Map();
  // Native DSH Follow can end after every completed turn. Retain a bounded
  // per-Task/Session terminal cursor so the next instruction never consumes the
  // previous turn/end as if it belonged to its own new turn.
  const taskFollowPositions = new Map();
  const TASK_FOLLOW_MAX_SESSIONS = 64;
  function rememberTaskFollowPosition(key, taskId, sequence, terminalTurns) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return;
    const previous = taskFollowPositions.get(key);
    const highest = previous?.taskId === taskId ? Math.max(previous.sequence, sequence) : sequence;
    taskFollowPositions.delete(key);
    taskFollowPositions.set(key, { taskId, sequence: highest, terminalTurns: terminalTurns ? [...terminalTurns] : previous?.terminalTurns ?? [] });
    // These are in-process resumptions only; do not silently claim durability.
    while (taskFollowPositions.size > TASK_FOLLOW_MAX_SESSIONS * 4) {
      taskFollowPositions.delete(taskFollowPositions.keys().next().value);
    }
  }
  const workspaceImportStates = new Map();
  let approvalDecisionListener = null;
  const journalFile = stateDir ? path.join(stateDir, 'capability', 'requests.json') : null;
  const journal = journalFile ? readJsonFile(journalFile, { missing: {} }) : {};
  const requests = new Map();
  function taskFollowKey(provider, sessionId) { return `${String(provider)}\u0000${String(sessionId)}`; }
  function waitForTaskFollowRetry(ms, signal) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  function recordWorkingState(taskId) {
    if (typeof onTaskObservation !== 'function') return;
    try { onTaskObservation({ taskId }); }
    catch (error) { audit({ capability: 'memory.working', status: 'projection-failed', code: error?.code ?? 'MEMORY_WRITE_FAILED' }); }
  }
  function blockLostTaskFollow(provider, sessionId, taskId, errorCode) {
    const current = taskFor(taskId);
    if (!current || current.status !== 'running'
      || current.currentAgent?.provider !== provider || current.currentAgent?.sessionId !== sessionId) return;
    try {
      taskRuntime.block({ id: taskId, expectedRev: current.rev,
        reason: 'needs-reconciliation: Agent Follow ended without verified completion (' +
          String(errorCode ?? 'AGENT_FOLLOW_DISCONNECTED').slice(0, 90) + '); verify external execution and Workspace before resuming' });
    } catch (error) {
      audit({ capability: 'agent.run', status: 'follow-recovery-block-failed',
        code: error?.code ?? 'TASK_CONFLICT' });
    }
  }
  function ensureTaskFollow(provider, sessionId, taskId, options = {}) {
    const capabilities = agentBroker?.capabilities?.(provider);
    if (!['capability-broker', 'staged-capability-broker', 'native-staged'].includes(capabilities?.workspaceBoundary)) return null;
    const key = taskFollowKey(provider, sessionId);
    const current = taskFollowConsumers.get(key);
    if (current && !current.controller.signal.aborted && current.finished !== true) {
      if (options.expectTurn === true) current.expectedTurns += 1;
      return current;
    }
    if (current) taskFollowConsumers.delete(key);
    if (taskFollowConsumers.size >= TASK_FOLLOW_MAX_SESSIONS) {
      throw capabilityError('AGENT_FOLLOW_CAPACITY', 'Task Agent event consumers are at the configured capacity');
    }
    const controller = new AbortController();
    const savedPosition = taskFollowPositions.get(key);
    const previousSequence = savedPosition?.taskId === taskId ? savedPosition.sequence : 0;
    const requestedSequence = Number.isSafeInteger(options.sinceSequence) && options.sinceSequence >= 0 ? options.sinceSequence : 0;
    const consumer = { provider, sessionId, taskId, controller, promise: null, finished: false,
      expectedTurns: options.expectTurn === true ? 1 : 0,
      sequence: Math.max(requestedSequence, previousSequence) };
    const answers = new Map();
    const terminalTurns = new Set(savedPosition?.taskId === taskId ? savedPosition.terminalTurns ?? [] : []);
    taskFollowConsumers.set(key, consumer);
    consumer.promise = (async () => {
      let failures = 0;
      while (!controller.signal.aborted && failures < 5) {
        let sawTurnEnd = false;
        try {
          for await (const item of agentBroker.follow({ provider, sessionId, signal: controller.signal, sinceSequence: consumer.sequence })) {
            if (controller.signal.aborted) break;
            const event = item?.type === 'event' ? { ...item.event, seq: item.event?.seq ?? item.seq } : item;
            if (Number.isSafeInteger(event?.seq)) {
              if (event.seq <= consumer.sequence) continue;
              consumer.sequence = event.seq;
            }
            const turnId = String(event?.data?.requestId ?? event?.data?.turn ?? '');
            // Core phase metadata is authoritative; internal turns never project user work.
            if (event?.data?.phase && event.data.phase !== 'user') continue;
            if ((options.bootstrapRequestId && event?.data?.requestId === options.bootstrapRequestId)
              || (options.bootstrapTurnId != null && event?.data?.turn === options.bootstrapTurnId)) continue;
            const observation = taskFor(taskId)?.executionObservation;
            // The dispatch identity is Core-owned. A prior native turn, internal
            // bootstrap or stale session cannot replace current user work.
            const staleRun = observation && (observation.provider !== provider || observation.sessionId !== sessionId
              || observation.runId !== event?.data?.runId || event?.data?.phase !== 'user');
            if (event?.type === 'tool/activity' || event?.type === 'tool/result') {
              taskRuntime.observeExecution?.({ id: taskId, provider, sessionId, runId: event.data?.runId,
                phase: event.data?.phase, state: event.data?.activity?.status === 'waiting-approval' ? 'waiting-approval' : 'running', toolActivity: true });
            }
            if (event?.type === 'tool/result') {
              const current = taskFor(taskId);
              if (current?.status === 'running' && current.currentAgent?.provider === provider
                && current.currentAgent?.sessionId === sessionId) {
                taskRuntime.recordToolOutcome({ id: taskId, provider, sessionId,
                  runId: event.data?.runId, phase: event.data?.phase,
                  eventId: String(event.data?.eventId ?? `${turnId}:${event.seq}`),
                  capability: event.data?.capability, status: event.data?.status,
                  filePath: event.data?.filePath, tool: event.data?.tool,
                  exitCode: event.data?.exitCode, hasChanges: event.data?.hasChanges,
                  retryCount: event.data?.retryCount, source: event.data?.source, resultSha256: event.data?.resultSha256 });
                recordWorkingState(taskId);
              }
            }
            if (event?.type === 'tool/activity' && !staleRun) {
              const activity = event.data?.activity;
              const current = taskFor(taskId);
              if (current?.status === 'running' && current.currentAgent?.provider === provider
                && current.currentAgent?.sessionId === sessionId && typeof activity?.capability === 'string') {
                const capability = activity.capability.slice(0, 100);
                const phase = activity.status === 'waiting-approval' ? 'Waiting for Owner approval' : `Agent tool: ${capability}`;
                taskRuntime.update({ id: taskId, expectedRev: current.rev, currentPhase: phase,
                  note: `${capability}: ${String(activity.status ?? 'running').slice(0, 40)}` });
                if (activity.status === 'completed') {
                  const latest = taskFor(taskId);
                  taskRuntime.addWork({ id: taskId, expectedRev: latest.rev, kind: 'completed',
                    text: `Agent tool ${capability} completed (${String(activity.id ?? turnId).slice(0, 160)})` });
                }
              }
            }
            if (event?.type === 'assistant/message' && turnId) {
              const content = event.data?.message?.content;
              const answer = Array.isArray(content) ? content.filter(part => part?.type === 'text')
                .map(part => String(part.text ?? '')).join('') : '';
              if (answer && !terminalTurns.has(turnId)) { answers.set(turnId, answer.slice(0, 8000)); if (answers.size > 256) answers.delete(answers.keys().next().value); }
            }
            if (event?.type === 'turn/end') {
              sawTurnEnd = true;
              if (['waiting', 'waiting-approval'].includes(event.data?.reason?.kind)) {
                taskRuntime.observeExecution?.({ id: taskId, provider, sessionId, runId: event.data?.runId, phase: event.data?.phase, state: 'waiting-approval' });
                consumer.expectedTurns = Math.max(1, consumer.expectedTurns);
                rememberTaskFollowPosition(key, taskId, consumer.sequence, terminalTurns);
                continue;
              }
              if (turnId && terminalTurns.has(turnId)) continue;
              if (turnId) { terminalTurns.add(turnId); if (terminalTurns.size > 256) terminalTurns.delete(terminalTurns.values().next().value); }
              const attemptTask = taskFor(taskId);
              const childAttempt = attemptTask?.parentTaskId && (attemptTask.attempts ?? []).find(row =>
                row.provider === provider && row.sessionId === sessionId
                && ['started', 'accepted'].includes(row.state)
                && ((event.data?.runId && row.requestId === event.data.runId)
                  || (turnId && row.nativeRequestId === turnId)));
              if (childAttempt) {
                const reasonKind = event.data?.reason?.kind;
                taskRuntime.settleAttempt({ id: taskId, expectedRev: attemptTask.rev,
                  requestId: childAttempt.requestId, nativeRequestId: turnId,
                  state: reasonKind === 'completed' ? 'completed'
                    : reasonKind === 'aborted' ? 'cancelled'
                      : ['failed', 'error'].includes(reasonKind) ? 'failed' : 'unknown',
                  reason: String(event.data?.reason?.error?.code ?? reasonKind ?? 'unknown').slice(0, 200) });
              }
              const answer = answers.get(turnId);
              answers.delete(turnId);
              const current = taskFor(taskId);
              if (!current || current.currentAgent?.provider !== provider || current.currentAgent?.sessionId !== sessionId
                || current.status !== 'running') {
                rememberTaskFollowPosition(key, taskId, consumer.sequence, terminalTurns);
                continue;
              }
              if (event.data?.reason?.kind === 'completed' && answer) {
                // Retain the original answer with explicit evidence class. Never overwrite
                // an established checkpoint or treat the answer as verified completed work.
                taskRuntime.recordAgentReport({ id: taskId, expectedRev: current.rev,
                  provider, sessionId, runId: event.data?.runId, phase: event.data?.phase,
                  eventId: `agent-report:${turnId || event.seq}`,
                  text: answer.slice(0, 8000) });
                const latest = taskFor(taskId);
                if (!staleRun && !latest.checkpoint?.summary) taskRuntime.setCheckpoint({ id: taskId, expectedRev: latest.rev,
                  summary: '[Unverified Agent report]\n' + answer.slice(0, 7900),
                  nextAction: latest.checkpoint?.nextAction ?? '' });
                recordWorkingState(taskId);
              } else if (['failed', 'error'].includes(event.data?.reason?.kind) && (!staleRun
                || /OUTCOME_UNKNOWN|CANCEL_UNCONFIRMED|CLOSE_UNKNOWN|TERMINATION_UNKNOWN/.test(event.data?.reason?.error?.code ?? ''))) {
                const failureCode = String(event.data?.reason?.error?.code ?? 'Agent turn failed').slice(0, 1000);
                taskRuntime.block({ id: taskId, expectedRev: current.rev,
                  reason: /OUTCOME_UNKNOWN|CANCEL_UNCONFIRMED|CLOSE_UNKNOWN|TERMINATION_UNKNOWN/.test(failureCode) ? 'needs-reconciliation: ' + failureCode : failureCode });
              }
              taskRuntime.observeExecution?.({ id: taskId, provider, sessionId, runId: event.data?.runId, phase: event.data?.phase,
                state: event.data?.reason?.kind === 'completed' ? 'awaiting-review'
                  : event.data?.reason?.kind === 'aborted' ? 'cancelled' : 'unknown' });
              // DSH Follow may end once per turn while another request is queued.
              // Keep its independent cursor until all scheduled turns are projected.
              if (consumer.expectedTurns > 0) consumer.expectedTurns -= 1;
              rememberTaskFollowPosition(key, taskId, consumer.sequence, terminalTurns);
              if (consumer.expectedTurns === 0) { consumer.finished = true; return; }
            }
          }
          if (controller.signal.aborted) { consumer.finished = true; return; }
          if (sawTurnEnd && consumer.expectedTurns > 0) continue;
          if (sawTurnEnd) { consumer.finished = true; return; }
          throw capabilityError('AGENT_FOLLOW_DISCONNECTED', 'Task Agent event stream ended before turn completion');
        } catch (error) {
          if (controller.signal.aborted || ['SESSION_NOT_FOUND', 'AGENT_UNSUPPORTED'].includes(error?.code)) return;
          failures += 1;
          audit({ capability: 'agent.run', status: 'follow-retrying', code: error?.code ?? 'AGENT_FOLLOW_FAILED' });
          if (failures >= 5) {
            audit({ capability: 'agent.run', status: 'follow-error', code: error?.code ?? 'AGENT_FOLLOW_FAILED' });
            if (consumer.expectedTurns > 0) {
              blockLostTaskFollow(provider, sessionId, taskId, error?.code ?? 'AGENT_FOLLOW_FAILED');
            }
            return;
          }
          await waitForTaskFollowRetry(Math.min(250 * (2 ** (failures - 1)), 4000), controller.signal);
        }
      }
    })().catch(error => {
      audit({ capability: 'agent.run', status: 'follow-error', code: error?.code ?? 'AGENT_FOLLOW_FAILED' });
    }).finally(() => {
      consumer.finished = true;
      if (taskFollowConsumers.get(key) === consumer) taskFollowConsumers.delete(key);
    });
    return consumer;
  }
  agentBroker?.setTaskExecutionObserver?.(({ taskId, provider, sessionId, runId, phase, state }) => {
    if (phase !== 'user' || !taskId) return;
    if (state === 'running') {
      taskRuntime.beginExecutionObservation({ id: taskId, provider, sessionId, runId, phase });
      ensureTaskFollow(provider, sessionId, taskId, { expectTurn: true });
    } else taskRuntime.observeExecution({ id: taskId, provider, sessionId, runId, phase, state });
  });
  function stopTaskFollow(provider, sessionId) {
    const key = taskFollowKey(provider, sessionId);
    const consumer = taskFollowConsumers.get(key);
    taskFollowPositions.delete(key);
    if (!consumer) return false;
    consumer.controller.abort();
    taskFollowConsumers.delete(key);
    return true;
  }
  function saveJournal() {
    if (!journalFile) return;
    writeJsonAtomic(journalFile, journal);
  }
  async function idempotent(request, run) {
    const hash = requestFingerprint(request), old = journal[request.requestId];
    if (old && old.hash !== hash) throw capabilityError('REQUEST_ID_CONFLICT', 'Request ID reused with different data');
    if (old?.status === 'completed') return structuredClone(old.result);
    if (requests.has(request.requestId)) return requests.get(request.requestId);
    if (request.capability === 'agent.run' && old && old.status !== 'completed') {
      throw capabilityError('REQUEST_RECOVERY_REQUIRED', 'Previous Agent dispatch outcome is uncertain; review Task before retrying');
    }
    journal[request.requestId] = { hash, status: 'in-flight', taskId: request.taskId ?? null }; saveJournal();
    const pending = Promise.resolve().then(run);
    requests.set(request.requestId, pending);
    try { const result = await pending; journal[request.requestId] = { hash, status: 'completed', taskId: request.taskId ?? null, result }; saveJournal(); return result; }
    catch (error) { journal[request.requestId] = { hash, status: 'failed', taskId: request.taskId ?? null, code: error.code }; saveJournal(); throw error; }
    finally { requests.delete(request.requestId); }
  }
  const taskFor = id => {
    if (!taskRuntime) return null;
    try { return taskRuntime.get({ id }).task ?? null; }
    catch (error) {
      if (error?.code === 'TASK_NOT_FOUND') return null;
      throw error;
    }
  };
  const resolveWorkspace = id => workspaceService?.describeWorkspace(id);
  const policy = createCapabilityPolicy({ resolveWorkspace, resolveTask: taskFor,
    resolveGrants: taskId => grants[taskId],
    isTaskHandoff: taskId => taskHandoffGuard(taskId) });
  const broker = createCapabilityBroker({
    policy,
    approval: createCapabilityApproval({ stateDir, now }), audit, stateDir
  });
  const nativeApproval = createNativeApprovalAdapter({ broker, resolveWorkspace, agentBroker, now,
    resolveTask: taskId => taskHandoffGuard(taskId) ? null : taskFor(taskId) });
  function saveGrants() {
    if (!file) return;
    writeJsonAtomic(file, grants);
  }
  function rememberWorkspaceImport(id, state) {
    if (!id) return;
    workspaceImportStates.delete(String(id));
    workspaceImportStates.set(String(id), state);
    while (workspaceImportStates.size > 1000) workspaceImportStates.delete(workspaceImportStates.keys().next().value);
  }
  function validateWorkspaceImport(request) {
    const assigned = request.assignment, current = taskFor(request.taskId);
    if (assigned && current?.executionObservation && (current.currentAgent?.provider !== assigned.provider
      || current.currentAgent?.sessionId !== assigned.sessionId || current.executionObservation.runId !== assigned.runId)) {
      throw capabilityError('AGENT_ASSIGNMENT_EXPIRED', 'Workspace import belongs to a stale execution');
    }
    const changes = request.input?.changes;
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_AGENT_IMPORT_FILES) {
      throw capabilityError('INVALID_CHANGES', `Workspace import requires 1-${MAX_AGENT_IMPORT_FILES} changes`);
    }
    const workspace = resolveWorkspace(request.workspaceId);
    if (!workspace) throw capabilityError('WORKSPACE_NOT_FOUND', request.workspaceId);
    const seen = new Set();
    let totalBytes = 0;
    for (const change of changes) {
      if (!change || !['write', 'delete'].includes(change.action) || typeof change.path !== 'string' || !change.path.trim()) {
        throw capabilityError('INVALID_CHANGES', 'Each Workspace import change needs an action and relative path');
      }
      const relative = change.path.replaceAll('\\', '/');
      const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
      if (seen.has(key)) throw capabilityError('INVALID_CHANGES', `Workspace import contains a duplicate path: ${relative}`);
      seen.add(key);
      if (relative.split('/').some(segment => SENSITIVE_IMPORT_SEGMENT.test(segment)
        || /\.(?:pem|p12|pfx|key|keystore)$/i.test(segment))) {
        throw capabilityError('SENSITIVE_RESOURCE_DENIED', 'Workspace import cannot modify repository controls or credentials');
      }
      let resolved;
      try { resolved = resolveInside(workspace.root, relative, { forWrite: true }); }
      catch (error) {
        if (/OUTSIDE|ESCAPE|ABSOLUTE|TRAVERSAL|INVALID_PATH|BOUNDARY/.test(error.code ?? '')) {
          throw capabilityError('PATH_OUTSIDE_WORKSPACE', error.message);
        }
        throw error;
      }
      const parts = path.relative(workspace.root, resolved.absolute).split(path.sep).filter(Boolean);
      let cursor = workspace.root;
      let existing = null;
      for (let index = 0; index < parts.length; index += 1) {
        cursor = path.join(cursor, parts[index]);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (stat.isSymbolicLink()) throw capabilityError('PATH_SYMLINK_DENIED', `Workspace import refuses symbolic links: ${relative}`);
        if (index < parts.length - 1 && !stat.isDirectory()) throw capabilityError('PATH_INVALID', `Workspace import parent is not a directory: ${relative}`);
        if (index === parts.length - 1) existing = stat;
      }
      const currentHash = existing?.isFile() ? sha256(fs.readFileSync(resolved.absolute)) : null;
      if (existing && !existing.isFile()) throw capabilityError('IMPORT_TARGET_INVALID', `Workspace import target is not a regular file: ${relative}`);
      if ((change.expectedHash ?? null) !== currentHash) {
        throw capabilityError('WORKSPACE_CONFLICT', `Workspace file changed since staging: ${relative}`);
      }
      if (change.action === 'write') {
        if (typeof change.content !== 'string') throw capabilityError('INVALID_CHANGES', `Workspace write content must be text: ${relative}`);
        const bytes = Buffer.byteLength(change.content, 'utf8');
        if (bytes > MAX_AGENT_IMPORT_FILE_BYTES) throw capabilityError('IMPORT_TOO_LARGE', `Workspace import file exceeds limit: ${relative}`);
        totalBytes += bytes;
        if (typeof change.hash !== 'string' || change.hash !== sha256(Buffer.from(change.content, 'utf8'))) {
          throw capabilityError('IMPORT_HASH_MISMATCH', `Workspace import content hash does not match: ${relative}`);
        }
      } else if (typeof change.expectedHash !== 'string' || change.hash !== null) {
        throw capabilityError('INVALID_CHANGES', `Workspace delete requires the original file hash: ${relative}`);
      }
      if (totalBytes > MAX_AGENT_IMPORT_BYTES) throw capabilityError('IMPORT_TOO_LARGE', 'Workspace import exceeds the total size limit');
    }
  }
  function grantTask(taskId, value) {
    const task = taskFor(taskId);
    if (!task?.workspaceId) throw capabilityError('WORKSPACE_REQUIRED', 'Task workspace required');
    const readOnlyChild = task.parentTaskId && task.childContract?.mode === 'read-only';
    // 默认 Agent 能力集（v2 final security）：**不含 test.run**。
    // Agent 可以默认修改 Workspace ≠ Agent 可以默认执行 Workspace 代码——
    // test.run 执行的是 Agent 可经 filesystem.write 修改的项目代码（package.json
    // 脚本 / 测试 / 构建脚本），allowlist 只防命令注入、防不了项目代码本身。
    // 需要 test.run 的任务必须显式传入（Workshop Owner 勾选 / Smart 路径显式
    // request-only grant），且每一次执行仍需 Owner Approve Once（risk=high）。
    if (readOnlyChild && value?.capabilities?.some(id => !['filesystem.read', 'filesystem.search'].includes(id))) {
      throw capabilityError('TASK_CHILD_READ_ONLY', 'Child grant cannot advertise write or unrelated tools');
    }
    const capabilities = new Set(readOnlyChild ? ['filesystem.read', 'filesystem.search']
      : value?.capabilities ?? ['filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'memory.read', ...(evidenceStore ? ['context.evidence.read'] : [])]);
    if (capabilities.has('filesystem.write')) capabilities.add('workspace.apply');
    for (const id of capabilities) broker.registry.require(id);
    if ((value?.workspaceIds ?? [task.workspaceId]).some(id => id !== task.workspaceId)) {
      throw capabilityError('WORKSPACE_NOT_AUTHORIZED', 'A Task grant cannot include another workspace');
    }
    grants[taskId] = { capabilities: [...capabilities], workspaceIds: [task.workspaceId], taskIds: [taskId],
      scopes: readOnlyChild ? [`task:${taskId}`] : [`task:${taskId}`, `workspace:${task.workspaceId}`],
      types: readOnlyChild ? ['task'] : ['working', 'task', 'workspace', 'knowledge', 'skill'] };
    saveGrants();
    return principalForTask(taskId);
  }
  function refreshTaskWorkspaceGrant(taskId) {
    const task = taskFor(taskId);
    if (!task?.workspaceId) throw capabilityError('WORKSPACE_REQUIRED', 'Task workspace required');
    if (!grants[taskId]) return { refreshed: false, actor: null };
    grants[taskId].workspaceIds = [task.workspaceId];
    grants[taskId].taskIds = [taskId];
    grants[taskId].scopes = task.parentTaskId && task.childContract?.mode === 'read-only'
      ? [`task:${taskId}`]
      : [...new Set([...(grants[taskId].scopes ?? []).filter(scope => !String(scope).startsWith('workspace:')), `workspace:${task.workspaceId}`])];
    saveGrants();
    return { refreshed: true, actor: principalForTask(taskId) };
  }
  function principalForTask(taskId) {
    const task = taskFor(taskId);
    if (!grants[taskId] || !task) throw capabilityError('TASK_NOT_AUTHORIZED', taskId);
    const projected = structuredClone(grants[taskId]);
    if (task.parentTaskId && task.childContract?.mode === 'read-only') {
      projected.capabilities = projected.capabilities.filter(id => ['filesystem.read', 'filesystem.search'].includes(id));
      projected.scopes = [`task:${taskId}`];
      projected.types = ['task'];
    }
    return { kind: 'agent', id: `task:${taskId}`, grants: projected };
  }
  function memoryPrincipal(actor) {
    if (actor.kind === 'owner') return { kind: 'user', id: actor.id };
    const task = actor.grants?.taskIds?.length === 1 ? taskFor(actor.grants.taskIds[0]) : null;
    const readOnlyRefs = {};
    for (const ref of task?.memoryRefs ?? []) {
      if (ref.authorizedBy !== 'user:desktop' || !ref.scope || !ref.type || !ref.memoryId) continue;
      if ((actor.grants?.scopes ?? []).includes(ref.scope)) continue;
      (readOnlyRefs[ref.scope] ??= []).push(ref.memoryId);
    }
    return { kind: 'agent', id: actor.id, grants: { scopes: [...(actor.grants?.scopes ?? []), ...Object.keys(readOnlyRefs)],
      types: [...new Set([...(actor.grants?.types ?? []), ...(task?.memoryRefs ?? [])
        .filter(ref => readOnlyRefs[ref.scope]?.includes(ref.memoryId)).map(ref => ref.type)])], readOnlyRefs } };
  }
  if (workspaceService) {
    for (const [method, id] of Object.entries(WORKSPACE_CAPABILITIES)) {
      broker.register({ id, cancellationAware: id === 'test.run', permission: id === 'workspace.apply' ? 'filesystem.write' : id, provider: 'workspace', workspace: id !== 'workspace.create',
        description: WORKSPACE_TOOL_DESCRIPTORS[id][0],
        inputSchema: WORKSPACE_TOOL_DESCRIPTORS[id][1],
        category: id.startsWith('filesystem.') ? 'filesystem' : id.startsWith('git.') ? 'git' : 'workspace',
        // test.run = 执行 Workspace 中可被 Agent 修改的代码：high（审批必经），
        // 不是普通 medium。Owner 直接点击"运行测试"走 executeWorkspace 的
        // approved:true（Owner 的点击本身就是显式决定，语义与既往一致）。
        risk: ['workspace.create', 'git.commit', 'test.run', 'workspace.apply', 'filesystem.write'].includes(id) ? 'high' : 'low',
        validate(request) {
          if (id === 'workspace.apply') {
            validateWorkspaceImport(request);
            return;
          }
          if (id === 'workspace.create') {
            assertSafeRootForm(request.input.root);
            if (fs.existsSync(request.input.root)) canonicalizeRoot(request.input.root);
            return;
          }
          if (id === 'test.run' && request.actor.kind !== 'owner') {
            // v2 final security：Agent test.run = 三层同时满足——
            //   1) Agent Grant 含 test.run（= 可以"请求"，不等于可以执行）；
            //   2) Capability Permission（policy.authorize）；
            //   3) Owner Approve Once（risk=high → 审批必经，见 broker policy）。
            // 缺第一层 → PERMISSION_DENIED；缺第三层 → pending 待 Owner 决定。
            // grant 含 test.run 绝不会被解释为"无需审批"。
            if (!isolatedRunner) {
              throw capabilityError('TEST_SANDBOX_UNAVAILABLE', 'Controlled test runner unavailable; Agent test execution stays denied');
            }
            if (typeof request.input?.tool !== 'string' || !Array.isArray(request.input?.args)) {
              throw capabilityError('INVALID_PARAMS', 'test.run 需要 { tool, args }（allowlist 形态）');
            }
          }
          if (id === 'filesystem.read' || id === 'filesystem.write') {
            const ws = resolveWorkspace(request.workspaceId);
            if (request.actor.kind !== 'owner') {
              const segments = path.relative(ws.root, path.resolve(ws.root, String(request.input.path ?? ''))).split(/[\\/]/);
              if (segments.some(s => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(s))) {
                throw capabilityError('SENSITIVE_RESOURCE_DENIED', 'Repository controls and credentials require Owner access');
              }
            }
            try {
              const resolved = resolveInside(ws.root, request.input.path, { forWrite: id === 'filesystem.write' });
              if (id === 'filesystem.write' && request.actor.kind !== 'owner' && fs.existsSync(resolved.absolute)
                && typeof request.input.expectedHash !== 'string') {
                throw capabilityError('EXPECTED_HASH_REQUIRED', 'Agent write to an existing file requires expectedHash');
              }
              if (request.actor.kind !== 'owner' && path.relative(ws.root, resolved.real).split(/[\\/]/)
                .some(s => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(s))) {
                throw capabilityError('SENSITIVE_RESOURCE_DENIED', 'Resolved target is a protected resource');
              }
              if (request.actor.kind === 'extension') {
                const scoped = request.actor.grants.paths.some(rel => {
                  const allowed = resolveInside(ws.root, rel, { forWrite: true }).real;
                  return resolved.real === allowed || resolved.real.startsWith(allowed + path.sep);
                });
                if (!scoped) throw capabilityError('FILESYSTEM_SCOPE_DENIED', 'Real path escapes Extension declared scope');
              }
            }
            catch (error) { if (/OUTSIDE|ESCAPE|ABSOLUTE|TRAVERSAL|INVALID_PATH/.test(error.code ?? '')) throw capabilityError('PATH_OUTSIDE_WORKSPACE', error.message); throw error; }
          }
        },
        execute: request => {
          const run = async () => {
            if (id === 'workspace.create' && journal[request.requestId]) {
              const list = await workspaceService.execute({ method: 'workspace.list' });
              const existing = list.workspaces.find(ws => path.resolve(ws.root) === path.resolve(request.input.root));
              if (existing) return { workspace: existing, recovered: true };
            }
            if (id === 'test.run' && request.actor.kind !== 'owner') {
              // Agent 的 test.run 走 Controlled Test Runner（命令 allowlist，绝不执行
              // Owner 的 testCommand 字符串，也绝不接受调用方 shell）。
              // 到达这里意味着 Owner 已经 Approve Once（risk=high 审批已消费）。
              return isolatedRunner.run({ workspaceId: request.workspaceId,
                tool: request.input.tool, args: request.input.args, timeoutMs: request.input.timeoutMs, signal: request.signal });
            }
            if (id === 'workspace.apply') {
              const result = await workspaceService.applyChanges({ id: request.workspaceId, changes: request.input.changes, actor: request.actor.id });
              const binding = request.assignment;
              if (binding?.provider && binding.sessionId && binding.runId && binding.phase === 'user') {
                const changes = request.input.changes.map(change => ({ action: change.action, path: change.path,
                  sha256: change.action === 'write' ? sha256(fs.readFileSync(resolveInside(resolveWorkspace(request.workspaceId).root, change.path).absolute)) : null, previousSha256: change.expectedHash ?? null }));
                taskRuntime.recordToolOutcome({ id: request.taskId, provider: binding.provider, sessionId: binding.sessionId,
                  runId: binding.runId, phase: binding.phase, eventId: `core-import:${request.requestId}`.slice(0,240),
                  capability: 'workspace.apply', status: 'completed', source: 'core-import',
                  resultSha256: sha256(JSON.stringify(changes)), changes });
              }
              return result;
            }
            return workspaceService.execute({ method, params: { ...request.input,
              ...(id === 'filesystem.read' ? { maxBytes: request.input.maxBytes ?? request.input.maxChars ?? 8192 } : {}),
              ...(id === 'filesystem.search' ? { searchRestricted: request.actor.kind !== 'owner' } : {}),
              ...(id === 'git.diff' ? { excludeSensitive: request.actor.kind !== 'owner' } : {}),
              ...(request.workspaceId ? { id: request.workspaceId } : {}), actor: request.actor.id } });
          };
          return id === 'workspace.create' ? idempotent(request, run) : run();
        }
      });
    }
  }
  if (taskRuntime) {
    broker.register({
      id: 'task.create',
      permission: 'task.create',
      provider: 'task-runtime',
      risk: 'medium',
      description: 'Create a CetaMesh Task bound to the current authorized Workspace.',
      inputSchema: objectInput({
        goal: stringField('Task outcome to achieve.'),
        requirements: { type: 'array', items: stringField('Task requirement.'), maxItems: 50 },
        acceptanceCriteria: { type: 'array', items: stringField('Verifiable completion criterion.'), maxItems: 50 },
        note: stringField('Short initial Task note.')
      }, ['goal']),
      validate(request) {
        if (request.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Only Owner may create a Task from Chat');
        if (request.workspaceId && !resolveWorkspace(request.workspaceId)) throw capabilityError('WORKSPACE_NOT_FOUND', request.workspaceId);
      },
      execute(request) {
        const task = taskRuntime.create({
          goal: request.input.goal,
          requirements: request.input.requirements,
          acceptanceCriteria: request.input.acceptanceCriteria,
          note: request.input.note,
          workspaceId: request.workspaceId ?? null
        });
        return { task: { id: task.id, goal: task.goal, status: task.status, workspaceId: task.workspaceId } };
      }
    });
  }
  if (memoryService) {
    for (const action of ['read', 'write', 'link']) {
      broker.register({ id: 'memory.desktop.' + action, permission: 'memory.' + action,
        provider: 'memory', risk: 'low', modelCallable: false, execute: r => {
          if (r.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Owner administration only');
          return memoryService.execute(r.input);
        }});
    }
    broker.register({ id: 'memory.read', permission: 'memory.read', provider: 'memory', requiresTask: true, risk: 'low',
      description: 'Search or read Memory only within the current authorized Task scope.',
      inputSchema: objectInput({ id: stringField('Optional Memory record id.'), query: stringField('Search query within the current Task scope.'), limit: { type: 'integer', minimum: 1, maximum: 20 } }),
      validate: r => { if (['owner', 'agent'].includes(r.actor.kind) && !r.taskId) throw capabilityError('TASK_REQUIRED', 'Memory model tools require a CetaMesh Task scope'); },
      execute: r => {
      const principal = memoryPrincipal(r.actor);
      const input = { ...r.input, ...(r.taskId ? { scope: 'task:' + r.taskId } : {}), principal };
      return input.id ? memoryService.runtime.get(input) : memoryService.runtime.search(input);
    }});
    broker.register({ id: 'memory.write', permission: 'memory.write', provider: 'memory', requiresTask: true, risk: 'medium',
      description: 'Write or propose a Memory item within the current authorized scope.',
      inputSchema: objectInput({ title: stringField('Memory title.'), content: stringField('Memory content.'), type: stringField('Memory type.') }, ['title', 'content']),
      validate: r => { if (['owner', 'agent'].includes(r.actor.kind) && !r.taskId) throw capabilityError('TASK_REQUIRED', 'Memory model tools require a CetaMesh Task scope'); },
      execute: r => {
      const principal = memoryPrincipal(r.actor);
      const input = { ...r.input, ...(['owner', 'agent'].includes(r.actor.kind) ? { scope: `task:${r.taskId}` } : {}) };
      if (r.actor.kind !== 'owner' && input.type !== 'working') return memoryService.runtime.proposeCandidate({ ...input, principal });
      return memoryService.runtime.create({ ...input, principal });
    }});
    broker.register({ id: 'memory.link', permission: 'memory.link', provider: 'memory', requiresTask: true, risk: 'medium',
      description: 'Build a bounded Memory reference package from the current authorized Task scope.',
      inputSchema: objectInput({ query: stringField('Reference query within the current Task scope.') }, ['query']),
      validate: r => { if (['owner', 'agent'].includes(r.actor.kind) && !r.taskId) throw capabilityError('TASK_REQUIRED', 'Memory model tools require a CetaMesh Task scope'); },
      execute: r => {
      const principal = memoryPrincipal(r.actor);
      return memoryService.runtime.buildContextPackage({ ...r.input,
        ...(['owner', 'agent'].includes(r.actor.kind) ? { scope: `task:${r.taskId}` } : {}), principal });
    }});
  }
  if (evidenceStore) {
    broker.register({ id: 'context.evidence.read', permission: 'context.evidence.read', provider: 'context', risk: 'low',
      description: 'Retrieve a bounded page of preserved tool evidence in this exact Session, Task and Workspace. Current source permissions are required.',
      inputSchema: objectInput({ id: stringField('Opaque evidence id from a tool result.'),
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 6000 } }, ['id']),
      validate: r => {
        if (!['owner', 'agent'].includes(r.actor.kind)) throw capabilityError('PERMISSION_DENIED', 'Evidence is restricted to its Owner or assigned Agent');
        if (typeof r.origin?.sessionId !== 'string' || !r.origin.sessionId) throw capabilityError('TOOL_EVIDENCE_DENIED', 'Trusted Session origin required');
        const assigned = r.taskId ? taskFor(r.taskId)?.currentAgent : null;
        if (r.actor.kind === 'agent' && assigned?.sessionId && assigned.sessionId !== r.origin.sessionId)
          throw capabilityError('TOOL_EVIDENCE_DENIED', 'Agent Session assignment changed');
      },
      execute: r => evidenceStore.read({
        binding: evidenceBinding({ actor: r.actor, sessionId: r.origin.sessionId,
          scope: { taskId: r.taskId ?? null, workspaceId: r.workspaceId ?? null } }),
        id: r.input.id, offset: r.input.offset, limit: r.input.limit,
        authorizeSource: source => {
          // A read never replays the original effect. Only audited sources with
          // complete synchronous scope validation are eligible for compaction.
          if (!EVIDENCE_SOURCE_CAPABILITIES.includes(source?.capability)) return false;
          try {
            const entry = broker.registry.require(source.capability);
            const original = { ...r, capability: source.capability, input: source.input,
              approvalId: undefined, approvalBinding: undefined, approved: undefined };
            policy.authorize(original, entry);
            const validation = entry.validate?.(original);
            return !validation || typeof validation.then !== 'function';
          } catch { return false; }
        }
      })
    });
  }
  broker.register({ id: 'network', permission: 'network', provider: 'safe-fetch', risk: 'high', modelCallable: false,
    validate: r => {
      if (r.input.init?.method && r.input.init.method.toUpperCase() !== 'GET' || r.input.init?.body !== undefined) {
        throw capabilityError('NETWORK_OPERATION_DENIED', 'Only read-only GET is implemented');
      }
    },
    execute: r => safeFetch(String(r.input.url), Math.min(50000, Number(r.input.maxChars) || 50000), {
      authorizeUrl: url => {
        if (r.actor.kind === 'extension' && !r.actor.grants.hosts.includes(url.host)) {
          throw capabilityError('NETWORK_SCOPE_DENIED', 'Redirect host not declared');
        }
      }
    }) });
  broker.register({ id: 'web.search', permission: 'web.search', provider: 'mcp-adapter', risk: 'medium',
    available: typeof searchImpl === 'function',
    description: 'Search the public web through the configured safe-search adapter.',
    inputSchema: objectInput({ query: stringField('Public web search query.') }, ['query']),
    execute: r => {
      if (!searchImpl) throw capabilityError('PROVIDER_UNAVAILABLE', 'Web search adapter is not connected');
      return searchImpl(String(r.input.query ?? ''));
    } });
  broker.register({ id: 'clock.now', permission: 'log', provider: 'desktop', risk: 'low',
    description: 'Return the current local time and timezone.',
    inputSchema: objectInput(),
    execute: () => ({ iso: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  broker.register({ id: 'agent.execution.authorize', permission: 'agent.run', provider: 'agent-broker',
    workspace: true, risk: 'high', modelCallable: false,
    description: 'Confirm the disclosed native execution scope for one Workspace and Agent policy.',
    inputSchema: objectInput({ provider: stringField('Agent Provider.'), fingerprint: stringField('Current execution policy fingerprint.') }, ['provider', 'fingerprint']),
    validate(request) {
      if (request.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Only Owner may confirm native execution');
      if (!resolveWorkspace(request.workspaceId)) throw capabilityError('WORKSPACE_NOT_FOUND', 'Registered Workspace required');
      const scope = agentBroker.describeExecutionSecurity(request.input.provider, request.workspaceId);
      if (!scope.required || request.input.fingerprint !== scope.fingerprint) throw capabilityError('AGENT_SECURITY_POLICY_CHANGED', 'Agent policy changed; review again');
      // The authoritative disclosure is fingerprint-bound; never trust caller-provided copy.
      if (request.reason !== scope.disclosure.slice(0, 1000)) throw capabilityError('AGENT_SECURITY_DISCLOSURE_MISMATCH', 'Execution disclosure must match the current policy');
    },
    execute: request => agentBroker.authorizeExecution(request.input.provider, request.workspaceId, request.input.fingerprint)
  });
  broker.register({ id: 'agent.run', permission: 'agent.run', provider: 'agent-broker', workspace: true, requiresTask: true, risk: 'medium',
    available: Boolean(agentBroker?.ids?.().length),
    description: 'Assign the current CetaMesh Task to a registered Agent Provider.',
    inputSchema: objectInput({
      agentProvider: stringField('Registered Agent Provider id.'),
      content: stringField('Task instructions for the Agent.'),
      modelProvider: stringField('Optional Model Provider id.'),
      model: stringField('Optional Model id.'),
      reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
    }),
    async execute(r) {
      return idempotent(r, async () => {
      if (r.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Only Owner may assign Agents');
      if (r.signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
      let task = taskFor(r.taskId);
      if (!task || task.workspaceId !== r.workspaceId) throw capabilityError('TASK_NOT_AUTHORIZED', 'Task workspace required');
      if (/needs-reconciliation|approval-pending/i.test(task.progress?.note ?? '')) {
        throw capabilityError('NEEDS_RECONCILIATION', 'Task has an unreviewed interrupted effect or approval');
      }
      if ((task.attempts ?? []).some(row => ['started', 'unknown'].includes(row.state) && row.requestId !== r.requestId)) {
        throw capabilityError('NEEDS_RECONCILIATION', 'Prior Agent Attempt has an unconfirmed effect');
      }
      if (taskHandoffGuard(task.id)) throw capabilityError('TASK_HANDOFF_IN_FLIGHT', 'Task Handoff owns this execution boundary');
      const provider = String(r.input.agentProvider || r.input.provider || 'cetamesh');
      const readOnlyChild = Boolean(task.parentTaskId && task.childContract?.mode === 'read-only');
      const assertChildParentActive = () => {
        if (!readOnlyChild) return;
        taskRuntime.assertChildParentCurrent({ id: task.id, workspaceId: r.workspaceId });
      };
      if (readOnlyChild && provider !== 'cetamesh') {
        throw capabilityError('AGENT_READ_ONLY_BOUNDARY_UNVERIFIED', 'Native external Agent has no verified read-only Workspace boundary');
      }
      assertChildParentActive();
      const health = await agentBroker.health(provider);
      const providerCapabilities = agentBroker.capabilities(provider);
      // A configured key is not an authenticated account. This explicitly selected
      // mode may verify its credentials during dispatch, only after protocol and
      // every-tool permission policy verification. Explicit auth failure still denies.
      const configuredNativeDispatch = canDispatchConfiguredNativeAgent(health,providerCapabilities?.security);
      if (health?.available !== true || health?.disabled === true || health?.enabled === false
        || health?.ready === false || health?.reachable === false || health?.installed === false
        || health?.authenticated === false || health?.sessionCapable === false
        || health?.taskEligible === false || health?.compatible === false
        || (provider !== 'cetamesh' && (health?.sessionCapable !== true
          || (health?.authenticated !== true && !configuredNativeDispatch)))) {
        const error = capabilityError('PROVIDER_UNAVAILABLE', 'Agent Provider is not currently eligible for Task execution');
        // This check precedes Session creation, Attempt recording and send.
        // Only this trusted preflight failure can authorize one reassignment.
        safeAgentPreflights.add(error);
        throw error;
      }
      const boundary = providerCapabilities?.workspaceBoundary;
      if (!['capability-broker', 'staged-capability-broker', 'native-staged'].includes(boundary)) {
        throw capabilityError('AGENT_BOUNDARY_UNSUPPORTED', 'Provider has no enforced Capability Broker workspace boundary');
      }
      agentBroker.assertExecutionConsent?.(provider, { workspaceId: r.workspaceId });
      if (task.currentAgent && task.currentAgent.provider !== provider) {
        throw capabilityError('AGENT_PROVIDER_SWITCH_REQUIRES_CONTINUITY', 'An existing Task must change Agent Providers through Continuity Fresh Session');
      }
      const otherOwner = taskRuntime.activeWorkspaceOwner({ workspaceId: task.workspaceId,
        exceptTaskId: task.id, forReadOnlyTaskId: readOnlyChild ? task.id : null });
      const reservation = workspaceProvisioning.get(task.workspaceId);
      const readReservations = workspaceReadProvisioning.get(task.workspaceId);
      const activeReaders = taskRuntime.activeWorkspaceReaders({ workspaceId: task.workspaceId, exceptTaskId: task.id });
      const otherReaders = new Set([...activeReaders.map(row => row.id), ...(readReservations?.keys() ?? [])]);
      otherReaders.delete(task.id);
      if (otherOwner || (reservation && reservation.taskId !== task.id)
        || (!readOnlyChild && readReservations?.size) || (readOnlyChild && otherReaders.size >= 2)) {
        throw Object.assign(capabilityError('TASK_WORKSPACE_BUSY', '工作区仍由另一任务持有写入权；请先查看占用任务并核验，或切换工作区。'),
          { blockingTaskId: otherOwner?.id ?? reservation?.taskId ?? otherReaders.values().next().value });
      }
      if (readOnlyChild) {
        const held = readReservations ?? new Map();
        held.set(task.id, (held.get(task.id) ?? 0) + 1);
        workspaceReadProvisioning.set(task.workspaceId, held);
      } else workspaceProvisioning.set(task.workspaceId, { taskId: task.id, count: (reservation?.count ?? 0) + 1 });
      const previous = provisioning.get(task.id);
      const pending = (async () => {
        if (previous) {
          try { await previous; }
          catch (previousError) {
            audit({ requestId: r.requestId, capability: 'agent.run', status: 'prior-instruction-failed',
              code: previousError?.code ?? 'PROVIDER_ERROR' });
          }
          task = taskFor(r.taskId);
          if (!task || task.workspaceId !== r.workspaceId) {
            throw capabilityError('TASK_NOT_AUTHORIZED', 'Task workspace changed while instruction was queued');
          }
          if (task.currentAgent && task.currentAgent.provider !== provider) {
            throw capabilityError('AGENT_PROVIDER_SWITCH_REQUIRES_CONTINUITY', 'Task Agent changed while instruction was queued');
          }
        }
        if (!['queued', 'running'].includes(task.status)) {
          throw capabilityError('TASK_NOT_RUNNING', 'Task is paused or ended; resume it before dispatching Agent work');
        }
        assertChildParentActive();
        const queuedOwner = taskRuntime.activeWorkspaceOwner({ workspaceId: task.workspaceId,
          exceptTaskId: task.id, forReadOnlyTaskId: readOnlyChild ? task.id : null });
        if (queuedOwner) {
          throw Object.assign(capabilityError('TASK_WORKSPACE_BUSY', '工作区写入权已由另一任务持有；请查看占用任务后核验。'),
            { blockingTaskId: queuedOwner.id });
        }
        if (r.signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
        if (taskHandoffGuard(task.id)) throw capabilityError('TASK_HANDOFF_IN_FLIGHT', 'Task Handoff owns this execution boundary');
        const actor = grants[task.id] ? principalForTask(task.id) : grantTask(task.id, r.input.grants);
        if (task.currentAgent) {
          try {
            await agentBroker.status(task.currentAgent);
            if (r.signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
            if (taskHandoffGuard(task.id)) throw capabilityError('TASK_HANDOFF_IN_FLIGHT', 'Task Handoff owns this execution boundary');
            ensureTaskFollow(task.currentAgent.provider, task.currentAgent.sessionId, task.id, { expectTurn: typeof agentBroker.setTaskExecutionObserver !== 'function' });
            const beforeSend = taskFor(task.id);
            if (beforeSend?.status !== 'running' || beforeSend.currentAgent?.sessionId !== task.currentAgent.sessionId) {
              throw capabilityError('TASK_NOT_RUNNING', 'Task changed before Agent instruction dispatch');
            }
            assertChildParentActive();
            if (readOnlyChild) taskRuntime.recordAttempt({ id: task.id, expectedRev: beforeSend.rev,
              provider, sessionId: task.currentAgent.sessionId, requestId: r.requestId, state: 'started' });
            const sent = await agentBroker.send({ ...task.currentAgent, content: String(r.input.content || task.goal),
              ...(readOnlyChild ? { runId: r.requestId } : {}) });
            if (sent?.accepted !== true) throw capabilityError('AGENT_SEND_REJECTED', 'Agent did not accept Task instruction');
            if (readOnlyChild) taskRuntime.settleAttempt({ id: task.id, expectedRev: taskFor(task.id).rev,
              requestId: r.requestId, state: 'accepted', nativeRequestId: sent?.requestId ?? sent?.turnId });
            const afterSend = taskFor(task.id);
            if (!afterSend || ['queued', 'paused', 'waiting', 'blocked', 'cancelled'].includes(afterSend.status)
              || (afterSend.status === 'running' && afterSend.currentAgent?.sessionId !== task.currentAgent.sessionId)) {
              await agentBroker.cancel(task.currentAgent);
              throw capabilityError('TASK_NOT_RUNNING', 'Task changed while Agent accepted the instruction');
            }
            if (r.signal?.aborted) {
              try { await agentBroker.cancel(task.currentAgent); }
              catch (cancelError) {
                if (cancelError?.code !== 'SESSION_NOT_FOUND') throw cancelError;
              }
              throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
            }
            return { taskId: task.id, workspaceId: task.workspaceId, ...task.currentAgent,
              accepted: sent?.accepted === true, requestId: sent?.requestId ?? sent?.turnId ?? null,
              turnId: sent?.turnId ?? null, reused: true, actor };
          } catch (error) {
            if (error.code !== 'SESSION_NOT_FOUND') throw error;
            task = taskRuntime.detachAgent({ id: task.id, expectedRev: task.rev, note: 'Managed session unavailable after restart; fresh authorized session' }).task;
          }
        }
        const ws = resolveWorkspace(r.workspaceId);
        if (taskHandoffGuard(task.id)) throw capabilityError('TASK_HANDOFF_IN_FLIGHT', 'Task Handoff owns this execution boundary');
        let created = null;
        let attached = false;
        let startedByRequest = false;
        try {
          const modelConfig = {
            model: r.input.model ?? task.modelConfig?.model,
            modelProvider: r.input.modelProvider ?? task.modelConfig?.modelProvider,
            reasoningEffort: r.input.reasoningEffort ?? task.modelConfig?.reasoningEffort
          };
          created = await agentBroker.createSession(provider, { cwd: ws.root, taskId: task.id, workspaceId: ws.id,
            ...modelConfig });
          if (!created?.sessionId) throw capabilityError('PROVIDER_ERROR', 'Agent returned no session');
          if (r.signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
          const assignment = taskRuntime.attachAgent({ id: task.id, expectedRev: task.rev, provider, sessionId: created.sessionId });
          attached = true;
          if (provider === 'cetamesh') {
            bindAgentSession?.(created.sessionId, { taskId: task.id, workspaceId: ws.id, actor });
          }
          if (assignment.task.status === 'queued') {
            taskRuntime.start({ id: task.id, expectedRev: assignment.task.rev });
            startedByRequest = true;
          }
          if (r.signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
          ensureTaskFollow(provider, created.sessionId, task.id, { expectTurn: typeof agentBroker.setTaskExecutionObserver !== 'function' });
          const beforeSend = taskFor(task.id);
          if (beforeSend?.status !== 'running' || beforeSend.currentAgent?.sessionId !== created.sessionId) {
            throw capabilityError('TASK_NOT_RUNNING', 'Task changed before Agent instruction dispatch');
          }
          assertChildParentActive();
          if (readOnlyChild) taskRuntime.recordAttempt({ id: task.id, expectedRev: beforeSend.rev,
            provider, sessionId: created.sessionId, requestId: r.requestId, state: 'started' });
          const sent = await agentBroker.send({ provider, sessionId: created.sessionId, content: String(r.input.content || task.goal),
            ...(readOnlyChild ? { runId: r.requestId } : {}) });
          if (sent?.accepted !== true) throw capabilityError('AGENT_SEND_REJECTED', 'Agent did not accept Task instruction');
          if (readOnlyChild) taskRuntime.settleAttempt({ id: task.id, expectedRev: taskFor(task.id).rev,
            requestId: r.requestId, state: 'accepted', nativeRequestId: sent?.requestId ?? sent?.turnId });
          const afterSend = taskFor(task.id);
          if (!afterSend || ['queued', 'paused', 'waiting', 'blocked', 'cancelled'].includes(afterSend.status)
            || (afterSend.status === 'running' && afterSend.currentAgent?.sessionId !== created.sessionId)) {
            await agentBroker.cancel({ provider, sessionId: created.sessionId });
            throw capabilityError('TASK_NOT_RUNNING', 'Task changed while Agent accepted the instruction');
          }
          if (r.signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Agent assignment cancelled');
          if (Object.values(modelConfig).some(value => value !== null && value !== undefined && value !== '')) {
            const latest = taskFor(task.id);
            taskRuntime.setModelConfig({ id: task.id, expectedRev: latest.rev, ...modelConfig });
          }
          return { taskId: task.id, workspaceId: ws.id, provider, sessionId: created.sessionId,
            accepted: sent?.accepted === true, requestId: sent?.requestId ?? sent?.turnId ?? null,
            turnId: sent?.turnId ?? null, actor };
        } catch (error) {
          if (created?.sessionId) stopTaskFollow(provider, created.sessionId);
          let current = taskFor(task.id);
          if (attached && current?.currentAgent?.sessionId === created?.sessionId) {
            try { current = taskRuntime.detachAgent({ id: task.id, expectedRev: current.rev, note: 'Agent initialization rolled back' }).task; }
            catch (rollbackError) {
              audit({ requestId: r.requestId, capability: 'agent.run', status: 'rollback-warning', stage: 'detach-task',
                code: rollbackError?.code ?? 'TASK_ROLLBACK_FAILED' });
            }
          }
          if (created?.sessionId) {
            try { await agentBroker.closeSession({ provider, sessionId: created.sessionId }); }
            catch (cleanupError) {
              audit({ requestId: r.requestId, capability: 'agent.run', status: 'rollback-warning', stage: 'close-session',
                code: cleanupError?.code ?? 'SESSION_CLEANUP_FAILED' });
            }
          }
          if (startedByRequest && current?.status === 'running') {
            try { taskRuntime.fail({ id: task.id, expectedRev: current.rev, reason: 'Agent initialization failed and was rolled back' }); }
            catch (rollbackError) {
              audit({ requestId: r.requestId, capability: 'agent.run', status: 'rollback-warning', stage: 'fail-task',
                code: rollbackError?.code ?? 'TASK_ROLLBACK_FAILED' });
            }
          }
          throw error;
        }
      })();
      provisioning.set(task.id, pending);
      try { return await pending; } finally {
        if (provisioning.get(task.id) === pending) provisioning.delete(task.id);
        if (readOnlyChild) {
          const readers = workspaceReadProvisioning.get(task.workspaceId);
          if (readers?.has(task.id)) {
            const count = readers.get(task.id);
            if (count > 1) readers.set(task.id, count - 1);
            else readers.delete(task.id);
            if (!readers.size) workspaceReadProvisioning.delete(task.workspaceId);
          }
        }
        const held = workspaceProvisioning.get(task.workspaceId);
        if (held?.taskId === task.id) {
          if (held.count > 1) workspaceProvisioning.set(task.workspaceId, { taskId: task.id, count: held.count - 1 });
          else workspaceProvisioning.delete(task.workspaceId);
        }
      }
      });
    }
  });
  const operations = createApprovalOperations({ stateDir, getApproval: id => broker.approvals.get(id),
    cancelApproval: id => broker.approvals.cancel(id, 'owner-cancelled-before-dispatch'),
    execute: (params, context) => decideApproval(params, context), notify: onOperation });
  async function decideApproval(params, { signal } = {}) {
      const original = broker.approvals.get(params.id).request;
      const result = await broker.decide({ id: params.id, approve: params.approve === true, actor: OWNER_ACTOR }, { signal });
      if (original.capability === 'workspace.apply') rememberWorkspaceImport(params.id, {
        status: result.status,
        ...(result.status === 'completed' ? { result: result.result } : {})
      });
      if (typeof approvalDecisionListener === 'function') {
        const resumed = await approvalDecisionListener({ approvalId: params.id,
          requestFingerprint: requestFingerprint(original), decisionResult: result, request: original, signal });
        if (resumed) return { ...result, turnResumed: resumed.resumed === true, resumePending: resumed.pending === true,
          ...(resumed.pending === true && resumed.approvalId ? { resumeApprovalId: resumed.approvalId } : {}),
          ...(resumed.error ? { resumeError: resumed.error } : {}) };
      }
      if (original.actor.kind === 'agent' && original.taskId && agentBroker) {
        const task = taskFor(original.taskId);
        if (task?.currentAgent?.provider === 'cetamesh' && task.workspaceId === original.workspaceId) {
          try {
            if (typeof resumeAgentApproval === 'function') {
              const resumed = await resumeAgentApproval({ sessionId: task.currentAgent.sessionId,
                approvalId: params.id, decisionResult: result });
              if (resumed?.resumed === true) return { ...result, taskResumed: true };
              if (resumed?.error) return { ...result, taskResumed: false, resumeError: resumed.error };
            }
            await agentBroker.send({ ...task.currentAgent, content: '[Owner capability decision reference data]\n'
              + JSON.stringify({ approvalId: params.id, decision: result }).slice(0, 16000) });
            return { ...result, taskResumed: true };
          } catch (error) { return { ...result, taskResumed: false, resumeError: error.code ?? 'PROVIDER_ERROR' }; }
        }
      }
      return result;
  }
  async function execute({ method, params = {} } = {}) {
    if (method === 'capability.list') return { capabilities: broker.list() };
    if (method === 'capability.approval.list') return { approvals: broker.approvals.list() };
    if (method === 'capability.approval.decide') return params.defer === true ? operations.submit({ id: params.id, approve: params.approve === true }) : decideApproval(params);
    if (method === 'capability.operation.get') return operations.get(params.id);
    if (method === 'capability.operation.list') return { operations: operations.list() };
    if (method === 'capability.operation.cancel') return operations.cancel(params.id);
    if (method === 'capability.execute') return broker.execute({ ...params, actor: OWNER_ACTOR });
    throw capabilityError('METHOD_NOT_FOUND', method);
  }
  async function executeWorkspace({ method, params = {} } = {}) {
    const capability = WORKSPACE_CAPABILITIES[method];
    if (!capability) return workspaceService.execute({ method, params }); // Owner-only registry/settings/legacy approvals
    const workspaceId = params.id || (await workspaceService.execute({ method: 'workspace.list' })).activeId;
    // test.run 保持 Owner 直接操作语义：Owner 在 Workspace UI 点击"运行测试"就是
    // 显式决定（approved:true，跳过审批队列）；Managed Agent 的 test.run 不走此
    // 路径，risk=high 使其必然进入 Approve Once。
    const ownerDirect = ['workspace.create', 'filesystem.write', 'test.run', 'workspace.apply'].includes(capability);
    const result = await broker.execute({ capability, actor: OWNER_ACTOR, input: params,
      ...(capability !== 'workspace.create' ? { workspaceId } : {}), approved: ownerDirect, reason: 'Desktop Owner action' });
    return result.status === 'completed' ? result.result : result;
  }
  async function executeMemory(command) {
    // Desktop administration methods retain their existing confirmation/state semantics,
    // but every call still passes registry and the central permission decision.
    const capability = /create|update|delete|pin|import|confirm|propose/.test(command.method) ? 'memory.write'
      : /links|references|context/.test(command.method) ? 'memory.link' : 'memory.read';
    const result = await broker.execute({ capability: 'memory.desktop.' + capability.slice('memory.'.length),
      actor: OWNER_ACTOR, input: command, reason: 'Desktop Owner Memory action' });
    return result.result;
  }
  async function applyAgentWorkspaceChanges({ taskId, workspaceId, provider, sessionId, runId, phase, requestId, changes, summary } = {}) {
    const task = taskFor(String(taskId ?? ''));
    if (!task || task.workspaceId !== String(workspaceId ?? '')
      || !provider || !sessionId || task.currentAgent?.provider !== provider || task.currentAgent?.sessionId !== sessionId) {
      throw capabilityError('TASK_NOT_AUTHORIZED', 'Agent Workspace import requires its Task binding');
    }
    if (task.executionObservation && task.executionObservation.runId !== runId) throw capabilityError('AGENT_ASSIGNMENT_EXPIRED', 'Workspace import belongs to a stale run');
    const actor = principalForTask(task.id);
    const result = await broker.execute({ actor, taskId: task.id, workspaceId: task.workspaceId,
      capability: 'workspace.apply', requestId, assignment: { provider, sessionId, runId, phase },
      input: { changes, summary }, reason: 'Agent staging Workspace reconciliation' });
    if (result.status === 'pending') rememberWorkspaceImport(result.approvalId, { status: 'pending' });
    return result;
  }
  function workspaceImportStatus(approvalId) {
    return workspaceImportStates.get(String(approvalId ?? '')) ?? null;
  }
  function cancelWorkspaceImportApproval(approvalId) {
    const row = broker.approvals.get(String(approvalId ?? ''));
    if (row.request?.capability !== 'workspace.apply') return { cancelled: false, status: row.status };
    const result = broker.approvals.cancel(row.id, 'agent-cancelled');
    if (result.cancelled) rememberWorkspaceImport(row.id, { status: 'cancelled', code: 'INVOKE_CANCELLED' });
    return result;
  }
  return { execute, executeWorkspace, executeMemory, broker, grantTask, principalForTask, refreshTaskWorkspaceGrant, memoryPrincipal,
    requestAgentNativeApproval: (request, options) => nativeApproval.request(request, options),
    cancelTaskOperations: scope => operations.cancelScope(scope),
    verifyTaskImportReceipts(taskId, runId) {
      const task = taskFor(taskId), latest = new Map();
      const receipts = (task?.executionEvidence ?? []).filter(row => row.source === 'core-import' && row.status === 'completed'
        && row.runId === runId && row.provider === task.currentAgent?.provider && row.sessionId === task.currentAgent?.sessionId);
      for (const receipt of receipts) for (const change of receipt.changes ?? []) latest.set(change.path, change);
      if (!latest.size) return receipts.length === 0;
      try {
        const workspace = resolveWorkspace(task.workspaceId);
        for (const change of latest.values()) {
          const file = resolveInside(workspace.root, change.path, { forWrite: change.action === 'delete' }).absolute;
          if (change.action === 'delete' ? fs.existsSync(file) : sha256(fs.readFileSync(file)) !== change.sha256) return false;
        }
        return true;
      } catch { return false; }
    },
    completionBlocker(taskId) {
      if (provisioning.has(taskId) || Object.values(journal).some(row => row?.taskId === taskId && row.status === 'in-flight')) return 'TASK_EXECUTION_UNCONFIRMED';
      if (operations.list().some(row => ['accepted', 'running', 'waiting', 'unknown'].includes(row.status)
        && broker.approvals.get(row.approvalId).request?.taskId === taskId)) return 'TASK_EFFECT_UNCONFIRMED';
      if (broker.approvals.list().some(row => row.request?.taskId === taskId && ['pending', 'approved', 'executing'].includes(row.status))) return 'TASK_APPROVAL_PENDING';
      if ([...taskFollowConsumers.values()].some(row => row.taskId === taskId && !row.finished && row.expectedTurns > 0)) return 'TASK_EXECUTION_UNCONFIRMED';
      return null;
    },
    recoveryForTask(taskId) {
      return Object.values(journal).some(row => row?.taskId === taskId && row.status === 'in-flight')
        ? { state: 'needs-reconciliation', capability: 'agent.run' } : null;
    },
    acknowledgeTaskRecovery(taskId) {
      const rows = Object.values(journal).filter(row => row?.taskId === taskId && row.status === 'in-flight');
      for (const row of rows) row.status = 'reconciled';
      if (rows.length) {
        try { saveJournal(); }
        catch (error) {
          for (const row of rows) row.status = 'in-flight';
          throw error;
        }
      }
      return { reconciled: rows.length };
    },
    isTaskProvisioning(taskId) { return provisioning.has(String(taskId ?? '')); },
    setTaskHandoffGuard(guard) {
      if (typeof guard !== 'function') throw capabilityError('INVALID_PARAMS', 'Task Handoff guard must be a function');
      taskHandoffGuard = guard;
    },
    trackTaskAgent({ taskId, provider, sessionId, sinceSequence, bootstrapRequestId, bootstrapTurnId }) {
      const task = taskFor(taskId);
      if (!task || task.currentAgent?.provider !== provider || task.currentAgent?.sessionId !== sessionId) {
        throw capabilityError('TASK_NOT_AUTHORIZED', 'Task Agent follow requires the current assignment');
      }
      return ensureTaskFollow(provider, sessionId, taskId, { sinceSequence, bootstrapRequestId, bootstrapTurnId }) !== null;
    },
    applyAgentWorkspaceChanges, workspaceImportStatus, cancelWorkspaceImportApproval,
    async close() {
      nativeApproval.close();
      await operations.close();
      const consumers = [...taskFollowConsumers.values()];
      for (const consumer of consumers) consumer.controller.abort();
      await Promise.allSettled(consumers.map(consumer => consumer.promise));
      taskFollowConsumers.clear();
      taskFollowPositions.clear();
    },
    setApprovalDecisionListener(listener) {
      if (listener !== null && typeof listener !== 'function') throw capabilityError('INVALID_PARAMS', 'Approval decision listener must be a function');
      approvalDecisionListener = listener;
      return true;
    }
  };
}

