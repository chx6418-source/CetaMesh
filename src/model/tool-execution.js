import { evidenceBinding, evidenceSummary, sanitizeToolEvidence, EVIDENCE_SOURCE_CAPABILITIES, validateEvidenceSourceInput } from '../context/tool-evidence.js';
import { projectMessageBudget } from '../context/message-budget.js';
import { readHistorySource, fingerprintHistorySource } from '../context/history-synopsis.js';
import { accumulateModelUsage } from './usage.js';
import { validateSchema, schemaFailureDetail } from './input-schema.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic, StorageError } from '../storage/json-file.js';
import { redactText, isSensitiveKey } from '../logging/redact.js';
import { capabilityError } from '../capability/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { mayRetrySafeTool, runBoundedRetryAttempt, SAFE_TOOL_RETRY } from './safe-tool-retry.js';
import { validateReadBatchPlan, applyBatchTransform, selectBatchFields, batchField, batchGlobMatches, READ_BATCH_LIMITS } from './read-batch-program.js';
import { planPostWriteVerification, postWriteVerificationFeedback } from './post-write-verification.js';

const MAX_BATCH_CALLS = 8;
const MAX_TOOL_CYCLES = 6;
const MAX_TOTAL_CALLS = 24;
const MAX_RESULT_CHARS = 12000;
const AUTHORITY_KEYS = new Set([
  'actor', 'actorid', 'grants', 'taskid', 'workspaceid', 'scope', 'approved', 'approvalid',
  'requestid', 'operationid', 'idempotencykey', 'attemptid', 'executorid', 'assignment', 'assignmentrevision', 'principal', 'permissions', 'capabilities', 'provider', 'providerid'
]);

function fail(code, message) { throw capabilityError(code, message); }

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsAuthorityKey(value, depth = 0) {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => containsAuthorityKey(item, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => AUTHORITY_KEYS.has(key.toLowerCase()) || containsAuthorityKey(child, depth + 1));
}


function parseArguments(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value; }
  catch { fail('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be valid JSON'); }
  if (!isPlainObject(parsed)) fail('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be a JSON object');
  if (containsAuthorityKey(parsed)) fail('TOOL_AUTHORITY_OVERRIDE', 'Tool input cannot provide CetaMesh authority or scope');
  return parsed;
}

