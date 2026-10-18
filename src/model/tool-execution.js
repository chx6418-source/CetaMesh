import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic, StorageError } from '../storage/json-file.js';
import { redactText, isSensitiveKey } from '../logging/redact.js';
import { capabilityError } from '../capability/types.js';

const MAX_BATCH_CALLS = 8;
const MAX_TOOL_CYCLES = 6;
const MAX_TOTAL_CALLS = 24;
const MAX_RESULT_CHARS = 12000;
const AUTHORITY_KEYS = new Set([
  'actor', 'actorid', 'grants', 'taskid', 'workspaceid', 'scope', 'approved', 'approvalid',
  'requestid', 'principal', 'permissions', 'capabilities', 'provider', 'providerid'
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

function validateSchema(schema, value, location = '$', depth = 0) {
  if (depth > 8 || !schema || typeof schema !== 'object') fail('TOOL_ARGUMENTS_INVALID', `${location}: invalid schema`);
  const type = schema.type;
  const validType = type === 'object' ? isPlainObject(value)
    : type === 'array' ? Array.isArray(value)
      : type === 'string' ? typeof value === 'string'
        : type === 'integer' ? Number.isSafeInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type === 'boolean' ? typeof value === 'boolean'
              : false;
  if (!validType) fail('TOOL_ARGUMENTS_INVALID', `${location}: expected ${String(type)}`);
  if (type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) fail('TOOL_ARGUMENTS_INVALID', `${location}.${name}: required`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, name)) {
        if (schema.additionalProperties !== true) fail('TOOL_ARGUMENTS_INVALID', `${location}.${name}: unexpected property`);
        continue;
      }
      validateSchema(properties[name], child, `${location}.${name}`, depth + 1);
    }
  } else if (type === 'array') {
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) fail('TOOL_ARGUMENTS_INVALID', `${location}: too many items`);
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) fail('TOOL_ARGUMENTS_INVALID', `${location}: too few items`);
    if (schema.items) value.forEach((child, index) => validateSchema(schema.items, child, `${location}[${index}]`, depth + 1));
  } else if (type === 'string') {
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) fail('TOOL_ARGUMENTS_INVALID', `${location}: too long`);
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) fail('TOOL_ARGUMENTS_INVALID', `${location}: too short`);
  } else if (type === 'number' || type === 'integer') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) fail('TOOL_ARGUMENTS_INVALID', `${location}: below minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) fail('TOOL_ARGUMENTS_INVALID', `${location}: above maximum`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail('TOOL_ARGUMENTS_INVALID', `${location}: value is not allowed`);
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
  let text = redactText(value)
    .replace(/(?:[A-Za-z]:\\|\\\\[^\s"']+|\/(?:Users|home|root|mnt|tmp)\/)[^\s"'<>]*/g, '[LOCAL_PATH]')
    .slice(0, MAX_RESULT_CHARS);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text;
}

function safeValue(value, depth = 0) {
  if (depth > 5) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return stripLocalPaths(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeValue(item, depth + 1));
  if (!isPlainObject(value)) return String(value).slice(0, 200);
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    if (AUTHORITY_KEYS.has(key.toLowerCase())) continue;
    if (isSensitiveKey(key)) { result[String(key).slice(0, 100)] = '[REDACTED:sensitive]'; continue; }
    result[String(key).slice(0, 100)] = safeValue(child, depth + 1);
  }
  return result;
}

function safeJson(value) {
  let text;
  try { text = JSON.stringify(safeValue(value)); }
  catch { text = '{"error":{"code":"RESULT_SERIALIZATION_FAILED"}}'; }
  if (text.length <= MAX_RESULT_CHARS) return text;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  let preview = text.slice(0, MAX_RESULT_CHARS - 300);
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  let envelope = JSON.stringify({ truncated: true, originalChars: text.length, sha256: hash, preview });
  while (envelope.length > MAX_RESULT_CHARS && preview.length) {
    preview = preview.slice(0, Math.max(0, preview.length - (envelope.length - MAX_RESULT_CHARS) - 1));
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    envelope = JSON.stringify({ truncated: true, originalChars: text.length, sha256: hash, preview });
  }
  return envelope;
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
  maxCycles = MAX_TOOL_CYCLES,
  maxCalls = MAX_TOTAL_CALLS,
  maxBatchCalls = MAX_BATCH_CALLS,
  timeoutMs = 300000,
  actorResolver = null
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
  const interruptedExecutions = Object.values(executions).filter(row => row?.status === 'started');
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

  function recordExecution(requestId, data) {
    if (!executionFile) return;
    executions[requestId] = { ...executions[requestId], ...data };
    try { writeJsonAtomic(executionFile, executions); }
    catch (error) {
      if (error instanceof StorageError) fail('TOOL_EXECUTION_PERSIST_FAILED', 'Unable to persist Model tool execution state');
      throw error;
    }
  }

  function recoveryForSession(sessionId) {
    const uncertain = interruptedExecutions.find(row => row.status === 'started' && row.sessionId === sessionId);
    if (uncertain) return { state: 'needs-reconciliation', capability: uncertain.capability, turnId: uncertain.turnId };
    const orphaned = Object.values(continuations).find(row => row.status === 'orphaned' && row.target?.sessionId === sessionId);
    if (orphaned) return { state: 'needs-reconciliation', capability: 'approval', turnId: orphaned.target.turnId };
    const pending = Object.values(continuations).find(row => row.status !== 'reconciled' && row.target?.sessionId === sessionId);
    return pending ? { state: 'approval-pending', approvalId: pending.approvalId, turnId: pending.target.turnId } : null;
  }

  function recoveryForTask(taskId) {
    const uncertain = interruptedExecutions.find(row => row.status === 'started' && row.taskId === taskId);
    if (uncertain) return { state: 'needs-reconciliation', capability: uncertain.capability, turnId: uncertain.turnId };
    const orphaned = Object.values(continuations).find(row => row.status === 'orphaned' && row.state?.scope?.taskId === taskId);
    if (orphaned) return { state: 'needs-reconciliation', capability: 'approval', turnId: orphaned.target.turnId };
    const pending = Object.values(continuations).find(row => row.status !== 'reconciled' && row.state?.scope?.taskId === taskId);
    return pending ? { state: 'approval-pending', approvalId: pending.approvalId, turnId: pending.target.turnId } : null;
  }

  function acknowledgeTaskRecovery(taskId) {
    const rows = interruptedExecutions.filter(row => row.status === 'started' && row.taskId === taskId);
    const orphaned = Object.values(continuations).filter(row => row.status === 'orphaned' && row.state?.scope?.taskId === taskId);
    for (const row of rows) row.status = 'reconciled';
    for (const row of orphaned) row.status = 'reconciled';
    if (rows.length && executionFile) {
      try { writeJsonAtomic(executionFile, executions); }
      catch (error) {
        for (const row of rows) row.status = 'started';
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

  async function runLoop(state, signal) {
    const { providerId, model, reasoning, actor, sessionId, turnId, scope } = state;
    let totalCalls = state.totalCalls ?? 0;
    const seenCallIds = new Set(state.seenCallIds ?? []);
    let text = '';
    let usage = state.usage ?? null;
    let resolvedModel = state.resolvedModel ?? null;
    let limitReached = state.limitReached === true;

    for (let cycle = state.cycle ?? 0; cycle <= maxCycles; cycle++) {
      if (signal?.aborted) fail('INVOKE_CANCELLED', 'Tool execution was cancelled');
      if (cycle > 0 && typeof state.onStreamReset === 'function') {
        await state.onStreamReset({ cycle });
      }
      const resumingToolBatch = Array.isArray(state.pendingCalls);
      const request = {
        providerId, model, reasoning, messages: state.messages, signal,
        tools: cycle < maxCycles && totalCalls < maxCalls ? state.manifest.map((item) => ({ id: item.id, description: item.description, inputSchema: item.inputSchema })) : [],
        toolChoice: cycle < maxCycles && totalCalls < maxCalls ? 'auto' : 'none'
      };
      let response;
      if (resumingToolBatch) {
        response = { text: '', toolCalls: state.pendingCalls, usage, resolvedModel };
      } else if (typeof modelRuntime.stream === 'function') {
        let streamedText = '';
        let streamedToolCalls = [];
        let streamUsage = null;
        let streamResolvedModel = null;
        let streamReason = null;
        for await (const event of modelRuntime.stream(request)) {
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
            streamUsage = event.data?.reason?.usage ?? event.data?.usage ?? streamUsage;
            streamReason = event.data?.reason?.kind ?? streamReason;
            streamResolvedModel = typeof event.data?.resolvedModel === 'string'
              ? event.data.resolvedModel : streamResolvedModel;
          }
        }
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
          toolCalls: streamedToolCalls,
          usage: streamUsage,
          resolvedModel: streamResolvedModel
        };
      } else {
        response = await modelRuntime.chat(request);
      }
      if (typeof response?.text === 'string') text = response.text;
      if (response?.usage && typeof response.usage === 'object') usage = response.usage;
      if (typeof response?.resolvedModel === 'string' && response.resolvedModel.trim()) resolvedModel = response.resolvedModel.trim();
      else if (typeof response?.model === 'string' && response.model.trim()) resolvedModel = response.model.trim();
      const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      if (!calls.length) return { status: limitReached ? 'partial' : 'completed', ...(limitReached ? { code: 'TOOL_CALL_LIMIT' } : {}), toolCalling: 'supported', text, usage, resolvedModel, totalCalls, messages: state.messages };
      const known = new Set(state.manifest.map((item) => item.id));

      const firstCallIndex = resumingToolBatch ? Math.max(0, Number(state.pendingCallIndex) || 0) : 0;
      if (!resumingToolBatch) {
        state.messages.push({
          role: 'assistant',
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
        const toolRequestId = `model:${sessionId}:${turnId}:${cycle}:${index}`.slice(0, 240);
        try {
          input = parseArguments(call?.arguments);
          const descriptor = state.manifest.find((item) => item.id === capability);
          if (!descriptor) fail('UNKNOWN_TOOL_IN_TURN', 'Tool was not authorized in this turn');
          validateSchema(descriptor.inputSchema, input);
          const liveActor = typeof actorResolver === 'function'
            ? await actorResolver({ actorKind: actor.kind, actorId: actor.id, sessionId, turnId, scope: state.scope })
            : actor;
          if (!liveActor || liveActor.kind !== actor.kind || liveActor.id !== actor.id) {
            fail('TOOL_ACTOR_UNAVAILABLE', 'The trusted CetaMesh actor is no longer available');
          }
          recordExecution(toolRequestId, { status: 'started', sessionId, turnId,
            taskId: state.scope?.taskId ?? null, capability, at: Date.now() });
          result = await capabilityBroker.execute({
            requestId: toolRequestId,
            actor: liveActor,
            taskId: state.scope?.taskId ?? null,
            workspaceId: state.scope?.workspaceId ?? null,
            capability,
            input,
            reason: 'Model structured tool call',
            ...(scope?.signal ? { signal: scope.signal } : {})
          }, { signal });
        } catch (error) {
          if (executions[toolRequestId]?.status === 'started' && !capabilityBroker.dispatchStatus?.(toolRequestId)
            && error?.code !== 'INVOKE_CANCEL_UNCONFIRMED' && error?.code !== 'TOOL_EXECUTION_PERSIST_FAILED') {
            recordExecution(toolRequestId, { status: 'failed', code: String(error?.code ?? 'CAPABILITY_DENIED').slice(0, 100) });
          }
          result = { status: 'denied', ...errorResult(error) };
        }

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
              sessionId, turnId, scope: { taskId: scope?.taskId ?? null, workspaceId: scope?.workspaceId ?? null },
              messages: storedState.messages, cycle,
              totalCalls, usage, resolvedModel,
              limitReached,
              seenCallIds: state.seenCallIds,
              pendingToolCallId: callId,
              pendingCapability: capability,
              pendingInput: { path: typeof input.path === 'string' ? input.path : null,
                tool: typeof input.tool === 'string' ? input.tool : null },
              pendingCalls: calls,
              pendingCallIndex: index + 1
            },
            createdAt: Date.now()
          };
          continuations[approvalId] = continuation;
          save();
          recordExecution(toolRequestId, { status: 'approval-pending', approvalId });
          return { status: 'pending', toolCalling: 'supported', approvalId, expiresAt: result.expiresAt, text: '', continuationId: id };
        }

        state.messages.push({
          role: 'tool', tool_call_id: callId,
          content: result?.status === 'completed'
            ? safeJson({ status: result.status, result: result.result })
            : safeJson(result?.error ?? result ?? { status: 'denied', code: 'CAPABILITY_DENIED' })
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
  }

  async function run({ providerId, model, reasoning, messages = [], manifest = [], actor, sessionId, turnId, targetKind = 'chat', scope = {}, signal, refreshContext, onCapabilityResult, onActivity, onTextDelta, onStreamReset } = {}) {
    if (!actor || !['owner', 'agent'].includes(actor.kind) || typeof actor.id !== 'string') fail('UNAUTHORIZED', 'Trusted Model actor required');
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
  }

  async function resumeApproval({ approvalId, requestFingerprint, decisionResult, signal, refreshContext, onCapabilityResult, onTextDelta, onStreamReset } = {}) {
    const continuation = continuations[String(approvalId ?? '')];
    if (!continuation) fail('APPROVAL_CONTINUATION_NOT_FOUND', 'No Model turn is waiting for this approval');
    if (continuation.status === 'orphaned' || continuation.status === 'reconciled') {
      fail('APPROVAL_CONTINUATION_ORPHANED', 'Interrupted Agent approval requires Owner reconciliation');
    }
    if (continuation.requestFingerprint !== requestFingerprint) fail('APPROVAL_MISMATCH', 'Approval continuation fingerprint mismatch');
    if (decisionResult?.status === 'pending') fail('APPROVAL_NOT_DECIDED', 'Approval decision is still pending');
    const state = {
      ...continuation.state,
      manifest: structuredClone(continuation.state.manifest),
      scope: { ...continuation.state.scope },
      messages: continuation.state.messages.map((message) => ({ ...message }))
    };
    if (typeof refreshContext === 'function') state.refreshContext = refreshContext;
    if (typeof onCapabilityResult === 'function') state.onCapabilityResult = onCapabilityResult;
    if (typeof onTextDelta === 'function') state.onTextDelta = onTextDelta;
    if (typeof onStreamReset === 'function') state.onStreamReset = onStreamReset;
    const result = decisionResult?.status === 'completed'
      ? { status: 'completed', result: safeValue(decisionResult.result) }
      : { status: 'rejected', error: { code: 'APPROVAL_REJECTED' } };
    state.messages.push({
      role: 'tool', tool_call_id: state.pendingToolCallId,
      content: safeJson(result)
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

  return { run, resumeApproval, pendingTarget, cancelSession, recoveryForSession, recoveryForTask,
    acknowledgeTaskRecovery };
}
