import { evidenceBinding, evidenceSummary, sanitizeToolEvidence, EVIDENCE_SOURCE_CAPABILITIES, validateEvidenceSourceInput } from '../context/tool-evidence.js';
import { projectMessageBudget } from '../context/message-budget.js';
import { accumulateModelUsage } from './usage.js';
import { validateSchema } from './input-schema.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic, StorageError } from '../storage/json-file.js';
import { redactText, isSensitiveKey } from '../logging/redact.js';
import { capabilityError } from '../capability/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { mayRetrySafeTool, runBoundedRetryAttempt, SAFE_TOOL_RETRY } from './safe-tool-retry.js';

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
  return { error: { code: String(error?.code ?? 'CAPABILITY_DENIED').slice(0, 100) } };
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
    if (continuation?.targetKind !== 'agent' && approval?.status === 'pending'
      && approval.expiresAt > Date.now()) continue;
    if (approval?.status === 'pending' || approval?.status === 'approved') {
      capabilityBroker.approvals.revoke(approvalId, 'core-restart-orphaned-agent');
    }
    continuation.status = 'orphaned';
    orphanedOnRestart = true;
  }
  if (orphanedOnRestart) save();

  // A failed model-journal write followed by stop may remove its continuation.
  // Recover uncertainty from the already durable Broker intent/outcome instead
  // of interpreting an old approval-pending projection as proof of no effect.
  for (const [id, row] of Object.entries(executions)) {
    if (row?.status !== 'approval-pending' || !row.approvalId) continue;
    let dispatch = capabilityBroker.dispatchStatus?.(id);
    if (!dispatch) {
      let approval;
      try { approval = capabilityBroker.approvals?.get(row.approvalId); }
      catch (error) { if (error?.code === 'APPROVAL_NOT_FOUND') continue; throw error; }
      dispatch = capabilityBroker.dispatchStatus?.(approval?.request?.requestId);
    }
    if (dispatch && ['started', 'outcome-unknown', 'completed'].includes(dispatch.status)) {
      recordExecution(id, { status: 'outcome-unknown', code: 'APPROVAL_DISPATCH_RECOVERY_REQUIRED' });
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

  function recoveryForSession(sessionId) {
    const uncertain = uncertainExecutions().find(row => row.sessionId === sessionId);
    if (uncertain) return { state: 'needs-reconciliation', capability: uncertain.capability, turnId: uncertain.turnId };
    const orphaned = Object.values(continuations).find(row => row.status === 'orphaned' && row.target?.sessionId === sessionId);
    if (orphaned) return { state: 'needs-reconciliation', capability: 'approval', turnId: orphaned.target.turnId };
    const pending = Object.values(continuations).find(row => row.status !== 'reconciled' && row.target?.sessionId === sessionId);
    return pending ? { state: 'approval-pending', approvalId: pending.approvalId, turnId: pending.target.turnId } : null;
  }

  function recoveryForTask(taskId) {
    const uncertain = uncertainExecutions().find(row => row.taskId === taskId);
    if (uncertain) return { state: 'needs-reconciliation', capability: uncertain.capability, turnId: uncertain.turnId };
    const orphaned = Object.values(continuations).find(row => row.status === 'orphaned' && row.state?.scope?.taskId === taskId);
    if (orphaned) return { state: 'needs-reconciliation', capability: 'approval', turnId: orphaned.target.turnId };
    const pending = Object.values(continuations).find(row => row.status !== 'reconciled' && row.state?.scope?.taskId === taskId);
    return pending ? { state: 'approval-pending', approvalId: pending.approvalId, turnId: pending.target.turnId } : null;
  }

  function acknowledgeTaskRecovery(taskId) {
    const rows = uncertainExecutions().filter(row => row.taskId === taskId);
    const previousStatuses = rows.map(row => row.status);
    const orphaned = Object.values(continuations).filter(row => row.status === 'orphaned' && row.state?.scope?.taskId === taskId);
    for (const row of rows) row.status = 'reconciled';
    for (const row of orphaned) row.status = 'reconciled';
    if (rows.length && executionFile) {
      try { writeJsonAtomic(executionFile, executions); }
      catch (error) {
        rows.forEach((row, index) => { row.status = previousStatuses[index]; });
        for (const row of orphaned) row.status = 'orphaned';
        if (error instanceof StorageError) fail('TOOL_EXECUTION_PERSIST_FAILED', 'Unable to persist Model tool reconciliation');
        throw error;
      }
    }
    if (orphaned.length) {
      try { save(); }
      catch (error) {
        for (const row of orphaned) row.status = 'orphaned';
        throw error;
      }
    }
    return { reconciled: rows.length + orphaned.length };
  }

  function completedResultContent(result, state, capability, input) {
    const value = { status: 'completed', result: result.result };
    if (evidenceStore && EVIDENCE_SOURCE_CAPABILITIES.includes(capability) && input
      && state.manifest.some(item => item.id === 'context.evidence.read' && item.available !== false)) {
      try {
        const content = sanitizeToolEvidence(value);
        if (content.length > MAX_RESULT_CHARS) {
          const reference = evidenceStore.put({ binding: evidenceBinding(state), content,
            sourceCapability: capability, sourceInput: input });
          return evidenceSummary(content, reference);
        }
      } catch { return safeJson({ ...value, evidenceUnavailable: { code: 'TOOL_EVIDENCE_UNAVAILABLE', note: 'No stored source is available; request a smaller result.' } }); }
    }
    return safeJson(value);
  }

  async function recordUsage(state, usage) {
    if (typeof onUsage !== 'function') return;
    try { await onUsage({ sessionId: state.sessionId, turnId: state.turnId,
      taskId: state.accountingTaskId ?? null, providerId: state.providerId ?? null,
      model: state.model ?? null, usage }); }
    catch { fail('TOOL_USAGE_PERSIST_FAILED', 'Request usage could not be durably recorded'); }
  }

  async function runLoop(state, signal) {
    const { providerId, model, reasoning, actor, sessionId, turnId, scope } = state;
    let totalCalls = state.totalCalls ?? 0;
    const seenCallIds = new Set(state.seenCallIds ?? []);
    let text = '';
    let usage = state.usage ?? null;
    let resolvedModel = state.resolvedModel ?? null;
    let limitReached = state.limitReached === true;
    let activeRequestId = null;
    let activeUsage = null;

    try {
    for (let cycle = state.cycle ?? 0; cycle <= maxCycles; cycle++) {
      if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
      if (cycle > 0 && typeof state.onStreamReset === 'function') {
        await state.onStreamReset({ cycle });
      }
      const resumingToolBatch = Array.isArray(state.pendingCalls);
      const toolsAllowed = cycle < maxCycles && totalCalls < maxCalls;
      const request = {
        providerId, model, reasoning, messages: toolsAllowed || finalSynthesisAtLimit !== true ? state.messages : [...state.messages, { role: 'system', content: 'The bounded tool budget is exhausted. Do not request or simulate more tools. Summarize the verified results already available, explain any missing evidence, and answer the user now. Do not claim unperformed work is complete.' }], signal,
        tools: toolsAllowed || finalSynthesisAtLimit !== true ? state.manifest.map((item) => ({ id: item.id, description: item.description, inputSchema: item.inputSchema })) : [],
        toolChoice: cycle < maxCycles && totalCalls < maxCalls ? 'auto' : 'none'
      };
      if (!resumingToolBatch && !toolsAllowed && finalSynthesisAtLimit !== true) limitReached = true;
      if (!resumingToolBatch) request.messages = projectMessageBudget(request.messages, { evidenceStore, binding: evidenceBinding(state), canRetrieveEvidence: state.manifest.some(item => item.id === 'context.evidence.read' && item.available !== false) }).messages;
      let response;
      if (resumingToolBatch) {
        response = { text: '', toolCalls: state.pendingCalls, usage, resolvedModel };
      } else if (typeof modelRuntime.stream === 'function') {
        activeRequestId = `${turnId ?? 'turn'}:${cycle}`;
        activeUsage = null;
        let streamedText = '';
        let streamedToolCalls = [];
        let streamUsage = null;
        let streamResolvedModel = null;
        let streamReason = null;
        let modelContinuation = null;
        for await (const event of modelRuntime.stream(request)) {
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
        usage = accumulateModelUsage(usage, streamUsage, { requestId: activeRequestId, providerId, model: streamResolvedModel ?? model ?? null });
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
          resolvedModel: streamResolvedModel
        };
      } else {
        activeRequestId = `${turnId ?? 'turn'}:${cycle}`;
        activeUsage = null;
        response = await modelRuntime.chat(request);
        activeRequestId = null;
      }
      if (typeof response?.text === 'string') text = response.text;
      if (!resumingToolBatch) usage = accumulateModelUsage(usage, response?.usage, {
        requestId: `${turnId ?? 'turn'}:${cycle}`, providerId, model: response?.resolvedModel ?? response?.model ?? model ?? null
      });
      if (!resumingToolBatch) await recordUsage(state, usage);
      if (typeof response?.resolvedModel === 'string' && response.resolvedModel.trim()) resolvedModel = response.resolvedModel.trim();
      else if (typeof response?.model === 'string' && response.model.trim()) resolvedModel = response.model.trim();
      const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      if (!calls.length) return { status: limitReached ? 'partial' : 'completed', ...(limitReached ? { code: 'TOOL_CALL_LIMIT' } : {}), toolCalling: 'supported', text, usage, resolvedModel, totalCalls, messages: state.messages, ...(response?.modelContinuation ? { modelContinuation: response.modelContinuation } : {}) };
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
      }
      delete state.pendingCalls;
      delete state.pendingCallIndex;

      for (let index = firstCallIndex; index < calls.length; index++) {
        const call = calls[index];
        const callId = String(call?.id || `call-${cycle}-${index}`).slice(0, 200);
        if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
        if (seenCallIds.has(callId)) {
          state.messages.push({ role: 'tool', tool_call_id: callId, content: safeJson({ error: { code: 'DUPLICATE_TOOL_CALL' } }) });
          continue;
        }
        seenCallIds.add(callId);
        state.seenCallIds = [...seenCallIds].slice(-MAX_TOTAL_CALLS);
        if (index >= maxBatchCalls || totalCalls >= maxCalls || cycle >= maxCycles) {
          limitReached = true;
          state.limitReached = true;
          state.messages.push({ role: 'tool', tool_call_id: callId, content: safeJson({ error: { code: 'TOOL_CALL_LIMIT' } }) });
          continue;
        }
        totalCalls += 1;
        const capability = capabilityFromCall(call, known);
        const activityId = `${turnId}:${callId}`.slice(0, 200);
        const activityStartedAt = Date.now();
        if (typeof state.onActivity === 'function') {
          await state.onActivity({ id: activityId, capability, status: 'running', durationMs: null });
        }
        let result;
        let input;
        const baseToolRequestId = 'model:' + crypto.createHash('sha256')
          .update(JSON.stringify([sessionId, turnId, cycle, index])).digest('hex');
        let toolRequestId = baseToolRequestId;
        let retryCount = 0;
        try {
          input = parseArguments(call?.arguments);
          const descriptor = state.manifest.find((item) => item.id === capability);
          if (!descriptor) fail('UNKNOWN_TOOL_IN_TURN', 'Tool was not authorized in this turn');
          const registered = capabilityBroker.registry?.require(capability) ?? descriptor;
          const hasEffect = (registered.effect && registered.effect !== 'read-only')
            || ['message.send', 'filesystem.write', 'git.commit', 'test.run', 'publish', 'network'].includes(registered.permission ?? capability);
          validateSchema(descriptor.inputSchema, input);
          const retryStartedAt = Date.now();
          let retryError = null;
          for (let attempt = 0; attempt < SAFE_TOOL_RETRY.maxAttempts; attempt++) {
            if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
            if (attempt && Date.now() - retryStartedAt > SAFE_TOOL_RETRY.deadlineMs) throw retryError;
            toolRequestId = attempt ? `${baseToolRequestId}:r${attempt}` : baseToolRequestId;
            // Both the trusted actor and the Broker policy are resolved afresh on each attempt.
            const liveActor = typeof actorResolver === 'function'
              ? await actorResolver({ actorKind: actor.kind, actorId: actor.id, sessionId, turnId, scope: state.scope })
              : actor;
            if (!liveActor || liveActor.kind !== actor.kind || liveActor.id !== actor.id) {
              fail('TOOL_ACTOR_UNAVAILABLE', 'The trusted CetaMesh actor is no longer available');
            }
            if (attempt && Date.now() - retryStartedAt >= SAFE_TOOL_RETRY.deadlineMs) throw retryError;
            recordExecution(toolRequestId, { status: 'started', sessionId, turnId,
              taskId: state.scope?.taskId ?? null, capability, at: Date.now() });
            try {
              const executeBroker = attemptSignal => capabilityBroker.execute({
                requestId: toolRequestId, actor: liveActor,
                ...(hasEffect && !registered.delegatesOperation && state.scope?.taskId && state.scope?.workspaceId ? {
                  operationId: 'tool:' + crypto.createHash('sha256').update(baseToolRequestId).digest('hex')
                } : {}),
                taskId: state.scope?.taskId ?? null,
                workspaceId: state.scope?.workspaceId ?? null,
                capability, input, reason: 'Model structured tool call',
                origin: { sessionId, turnId, targetKind: state.targetKind },
                ...(attemptSignal ? { signal: attemptSignal } : {})
              }, { signal: attemptSignal });
              result = attempt
                ? await runBoundedRetryAttempt(executeBroker, { signal,
                  remainingMs: SAFE_TOOL_RETRY.deadlineMs - (Date.now() - retryStartedAt) })
                : await executeBroker(signal);
              break;
            } catch (error) {
              if (!mayRetrySafeTool({ capability, error, attempt, startedAt: retryStartedAt,
                signal, dispatchStatus: capabilityBroker.dispatchStatus?.(toolRequestId) })) throw error;
              retryError = error;
              recordExecution(toolRequestId, { status: 'failed', code: String(error.code).slice(0, 100) });
              retryCount = attempt + 1;
              if (typeof state.onActivity === 'function') {
                await state.onActivity({ id: activityId, capability, status: 'retrying',
                  retryCount, durationMs: Date.now() - activityStartedAt });
              }
              await delay(SAFE_TOOL_RETRY.delayMs, undefined, { signal });
            }
          }
        } catch (error) {
          if (executions[toolRequestId]?.status === 'started' && !capabilityBroker.dispatchStatus?.(toolRequestId)
            && error?.code !== 'INVOKE_CANCEL_UNCONFIRMED' && error?.code !== 'TOOL_EXECUTION_PERSIST_FAILED') {
            recordExecution(toolRequestId, { status: 'failed', code: String(error?.code ?? 'CAPABILITY_DENIED').slice(0, 100) });
          }
          result = { status: error?.effectStatus === 'unknown' ? 'outcome-unknown' : 'denied', ...errorResult(error) };
        }
        if (result && typeof result === 'object') result = { ...result, retryCount };

        if (result?.status === 'pending') {
          if (typeof state.onActivity === 'function') {
            await state.onActivity({ id: activityId, capability, status: 'waiting-approval', durationMs: Date.now() - activityStartedAt });
          }
          const approvalId = String(result.approvalId ?? '');
          let fingerprint = '';
          try { fingerprint = capabilityBroker.approvals?.get(approvalId)?.fingerprint ?? ''; }
          catch { fingerprint = ''; }
          if (!approvalId || !fingerprint) fail('APPROVAL_CONTINUATION_INVALID', 'Broker returned an invalid approval reference');
          const id = crypto.randomUUID();
          const storedState = { ...state, messages: safePersistedMessages(state.messages) };
          delete storedState.refreshContext;
          delete storedState.onCapabilityResult;
          const continuation = {
            id, approvalId, requestFingerprint: fingerprint,
            target: { sessionId, turnId },
            targetKind: state.targetKind,
            state: {
              providerId, model: model ?? null, reasoning: reasoning ?? null,
              manifest: structuredClone(state.manifest), actor: { kind: actor.kind, id: actor.id },
              sessionId, turnId, accountingTaskId: state.accountingTaskId ?? null, scope: { taskId: scope?.taskId ?? null, workspaceId: scope?.workspaceId ?? null },
              messages: storedState.messages, cycle,
              totalCalls, usage, resolvedModel,
              limitReached,
              seenCallIds: state.seenCallIds,
              pendingToolCallId: callId,
              pendingCapability: capability,
              pendingInput: { path: typeof input.path === 'string' ? input.path : null,
                tool: typeof input.tool === 'string' ? input.tool : null },
              pendingEvidenceInput: (() => {
                if (!evidenceStore || !EVIDENCE_SOURCE_CAPABILITIES.includes(capability)
                  || !state.manifest.some(item => item.id === 'context.evidence.read' && item.available !== false)) return null;
                try {
                  if (Buffer.byteLength(JSON.stringify(input)) > 65536) return null;
                  return structuredClone(validateEvidenceSourceInput(input));
                } catch { return null; }
              })(),
              pendingCalls: calls,
              pendingCallIndex: index + 1
            },
            createdAt: Date.now()
          };
          continuations[approvalId] = continuation;
          save();
          recordExecution(toolRequestId, { status: 'approval-pending', approvalId });
          return { status: 'pending', toolCalling: 'supported', approvalId, expiresAt: result.expiresAt, text: '', usage, resolvedModel, continuationId: id };
        }

        state.messages.push({
          role: 'tool', tool_call_id: callId,
          content: result?.status === 'completed'
            ? completedResultContent(result, state, capability, input)
            : safeJson(result?.status === 'outcome-unknown' ? result
              : result?.error ?? result ?? { status: 'denied', code: 'CAPABILITY_DENIED' })
        });
        if (typeof state.onActivity === 'function') {
          await state.onActivity({
            id: activityId, capability,
            status: result?.status === 'completed' ? 'completed' : 'failed',
            durationMs: Date.now() - activityStartedAt
          });
        }
        if (typeof state.onCapabilityResult === 'function') {
          await state.onCapabilityResult({ capability, result, input, eventId: activityId,
            sessionId, turnId, scope: state.scope });
        }
        if (result?.status === 'outcome-unknown') {
          // The Broker owns reconciliation of this dispatch. No model recovery turn or
          // subsequent tool call may replay an effect whose outcome is still unknown.
          recordExecution(toolRequestId, { status: 'outcome-unknown', code: result.error?.code ?? 'OUTCOME_UNKNOWN' });
          return { status: 'partial', code: 'OUTCOME_UNKNOWN', toolCalling: 'supported',
            text: '', usage, resolvedModel, totalCalls };
        }
        if (typeof state.refreshContext === 'function') {
          const refreshed = await state.refreshContext({ capability, result, sessionId, turnId, scope: state.scope });
          if (refreshed && typeof refreshed === 'object') {
            if (Array.isArray(refreshed.manifest)) state.manifest = refreshed.manifest;
            if (typeof refreshed.context === 'string' && refreshed.context.trim()) {
              const marker = 'CetaMesh dynamic context (JSON reference data):\n';
              const existing = state.messages.findIndex((message) => message.role === 'system' && String(message.content ?? '').startsWith(marker));
              const contextMessage = { role: 'system', content: marker + refreshed.context };
              if (existing >= 0) state.messages[existing] = contextMessage;
              else state.messages.splice(Math.min(2, state.messages.length), 0, contextMessage);
            }
            if (refreshed.scope && typeof refreshed.scope === 'object') {
              state.scope = { taskId: refreshed.scope.taskId ?? null, workspaceId: refreshed.scope.workspaceId ?? null };
            }
          }
        }
        if (executions[toolRequestId]?.status === 'started') {
          recordExecution(toolRequestId, { status: result?.status === 'completed' ? 'completed' : 'failed' });
        }
      }
    }
    return { status: 'partial', code: 'TOOL_CALL_LIMIT', toolCalling: 'supported', text, usage, resolvedModel, totalCalls, messages: state.messages };
    } catch (error) {
      // A failed transport may still be billable, but its usage is unknown. Keep
      // earlier receipts and a distinct unknown attempt rather than reporting 0.
      if (activeRequestId) usage = accumulateModelUsage(usage, activeUsage, {
        requestId: `${activeRequestId}:failed:${crypto.randomUUID()}`, providerId, model: model ?? null
      });
      if (activeRequestId) {
        try { await recordUsage(state, usage); }
        catch { if (error && typeof error === 'object') error.accountingWarning = 'TOOL_USAGE_PERSIST_FAILED'; }
      }
      if (usage && error && typeof error === 'object') error.usage = { ...usage, accountingComplete: false };
      throw error;
    }
  }

  async function run({ providerId, model, reasoning, messages = [], manifest = [], actor, sessionId, turnId, targetKind = 'chat', scope = {}, signal, refreshContext, onCapabilityResult, onActivity, onTextDelta, onStreamReset } = {}) {
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
      return await runLoop({
        providerId, model, reasoning, manifest: safeManifest, actor,
        sessionId: String(sessionId ?? 'session').slice(0, 160),
        turnId: String(turnId ?? crypto.randomUUID()).slice(0, 160),
        targetKind: targetKind === 'agent' ? 'agent' : 'chat',
        accountingTaskId: scope.taskId ?? null,
        scope: { taskId: scope.taskId ?? null, workspaceId: scope.workspaceId ?? null },
        messages: structuredClone(messages), cycle: 0, totalCalls: 0,
        ...(typeof onActivity === 'function' ? { onActivity } : {}),
        ...(typeof onTextDelta === 'function' ? { onTextDelta } : {}),
        ...(typeof onStreamReset === 'function' ? { onStreamReset } : {}),
        ...(typeof refreshContext === 'function' ? { refreshContext } : {}),
        ...(typeof onCapabilityResult === 'function' ? { onCapabilityResult } : {})
      }, controller.signal);
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

  async function resumeApproval({ approvalId, requestFingerprint, decisionResult, signal, refreshContext, onCapabilityResult, onTextDelta, onStreamReset } = {}) {
    const continuation = continuations[String(approvalId ?? '')];
    if (!continuation) fail('APPROVAL_CONTINUATION_NOT_FOUND', 'No Model turn is waiting for this approval');
    if (continuation.status === 'orphaned' || continuation.status === 'reconciled') {
      fail('APPROVAL_CONTINUATION_ORPHANED', 'Interrupted Agent approval requires Owner reconciliation');
    }
    if (continuation.requestFingerprint !== requestFingerprint) fail('APPROVAL_MISMATCH', 'Approval continuation fingerprint mismatch');
    if (decisionResult?.status === 'pending') fail('APPROVAL_NOT_DECIDED', 'Approval decision is still pending');
    if (decisionResult?.status === 'outcome-unknown') {
      recordApprovalOutcomeUnknown({ approvalId, requestFingerprint, decisionResult });
      if (typeof onCapabilityResult === 'function') await onCapabilityResult({
        capability: continuation.state.pendingCapability, result: decisionResult,
        input: continuation.state.pendingInput ?? {},
        eventId: `${continuation.target.turnId}:${continuation.state.pendingToolCallId}`.slice(0, 240),
        ...continuation.target, scope: continuation.state.scope
      });
      delete continuations[String(approvalId)];
      try { save(); } catch (error) { continuations[String(approvalId)] = continuation; throw error; }
      return { status: 'partial', code: 'OUTCOME_UNKNOWN', toolCalling: 'supported', text: '',
        usage: continuation.state.usage ?? null, resolvedModel: continuation.state.resolvedModel ?? null,
        totalCalls: continuation.state.totalCalls, target: continuation.target, targetKind: continuation.targetKind };
    }
    // Distinguish a durably consumed result from a stale pending projection;
    // startup must review the latter even if the external effect completed late.
    for (const [id, row] of Object.entries(executions)) {
      if (row?.approvalId === approvalId) recordExecution(id, {
        status: decisionResult?.status === 'completed' ? 'completed' : 'failed'
      });
    }
    const state = {
      ...continuation.state,
      targetKind: continuation.targetKind,
      manifest: structuredClone(continuation.state.manifest),
      scope: { ...continuation.state.scope },
      messages: continuation.state.messages.map((message) => ({ ...message }))
    };
    if (typeof refreshContext === 'function') state.refreshContext = refreshContext;
    if (typeof onCapabilityResult === 'function') state.onCapabilityResult = onCapabilityResult;
    if (typeof onTextDelta === 'function') state.onTextDelta = onTextDelta;
    if (typeof onStreamReset === 'function') state.onStreamReset = onStreamReset;
    const result = decisionResult?.status === 'completed'
      ? { status: 'completed', result: decisionResult.result }
      : { status: 'rejected', error: { code: 'APPROVAL_REJECTED' } };
    state.messages.push({
      role: 'tool', tool_call_id: state.pendingToolCallId,
      content: result.status === 'completed' ? completedResultContent(result, state, state.pendingCapability, state.pendingEvidenceInput) : safeJson(result)
    });
    if (typeof state.onCapabilityResult === 'function' && state.pendingCapability) {
      await state.onCapabilityResult({ capability: state.pendingCapability, result,
        input: state.pendingInput ?? {},
        eventId: `${continuation.target.turnId}:${state.pendingToolCallId}`.slice(0, 240),
        sessionId: continuation.target.sessionId, turnId: continuation.target.turnId, scope: state.scope });
    }
    state.pendingCalls = structuredClone(continuation.state.pendingCalls ?? []);
    state.pendingCallIndex = Math.max(0, Number(continuation.state.pendingCallIndex) || 0);
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
    try {
      const resumed = await runLoop(state, controller.signal);
      delete continuations[String(approvalId)];
      try { save(); }
      catch (error) {
        continuations[String(approvalId)] = continuation;
        throw error;
      }
      return { ...resumed, target: continuation.target, targetKind: continuation.targetKind };
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  function cancelSession(sessionId, reason = 'chat-deleted') {
    const wanted = String(sessionId ?? '');
    if (!wanted) return { cancelled: 0 };
    let cancelled = 0;
    let changed = false;
    for (const [approvalId, continuation] of Object.entries(continuations)) {
      if (continuation.target?.sessionId !== wanted) continue;
      try {
        const row = capabilityBroker.approvals?.get(approvalId);
        if (row?.status === 'pending') capabilityBroker.approvals.cancel(approvalId, reason);
      } catch (error) {
        if (!['APPROVAL_NOT_FOUND', 'APPROVAL_EXPIRED'].includes(error?.code)) throw error;
      }
      delete continuations[approvalId];
      cancelled += 1;
      changed = true;
    }
    if (changed) save();
    return { cancelled };
  }

  function pendingTarget(approvalId) {
    const entry = continuations[String(approvalId ?? '')];
    return entry && entry.status !== 'orphaned' && entry.status !== 'reconciled'
      ? { ...entry.target, kind: entry.targetKind ?? 'chat' } : null;
  }

  return { run, resumeApproval, recordApprovalOutcomeUnknown, pendingTarget, cancelSession, recoveryForSession, recoveryForTask,
    acknowledgeTaskRecovery };
}