function stripLocalPaths(value) {
  return redactText(value)
    .replace(/(?:[A-Za-z]:\\|\\\\[^\s"']+|\/(?:Users|home|root|mnt|tmp)\/)[^\s"'<>]*/g, '[LOCAL_PATH]');
}

function recordOmission(omissions, item) {
  const prior = omissions.find(row => row.reason === item.reason);
  if (prior) {
    prior.occurrences = (prior.occurrences ?? 1) + 1;
    if (item.omitted !== undefined) prior.omitted = (prior.omitted ?? 0) + item.omitted;
  } else omissions.push(item);
}

function safeValue(value, omissions, depth = 0) {
  if (depth > 5) { recordOmission(omissions, { reason: 'depth-limit' }); return '[DEPTH_LIMIT]'; }
  if (typeof value === 'string') {
    const text = stripLocalPaths(value);
    if (text.length <= MAX_RESULT_CHARS) return text;
    let preview = text.slice(0, MAX_RESULT_CHARS);
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    recordOmission(omissions, { reason: 'string-characters', omitted: text.length - preview.length });
    return preview;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 40) recordOmission(omissions, { reason: 'array-items', omitted: value.length - 40 });
    return value.slice(0, 40).map(item => safeValue(item, omissions, depth + 1));
  }
  if (!isPlainObject(value)) {
    const text = stripLocalPaths(String(value));
    if (text.length > 200) recordOmission(omissions, { reason: 'unsupported-value-characters', omitted: text.length - 200 });
    return text.slice(0, 200);
  }
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > 40) recordOmission(omissions, { reason: 'object-properties', omitted: entries.length - 40 });
  for (const [key, child] of entries.slice(0, 40)) {
    if (AUTHORITY_KEYS.has(key.toLowerCase())) continue;
    if (key.length > 100) recordOmission(omissions, { reason: 'property-name-characters', omitted: key.length - 100 });
    if (isSensitiveKey(key)) { result[String(key).slice(0, 100)] = '[REDACTED:sensitive]'; continue; }
    result[String(key).slice(0, 100)] = safeValue(child, omissions, depth + 1);
  }
  return result;
}

function safeJson(value) {
  let text;
  const omissions = [];
  try { text = JSON.stringify(safeValue(value, omissions)); }
  catch { return '{"status":"incomplete","error":{"code":"RESULT_SERIALIZATION_FAILED"}}'; }
  if (text.length <= MAX_RESULT_CHARS && !omissions.length) return text;
  // This digest identifies ONLY the retained sanitized representation, not the
  // unavailable original. No clipped result may masquerade as complete evidence.
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  let preview = text.slice(0, MAX_RESULT_CHARS - 1500);
  const envelope = () => JSON.stringify({ status: 'incomplete', truncated: true,
    error: { code: 'TOOL_RESULT_TRUNCATED', message: 'Evidence omitted. Obtain a smaller targeted result before claiming the task is complete.' },
    omissions, sanitizedChars: text.length, sha256OfSanitizedRepresentation: hash, preview });
  if (text.length > preview.length) recordOmission(omissions, { reason: 'serialized-preview-characters', omitted: text.length - preview.length });
  let result = envelope();
  while (result.length > MAX_RESULT_CHARS && preview.length) {
    preview = preview.slice(0, Math.max(0, preview.length - (result.length - MAX_RESULT_CHARS) - 1));
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    const item = omissions.find(row => row.reason === 'serialized-preview-characters');
    if (item) item.omitted = text.length - preview.length;
    result = envelope();
  }
  return result;
}

function safePersistedMessages(messages) {
  return messages.map((message) => {
    const copy = structuredClone(message);
    if (typeof copy.content === 'string') {
      try { copy.content = safeJson(JSON.parse(copy.content)); }
      catch { copy.content = stripLocalPaths(copy.content); }
    }
    if (Array.isArray(copy.tool_calls)) {
      for (const call of copy.tool_calls) {
        if (typeof call?.function?.arguments === 'string') {
          try { call.function.arguments = safeJson(JSON.parse(call.function.arguments)); }
          catch { call.function.arguments = '{}'; }
        }
      }
    }
    return copy;
  });
}

function providerToolName(capabilityId) {
  return 'cap_' + String(capabilityId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function capabilityFromCall(call, known) {
  if (typeof call?.capabilityId === 'string' && call.capabilityId) return call.capabilityId;
  const name = String(call?.name ?? '');
  if (known.has(name)) return name;
  if (name.startsWith('cap_')) {
    const mapped = name.slice(4);
    for (const id of known) if (providerToolName(id) === name) return id;
    return mapped;
  }
  return name;
}

function errorResult(error) {
  const validation = schemaFailureDetail(error);
  return { error: { code: String(error?.code ?? 'CAPABILITY_DENIED').slice(0, 100), ...(validation ? { validation } : {}) } };
}

function terminalActivity(result, { id, capability, startedAt } = {}) {
  const code = result?.error?.code ?? '';
  return { id, capability,
    status: result?.status === 'completed' ? 'completed'
      : result?.status === 'outcome-unknown' ? 'outcome-unknown'
        : result?.status === 'cancelled' || code === 'INVOKE_CANCELLED' ? 'cancelled' : 'failed',
    summary: /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code + (result.error.validation ? ': ' + result.error.validation.path + ' ' + result.error.validation.reason : '') : '',
    durationMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null };
}

/** Only the live, audited Core descriptor may opt into read concurrency. */
export function isTrustedParallelRead(entry) {
  return Boolean(entry && ['filesystem.read', 'filesystem.search'].includes(entry.id)
    && entry.provider === 'workspace' && (entry.source === undefined || entry.source === 'workspace')
    && entry.readOnly === true && entry.parallelSafe === true && entry.effect === 'read-only'
    && entry.cancellationAware === true && entry.cancellationMode === 'cooperative' && entry.timeoutMode === 'await-settlement'
    && entry.risk === 'low' && entry.requiresApproval !== true && !entry.catalogOwner && !entry.delegatesOperation);
}

function configurationObservation(value) {
  const text = (item, maximum = 240) => typeof item === 'string' && item.length > 0 && item.length <= maximum
    && stripLocalPaths(item) === item ? item : null;
  if (value?.schemaVersion !== 1 || !text(value.requestId) || !text(value.providerId, 80)
    || value.application !== 'current-request' || !['serialized', 'response', 'aborted'].includes(value.stage)) return null;
  const selection = item => ({ model: text(item?.model), reasoning: ['off', 'low', 'high', 'max'].includes(item?.reasoning) ? item.reasoning : null });
  return { schemaVersion: 1, requestId: text(value.requestId), providerId: text(value.providerId, 80),
    connectionRevision: Number.isSafeInteger(value.connectionRevision) ? value.connectionRevision : null,
    requested: selection(value.requested), effective: selection(value.effective), response: { model: text(value.response?.model) },
    source: { model: text(value.source?.model, 60), reasoning: text(value.source?.reasoning, 60), effective: text(value.source?.effective, 60) },
    application: 'current-request', stage: value.stage, overrideReason: text(value.overrideReason, 100),
    at: Number.isFinite(value.at) ? value.at : null };
}

/** Runs a bounded Model ↔ Capability Broker loop for one logical turn. */
export function createToolExecutionCoordinator({
  modelRuntime,
  capabilityBroker,
  stateDir,
  finalSynthesisAtLimit = false,
  maxCycles = MAX_TOOL_CYCLES,
  maxCalls = MAX_TOTAL_CALLS,
  maxBatchCalls = MAX_BATCH_CALLS,
  timeoutMs = 300000,
  actorResolver = null,
  resolvePostWriteVerification = null,
  resolveHistoryContext = null,
  onMessagesCheckpoint = null,
  evidenceStore = null,
  onUsage = null
} = {}) {
  if (!modelRuntime?.chat || !capabilityBroker?.execute) throw new TypeError('Tool execution needs Model Runtime and Capability Broker');
  const continuationFile = typeof stateDir === 'string' && stateDir.trim()
    ? path.join(stateDir, 'model', 'tool-continuations.json') : null;
  const executionFile = typeof stateDir === 'string' && stateDir.trim()
    ? path.join(stateDir, 'model', 'tool-executions.json') : null;
  let executions = {};
  if (executionFile) {
    try { executions = readJsonFile(executionFile, { missing: {} }); }
    catch (error) {
      if (error instanceof StorageError) fail('TOOL_EXECUTION_STORE_CORRUPT', 'Unable to read Model tool execution state');
      throw error;
    }
  }
  if (!executions || typeof executions !== 'object' || Array.isArray(executions)) {
    fail('TOOL_EXECUTION_STORE_CORRUPT', 'Tool execution store is invalid');
  }
  const uncertainExecutions = () => Object.values(executions).filter(row =>
    row?.status === 'started' || row?.status === 'outcome-unknown');
  let continuations = {};
  if (continuationFile) {
    try { continuations = readJsonFile(continuationFile, { missing: {} }); }
    catch (error) {
      if (error instanceof StorageError) fail('TOOL_CONTINUATION_STORE_CORRUPT', 'Unable to read Model tool continuation state');
      throw error;
    }
  }
  if (!continuations || typeof continuations !== 'object' || Array.isArray(continuations)) {
    fail('TOOL_CONTINUATION_STORE_CORRUPT', 'Tool continuation store is invalid');
  }
  const activeTurns = new Set();
  // Trusted delegates can access only their currently accepted coordinator call.
  // This is process-local context, never authority supplied by a tool argument.
  const batchFrames = new Map();
  const historyFrames = new Map();
  let activeReads = 0;
  const waitingReads = [];
  const activeResumes = new Set();
  function readSlot(signal) {
    if (signal?.aborted) return Promise.reject(capabilityError('INVOKE_CANCELLED', 'Read admission was cancelled'));
    function release() {
      if (release.used) return;
      release.used = true;
      activeReads--;
      const next = waitingReads.shift();
      if (next) { activeReads++; next.signal?.removeEventListener('abort', next.abort); next.resolve(next.release); }
    }
    if (activeReads < 2) { activeReads++; return Promise.resolve(release); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, release, abort: null };
      entry.abort = () => { const index = waitingReads.indexOf(entry); if (index >= 0) waitingReads.splice(index, 1);
        reject(capabilityError('INVOKE_CANCELLED', 'Read admission was cancelled')); };
      waitingReads.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
    });
  }

  function save() {
    if (!continuationFile) return;
    try { writeJsonAtomic(continuationFile, continuations); }
    catch (error) {
      if (error instanceof StorageError) fail('TOOL_CONTINUATION_PERSIST_FAILED', 'Unable to persist Model tool continuation state');
      throw error;
    }
  }

  let orphanedOnRestart = false;
  for (const [approvalId, continuation] of Object.entries(continuations)) {
    if (continuation?.status === 'reconciled') continue;
    let approval;
    try { approval = capabilityBroker.approvals?.get(approvalId); }
    catch (error) {
      // A stale continuation may outlive approval retention; it is still unsafe to resume.
      if (error?.code !== 'APPROVAL_NOT_FOUND') throw error;
    }
    // Agent turns are process-local. Chat continuations remain resumable only
    // while their original approval is still pending and unexpired.
    if (continuation?.targetKind !== 'agent' && !continuation?.state?.pendingBatch?.quotaInFlight && approval?.status === 'pending'
      && approval.expiresAt > Date.now()) continue;
    if (approval?.status === 'pending' || approval?.status === 'approved') {
      capabilityBroker.approvals.revoke(approvalId, continuation?.state?.pendingBatch?.quotaInFlight
        ? 'core-restart-interrupted-batch-quota' : 'core-restart-orphaned-agent');
    }
    continuation.status = 'orphaned';
    orphanedOnRestart = true;
  }
  if (orphanedOnRestart) save();

  // A failed model-journal write followed by stop may remove its continuation.
  // Recover uncertainty from the already durable Broker intent/outcome instead
  // of interpreting an old approval-pending projection as proof of no effect.
  for (const [id, row] of Object.entries(executions)) {
    if (!row?.approvalId || !(row.status === 'approval-pending'
      || row.status === 'failed' && row.code === 'INVOKE_CANCELLED')) continue;
    let dispatch = capabilityBroker.dispatchStatus?.(id);
    if (!dispatch) {
      let approval;
      try { approval = capabilityBroker.approvals?.get(row.approvalId); }
      catch (error) { if (error?.code === 'APPROVAL_NOT_FOUND') continue; throw error; }
      dispatch = capabilityBroker.dispatchStatus?.(approval?.request?.requestId);
    }
    if (dispatch && ['started', 'outcome-unknown', 'completed'].includes(dispatch.status)) {
      recordExecution(id, { status: 'outcome-unknown', code: 'APPROVAL_DISPATCH_RECOVERY_REQUIRED', observedDispatchStatus: dispatch.status });
    }
  }

  function recordExecution(requestId, data) {
    executions[requestId] = { ...executions[requestId], ...data };
    if (!executionFile) return;
    try { writeJsonAtomic(executionFile, executions); }
    catch (error) {
      if (error instanceof StorageError) fail('TOOL_EXECUTION_PERSIST_FAILED', 'Unable to persist Model tool execution state');
      throw error;
    }
  }

  async function historyContext(state, purpose, signal) {
    if (typeof resolveHistoryContext !== 'function' || !state.manifest.some(row => row.id === 'context.history.read' && row.available !== false)) return null;
    const descriptor = capabilityBroker.registry?.require('context.history.read');
    if (!descriptor || descriptor.provider !== 'context' || descriptor.readOnly !== true || descriptor.effect !== 'read-only'
      || descriptor.risk !== 'low' || descriptor.requiresApproval || descriptor.catalogOwner) fail('CONTEXT_HISTORY_DENIED', 'Current Core history descriptor required');
    const actor = typeof actorResolver === 'function' ? await actorResolver({ actorKind: state.actor.kind, actorId: state.actor.id,
      sessionId: state.sessionId, turnId: state.turnId, scope: state.scope }) : state.actor;
    if (!actor || actor.kind !== state.actor.kind || actor.id !== state.actor.id
      || actor.kind === 'agent' && !actor.grants?.capabilities?.includes('context.history.read')) fail('CONTEXT_HISTORY_DENIED', 'Current history principal required');
    const binding = evidenceBinding(state);
    const resolved = await resolveHistoryContext({ purpose, actorKind: actor.kind, actorId: actor.id,
      sessionId: state.sessionId, turnId: state.turnId, runId: state.runId, targetKind: state.targetKind, scope: { ...state.scope }, signal });
    // Optional source availability is not a new admission gate for ordinary
    // short requests. Without authorization no omission/retrieval is enabled;
    // the original complete byte/model guards remain authoritative.
    if (purpose === 'projection' && (!resolved || resolved.authorized !== true)) return null;
    if (!resolved || resolved.authorized !== true || !(Number.isSafeInteger(resolved.revision) && resolved.revision >= 0
      || typeof resolved.revision === 'string' && resolved.revision.length > 0 && resolved.revision.length <= 160)
      || binding.taskId !== null && resolved.task?.id !== binding.taskId
      || JSON.stringify(binding) !== JSON.stringify(evidenceBinding(state))) fail('CONTEXT_HISTORY_DENIED', 'Current authorized history owner/revision required');
    if (signal?.aborted) fail('INVOKE_CANCELLED', 'History access cancelled');
    return { ...resolved, actor, binding, descriptor };
  }

  async function acquireHistorySource(state, context, purpose, signal) {
    // Read only after the caller has checked the expected authority revision.
    // This snapshot belongs to one invocation, never stored or reused as a grant.
    let sourceMessages = state.messages, sourceError = null;
    try { if (typeof context.resolveMessages === 'function') sourceMessages = await context.resolveMessages(); }
    catch (error) { if (purpose !== 'projection') throw error; sourceMessages = null; sourceError = error; }
    if (signal?.aborted) fail('INVOKE_CANCELLED', 'History access cancelled');
    return { ...context, sourceMessages, sourceError };
  }

  function sourcePage(state, context, input) {
    return readHistorySource({ ...input, sourceBinding: context.binding,
      resolveMessages: () => { if (context.sourceError) throw context.sourceError; return context.sourceMessages; },
      authorizeSource: () => context.authorized === true });
  }

  // This delegate is called only by the existing Broker's Core capability.
  // A copied model origin/actor/input cannot create the process-local frame.
  async function readHistory(request) {
    const accepted = historyFrames.get(request?.requestId);
    if (!accepted || accepted.entered || request.capability !== 'context.history.read'
      || request.actor?.kind !== accepted.actor.kind || request.actor.id !== accepted.actor.id
      || request.taskId !== (accepted.frame.scope.taskId ?? null) || request.workspaceId !== (accepted.frame.scope.workspaceId ?? null)
      || request.origin?.sessionId !== accepted.state.sessionId || request.origin?.turnId !== accepted.state.turnId
      || (request.origin?.runId ?? null) !== (accepted.state.runId ?? null) || (request.origin?.phase ?? null) !== (accepted.state.phase ?? null)
      || request.origin?.targetKind !== accepted.state.targetKind
      || JSON.stringify(request.input) !== JSON.stringify(accepted.frame.input)) fail('CONTEXT_HISTORY_DENIED', 'History requires its exact currently accepted Broker call');
    accepted.entered = true;
    const current = await historyContext(accepted.state, 'read', accepted.signal);
    if (!current || current.revision !== accepted.state.historyRevision
      || JSON.stringify(current.actor) !== JSON.stringify(accepted.actor)) fail('CONTEXT_SYNOPSIS_STALE', 'History authority changed; rebuild the current request');
    // Leave room for JSON escaping and source metadata in the existing bounded
    // tool-result envelope. maxChars is an upper bound, not an exact page size.
    const input = { ...request.input, maxChars: Math.min(request.input.maxChars ?? 4000, 4000) };
    const page = sourcePage(accepted.state, await acquireHistorySource(accepted.state, current, 'read', accepted.signal), input);
    const final = await historyContext(accepted.state, 'read', accepted.signal);
    if (!final || final.revision !== current.revision || final.descriptor !== current.descriptor
      || JSON.stringify(final.actor) !== JSON.stringify(current.actor)) fail('CONTEXT_SYNOPSIS_STALE', 'History authorization changed during retrieval');
    const verified = sourcePage(accepted.state, await acquireHistorySource(accepted.state, final, 'read', accepted.signal), input);
    if (verified.sourceFingerprint !== page.sourceFingerprint || verified.publicSha256 !== page.publicSha256 || verified.content !== page.content) fail('CONTEXT_SYNOPSIS_STALE', 'History source changed during retrieval');
    return verified;
  }

  async function messagesCheckpoint(state, phase) {
    if (typeof onMessagesCheckpoint !== 'function') return;
    const current = state.messages.slice(state.messages.findLastIndex(message => message.role === 'user') + 1);
    const settled = new Set(current.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    const pending = current.flatMap(message => message.tool_calls ?? []).map(call => call.id).filter(id => !settled.has(id));
    const binding = evidenceBinding(state);
    try {
      await onMessagesCheckpoint({ binding, turnId: state.turnId, runId: state.runId, targetKind: state.targetKind,
        phase, revision: state.historyRevision ?? null, sourceFingerprint: fingerprintHistorySource({ messages: state.messages, sourceBinding: binding }),
        messages: structuredClone(state.messages), synopsis: phase === 'request-projection' && state.contextSynopsis ? structuredClone(state.contextSynopsis) : null,
        settledCallIds: [...settled], pendingCallIds: pending });
    } catch { fail('CONTEXT_HISTORY_CHECKPOINT_PERSIST_FAILED', 'Original settled receipts are retained; restore checkpoint storage before continuing through verified fresh-session recovery'); }
  }

  function recoveryForSession(sessionId) {
    const uncertain = uncertainExecutions().find(row => row.sessionId === sessionId);
    if (uncertain) return { state: 'needs-reconciliation', capability: uncertain.capability, turnId: uncertain.turnId };
    const orphaned = Object.values(continuations).find(row => (row.status === 'orphaned'
      || (row.status === 'resuming' || row.state?.pendingBatch?.quotaInFlight) && !activeResumes.has(row.approvalId)) && row.target?.sessionId === sessionId);
    if (orphaned) return { state: 'needs-reconciliation', capability: 'approval', turnId: orphaned.target.turnId };
    const pending = Object.values(continuations).find(row => row.status !== 'reconciled' && row.target?.sessionId === sessionId);
    return pending ? { state: 'approval-pending', approvalId: pending.approvalId, turnId: pending.target.turnId } : null;
  }

  function recoveryForTask(taskId) {
    const uncertain = uncertainExecutions().find(row => row.taskId === taskId);
    if (uncertain) return { state: 'needs-reconciliation', capability: uncertain.capability, turnId: uncertain.turnId };
    const orphaned = Object.values(continuations).find(row => (row.status === 'orphaned'
      || (row.status === 'resuming' || row.state?.pendingBatch?.quotaInFlight) && !activeResumes.has(row.approvalId)) && row.state?.scope?.taskId === taskId);
    if (orphaned) return { state: 'needs-reconciliation', capability: 'approval', turnId: orphaned.target.turnId };
    const pending = Object.values(continuations).find(row => row.status !== 'reconciled' && row.state?.scope?.taskId === taskId);
    return pending ? { state: 'approval-pending', approvalId: pending.approvalId, turnId: pending.target.turnId } : null;
  }

  function acknowledgeTaskRecovery(taskId) {
    const rows = uncertainExecutions().filter(row => row.taskId === taskId);
    const previousStatuses = rows.map(row => row.status);
    const orphaned = Object.values(continuations).filter(row => (row.status === 'orphaned'
      || (row.status === 'resuming' || row.state?.pendingBatch?.quotaInFlight) && !activeResumes.has(row.approvalId)) && row.state?.scope?.taskId === taskId);
    const previousContinuationStatuses = orphaned.map(row => row.status);
    for (const row of rows) row.status = 'reconciled';
    for (const row of orphaned) row.status = 'reconciled';
    if (rows.length && executionFile) {
      try { writeJsonAtomic(executionFile, executions); }
      catch (error) {
        rows.forEach((row, index) => { row.status = previousStatuses[index]; });
        orphaned.forEach((row, index) => { row.status = previousContinuationStatuses[index]; });
        if (error instanceof StorageError) fail('TOOL_EXECUTION_PERSIST_FAILED', 'Unable to persist Model tool reconciliation');
        throw error;
      }
    }
    if (orphaned.length) {
      try { save(); }
      catch (error) {
        orphaned.forEach((row, index) => { row.status = previousContinuationStatuses[index]; });
        throw error;
      }
    }
    return { reconciled: rows.length + orphaned.length };
  }

  function completedResultContent(result, state, capability, input) {
    const finish = content => {
      if (!result.postWriteVerification) return content;
      const value = JSON.parse(content);
      value.postWriteVerification = JSON.parse(safeJson(result.postWriteVerification));
      let output = JSON.stringify(value);
      while (output.length > MAX_RESULT_CHARS && typeof value.preview === 'string' && value.preview.length) {
        const previous = value.preview.length;
        value.preview = value.preview.slice(0, Math.max(0, previous - (output.length - MAX_RESULT_CHARS) - 8));
        if (/[\uD800-\uDBFF]$/.test(value.preview)) value.preview = value.preview.slice(0, -1);
        const omission = value.omissions?.find(row => row.reason === 'serialized-preview-characters');
        if (omission) omission.omitted += previous - value.preview.length;
        output = JSON.stringify(value);
      }
      return output.length <= MAX_RESULT_CHARS ? output : safeJson({ status: 'incomplete', truncated: true,
        error: { code: 'TOOL_RESULT_TRUNCATED' }, postWriteVerification: value.postWriteVerification });
    };
    const value = { status: 'completed', result: result.result,
      ...(result.postWriteVerification ? { postWriteVerification: result.postWriteVerification } : {}) };
    if (capability === 'context.history.read' && result.result?.representation === 'retained-history-page'
      && result.result.referenceOnly === true && typeof result.result.content === 'string' && result.result.content.length <= 4000) {
      // The admitted Core delegate already excluded private protocol/arguments
      // and sanitized tool observations. Public Owner source text must remain
      // exact, including its JSON escaping and source-page hash/offsets.
      const content = JSON.stringify(value);
      if (content.length <= MAX_RESULT_CHARS) return content;
    }
    if (capability === 'context.batch') {
      const content = sanitizeToolEvidence(value);
      if (content.length <= MAX_RESULT_CHARS) return content;
    }
    if (evidenceStore && EVIDENCE_SOURCE_CAPABILITIES.includes(capability) && input
      && state.manifest.some(item => item.id === 'context.evidence.read' && item.available !== false)) {
      try {
        const content = sanitizeToolEvidence(value);
        if (content.length > MAX_RESULT_CHARS) {
          const reference = evidenceStore.put({ binding: evidenceBinding(state), content,
            sourceCapability: capability, sourceInput: input });
          return finish(evidenceSummary(content, reference));
        }
      } catch { return finish(safeJson({ ...value, evidenceUnavailable: { code: 'TOOL_EVIDENCE_UNAVAILABLE', note: 'No stored source is available; request a smaller result.' } })); }
    }
    return finish(safeJson(value));
  }

  function callFrame(state, call, cycle, index, source = null) {
    const capability = source?.capability ?? capabilityFromCall(call, new Set(state.manifest.map(item => item.id)));
    const callId = source ? `${source.parentCallId}/${source.batchStepId}/${source.itemIndex}`
      : String(call?.id || `call-${cycle}-${index}`).slice(0, 200);
    const requestId = 'model:' + crypto.createHash('sha256').update(JSON.stringify(source
      ? [source.parentRequestId, source.batchStepId, source.itemIndex]
      : [state.sessionId, state.turnId, cycle, index])).digest('hex');
    return { call, callId, capability, cycle, originalIndex: index, requestId,
      activityId: source ? `${state.turnId.slice(0, 100)}:batch:${requestId.slice(6)}`
        : `${state.turnId}:${callId}`.slice(0, 200), startedAt: Date.now(), scope: { ...state.scope },
      ...(source ? { input: source.input, parentRequestId: source.parentRequestId,
        batchStepId: source.batchStepId, itemIndex: source.itemIndex, internal: true } : {}) };
  }

  function eligibleCall(state, call) {
    try {
      const capability = capabilityFromCall(call, new Set(state.manifest.map(item => item.id)));
      const descriptor = state.manifest.find(item => item.id === capability);
      if (!descriptor || !isTrustedParallelRead(capabilityBroker.registry?.require(capability))) return false;
      validateSchema(descriptor.inputSchema, parseArguments(call?.arguments));
      return true;
    } catch { return false; }
  }

  function executionIdentity(state, frame) {
    return { sessionId: state.sessionId, turnId: state.turnId, taskId: frame.scope.taskId ?? null,
      workspaceId: frame.scope.workspaceId ?? null, runId: state.runId ?? null,
      actorKind: state.actor.kind, actorId: state.actor.id, capability: frame.capability,
      cycle: frame.cycle, originalIndex: frame.originalIndex, queuedAt: frame.startedAt,
      startedAt: executions[frame.requestId]?.startedAt ?? frame.startedAt, at: frame.startedAt,
      ...(frame.internal ? { parentRequestId: frame.parentRequestId, batchStepId: frame.batchStepId, itemIndex: frame.itemIndex } : {}) };
  }

  function persistSettlement(state, frame, result) {
    if (frame.postWriteVerification) result = { ...result,
      postWriteVerification: postWriteVerificationFeedback(frame.postWriteVerification, result,
        'tool:' + crypto.createHash('sha256').update(frame.requestId).digest('hex')) };
    const settledAt = Date.now();
    let evidence = null;
    if (frame.internal && evidenceStore) {
      // Keep all accepted source bodies/errors in the existing evidence store,
      // including short results that the final batch intentionally does not echo.
      const content = sanitizeToolEvidence(result);
      evidence = evidenceStore.put({ binding: evidenceBinding({ ...state, scope: frame.scope }), content,
        sourceCapability: frame.capability, sourceInput: frame.input });
    }
    const content = result?.status === 'completed'
      ? frame.internal ? safeJson({ status: 'completed', evidence }) : completedResultContent(result, state, frame.capability, frame.input)
      : safeJson(frame.postWriteVerification || result?.status === 'outcome-unknown' ? result : result?.error ?? result ?? { status: 'denied', code: 'CAPABILITY_DENIED' });
    const status = result?.status === 'pending' ? 'approval-pending' : result?.status === 'outcome-unknown'
      ? 'outcome-unknown' : result?.status === 'completed' ? 'completed' : 'failed';
    recordExecution(frame.requestId, { ...executionIdentity(state, frame), status, settledAt, content,
      resultSha256: evidence?.sha256 ?? crypto.createHash('sha256').update(content).digest('hex'),
      resultRepresentation: evidence ? 'stored-sanitized-evidence' : 'bounded-sanitized-content',
      ...(evidence ? { evidence } : {}), ...(result?.status === 'pending' ? { approvalId: result.approvalId } : {}),
      ...(result?.error?.code ? { code: result.error.code } : {}),
      ...(frame.postWriteVerification ? { postWriteVerification: structuredClone(frame.postWriteVerification) } : {}) });
    return { ...frame, result, content, settledAt, ...(evidence ? { evidence } : {}) };
  }

  function retainedSettlement(row) {
    // A durable continuation contains only sanitized source results. Full short
    // model messages and evidence refs remain attributable to the original call.
    const { call, consumeReadBytes, ...copy } = row;
    return { ...copy, result: JSON.parse(sanitizeToolEvidence(row.result)), input: row.input ? structuredClone(row.input) : null };
  }

  function retainedBatchCheckpoint(batch) {
    return { ...batch, plan: structuredClone(batch.plan),
      values: JSON.parse(sanitizeToolEvidence(batch.values)),
      current: batch.current ? { ...batch.current, inputs: structuredClone(batch.current.inputs),
        rows: JSON.parse(sanitizeToolEvidence(batch.current.rows)),
        pending: batch.current.pending ? retainedSettlement(batch.current.pending) : null,
        held: batch.current.held.map(retainedSettlement) } : null };
  }

  async function notifyActivity(state, activity) {
    if (typeof state.onActivity !== 'function') return;
    try { await state.onActivity(activity); }
    catch (error) {
      const failure = error && typeof error === 'object' ? error
        : capabilityError('TOOL_OBSERVER_FAILED', 'Tool activity observer interrupted the turn');
      failure.coordinatorObserverFailure = true;
      throw failure;
    }
  }

  async function dispatchPreparedCall(state, frame, signal) {
    const { capability, activityId, startedAt, scope } = frame;
    await notifyActivity(state, { id: activityId, capability, status: 'running', durationMs: null });
    let result, registered;
    let toolRequestId = frame.requestId;
    let retryCount = 0;
    const accepted = [];
    const actualOutcomes = new Map();
    let releaseRead = null;
    try {
      frame.input ??= parseArguments(frame.call?.arguments);
      // This one server-owned call still passes the same live Broker policy.
      // It cannot acquire test.run from saved configuration or a model argument.
      const descriptor = frame.postWriteVerification ? capabilityBroker.registry?.require('test.run')
        : state.manifest.find(item => item.id === capability);
      if (!descriptor) fail('UNKNOWN_TOOL_IN_TURN', 'Tool was not authorized in this turn');
      registered = capabilityBroker.registry?.require(capability) ?? descriptor;
      validateSchema(descriptor.inputSchema, frame.input);
      if (isTrustedParallelRead(registered)) releaseRead = await readSlot(signal);
      const hasEffect = (registered.effect && registered.effect !== 'read-only')
        || ['message.send', 'filesystem.write', 'git.commit', 'test.run', 'publish', 'network'].includes(registered.permission ?? capability);
      const retryStartedAt = Date.now();
      let retryError = null;
      for (let attempt = 0; attempt < SAFE_TOOL_RETRY.maxAttempts; attempt++) {
        if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
        if (attempt && Date.now() - retryStartedAt >= SAFE_TOOL_RETRY.deadlineMs) throw retryError;
        toolRequestId = attempt ? `${frame.requestId}:r${attempt}` : frame.requestId;
        const liveActor = typeof actorResolver === 'function'
          ? await actorResolver({ actorKind: state.actor.kind, actorId: state.actor.id,
            sessionId: state.sessionId, turnId: state.turnId, scope }) : state.actor;
        if (!liveActor || liveActor.kind !== state.actor.kind || liveActor.id !== state.actor.id) fail('TOOL_ACTOR_UNAVAILABLE', 'The trusted CetaMesh actor is no longer available');
        if (attempt && Date.now() - retryStartedAt >= SAFE_TOOL_RETRY.deadlineMs) throw retryError;
        recordExecution(toolRequestId, { ...executionIdentity(state, frame), startedAt: Date.now(), status: 'started' });
        try {
          const executeBroker = attemptSignal => {
            if (capability === 'context.batch') batchFrames.set(toolRequestId, { state, frame, signal: attemptSignal, actor: liveActor });
            if (capability === 'context.history.read') historyFrames.set(toolRequestId, { state, frame, signal: attemptSignal, actor: liveActor, entered: false });
            const promise = Promise.resolve().then(() => capabilityBroker.execute({ requestId: toolRequestId, actor: liveActor,
              ...(hasEffect && !registered.delegatesOperation && scope.taskId && scope.workspaceId
                ? { operationId: 'tool:' + crypto.createHash('sha256').update(frame.requestId).digest('hex') } : {}),
              taskId: scope.taskId ?? null, workspaceId: scope.workspaceId ?? null,
              capability, input: frame.input, reason: frame.postWriteVerification ? 'Owner-configured fresh post-write verification' : 'Model structured tool call',
              origin: { sessionId: state.sessionId, turnId: state.turnId, runId: state.runId, phase: state.phase, targetKind: state.targetKind,
                ...(frame.postWriteVerification ? { postWriteVerification: structuredClone(frame.postWriteVerification) } : {}),
                ...(frame.internal ? { readBatch: { parentRequestId: frame.parentRequestId, stepId: frame.batchStepId, itemIndex: frame.itemIndex } } : {}) },
              ...(attemptSignal ? { signal: attemptSignal } : {}) }, { signal: attemptSignal,
                ...(typeof frame.consumeReadBytes === 'function' ? { consumeReadBytes: frame.consumeReadBytes } : {}) }));
            accepted.push(promise);
            if (capability === 'context.history.read') {
              const acceptedHistoryId = toolRequestId;
              promise.then(() => historyFrames.delete(acceptedHistoryId), () => historyFrames.delete(acceptedHistoryId));
            }
            // Late completion is an observation, never permission to erase an
            // unknown receipt or retry an accepted operation.
            const acceptedId = toolRequestId;
            promise.then(value => {
              actualOutcomes.set(acceptedId, { status: value?.status ?? 'completed', at: Date.now(),
                sha256OfSanitizedRepresentation: crypto.createHash('sha256').update(safeJson(value)).digest('hex') });
              if (executions[acceptedId]?.status === 'outcome-unknown') {
                try { recordExecution(acceptedId, { lateSettlement: { status: value?.status ?? 'completed', at: Date.now(),
                  sha256: crypto.createHash('sha256').update(sanitizeToolEvidence(value)).digest('hex') } }); } catch { /* Original uncertainty remains fenced. */ }
              }
            }, error => {
              actualOutcomes.set(acceptedId, { status: 'failed', code: error?.code ?? 'PROVIDER_ERROR', at: Date.now() });
              if (executions[acceptedId]?.status === 'outcome-unknown') {
                try { recordExecution(acceptedId, { lateSettlement: { status: 'failed', code: error?.code ?? 'PROVIDER_ERROR', at: Date.now() } }); } catch { /* Keep the original fence. */ }
              }
            }).finally(() => { if (capability === 'context.batch') batchFrames.delete(acceptedId); });
            return promise;
          };
          result = attempt ? await runBoundedRetryAttempt(executeBroker, { signal,
            remainingMs: SAFE_TOOL_RETRY.deadlineMs - (Date.now() - retryStartedAt) }) : await executeBroker(signal);
          break;
        } catch (error) {
          if (!mayRetrySafeTool({ capability, error, attempt, startedAt: retryStartedAt, signal,
            dispatchStatus: capabilityBroker.dispatchStatus?.(toolRequestId) })) throw error;
          retryError = error;
          recordExecution(toolRequestId, { status: 'failed', code: String(error.code).slice(0, 100), settledAt: Date.now() });
          retryCount = attempt + 1;
          await notifyActivity(state, { id: activityId, capability, status: 'retrying', retryCount, durationMs: Date.now() - startedAt });
          await delay(SAFE_TOOL_RETRY.delayMs, undefined, { signal });
        }
      }
    } catch (error) {
      if (error?.coordinatorObserverFailure || ['TOOL_EXECUTION_PERSIST_FAILED', 'TOOL_EVIDENCE_PERSIST_FAILED',
        'TOOL_CONTINUATION_PERSIST_FAILED'].includes(error?.code)) throw error;
      result = { status: error?.effectStatus === 'unknown' || error?.code === 'INVOKE_CANCEL_UNCONFIRMED' ? 'outcome-unknown' : 'denied', ...errorResult(error) };
    } finally {
      // The retry wrapper can time out before its accepted Broker promise. Core
      // cooperative IO must actually close its handle before this group ends.
      if (isTrustedParallelRead(registered)) await Promise.allSettled(accepted);
      releaseRead?.();
    }
    if (result && typeof result === 'object') result = { ...result, retryCount };
    const settled = persistSettlement(state, { ...frame, requestId: toolRequestId }, result);
    if (result?.status === 'outcome-unknown' && isTrustedParallelRead(registered) && actualOutcomes.has(toolRequestId)) {
      recordExecution(toolRequestId, { drainedSettlement: actualOutcomes.get(toolRequestId) });
    }
    if (toolRequestId !== frame.requestId && executions[frame.requestId]?.status === 'failed') {
      recordExecution(frame.requestId, { finalRequestId: toolRequestId });
    }
    return settled;
  }

  async function dispatchGroup(state, frames, signal) {
    const receipts = await Promise.allSettled(frames.map(frame => dispatchPreparedCall(state, frame, signal)));
    const rejected = receipts.find(row => row.status === 'rejected');
    if (rejected) {
      cancelPendingRows(state, receipts.filter(row => row.status === 'fulfilled').map(row => row.value),
        'group-dispatch-failed', { code: 'TOOL_GROUP_INTERRUPTED' });
      throw rejected.reason;
    }
    return receipts.map(row => row.value);
  }

  async function finalizeSettledCall(state, row, { appendMessage = true } = {}) {
    if (appendMessage && !row.serverVerification) state.messages.push({ role: 'tool', tool_call_id: row.callId, content: row.content });
    try {
      if (typeof state.onActivity === 'function') await state.onActivity(terminalActivity(row.result,
        { id: row.activityId, capability: row.capability, startedAt: row.startedAt }));
      if (typeof state.onCapabilityResult === 'function') await state.onCapabilityResult({ capability: row.capability,
        result: row.result, input: row.input, eventId: row.activityId, sessionId: state.sessionId, turnId: state.turnId, scope: row.scope });
      if (typeof state.refreshContext === 'function') {
        const refreshed = await state.refreshContext({ capability: row.capability, result: row.result,
          sessionId: state.sessionId, turnId: state.turnId, scope: row.scope });
        if (refreshed && typeof refreshed === 'object') {
          if (Array.isArray(refreshed.manifest)) state.manifest = refreshed.manifest;
          if (refreshed.scope && typeof refreshed.scope === 'object') state.scope = {
            taskId: refreshed.scope.taskId ?? null, workspaceId: refreshed.scope.workspaceId ?? null };
          if (typeof refreshed.context === 'string' && refreshed.context.trim()) {
            const marker = 'CetaMesh dynamic context (JSON reference data):\n';
            const existing = state.messages.findIndex(message => message.role === 'system' && String(message.content ?? '').startsWith(marker));
            const message = { role: 'system', content: marker + refreshed.context };
            if (existing >= 0) state.messages[existing] = message;
            else state.messages.splice(Math.min(2, state.messages.length), 0, message);
          }
        }
      }
      rememberPostWriteSettlement(state, row);
    } catch (error) { if (error && typeof error === 'object') error.coordinatorObserverFailure = true; throw error; }
  }

  function postWriteState(state) {
    return state.postWriteState ??= { writes: [], postimages: [], checks: [], pairs: [], facts: [] };
  }

  function rememberPostWriteSettlement(state, row) {
    if (typeof resolvePostWriteVerification !== 'function') return;
    const current = postWriteState(state);
    if (row.postWriteVerification) {
      const check = current.checks.find(item => item.requestId === row.requestId);
      if (check) check.state = row.result.postWriteVerification?.state ?? 'unknown';
      if (row.serverVerification) current.pairs.push({ callId: row.callId, input: row.input, content: row.content });
    } else if (row.capability === 'filesystem.write' && row.result?.status === 'completed') {
      const operationId = 'tool:' + crypto.createHash('sha256').update(row.requestId).digest('hex');
      const proof = capabilityBroker.operationRecordForTask?.({ taskId: row.scope.taskId,
        workspaceId: row.scope.workspaceId, operationId });
      const receipt = { eventId: row.activityId, requestId: row.requestId,
        path: typeof row.input?.path === 'string' ? row.input.path : '',
        sha256: proof?.status === 'completed' && proof.capability === 'filesystem.write'
          && proof.accessInput?.path === row.input?.path ? proof.operationProof?.sha256 ?? null : null };
      current.writes.push(receipt);
      const key = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replaceAll('\\', '/');
      current.postimages = [...(current.postimages ?? []).filter(prior => key(prior.path) !== key(receipt.path)), receipt];
    }
  }

  function flushPostWritePairs(state) {
    const current = state.postWriteState;
    if (!current) return;
    // Do not place another assistant message inside the model's original batch.
    for (const row of current.pairs.splice(0)) state.messages.push({ role: 'assistant', content: null,
      tool_calls: [{ id: row.callId, type: 'function', function: { name: providerToolName('test.run'), arguments: JSON.stringify(row.input) } }] },
    { role: 'tool', tool_call_id: row.callId, content: row.content });
    for (const fact of current.facts.splice(0)) state.messages.push({ role: 'system',
      content: 'CetaMesh post-write verification feedback (JSON reference data):\n' + safeJson(fact) });
  }

  async function postWriteBarrier(state, calls, cycle, nextIndex, signal, context) {
    const current = state.postWriteState;
    if (!current?.writes.length) return null;
    const writes = current.writes.splice(0);
    let config;
    try { config = await resolvePostWriteVerification({ actor: state.actor, sessionId: state.sessionId,
      scope: { ...state.scope }, signal }); }
    catch (error) {
      current.facts.push({ kind: 'post-write-verification', state: 'not-run',
        code: String(error?.code ?? 'POST_WRITE_CONFIG_UNAVAILABLE').slice(0, 100),
        sourceWriteIds: writes.map(row => row.eventId), configDigest: null, operationRef: null });
      return null;
    }
    if (config?.enabled === true && config.maxRunsPerTurn > 0
      && writes.some(row => config.includeExtensions.some(ext => row.path.toLowerCase().endsWith(ext)))
      && (state.actor.kind !== 'agent' || !state.scope.taskId || !state.runId || state.phase !== 'user')) {
      current.facts.push({ kind: 'post-write-verification', state: 'not-run', code: 'POST_WRITE_TASK_REQUIRED',
        sourceWriteIds: writes.map(row => row.eventId), configDigest: config.configDigest, operationRef: null });
      return null;
    }
    const plan = planPostWriteVerification({ config, writeReceipts: writes, knownWriteReceipts: current.postimages ?? writes, priorChecks: current.checks,
      remainingCalls: maxCalls - state.callBudget.used });
    if (plan.state === 'not-run') { current.facts.push(plan); return null; }
    // An adjacent explicit model test may use the same fresh proof and its own
    // normal call/approval, rather than introducing a duplicate execution.
    const next = calls[nextIndex];
    let explicit = false;
    try {
      const input = capabilityFromCall(next, new Set(state.manifest.map(item => item.id))) === 'test.run' ? parseArguments(next?.arguments) : null;
      explicit = input?.tool === plan.input.tool && input.timeoutMs === plan.input.timeoutMs
        && JSON.stringify(input.args) === JSON.stringify(plan.input.args)
        && nextIndex < maxBatchCalls && cycle < maxCycles;
    } catch { /* Invalid input retains the ordinary refusal. */ }
    if (explicit) {
      current.explicit = { cycle, index: nextIndex, binding: plan.binding };
      return null;
    }
    const ordinal = current.checks.length;
    const requestId = 'post-write:' + crypto.createHash('sha256').update(JSON.stringify([state.sessionId, state.turnId, ordinal])).digest('hex');
    const callId = 'cetamesh-verification-' + requestId.slice(11, 51);
    const frame = { capability: 'test.run', callId, requestId, cycle, originalIndex: null,
      activityId: `${state.turnId}:${callId}`.slice(0, 200), startedAt: Date.now(), scope: { ...state.scope },
      input: plan.input, postWriteVerification: plan.binding, serverVerification: true };
    current.checks.push({ requestId, state: 'requested', writes: structuredClone(plan.binding.writes) });
    state.callBudget.used += 1;
    const row = await dispatchPreparedCall(state, frame, signal);
    if (signal?.aborted) {
      const rows = [row]; cancelPendingRows(state, rows, 'turn-cancelled');
      await finalizeSettledCall(state, rows[0]);
      fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
    }
    if (row.result?.status === 'pending') return suspendGroup(state, calls, cycle, [row], 0, nextIndex, context);
    await finalizeSettledCall(state, row);
    if (row.result?.status === 'outcome-unknown') return { status: 'partial', code: 'OUTCOME_UNKNOWN', toolCalling: 'supported',
      text: '', usage: context.usage, resolvedModel: context.resolvedModel, totalCalls: state.callBudget.used,
      postWriteVerification: row.result.postWriteVerification };
    return null;
  }

  function reserveSourceCalls(state, count) {
    if (!state.callBudget || state.callBudget.used + count > maxCalls) fail('TOOL_CALL_LIMIT', 'Read batch shares the remaining turn call budget');
    state.callBudget.used += count;
  }

  function cancelPendingRows(state, rows, reason, { start = 0, code = 'INVOKE_CANCELLED' } = {}) {
    for (let index = start; index < rows.length; index++) {
      const row = rows[index];
      if (row.result?.status !== 'pending') continue;
      const approvalId = row.result.approvalId;
      let cancelled = false;
      try {
        const approval = capabilityBroker.approvals?.get(approvalId);
        if (approval?.status === 'pending') capabilityBroker.approvals.cancel(approvalId, reason);
        cancelled = capabilityBroker.approvals?.get(approvalId)?.status === 'cancelled';
      } catch { /* Unknown approval persistence/status must retain its fence. */ }
      const result = cancelled ? { status: 'cancelled', error: { code } }
        : { status: 'outcome-unknown', error: { code: 'PARALLEL_APPROVAL_CHANGED' } };
      const inner = row.result.batchContinuation?.current?.pending;
      if (inner?.result?.approvalId === approvalId) persistSettlement(state, inner, result);
      rows[index] = persistSettlement(state, row, result);
      for (const [id, execution] of Object.entries(executions)) {
        if (execution.approvalId === approvalId && execution.status === 'approval-pending') {
          recordExecution(id, { status: cancelled ? 'failed' : 'outcome-unknown', settledAt: Date.now(),
            content: safeJson(result), code: result.error.code });
        }
      }
    }
  }

  async function retainPendingSiblings(state, rows) {
    const first = rows.findIndex(row => row.result?.status === 'pending');
    cancelPendingRows(state, rows, 'parallel-sibling-approval', { start: first + 1, code: 'PARALLEL_APPROVAL_CANCELLED' });
    return first;
  }

  function consumeBatchBytes(frame, batch, bytes) {
    if (!Number.isSafeInteger(batch.readBytes) || batch.readBytes < 0 || batch.readBytes > READ_BATCH_LIMITS.totalReadBytes) {
      fail('BATCH_QUOTA_UNAVAILABLE', 'Restore a verified source-byte checkpoint before continuing this batch');
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || batch.readBytes + bytes > READ_BATCH_LIMITS.totalReadBytes) {
      recordExecution(frame.requestId, { batchReadBytes: batch.readBytes, batchQuotaExceeded: true });
      fail('BATCH_BYTE_LIMIT', 'Source IO budget exhausted; use a smaller subtree or targeted file page');
    }
    batch.readBytes += bytes;
  }

  function resolvePendingReadContext({ approvalId, request }) {
    const row = executions[request.requestId], source = request.origin?.readBatch;
    const continuation = continuations[String(approvalId)];
    if (!source) {
      // Owner reads outside a model continuation keep their existing path.
      // A known coordinator read must rejoin its original admission gate.
      if (!row) return null;
      const pending = continuation?.state?.pendingFrame;
      if (!continuation || ['orphaned', 'reconciled', 'resuming'].includes(continuation.status)
        || row.approvalId !== approvalId || pending?.requestId !== request.requestId
        || continuation.requestFingerprint !== capabilityBroker.approvals?.get(approvalId)?.fingerprint
        || request.actor.kind !== continuation.state.actor.kind || request.actor.id !== continuation.state.actor.id
        || request.taskId !== (continuation.state.scope.taskId ?? null) || request.workspaceId !== (continuation.state.scope.workspaceId ?? null)
        || request.origin?.sessionId !== continuation.target.sessionId || request.origin?.turnId !== continuation.target.turnId
        || (request.origin?.runId ?? null) !== (continuation.state.runId ?? null)
        || JSON.stringify(request.input) !== JSON.stringify(pending.input)
        || !isTrustedParallelRead(capabilityBroker.registry?.require(request.capability))) {
        fail('APPROVAL_CONTINUATION_INVALID', 'This approved read needs its exact retained coordinator context');
      }
      return { acquireReadSlot: readSlot };
    }
    const batch = continuation?.state?.pendingBatch;
    const pending = batch?.current?.pending;
    if (!source || !row?.parentRequestId || !continuation || ['orphaned', 'reconciled', 'resuming'].includes(continuation.status)
      || continuation.requestFingerprint !== capabilityBroker.approvals?.get(approvalId)?.fingerprint
      || pending?.requestId !== request.requestId || row.parentRequestId !== source.parentRequestId
      || row.batchStepId !== source.stepId || row.itemIndex !== source.itemIndex
      || request.actor.kind !== continuation.state.actor.kind || request.actor.id !== continuation.state.actor.id
      || request.taskId !== (continuation.state.scope.taskId ?? null) || request.workspaceId !== (continuation.state.scope.workspaceId ?? null)
      || request.origin.sessionId !== continuation.target.sessionId || request.origin.turnId !== continuation.target.turnId
      || (request.origin.runId ?? null) !== (continuation.state.runId ?? null)
      || JSON.stringify(request.input) !== JSON.stringify(pending.input)
      || !isTrustedParallelRead(capabilityBroker.registry?.require(request.capability))
      || batch.quotaInFlight || !Number.isSafeInteger(batch.readBytes) || batch.readBytes < 0 || batch.readBytes > READ_BATCH_LIMITS.totalReadBytes) {
      fail('BATCH_CONTEXT_UNAVAILABLE', 'This approved source needs its exact retained batch checkpoint; review interrupted IO before retrying');
    }
    // This marker is in the existing continuation, not the permission grant.
    // A crash after admission cannot reset a partially consumed search quota.
    batch.quotaInFlight = { requestId: request.requestId, at: Date.now() };
    save();
    return { acquireReadSlot: readSlot, consumeReadBytes: bytes => consumeBatchBytes(continuation.state.pendingFrame, batch, bytes) };
  }

  async function runReadBatch(frameContext, checkpoint = null, decisionResult = null) {
    const { state, frame, signal } = frameContext;
    const batch = checkpoint ?? { plan: validateReadBatchPlan(frame.input), stepIndex: 0, values: {}, sources: [],
      transforms: [], observations: {}, readBytes: 0, current: null };
    if (!Number.isSafeInteger(batch.readBytes) || batch.readBytes < 0 || batch.readBytes > READ_BATCH_LIMITS.totalReadBytes) {
      fail('BATCH_QUOTA_UNAVAILABLE', 'The retained batch does not contain a valid source-byte counter');
    }
    const sourceIds = new Set(batch.plan.steps.flatMap(step => step.op === 'search' ? ['filesystem.search']
      : ['read', 'readEach'].includes(step.op) ? ['filesystem.read'] : []));
    for (const id of sourceIds) {
      if (!state.manifest.some(item => item.id === id) || !isTrustedParallelRead(capabilityBroker.registry?.require(id))
        || frameContext.actor.kind !== 'owner' && !frameContext.actor.grants?.capabilities?.includes(id)) {
        fail('BATCH_SOURCE_NOT_GRANTED', 'Grant each requested Core source capability on the current Task before using context.batch');
      }
    }
    if (!evidenceStore) fail('BATCH_EVIDENCE_UNAVAILABLE', 'Read batch requires the existing Tool Evidence store');
    for (; batch.stepIndex < batch.plan.steps.length; batch.stepIndex++) {
      if (signal?.aborted) fail('INVOKE_CANCELLED', 'Read batch was cancelled');
      const step = batch.plan.steps[batch.stepIndex];
      if (['read', 'search', 'readEach'].includes(step.op)) {
        if (!batch.current) {
          let inputs;
          if (step.op === 'search') {
            const literal = step.input.glob?.split(/[*?/]+/).filter(Boolean).sort((a, b) => b.length - a.length)[0];
            if (!step.input.query && !literal) fail('READ_BATCH_INVALID', 'A glob search needs a bounded literal candidate query');
            inputs = [{ query: step.input.query ?? literal, path: step.input.path ?? '.', maxResults: 100 }];
          } else if (step.op === 'read') inputs = [{ path: step.input.path ?? batchField(batch.values[step.input.pathRef.from]?.[step.input.pathRef.index ?? 0], step.input.pathRef.field),
            maxBytes: step.input.maxBytes ?? READ_BATCH_LIMITS.readBytes, offset: step.input.offset ?? 0 }];
          else {
            const rows = batch.values[step.from] ?? [];
            const cap = step.maxItems ?? READ_BATCH_LIMITS.items;
            if (rows.length > cap) { batch.observations.truncated = true; batch.observations.omittedItems = (batch.observations.omittedItems ?? 0) + rows.length - cap; }
            inputs = rows.slice(0, cap).map(row => ({ path: batchField(row, step.pathField), maxBytes: step.maxBytes ?? READ_BATCH_LIMITS.readBytes }));
          }
          batch.current = { inputs, cursor: 0, rows: [], pending: null, held: [] };
        }
        const current = batch.current;
        const accept = async receipt => {
          batch.sources.push({ capability: receipt.capability, step: receipt.batchStepId, itemIndex: receipt.itemIndex,
            status: receipt.result?.status, evidence: receipt.evidence ?? null });
          await finalizeSettledCall(state, receipt, { appendMessage: false });
          if (receipt.result?.status !== 'completed') return false;
          const value = JSON.parse(sanitizeToolEvidence(receipt.result.result));
          if (value?.truncated) batch.observations.truncated = true;
          if (step.op === 'search') {
            const rows = (value?.results ?? []).filter(row => !step.input.glob || batchGlobMatches(step.input.glob,
              row.path.startsWith((step.input.path ?? '.') + '/') ? row.path.slice(step.input.path.length + 1) : row.path));
            const cap = step.input.limit ?? READ_BATCH_LIMITS.items;
            if (rows.length > cap) { batch.observations.truncated = true; batch.observations.omittedItems = (batch.observations.omittedItems ?? 0) + rows.length - cap; }
            current.rows.push(...rows.slice(0, cap).map(row => ({ ...row, sourceRef: receipt.evidence })));
          } else current.rows.push({ ...value, sourceRef: receipt.evidence });
          return true;
        };
        if (current.pending) {
          const pending = current.pending;
          current.pending = null;
          batch.quotaInFlight = null;
          const receipt = persistSettlement(state, pending, decisionResult?.status === 'completed' ? { status: 'completed', result: decisionResult.result }
            : decisionResult?.status === 'outcome-unknown' ? decisionResult : { status: 'denied', error: { code: decisionResult?.status === 'rejected' ? 'APPROVAL_REJECTED' : decisionResult?.error?.code ?? 'CAPABILITY_DENIED' } });
          const retained = [receipt, ...current.held]; current.held = [];
          let failed = null;
          for (const row of retained) if (!await accept(row)) failed ??= row;
          if (failed) {
            const uncertain = retained.find(row => row.result?.status === 'outcome-unknown');
            return { ...(uncertain ?? failed).result, batchSources: batch.sources };
          }
          decisionResult = null;
        }
        while (current.cursor < current.inputs.length) {
          if (signal?.aborted) fail('INVOKE_CANCELLED', 'Read batch was cancelled');
          const group = current.inputs.slice(current.cursor, current.cursor + 2).map((input, offset) => {
            const itemIndex = current.cursor + offset;
            const sourceFrame = callFrame({ ...state, scope: frame.scope }, null, frame.cycle, frame.originalIndex,
              { capability: step.op === 'search' ? 'filesystem.search' : 'filesystem.read', input,
                parentRequestId: frame.requestId, parentCallId: frame.callId, batchStepId: step.id, itemIndex });
            sourceFrame.consumeReadBytes = bytes => consumeBatchBytes(frame, batch, bytes);
            return sourceFrame;
          });
          reserveSourceCalls(state, group.length);
          const rows = await dispatchGroup(state, group, signal);
          try {
            recordExecution(frame.requestId, { batchReadBytes: batch.readBytes });
            current.cursor += group.length;
            if (signal?.aborted) {
              cancelPendingRows(state, rows, 'turn-cancelled');
              for (const row of rows) await accept(row);
              fail('INVOKE_CANCELLED', 'Read batch was cancelled');
            }
            const pendingIndex = rows.findIndex(row => row.result?.status === 'pending');
            if (pendingIndex >= 0) {
              await retainPendingSiblings(state, rows);
              if (rows.some(row => row.result?.status === 'outcome-unknown')) {
                cancelPendingRows(state, rows, 'unknown-parallel-sibling');
                for (const row of rows) await accept(row);
                return { status: 'outcome-unknown', error: { code: 'PARALLEL_APPROVAL_CHANGED' }, batchSources: batch.sources };
              }
              let failed = null;
              for (const row of rows.slice(0, pendingIndex)) if (!await accept(row)) failed ??= row;
              if (failed) {
                cancelPendingRows(state, rows, 'failed-batch-sibling', { code: 'BATCH_SIBLING_FAILED' });
                for (const row of rows.slice(pendingIndex)) await accept(row);
                const uncertain = rows.find(row => row.result?.status === 'outcome-unknown');
                return { ...(uncertain ?? failed).result, batchSources: batch.sources };
              }
              current.pending = retainedSettlement(rows[pendingIndex]);
              current.held = rows.slice(pendingIndex + 1).map(retainedSettlement);
              return { ...rows[pendingIndex].result, batchContinuation: batch };
            }
            let failed = null;
            for (const row of rows) if (!await accept(row)) failed ??= row;
            if (failed) {
              const uncertain = rows.find(row => row.result?.status === 'outcome-unknown');
              return { ...(uncertain ?? failed).result, batchSources: batch.sources };
            }
            if (signal?.aborted) fail('INVOKE_CANCELLED', 'Read batch was cancelled');
          } catch (error) {
            cancelPendingRows(state, rows, 'batch-finalization-failed', { code: 'TOOL_GROUP_INTERRUPTED' });
            throw error;
          }
        }
        batch.values[step.id] = current.rows;
        batch.current = null;
      } else {
        const input = batch.values[step.from];
        const output = applyBatchTransform(step, input, batch.observations);
        const receipt = { step: step.id, op: step.op, inputRows: input.length, outputRows: output.length,
          inputSha256: crypto.createHash('sha256').update(sanitizeToolEvidence(input)).digest('hex'),
          outputSha256: crypto.createHash('sha256').update(sanitizeToolEvidence(output)).digest('hex') };
        batch.transforms.push(receipt);
        // Derived transforms are metadata under the existing parent receipt,
        // never synthetic Broker effects or independently verified file facts.
        recordExecution(frame.requestId, { batchTransforms: batch.transforms });
        batch.values[step.id] = output;
      }
    }
    let output = batch.values[batch.plan.output.from];
    if (batch.plan.output.fields) output = selectBatchFields(output, batch.plan.output.fields);
    const envelope = () => ({ status: 'completed', capability: 'context.batch', result: { output, sources: batch.sources,
      complete: !batch.observations.truncated && !batch.observations.invalidJsonl && !batch.observations.nonTextSources
        && !batch.observations.nonScalarGroups, observations: { ...batch.observations, readBytes: batch.readBytes }, transforms: batch.transforms } });
    if (sanitizeToolEvidence({ status: 'completed', result: envelope().result }).length > READ_BATCH_LIMITS.outputChars) {
      const original = output, previousOmitted = batch.observations.omittedOutputRows ?? 0;
      let minimum = 0, maximum = original.length;
      batch.observations.truncated = true;
      while (minimum < maximum) {
        const length = Math.ceil((minimum + maximum) / 2);
        output = original.slice(0, length);
        batch.observations.omittedOutputRows = previousOmitted + original.length - length;
        if (sanitizeToolEvidence({ status: 'completed', result: envelope().result }).length <= READ_BATCH_LIMITS.outputChars) minimum = length;
        else maximum = length - 1;
      }
      output = original.slice(0, minimum);
      batch.observations.omittedOutputRows = previousOmitted + original.length - minimum;
    }
    recordExecution(frame.requestId, { batchReadBytes: batch.readBytes });
    return envelope();
  }

  async function executeReadBatch(request) {
    const context = batchFrames.get(request?.requestId);
    if (!context || context.entered || context.frame.capability !== 'context.batch' || context.frame.input !== request.input
      && JSON.stringify(context.frame.input) !== JSON.stringify(request.input)
      || context && (request.actor?.kind !== context.actor.kind || request.actor.id !== context.actor.id
        || request.taskId !== (context.frame.scope.taskId ?? null) || request.workspaceId !== (context.frame.scope.workspaceId ?? null)
        || request.origin?.sessionId !== context.state.sessionId || request.origin?.turnId !== context.state.turnId
        || (request.origin?.runId ?? null) !== (context.state.runId ?? null)
        || (request.origin?.phase ?? null) !== (context.state.phase ?? null) || request.origin?.targetKind !== context.state.targetKind)) {
      fail('BATCH_CONTEXT_UNAVAILABLE', 'Read batch requires its currently accepted Core tool turn');
    }
    context.entered = true;
    return runReadBatch(context);
  }

  async function suspendGroup(state, calls, cycle, rows, pendingIndex, nextIndex, { usage, resolvedModel, limitReached }) {
    const pending = rows[pendingIndex], result = pending.result;
    await notifyActivity(state, { id: pending.activityId, capability: pending.capability,
      status: 'waiting-approval', durationMs: Date.now() - pending.startedAt });
    const approvalId = String(result.approvalId ?? '');
    let fingerprint = '';
    try { fingerprint = capabilityBroker.approvals?.get(approvalId)?.fingerprint ?? ''; } catch { /* Invalid reference fails closed below. */ }
    if (!approvalId || !fingerprint) fail('APPROVAL_CONTINUATION_INVALID', 'Broker returned an invalid approval reference');
    const id = crypto.randomUUID();
    const continuation = { id, approvalId, requestFingerprint: fingerprint,
      target: { sessionId: state.sessionId, turnId: state.turnId }, targetKind: state.targetKind,
      state: { providerId: state.providerId, model: state.model ?? null, reasoning: state.reasoning ?? null,
        manifest: structuredClone(state.manifest), actor: { kind: state.actor.kind, id: state.actor.id },
        sessionId: state.sessionId, turnId: state.turnId, runId: state.runId ?? null, phase: state.phase ?? null,
        accountingTaskId: state.accountingTaskId ?? null, scope: { ...pending.scope },
        messages: safePersistedMessages(state.messages), cycle, totalCalls: state.callBudget.used,
        usage, resolvedModel, limitReached,
        ...(state.configurationObservation ? { configurationObservation: structuredClone(state.configurationObservation) } : {}),
        ...(state.postWriteState ? { postWriteState: structuredClone(state.postWriteState) } : {}),
        ...(state.contextSynopsis ? { contextSynopsis: structuredClone(state.contextSynopsis), historyRevision: state.historyRevision } : {}),
        ...(typeof state.onContext === 'function' ? { onContext: state.onContext } : {}),
        seenCallIds: state.seenCallIds, pendingToolCallId: pending.callId,
        pendingActivityId: pending.activityId, pendingActivityStartedAt: pending.startedAt,
        pendingRequestId: pending.requestId, pendingCapability: pending.capability,
        pendingInput: { path: typeof pending.input?.path === 'string' ? pending.input.path : null,
          tool: typeof pending.input?.tool === 'string' ? pending.input.tool : null },
        pendingEvidenceInput: (() => {
          if (!evidenceStore || !EVIDENCE_SOURCE_CAPABILITIES.includes(pending.capability)
            || !state.manifest.some(item => item.id === 'context.evidence.read' && item.available !== false)) return null;
          try { return Buffer.byteLength(JSON.stringify(pending.input)) <= 65536 ? structuredClone(validateEvidenceSourceInput(pending.input)) : null; } catch { return null; }
        })(),
        pendingBatch: result.batchContinuation ? retainedBatchCheckpoint(result.batchContinuation) : null,
        pendingFrame: retainedSettlement({ ...pending, result: { status: 'pending', approvalId } }),
        settledCalls: rows.slice(pendingIndex + 1).map(retainedSettlement),
        pendingCalls: calls, pendingCallIndex: nextIndex }, createdAt: Date.now() };
    continuations[approvalId] = continuation;
    try { save(); }
    catch (error) {
      cancelPendingRows(state, rows, 'continuation-persist-failed', { code: 'APPROVAL_CONTINUATION_PERSIST_FAILED' });
      delete continuations[approvalId];
      throw error;
    }
    await messagesCheckpoint(state, 'settled-transcript');
    return { status: 'pending', toolCalling: 'supported', approvalId, expiresAt: result.expiresAt,
        text: '', usage, resolvedModel, continuationId: id,
        ...(pending.postWriteVerification ? { postWriteVerification: pending.result.postWriteVerification } : {}) };
  }

  async function recordUsage(state, usage) {
    if (typeof onUsage !== 'function') return;
    try { await onUsage({ sessionId: state.sessionId, turnId: state.turnId,
      taskId: state.accountingTaskId ?? null, providerId: state.providerId ?? null,
      model: state.model ?? null, usage }); }
    catch { fail('TOOL_USAGE_PERSIST_FAILED', 'Request usage could not be durably recorded'); }
  }

  function observeConfiguration(state, value, notify = false) {
    const observed = configurationObservation(value);
    if (!observed) return;
    state.configurationObservation = observed;
    if (notify && typeof state.onConfiguration === 'function') {
      try { const result = state.onConfiguration(structuredClone(observed)); result?.catch?.(() => {}); }
      catch { /* Telemetry observers cannot undo accepted tool work. */ }
    }
  }

  function withConfiguration(state, result) {
    return state.configurationObservation ? { ...result, configurationObservation: structuredClone(state.configurationObservation) } : result;
  }

  async function runLoop(state, signal) {
    const { providerId, model, reasoning, actor, sessionId, turnId, scope } = state;
    const budget = state.callBudget = { used: state.totalCalls ?? 0 };
    const seenCallIds = new Set(state.seenCallIds ?? []);
    let text = '';
    let usage = state.usage ?? null;
    let resolvedModel = state.resolvedModel ?? null;
    let limitReached = state.limitReached === true;
    let activeRequestId = null;
    let activeUsage = null;
    let activeProviderId = null;
    let activeModel = null;
    let activeRequestDiagnostics = null;

    try {
    for (let cycle = state.cycle ?? 0; cycle <= maxCycles; cycle++) {
      if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
      if (cycle > 0 && typeof state.onStreamReset === 'function') {
        await state.onStreamReset({ cycle });
      }
      const resumingToolBatch = Array.isArray(state.pendingCalls);
      const toolsAllowed = cycle < maxCycles && budget.used < maxCalls;
      const requestOnlyMessages = toolsAllowed || finalSynthesisAtLimit !== true ? [] : [{ role: 'system', content: 'The bounded tool budget is exhausted. Do not request or simulate more tools. Summarize the verified results already available, explain any missing evidence, and answer the user now. Do not claim unperformed work is complete.' }];
      const request = {
        providerId, model, reasoning, messages: [...state.messages, ...requestOnlyMessages], signal,
        tools: toolsAllowed || finalSynthesisAtLimit !== true ? state.manifest.map((item) => ({ id: item.id, description: item.description, inputSchema: item.inputSchema })) : [],
        toolChoice: cycle < maxCycles && budget.used < maxCalls ? 'auto' : 'none'
      };
      request.onConfiguration = value => observeConfiguration(state, value, true);
      if (!resumingToolBatch && !toolsAllowed && finalSynthesisAtLimit !== true) limitReached = true;
      if (!resumingToolBatch) {
        await messagesCheckpoint(state, 'settled-transcript');
        const history = await historyContext(state, 'projection', signal);
        const historySource = history ? await acquireHistorySource(state, history, 'projection', signal) : null;
        const projectionOptions = { evidenceStore, binding: evidenceBinding(state), canRetrieveEvidence: state.manifest.some(item => item.id === 'context.evidence.read' && item.available !== false),
          ...(history ? { synopsis: true, task: history.task ?? null, sourceBinding: history.binding, sourceResolver: input => sourcePage(state, historySource, input) } : {}) };
        // Projection authority is independent of permission to dispatch another
        // tool. Bind source refs only to actual retained originals; the final
        // no-tool instruction is request-only and has no owner history row.
        let projected = projectMessageBudget(state.messages, projectionOptions);
        request.messages = [...projected.messages, ...requestOnlyMessages];
        const modelBudget = history && typeof modelRuntime.contextBudget === 'function' ? modelRuntime.contextBudget(providerId, model, request) : null;
        if (history && (modelBudget?.status === 'exceeded' || Buffer.byteLength(JSON.stringify(request.messages)) > projected.maxBytes)) {
          projected = projectMessageBudget(state.messages, { ...projectionOptions, forceSynopsis: true });
          request.messages = [...projected.messages, ...requestOnlyMessages];
        }
        if (requestOnlyMessages.length) {
          // Count/guard the complete transport without rewriting protected
          // recent tool bodies or introducing new relative duplicate indexes.
          const complete = projectMessageBudget(request.messages, { deduplicate: false });
          projected = { ...projected, bytes: complete.bytes, maxBytes: complete.maxBytes };
        }
        if (history) { state.historyRevision = history.revision; state.contextSynopsis = projected.synopsis ?? null; }
        // Model Runtime still checks the complete final request, its live tool
        // schemas/provider framing/output reservation; no usage anchor is reused.
        await messagesCheckpoint(state, 'request-projection');
        if (typeof state.onContext === 'function') {
          // Only observed numeric projection facts leave the loop; evidence IDs and message bodies stay internal.
          const projection = { status: 'observed', bytes: projected.bytes, maxBytes: projected.maxBytes,
            compacted: projected.compactions.length > 0, compactionCount: projected.compactions.length,
            truncated: null }; // projectMessageBudget has no independent truncation observation.
          request.onContext = snapshot => state.onContext({ ...snapshot, cycle,
            requestId: `${turnId ?? 'turn'}:${cycle}`, projection });
        }
      }
      let response;
      if (resumingToolBatch) {
        response = { text: '', toolCalls: state.pendingCalls, usage, resolvedModel };
      } else if (typeof modelRuntime.stream === 'function') {
        activeRequestId = `${turnId ?? 'turn'}:${cycle}`;
        activeUsage = null;
        activeProviderId = providerId ?? null;
        activeModel = null;
        activeRequestDiagnostics = null;
        let streamedText = '';
        let streamedToolCalls = [];
        let streamUsage = null;
        let streamResolvedModel = null;
        let streamReason = null;
        let modelContinuation = null;
        for await (const event of modelRuntime.stream(request)) {
          if (event?.data?.configurationObservation) observeConfiguration(state, event.data.configurationObservation);
          if (typeof event?.data?.providerId === 'string' && event.data.providerId.trim()) activeProviderId = event.data.providerId.trim();
          if (typeof event?.data?.resolvedModel === 'string' && event.data.resolvedModel.trim()) activeModel = event.data.resolvedModel.trim();
          if (event?.data?.requestDiagnostics) activeRequestDiagnostics = event.data.requestDiagnostics;
          const snapshot = event?.data?.reason?.usage ?? event?.data?.usage ?? event?.data?.message?.usage;
          if (snapshot && typeof snapshot === 'object') activeUsage = streamUsage = snapshot;
          if (event?.type === 'assistant/chunk') {
            const delta = event.data?.chunk?.type === 'text-delta' ? event.data.chunk.text : '';
            if (typeof delta === 'string' && delta) {
              streamedText += delta;
              if (typeof state.onTextDelta === 'function') await state.onTextDelta(delta, { cycle });
            }
          } else if (event?.type === 'assistant/tool-calls') {
            streamedToolCalls = Array.isArray(event.data?.toolCalls) ? event.data.toolCalls : [];
          } else if (event?.type === 'assistant/message' && !streamedText) {
            const content = event.data?.message?.content;
            if (typeof content === 'string') streamedText = content;
            else if (Array.isArray(content)) streamedText = content.map(item => String(item?.text ?? '')).join('');
          } else if (event?.type === 'turn/end') {
            modelContinuation = event.data?.modelContinuation ?? null;
            streamUsage = event.data?.reason?.usage ?? event.data?.usage ?? streamUsage;
            streamReason = event.data?.reason?.kind ?? streamReason;
            streamResolvedModel = typeof event.data?.resolvedModel === 'string'
              ? event.data.resolvedModel : streamResolvedModel;
          }
        }
        usage = accumulateModelUsage(usage, streamUsage, { requestId: activeRequestId, providerId: activeProviderId,
          model: streamResolvedModel ?? activeModel ?? model ?? null, requestDiagnostics: activeRequestDiagnostics });
        activeRequestId = null;
        if (signal?.aborted || streamReason === 'aborted' || streamReason === 'cancelled') {
          fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
        }
        if (streamReason === null) {
          fail('MODEL_STREAM_TERMINAL_MISSING', 'Model stream ended without an explicit terminal event');
        }
        if (streamReason && streamReason !== 'completed') {
          fail('MODEL_STREAM_FAILED', `Model stream ended with ${String(streamReason).slice(0, 80)}`);
        }
        response = {
          text: streamedText,
          ...(modelContinuation ? { modelContinuation } : {}),
          toolCalls: streamedToolCalls,
          usage: streamUsage,
          providerId: activeProviderId,
          requestDiagnostics: activeRequestDiagnostics,
          resolvedModel: streamResolvedModel
        };
      } else {
        activeRequestId = `${turnId ?? 'turn'}:${cycle}`;
        activeUsage = null;
        activeProviderId = providerId ?? null;
        activeModel = null;
        activeRequestDiagnostics = null;
        response = await modelRuntime.chat(request);
        if (response?.configurationObservation) observeConfiguration(state, response.configurationObservation);
        activeRequestId = null;
      }
      if (typeof response?.text === 'string') text = response.text;
      if (!resumingToolBatch) usage = accumulateModelUsage(usage, response?.usage, {
        requestId: `${turnId ?? 'turn'}:${cycle}`, providerId: response?.providerId ?? providerId ?? null,
        model: response?.resolvedModel ?? response?.model ?? model ?? null, requestDiagnostics: response?.requestDiagnostics
      });
      if (!resumingToolBatch) await recordUsage(state, usage);
      if (typeof response?.resolvedModel === 'string' && response.resolvedModel.trim()) resolvedModel = response.resolvedModel.trim();
      else if (typeof response?.model === 'string' && response.model.trim()) resolvedModel = response.model.trim();
      const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      if (!calls.length) return { status: limitReached ? 'partial' : 'completed', ...(limitReached ? { code: 'TOOL_CALL_LIMIT' } : {}), toolCalling: 'supported', text, usage, resolvedModel, totalCalls: budget.used, messages: state.messages, ...(response?.modelContinuation ? { modelContinuation: response.modelContinuation } : {}) };
      const known = new Set(state.manifest.map((item) => item.id));

      const firstCallIndex = resumingToolBatch ? Math.max(0, Number(state.pendingCallIndex) || 0) : 0;
      if (!resumingToolBatch) {
        state.messages.push({
          role: 'assistant',
          ...(response?.modelContinuation ? { modelContinuation: structuredClone(response.modelContinuation) } : {}),
          content: typeof response.text === 'string' && response.text ? response.text : null,
          tool_calls: calls.map((call, index) => ({
            id: String(call?.id || `call-${cycle}-${index}`).slice(0, 200),
            type: 'function',
            function: { name: String(call?.name || (call?.capabilityId ? providerToolName(call.capabilityId) : 'unknown')), arguments: typeof call?.arguments === 'string' ? call.arguments : safeJson(call?.arguments ?? {}) }
          }))
        });
        await messagesCheckpoint(state, 'tool-calls');
      }
      delete state.pendingCalls;
      delete state.pendingCallIndex;

      for (let index = firstCallIndex; index < calls.length;) {
        if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
        const verification = await postWriteBarrier(state, calls, cycle, index, signal, { usage, resolvedModel, limitReached });
        if (verification) return verification;
        const call = calls[index];
        const callId = String(call?.id || `call-${cycle}-${index}`).slice(0, 200);
        if (seenCallIds.has(callId)) {
          state.messages.push({ role: 'tool', tool_call_id: callId, content: safeJson({ error: { code: 'DUPLICATE_TOOL_CALL' } }) });
          index++;
          continue;
        }
        if (index >= maxBatchCalls || budget.used >= maxCalls || cycle >= maxCycles) {
          seenCallIds.add(callId);
          limitReached = state.limitReached = true;
          state.messages.push({ role: 'tool', tool_call_id: callId, content: safeJson({ error: { code: 'TOOL_CALL_LIMIT' } }) });
          index++;
          continue;
        }
        const frames = [callFrame(state, call, cycle, index)];
        const explicit = state.postWriteState?.explicit;
        if (explicit?.cycle === cycle && explicit.index === index) {
          frames[0].postWriteVerification = explicit.binding;
          state.postWriteState.checks.push({ requestId: frames[0].requestId, state: 'requested', writes: structuredClone(explicit.binding.writes) });
          delete state.postWriteState.explicit;
        }
        // Group formation never crosses malformed, duplicate or serial calls.
        // Live Broker authorization remains separate for every admitted call.
        const next = calls[index + 1];
        const nextId = next ? String(next.id || `call-${cycle}-${index + 1}`).slice(0, 200) : '';
        if (eligibleCall(state, call) && next && index + 1 < maxBatchCalls && budget.used + 1 < maxCalls
          && nextId !== callId && !seenCallIds.has(nextId) && eligibleCall(state, next)) {
          frames.push(callFrame(state, next, cycle, index + 1));
        }
        for (const frame of frames) seenCallIds.add(frame.callId);
        state.seenCallIds = [...seenCallIds].slice(-MAX_TOTAL_CALLS);
        budget.used += frames.length;
        const rows = await dispatchGroup(state, frames, signal);
        try {
          if (signal?.aborted) {
            cancelPendingRows(state, rows, 'turn-cancelled');
            for (const row of rows) await finalizeSettledCall(state, row);
            fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
          }
          const nextIndex = index + frames.length;
          const pendingIndex = rows.findIndex(row => row.result?.status === 'pending');
          if (pendingIndex >= 0) await retainPendingSiblings(state, rows);
          const unknown = rows.find(row => row.result?.status === 'outcome-unknown');
          if (unknown) {
            cancelPendingRows(state, rows, 'unknown-parallel-sibling');
            for (const row of rows) await finalizeSettledCall(state, row);
            return { status: 'partial', code: 'OUTCOME_UNKNOWN', toolCalling: 'supported', text: '', usage, resolvedModel, totalCalls: budget.used };
          }
          for (const row of rows.slice(0, pendingIndex < 0 ? rows.length : pendingIndex)) await finalizeSettledCall(state, row);
          if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
          if (pendingIndex >= 0) return await suspendGroup(state, calls, cycle, rows, pendingIndex, nextIndex, { usage, resolvedModel, limitReached });
          index = nextIndex;
        } catch (error) {
          cancelPendingRows(state, rows, 'group-finalization-failed', { code: 'TOOL_GROUP_INTERRUPTED' });
          throw error;
        }
      }
      const verification = await postWriteBarrier(state, calls, cycle, calls.length, signal, { usage, resolvedModel, limitReached });
      if (verification) return verification;
      flushPostWritePairs(state);
    }
    return { status: 'partial', code: 'TOOL_CALL_LIMIT', toolCalling: 'supported', text, usage, resolvedModel, totalCalls: budget.used, messages: state.messages };
    } catch (error) {
      if (error?.configurationObservation) observeConfiguration(state, error.configurationObservation);
      if (state.configurationObservation && error && typeof error === 'object') error.configurationObservation = structuredClone(state.configurationObservation);
      // A failed transport may still be billable, but its usage is unknown. Keep
      // earlier receipts and a distinct unknown attempt rather than reporting 0.
      if (activeRequestId) usage = accumulateModelUsage(usage, activeUsage, {
        requestId: `${activeRequestId}:failed:${crypto.randomUUID()}`, providerId: error?.providerId ?? activeProviderId,
        model: error?.resolvedModel ?? activeModel, requestDiagnostics: error?.requestDiagnostics ?? activeRequestDiagnostics
      });
      if (activeRequestId) {
        try { await recordUsage(state, usage); }
        catch { if (error && typeof error === 'object') error.accountingWarning = 'TOOL_USAGE_PERSIST_FAILED'; }
      }
      if (usage && error && typeof error === 'object') error.usage = { ...usage, accountingComplete: false };
      throw error;
    }
  }

  async function run({ providerId, model, reasoning, messages = [], manifest = [], actor, sessionId, turnId, runId = null, phase = null, targetKind = 'chat', scope = {}, signal, refreshContext, onCapabilityResult, onActivity, onTextDelta, onStreamReset, onContext, onConfiguration } = {}) {
    if (!actor || !['owner', 'agent'].includes(actor.kind) || typeof actor.id !== 'string') fail('UNAUTHORIZED', 'Trusted Model actor required');
    const normalizedSessionId = String(sessionId ?? 'session').slice(0, 160);
    const normalizedTurnId = turnId == null ? null : String(turnId).slice(0, 160);
    const turnKey = normalizedTurnId === null ? null : JSON.stringify([normalizedSessionId, normalizedTurnId]);
    if ((scope.taskId && recoveryForTask(scope.taskId)?.state === 'needs-reconciliation')
      || recoveryForSession(sessionId)?.state === 'needs-reconciliation') {
      fail('REQUEST_RECOVERY_REQUIRED', 'Review the uncertain tool result before continuing');
    }
    // A caller may retry the same logical turn after losing its response. Its
    // tool request IDs would otherwise be reused while the Broker is called
    // again, including for writes already recorded as completed.
    if ((turnKey && activeTurns.has(turnKey)) || (normalizedTurnId !== null && Object.values(executions).some(row =>
      row?.sessionId === normalizedSessionId && row?.turnId === normalizedTurnId))) {
      fail('REQUEST_RECOVERY_REQUIRED', 'This turn already dispatched a tool; inspect its recorded outcome before starting a new turn');
    }
    if (turnKey) activeTurns.add(turnKey);
    try {
    const supports = typeof modelRuntime.supportsToolCalling === 'function'
      ? await modelRuntime.supportsToolCalling(providerId, model)
      : true;
    if (!supports) return { status: 'unsupported', toolCalling: 'unsupported', text: '', usage: null, resolvedModel: null };
    const safeManifest = (Array.isArray(manifest) ? manifest : []).filter((item) => item?.available !== false
      && typeof item?.id === 'string' && item.id && typeof item.description === 'string'
      && item.inputSchema && item.inputSchema.type === 'object').slice(0, 128);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(capabilityError('TOOL_EXECUTION_TIMEOUT', 'Model tool turn exceeded its time limit')), timeoutMs);
    try {
      const state = {
        providerId, model, reasoning, manifest: safeManifest, actor,
        sessionId: String(sessionId ?? 'session').slice(0, 160),
        turnId: String(turnId ?? crypto.randomUUID()).slice(0, 160),
        runId: typeof runId === 'string' && runId.length <= 240 ? runId : null,
        phase: ['user','bootstrap','system','approval'].includes(phase) ? phase : null,
        targetKind: targetKind === 'agent' ? 'agent' : 'chat',
        accountingTaskId: scope.taskId ?? null,
        scope: { taskId: scope.taskId ?? null, workspaceId: scope.workspaceId ?? null },
        messages: structuredClone(messages), cycle: 0, totalCalls: 0,
        ...(typeof onActivity === 'function' ? { onActivity } : {}),
        ...(typeof onTextDelta === 'function' ? { onTextDelta } : {}),
        ...(typeof onStreamReset === 'function' ? { onStreamReset } : {}),
        ...(typeof onContext === 'function' ? { onContext } : {}),
        ...(typeof onConfiguration === 'function' ? { onConfiguration } : {}),
        ...(typeof refreshContext === 'function' ? { refreshContext } : {}),
        ...(typeof onCapabilityResult === 'function' ? { onCapabilityResult } : {})
      };
      return withConfiguration(state, await runLoop(state, controller.signal));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    } finally {
      if (turnKey) activeTurns.delete(turnKey);
    }
  }

  function recordApprovalOutcomeUnknown({ approvalId, requestFingerprint, decisionResult } = {}) {
    const continuation = continuations[String(approvalId ?? '')];
    const expected = continuation?.requestFingerprint ?? capabilityBroker.approvals?.get(approvalId)?.fingerprint;
    if (!expected || expected !== requestFingerprint) fail('APPROVAL_MISMATCH', 'Approval outcome fingerprint mismatch');
    const rows = Object.entries(executions).filter(([, row]) => row?.approvalId === approvalId);
    if (!rows.length && continuation) rows.push([`approval:${approvalId}`, {
      sessionId: continuation.target.sessionId, turnId: continuation.target.turnId,
      taskId: continuation.state.scope?.taskId ?? null, capability: continuation.state.pendingCapability,
      approvalId, at: Date.now()
    }]);
    for (const [id, row] of rows) recordExecution(id, { ...row, status: 'outcome-unknown',
      code: String(decisionResult?.error?.code ?? 'OUTCOME_UNKNOWN').slice(0, 100) });
    return { recorded: rows.length };
  }

  async function resumeApprovalInternal({ approvalId, requestFingerprint, decisionResult, signal, refreshContext, restoreMessages, onCapabilityResult, onActivity, onTextDelta, onStreamReset, onContext, onConfiguration } = {}) {
    const continuation = continuations[String(approvalId ?? '')];
    if (!continuation) fail('APPROVAL_CONTINUATION_NOT_FOUND', 'No Model turn is waiting for this approval');
    if (continuation.status === 'resuming') fail('REQUEST_RECOVERY_REQUIRED', 'This consumed approval already resumed; inspect retained receipts before starting a fresh turn');
    if (continuation.status === 'orphaned' || continuation.status === 'reconciled') {
      fail('APPROVAL_CONTINUATION_ORPHANED', 'Interrupted Agent approval requires Owner reconciliation');
    }
    if (continuation.requestFingerprint !== requestFingerprint) fail('APPROVAL_MISMATCH', 'Approval continuation fingerprint mismatch');
    const modelOnlyResume = continuation.status === 'model-retry' && continuation.state.approvalDelivered === true;
    const activity = { id: continuation.state.pendingActivityId ?? `${continuation.target.turnId}:${continuation.state.pendingToolCallId}`.slice(0, 200),
      capability: continuation.state.pendingCapability, startedAt: continuation.state.pendingActivityStartedAt };
    if(decisionResult?.status==='pending'){
      const nextId=String(decisionResult.approvalId??''),next=capabilityBroker.approvals?.get(nextId),previous=capabilityBroker.approvals?.get(approvalId);
      if(!nextId||nextId===String(approvalId))fail('APPROVAL_NOT_DECIDED','Original approval is still pending');
      if(continuations[nextId]||next?.status!=='pending'||next.expiresAt<=Date.now()
        ||previous?.status!=='consumed'||next.request?.pluginParent?.approvalId!==String(approvalId)
        ||next.request.taskId!==continuation.state.scope?.taskId||next.request.workspaceId!==continuation.state.scope?.workspaceId
        ||next.request.actor?.kind!==continuation.state.actor.kind||next.request.actor.id!==continuation.state.actor.id
        ||(continuation.approvalDepth??0)>=4)fail('APPROVAL_CONTINUATION_INVALID','Nested pending decision is not an exact bounded successor');
      const moved={...continuation,approvalId:nextId,requestFingerprint:next.fingerprint,approvalDepth:(continuation.approvalDepth??0)+1};
      continuations[nextId]=moved;delete continuations[String(approvalId)];
      try{save();}catch(error){delete continuations[nextId];continuations[String(approvalId)]=continuation;throw error;}
      for(const [id,row]of Object.entries(executions))if(row?.approvalId===approvalId)recordExecution(id,{status:'approval-pending',approvalId:nextId,parentApprovalId:approvalId});
      return withConfiguration(continuation.state, {status:'pending',approvalId:nextId,expiresAt:next.expiresAt,text:'',usage:continuation.state.usage??null,
        toolCalling:'supported',target:continuation.target,targetKind:continuation.targetKind});
    }
    if (decisionResult?.status === 'outcome-unknown') {
      recordApprovalOutcomeUnknown({ approvalId, requestFingerprint, decisionResult });
      const verification = continuation.state.pendingFrame?.postWriteVerification
        ? persistSettlement(continuation.state, continuation.state.pendingFrame, decisionResult).result.postWriteVerification : null;
      if (typeof onActivity === 'function') await onActivity(terminalActivity(decisionResult, activity));
      if (typeof onCapabilityResult === 'function') await onCapabilityResult({
        capability: continuation.state.pendingCapability, result: decisionResult,
        input: continuation.state.pendingInput ?? {},
        eventId: activity.id,
        ...continuation.target, scope: continuation.state.scope
      });
      delete continuations[String(approvalId)];
      try { save(); } catch (error) { continuations[String(approvalId)] = continuation; throw error; }
      return withConfiguration(continuation.state, { status: 'partial', code: 'OUTCOME_UNKNOWN', toolCalling: 'supported', text: '',
        usage: continuation.state.usage ?? null, resolvedModel: continuation.state.resolvedModel ?? null,
        totalCalls: continuation.state.totalCalls, target: continuation.target, targetKind: continuation.targetKind,
        ...(verification ? { postWriteVerification: verification } : {}) });
    }
    // Distinguish a durably consumed result from a stale pending projection;
    // startup must review the latter even if the external effect completed late.
    for (const [id, row] of Object.entries(executions)) {
      if (row?.approvalId === approvalId && !continuation.state.pendingFrame) recordExecution(id, {
        status: decisionResult?.status === 'completed' ? 'completed' : 'failed'
      });
    }
    const state = {
      ...continuation.state,
      targetKind: continuation.targetKind,
      manifest: structuredClone(continuation.state.manifest),
      scope: { ...continuation.state.scope },
      ...(continuation.state.postWriteState ? { postWriteState: structuredClone(continuation.state.postWriteState) } : {}),
      messages: continuation.state.messages.map((message) => ({ ...message }))
    };
    if (typeof refreshContext === 'function') state.refreshContext = refreshContext;
    if (typeof onCapabilityResult === 'function') state.onCapabilityResult = onCapabilityResult;
    if (typeof onActivity === 'function') state.onActivity = onActivity;
    if (typeof onTextDelta === 'function') state.onTextDelta = onTextDelta;
    if (typeof onStreamReset === 'function') state.onStreamReset = onStreamReset;
    if (typeof onContext === 'function') state.onContext = onContext;
    if (typeof onConfiguration === 'function') state.onConfiguration = onConfiguration;
    let result = decisionResult?.status === 'completed'
      ? { status: 'completed', result: decisionResult.result }
      : decisionResult?.status === 'rejected' ? { status: 'rejected', error: { code: 'APPROVAL_REJECTED' } }
        : { status: ['cancelled', 'failed', 'denied'].includes(decisionResult?.status) ? decisionResult.status : 'failed',
          error: { code: decisionResult?.error?.code ?? 'CAPABILITY_DENIED' } };
    // Claim delivery before any resumed source/observer/model work. A later
    // failed ACK cannot run the old cursor a second time, even in this process.
    continuation.status = 'resuming';
    continuation.resumeStartedAt = Date.now();
    save();
    // A trusted live owner may retain protocol text that the durable execution
    // journal deliberately sanitizes. This callback is not a cold stack loader
    // or a model/RPC input. Claim the receipt first and require exact agreement
    // with the saved projection before any resumed tool/effect can execute.
    if (typeof restoreMessages === 'function') {
      const original = await restoreMessages();
      if (!Array.isArray(original) || JSON.stringify(safePersistedMessages(original)) !== JSON.stringify(continuation.state.messages)) {
        fail('CONTEXT_SYNOPSIS_STALE', 'Live approval transcript does not match its retained continuation; reconcile the consumed receipt before fresh recovery');
      }
      state.messages = structuredClone(original);
    }
    if (state.pendingBatch) {
      state.callBudget = { used: state.totalCalls };
      const actor = typeof actorResolver === 'function' ? await actorResolver({ actorKind: state.actor.kind, actorId: state.actor.id,
        sessionId: state.sessionId, turnId: state.turnId, scope: state.scope }) : state.actor;
      if (!actor || actor.kind !== state.actor.kind || actor.id !== state.actor.id) fail('TOOL_ACTOR_UNAVAILABLE', 'The trusted batch actor is unavailable');
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try { result = await runReadBatch({ state, frame: state.pendingFrame, signal: controller.signal, actor }, state.pendingBatch, decisionResult); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      state.totalCalls = state.callBudget.used;
      if (result?.status === 'pending') {
        const row = persistSettlement(state, state.pendingFrame, result);
        const pending = await suspendGroup(state, state.pendingCalls, state.cycle, [row], 0, state.pendingCallIndex,
          { usage: state.usage, resolvedModel: state.resolvedModel, limitReached: state.limitReached });
        delete continuations[String(approvalId)]; save();
        return withConfiguration(state, { ...pending, target: continuation.target, targetKind: continuation.targetKind });
      }
    }
    if (!modelOnlyResume) {
      const acceptedRow = state.pendingFrame ? persistSettlement(state, state.pendingFrame, result) : null;
      if (!acceptedRow?.serverVerification) state.messages.push({
        role: 'tool', tool_call_id: state.pendingToolCallId,
        content: acceptedRow?.content ?? (result.status === 'completed' ? completedResultContent(result, state, state.pendingCapability, state.pendingEvidenceInput) : safeJson(result))
      });
      if (typeof state.onActivity === 'function') await state.onActivity(terminalActivity(result, activity));
      if (typeof state.onCapabilityResult === 'function' && state.pendingCapability) {
        await state.onCapabilityResult({ capability: state.pendingCapability, result,
          input: state.pendingInput ?? {},
          eventId: activity.id,
          sessionId: continuation.target.sessionId, turnId: continuation.target.turnId, scope: state.scope });
      }
      if (acceptedRow) rememberPostWriteSettlement(state, acceptedRow);
      for (const row of state.settledCalls ?? []) await finalizeSettledCall(state, row);
      if (result?.status === 'outcome-unknown') {
        delete continuations[String(approvalId)]; save();
        return withConfiguration(state, { status: 'partial', code: 'OUTCOME_UNKNOWN', toolCalling: 'supported', text: '', usage: state.usage,
          resolvedModel: state.resolvedModel, totalCalls: state.totalCalls, target: continuation.target, targetKind: continuation.targetKind });
      }
      delete state.settledCalls;
      delete state.pendingBatch;
      state.pendingCalls = structuredClone(continuation.state.pendingCalls ?? []);
      state.pendingCallIndex = Math.max(0, Number(continuation.state.pendingCallIndex) || 0);
    } else {
      delete state.pendingCalls;
      delete state.pendingCallIndex;
      delete state.settledCalls;
      delete state.pendingBatch;
    }
    if (state.pendingFrame?.serverVerification && !state.pendingBatch
      && state.pendingCallIndex >= (state.pendingCalls?.length ?? 0)) flushPostWritePairs(state);
    if (typeof state.refreshContext === 'function') {
      const refreshed = await state.refreshContext({ capability: null, result: decisionResult,
        sessionId: continuation.target.sessionId, turnId: continuation.target.turnId, scope: state.scope, approvalResumed: true });
      if (refreshed && typeof refreshed === 'object') {
        if (Array.isArray(refreshed.manifest)) state.manifest = refreshed.manifest;
        if (refreshed.scope && typeof refreshed.scope === 'object') state.scope = {
          taskId: refreshed.scope.taskId ?? null, workspaceId: refreshed.scope.workspaceId ?? null
        };
        if (typeof refreshed.context === 'string' && refreshed.context.trim()) {
          const marker = 'CetaMesh dynamic context (JSON reference data):\n';
          const existing = state.messages.findIndex((message) => message.role === 'system' && String(message.content ?? '').startsWith(marker));
          const contextMessage = { role: 'system', content: marker + refreshed.context };
          if (existing >= 0) state.messages[existing] = contextMessage;
          else state.messages.splice(Math.min(2, state.messages.length), 0, contextMessage);
        }
      }
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(capabilityError('TOOL_EXECUTION_TIMEOUT', 'Model tool turn exceeded its time limit')), timeoutMs);
    const canRetryModelOnly = modelOnlyResume || !continuation.state.pendingBatch
      && state.pendingCallIndex >= state.pendingCalls.length;
    const modelRetryCycle = state.cycle + (modelOnlyResume ? 0 : 1);
    const settledMessageCount = state.messages.length;
    const turnDispatchIds = () => Object.entries(executions).filter(([, row]) => row?.sessionId === state.sessionId
      && row?.turnId === state.turnId).map(([id]) => id).sort();
    const settledDispatchIds = JSON.stringify(turnDispatchIds());
    try {
      let resumed;
      try { resumed = await runLoop(state, controller.signal); }
      catch (error) {
        // Retrying a failed first Model continuation is the pre-existing path:
        // no remaining call, transcript advance or new dispatch can be replayed.
        // Once any later source/tool was admitted, retain the resuming fence.
        if (canRetryModelOnly && !controller.signal.aborted && error?.effectStatus !== 'unknown'
          && !String(error?.code ?? '').endsWith('_PERSIST_FAILED')
          && state.messages.length === settledMessageCount && JSON.stringify(turnDispatchIds()) === settledDispatchIds
          && !uncertainExecutions().some(row => row.sessionId === state.sessionId && row.turnId === state.turnId)) {
          continuation.status = 'model-retry';
          continuation.state.approvalDelivered = true;
          continuation.state.messages = safePersistedMessages(state.messages);
          continuation.state.cycle = modelRetryCycle;
          continuation.state.totalCalls = state.callBudget?.used ?? state.totalCalls;
          continuation.state.scope = { ...state.scope };
          continuation.state.manifest = structuredClone(state.manifest);
          delete continuation.state.pendingCalls;
          delete continuation.state.pendingCallIndex;
          delete continuation.state.settledCalls;
          if (error?.usage) continuation.state.usage = structuredClone(error.usage);
          if (state.configurationObservation) continuation.state.configurationObservation = structuredClone(state.configurationObservation);
          save();
        }
        throw error;
      }
      delete continuations[String(approvalId)];
      try { save(); }
      catch (error) {
        continuations[String(approvalId)] = continuation;
        throw error;
      }
      return withConfiguration(state, { ...resumed, target: continuation.target, targetKind: continuation.targetKind });
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async function resumeApproval(options = {}) {
    const id = String(options.approvalId ?? '');
    if (activeResumes.has(id)) fail('APPROVAL_CONTINUATION_BUSY', 'This exact approval result is already being delivered');
    activeResumes.add(id);
    try { return await resumeApprovalInternal(options); }
    finally { activeResumes.delete(id); }
  }

  function cancelSession(sessionId, reason = 'chat-deleted') {
    const wanted = String(sessionId ?? '');
    if (!wanted) return { cancelled: 0 };
    let cancelled = 0;
    let changed = false;
    for (const [approvalId, continuation] of Object.entries(continuations)) {
      if (continuation.target?.sessionId !== wanted) continue;
      let approval;
      try {
        approval = capabilityBroker.approvals?.get(approvalId);
        if (approval?.status === 'pending') capabilityBroker.approvals.cancel(approvalId, reason);
        else if (approval?.status === 'approved') capabilityBroker.approvals.revoke(approvalId, reason);
        approval = capabilityBroker.approvals?.get(approvalId);
      } catch (error) {
        if (!['APPROVAL_NOT_FOUND', 'APPROVAL_EXPIRED'].includes(error?.code)) throw error;
      }
      delete continuations[approvalId];
      for (const [id, row] of Object.entries(executions)) if (row?.approvalId === approvalId && row.status === 'approval-pending') {
        const dispatch = capabilityBroker.dispatchStatus?.(id)
          ?? capabilityBroker.dispatchStatus?.(approval?.request?.requestId);
        const knownUnexecuted = dispatch?.status === 'failed-no-effect'
          || !dispatch && ['cancelled', 'rejected', 'revoked'].includes(approval?.status);
        // A local pending marker does not undo a consumed approval or an
        // accepted Broker effect. Retain it until normal Owner reconciliation.
        recordExecution(id, { status: knownUnexecuted ? 'failed' : 'outcome-unknown', settledAt: Date.now(),
          code: knownUnexecuted ? 'INVOKE_CANCELLED' : 'APPROVAL_DISPATCH_RECOVERY_REQUIRED',
          ...(dispatch ? { observedDispatchStatus: dispatch.status } : {}) });
      }
      cancelled += 1;
      changed = true;
    }
    if (changed) save();
    return { cancelled };
  }

  function pendingTarget(approvalId) {
    const entry = continuations[String(approvalId ?? '')];
    return entry && entry.status !== 'orphaned' && entry.status !== 'reconciled'
      && (entry.status !== 'resuming' || activeResumes.has(String(approvalId)))
      ? { ...entry.target, kind: entry.targetKind ?? 'chat' } : null;
  }

  capabilityBroker.setReadContextResolver?.(resolvePendingReadContext);
  return { run, executeReadBatch, readHistory, resumeApproval, recordApprovalOutcomeUnknown, pendingTarget, cancelSession, recoveryForSession, recoveryForTask,
    acknowledgeTaskRecovery,
    taskReviewState(taskId) {
      return {
        executions: Object.entries(executions).filter(([,row]) => row?.taskId === taskId
          && ['started','outcome-unknown'].includes(row.status)).map(([id,row]) => [id,row.status]),
        continuations: Object.entries(continuations).filter(([,row]) => row?.state?.scope?.taskId === taskId
          && row.status !== 'reconciled').map(([id,row]) => [id,row.status])
      };
    } };
}

