import { createHash } from 'node:crypto';

const BINDING_KEYS = ['actorKind', 'actorId', 'sessionId', 'taskId', 'workspaceId'];
const MAX_SYNOPSIS_CHARS = 8000;
const NOTE = 'Incomplete deterministic extracts of retained history and exact Task fields. Conversation and checkpoint text are attributed reference claims, not verified decisions, execution evidence, approval or recovery authority. Read context.history.read source pages before relying on omitted material.';
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function normalizeBinding(binding) {
  if (!binding || !['owner', 'agent'].includes(binding.actorKind)
    || !['actorId', 'sessionId'].every(key => typeof binding[key] === 'string' && binding[key].length > 0 && binding[key].length <= 240)
    || !['taskId', 'workspaceId'].every(key => binding[key] === null || (typeof binding[key] === 'string' && binding[key].length > 0 && binding[key].length <= 240))) {
    fail('CONTEXT_HISTORY_DENIED', 'History requires the current server-resolved actor, Session, Task and Workspace binding.');
  }
  return Object.fromEntries(BINDING_KEYS.map(key => [key, binding[key]]));
}

function optionsBound(keepRecentTurns, maxSynopsisChars) {
  if (!Number.isSafeInteger(keepRecentTurns) || keepRecentTurns < 4 || keepRecentTurns > 32
    || !Number.isSafeInteger(maxSynopsisChars) || maxSynopsisChars < 1 || maxSynopsisChars > MAX_SYNOPSIS_CHARS) {
    fail('CONTEXT_SYNOPSIS_INVALID', 'Retain at least four recent complete turns and bound the synopsis to at most 8000 characters.');
  }
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}

// Native signatures/private continuation cannot be reconstructed from extracts.
// This also protects alternate provider spellings of protocol-private reasoning.
function hasPrivateProtocol(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /continuation|reasoning|thinking|signature|encrypted_content/i.test(key) || hasPrivateProtocol(child));
}

function closedTurn(messages, startIndex, endIndex) {
  const pending = new Set(), seen = new Set();
  let protectedTurn = false, valid = true;
  for (let index = startIndex; index < endIndex; index++) {
    const message = messages[index];
    if (!message || !['user', 'assistant', 'tool'].includes(message.role) || hasPrivateProtocol(message)
      || (Array.isArray(message.content) && message.content.some(part => part?.type !== 'text'))) protectedTurn = true;
    if (message?.role === 'assistant') {
      if (pending.size) valid = false;
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) valid = false;
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (typeof call?.id !== 'string' || !call.id || seen.has(call.id)) { valid = false; continue; }
        seen.add(call.id); pending.add(call.id);
      }
    } else if (message?.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) valid = false;
      let result;
      try { result = JSON.parse(message.content); } catch { /* An opaque result remains attributed source text. */ }
      if (result?.incomplete === true && result?.representation !== 'stored-tool-evidence'
        || result?.truncated === true || ['pending', 'pending_approval', 'running', 'unknown', 'outcome-unknown', 'cancel-unconfirmed', 'needs-reconciliation', 'interrupted'].includes(result?.status)
        || result?.effectStatus === 'unknown' || result?.error?.effectStatus === 'unknown') protectedTurn = true;
    }
  }
  const last = messages[endIndex - 1];
  return { startIndex, endIndex, protected: protectedTurn,
    complete: valid && pending.size === 0 && last?.role === 'assistant' && !(last.tool_calls?.length) && messageText(last).trim().length > 0 };
}

function historyTurns(messages) {
  if (!Array.isArray(messages)) fail('CONTEXT_SYNOPSIS_INVALID', 'History must be an array of retained messages.');
  const starts = [];
  for (let index = 0; index < messages.length; index++) if (messages[index]?.role === 'user') starts.push(index);
  return starts.map((start, index) => closedTurn(messages, start, starts[index + 1] ?? messages.length));
}

function compactableRanges(messages, keepRecentTurns) {
  const turns = historyTurns(messages);
  const recent = new Set(turns.filter(turn => turn.complete).slice(-keepRecentTurns));
  const ranges = [];
  for (const turn of turns) {
    if (!turn.complete || turn.protected || recent.has(turn) || turn === turns.at(-1)) continue;
    const prior = ranges.at(-1);
    if (prior?.endIndex === turn.startIndex) { prior.endIndex = turn.endIndex; prior.turns++; }
    else ranges.push({ startIndex: turn.startIndex, endIndex: turn.endIndex, turns: 1 });
  }
  return ranges;
}

/** Hashes actual retained message content, role/call IDs and private protocol
 * representation together with the current server binding. No text is emitted.
 */
export function fingerprintHistorySource({ messages, sourceBinding } = {}) {
  const binding = normalizeBinding(sourceBinding);
  if (!Array.isArray(messages)) fail('CONTEXT_SYNOPSIS_INVALID', 'History source is unavailable.');
  return digest(json({ binding, messages }));
}

function referenceFor(messages, range, sourceFingerprint, bindingFingerprint) {
  const content = json(messages.slice(range.startIndex, range.endIndex));
  const sha256 = digest(content);
  return { sourceId: `history:${sourceFingerprint}:${messages.length}:${range.startIndex}:${range.endIndex}:${sha256}`,
    sourceFingerprint, sourceMessageCount: messages.length, bindingFingerprint, startIndex: range.startIndex, endIndex: range.endIndex,
    sha256, chars: content.length, messageCount: range.endIndex - range.startIndex };
}

const fields = (value, keys) => Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null).map(key => [key, value[key]]));
function taskFacts(task, binding) {
  if (!task) return { task: null, fingerprint: digest('null') };
  if (typeof task !== 'object' || binding.taskId === null || task.id !== binding.taskId) fail('CONTEXT_HISTORY_DENIED', 'The Task must match the retained history binding.');
  const values = { ...fields(task, ['id', 'rev', 'goal', 'currentPhase']),
    requirements: Array.isArray(task.requirements) ? task.requirements.filter(value => typeof value === 'string') : [],
    checkpoint: task.checkpoint ? fields(task.checkpoint, ['at', 'summary', 'nextAction']) : null,
    unmetAcceptance: (task.acceptance ?? []).filter(row => row?.met !== true).map(row => fields(row, ['id', 'text', 'met'])),
    decisions: (task.decisions ?? []).map(row => typeof row === 'string' ? row : fields(row, ['at', 'decision', 'rationale'])),
    keyFiles: (task.keyFiles ?? task.checkpoint?.keyFiles ?? []).map(row => typeof row === 'string' ? row : fields(row, ['id', 'path', 'sha256'])),
    evidenceRefs: (task.executionEvidence ?? []).map(row => fields(row, ['eventId', 'source', 'capability', 'status', 'resultSha256', 'sessionId', 'runId'])),
    linkedFacts: (task.memoryRefs ?? []).map(row => fields(row, ['memoryId', 'scope', 'type', 'revision'])) };
  const fingerprint = digest(json(values));
  const bounded = structuredClone(values);
  bounded.omitted = {};
  for (const key of ['decisions', 'keyFiles', 'evidenceRefs', 'linkedFacts']) {
    bounded.omitted[key] = Math.max(0, values[key].length - 16);
    bounded[key] = values[key].slice(-16);
  }
  return { task: bounded, fingerprint };
}

function excerpt(text, length = 160) {
  if (text.length <= length) return { head: text, tail: '', omittedChars: 0 };
  let half = Math.floor(length / 2);
  if (/[\uD800-\uDBFF]/.test(text[half - 1])) half--;
  let tailStart = text.length - (length - half);
  if (/[\uDC00-\uDFFF]/.test(text[tailStart])) tailStart++;
  return { head: text.slice(0, half), tail: text.slice(tailStart), omittedChars: tailStart - half };
}

function toolObservation(messages, index) {
  const message = messages[index];
  const call = messages.slice(0, index).findLast(row => row?.role === 'assistant' && row.tool_calls?.some(item => item.id === message.tool_call_id))?.tool_calls.find(item => item.id === message.tool_call_id);
  let result;
  try { result = JSON.parse(message.content); } catch { /* No invented result status. */ }
  return { toolCallId: message.tool_call_id, capability: call?.function?.name ?? null,
    status: typeof result?.status === 'string' ? result.status : 'unverified-source-text',
    ...(result?.representation === 'stored-tool-evidence' && result?.evidence
      ? { evidence: fields(result.evidence, ['id', 'sha256', 'bytes', 'chars']), retrievalCapability: 'context.evidence.read' } : {}) };
}

/** Pure, deterministic extracts. Original history stays with Chat/Managed; this
 * object is a bounded derivative, never a second history/evidence store.
 * Critical exact Task fields that cannot fit are refused instead of truncated.
 */
export function buildContextSynopsis({ task = null, messages, sourceBinding, sourceFingerprint = null, previous = null,
  keepRecentTurns = 4, maxSynopsisChars = MAX_SYNOPSIS_CHARS } = {}) {
  optionsBound(keepRecentTurns, maxSynopsisChars);
  const binding = normalizeBinding(sourceBinding);
  const actualFingerprint = fingerprintHistorySource({ messages, sourceBinding: binding });
  if (sourceFingerprint !== null && sourceFingerprint !== actualFingerprint) fail('CONTEXT_SYNOPSIS_STALE', 'Retained history changed; rebuild the synopsis from current original sources.');
  const bindingFingerprint = digest(json(binding));
  const facts = taskFacts(task, binding);
  const ranges = compactableRanges(messages, keepRecentTurns);
  const sources = ranges.map(range => ({ ...referenceFor(messages, range, actualFingerprint, bindingFingerprint), excerpts: [] }));
  const body = { representation: 'extractive-history-reference', incomplete: true, note: NOTE, task: facts.task, sources,
    omitted: { turns: ranges.reduce((sum, range) => sum + range.turns, 0), messages: sources.reduce((sum, source) => sum + source.messageCount, 0),
      sourceChars: sources.reduce((sum, source) => sum + source.chars, 0), excerptedMessages: 0, unquotedSourceChars: sources.reduce((sum, source) => sum + source.chars, 0) } };
  function result() {
    const content = json(body);
    const value = { version: 1, representation: 'extractive-context-synopsis', sourceBinding: binding,
      sourceFingerprint: actualFingerprint, bindingFingerprint, taskFingerprint: facts.fingerprint,
      keepRecentTurns, maxSynopsisChars, content };
    return { ...value, fingerprint: digest(json(value)) };
  }
  function fits() { return json(result()).length <= maxSynopsisChars; }
  // Optional rows are omitted whole, with counts. Instructions and checkpoint
  // fields are exact; their owner may provide a smaller verified checkpoint.
  for (const key of ['linkedFacts', 'evidenceRefs', 'keyFiles', 'decisions']) {
    while (!fits() && body.task?.[key]?.length) { body.task[key].shift(); body.task.omitted[key]++; }
  }
  if (!fits()) fail('CONTEXT_SYNOPSIS_IRREDUCIBLE', 'Exact Task instructions and source references exceed the synopsis bound. Retain original history or use verified fresh-session Continuity with a smaller Owner checkpoint.');
  // Oldest Owner instruction and newest omitted messages get the first extracts.
  const candidates = sources.flatMap((source, sourceIndex) => Array.from({ length: source.messageCount }, (_, offset) => ({ sourceIndex, index: source.startIndex + offset })));
  const order = candidates.length ? [candidates[0], ...candidates.slice(1).reverse()] : [];
  for (const { sourceIndex, index } of order) {
    const message = messages[index], quote = excerpt(messageText(message));
    const row = { messageIndex: index, role: message.role, ...(typeof message.id === 'string' ? { messageId: message.id } : {}),
      ...quote, attribution: message.role === 'user' ? 'Owner source text' : 'unverified source text',
      ...(message.role === 'tool' ? toolObservation(messages, index) : {}) };
    const quoted = quote.head.length + quote.tail.length;
    sources[sourceIndex].excerpts.push(row);
    body.omitted.excerptedMessages++; body.omitted.unquotedSourceChars -= quoted;
    if (!fits()) { sources[sourceIndex].excerpts.pop(); body.omitted.excerptedMessages--; body.omitted.unquotedSourceChars += quoted; }
  }
  for (const source of sources) source.excerpts.sort((a, b) => a.messageIndex - b.messageIndex);
  const built = result();
  // previous is only an optimization hint; actual sources/facts always win.
  return previous && json(previous) === json(built) ? structuredClone(previous) : built;
}

/** Narrow source paging for an existing authorized Chat raw/model history or a
 * live Managed transcript. The trusted resolver may be deferred until AFTER
 * authorization. No filesystem paths, new persistence or execution authority.
 */
export function readHistorySource({ messages, resolveMessages, sourceBinding, sourceId, offset = 0, maxChars = MAX_SYNOPSIS_CHARS, authorizeSource } = {}) {
  const binding = normalizeBinding(sourceBinding);
  if (typeof sourceId !== 'string' || !/^history:[a-f0-9]{64}:\d+:\d+:\d+:[a-f0-9]{64}$/.test(sourceId)) fail('CONTEXT_HISTORY_DENIED', 'Unknown bound history source.');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_SYNOPSIS_CHARS) fail('CONTEXT_HISTORY_PAGE_INVALID', 'History pages are bounded to 8000 characters.');
  if (typeof authorizeSource !== 'function' || authorizeSource({ sourceId, sourceBinding: structuredClone(binding) }) !== true) fail('CONTEXT_HISTORY_DENIED', 'Current history read authorization is required before source access.');
  const available = typeof resolveMessages === 'function' ? resolveMessages() : messages;
  if (!Array.isArray(available)) fail('CONTEXT_HISTORY_UNAVAILABLE', 'The original history is unavailable. Retain the synopsis as an incomplete reference and use verified fresh-session Continuity.');
  const [, fingerprint, count, start, end, wantedHash] = sourceId.split(':');
  const sourceMessageCount = Number(count);
  if (!Number.isSafeInteger(sourceMessageCount) || sourceMessageCount < 1 || sourceMessageCount > available.length) fail('CONTEXT_HISTORY_UNAVAILABLE', 'The original source prefix is unavailable; retain the incomplete reference and restore that bound history.');
  // A model's retrieval call itself appends to a live transcript. Validate the
  // complete original prefix, not later output; any changed original row or
  // binding still invalidates the source. The next request rebuilds normally.
  const retained = available.slice(0, sourceMessageCount);
  const sourceFingerprint = fingerprintHistorySource({ messages: retained, sourceBinding: binding });
  if (fingerprint !== sourceFingerprint) fail('CONTEXT_SYNOPSIS_STALE', 'History or binding changed; retrieve from a freshly built current synopsis.');
  const startIndex = Number(start), endIndex = Number(end);
  if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex > retained.length) fail('CONTEXT_HISTORY_DENIED', 'Invalid history range.');
  const turns = historyTurns(retained).filter(turn => turn.startIndex >= startIndex && turn.endIndex <= endIndex);
  if (!turns.length || turns[0].startIndex !== startIndex || turns.at(-1).endIndex !== endIndex || turns.some(turn => !turn.complete || turn.protected)) {
    fail('CONTEXT_HISTORY_DENIED', 'Native continuation and incomplete tool spans cannot be read through synopsis sources.');
  }
  const reference = referenceFor(retained, { startIndex, endIndex }, sourceFingerprint, digest(json(binding)));
  if (reference.sha256 !== wantedHash) fail('CONTEXT_SYNOPSIS_STALE', 'History source content changed.');
  const content = json(retained.slice(startIndex, endIndex));
  if (offset > content.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset]) && /[\uD800-\uDBFF]/.test(content[offset - 1]))) fail('CONTEXT_HISTORY_PAGE_INVALID', 'Invalid history page offset.');
  let pageEnd = Math.min(offset + maxChars, content.length);
  if (pageEnd < content.length && /[\uD800-\uDBFF]/.test(content[pageEnd - 1])) pageEnd = pageEnd - offset === 1 ? pageEnd + 1 : pageEnd - 1;
  return { ...reference, representation: 'retained-history-page', referenceOnly: true, offset,
    nextOffset: pageEnd < content.length ? pageEnd : null, complete: pageEnd === content.length, content: content.slice(offset, pageEnd) };
}

/** Separate request projection. A trusted synchronous sourceResolver must use
 * current history authorization and return the first retained source page.
 * sourceMessages is used only when the earlier evidence/dedup layer changed
 * tool result representations; source references still bind original history.
 */
export function projectHistoryLayers(messages, { synopsis = true, task = null, sourceBinding, sourceResolver,
  sourceMessages = messages, keepRecentTurns = 4, maxSynopsisChars = MAX_SYNOPSIS_CHARS } = {}) {
  const current = buildContextSynopsis({ task, messages: sourceMessages, sourceBinding, keepRecentTurns, maxSynopsisChars });
  if (synopsis !== true && synopsis !== null && json(synopsis) !== json(current)) fail('CONTEXT_SYNOPSIS_STALE', 'Synopsis facts or source binding changed. Rebuild from current original sources.');
  if (!Array.isArray(messages) || messages.length !== sourceMessages.length || messages.some((message, index) => {
    const original = sourceMessages[index];
    if (message?.role !== 'tool') return json(message) !== json(original);
    const { content, ...rest } = message, { content: priorContent, ...priorRest } = original ?? {};
    return json(rest) !== json(priorRest);
  })) fail('CONTEXT_SYNOPSIS_STALE', 'The request projection no longer matches the retained source message identities.');
  const sources = JSON.parse(current.content).sources;
  if (!sources.length) return { messages: structuredClone(messages), synopsis: null, compactions: [], bytes: Buffer.byteLength(json(messages)), warnings: [] };
  if (typeof sourceResolver !== 'function') fail('CONTEXT_HISTORY_UNAVAILABLE', 'Authorized source retrieval is required before omitting history. Retain originals or use verified fresh-session Continuity.');
  for (const source of sources) {
    let resolved;
    try { resolved = sourceResolver({ ...fields(source, ['sourceId', 'sourceFingerprint', 'sourceMessageCount', 'bindingFingerprint', 'startIndex', 'endIndex', 'sha256', 'chars', 'messageCount']), offset: 0, maxChars: 1 }); }
    catch (error) {
      if (['CONTEXT_HISTORY_DENIED', 'CONTEXT_SYNOPSIS_STALE'].includes(error?.code)) throw error;
      fail('CONTEXT_HISTORY_UNAVAILABLE', 'A retained history source cannot be retrieved. Preserve originals and restore the bound source or use verified fresh-session Continuity.');
    }
    const exact = json(sourceMessages.slice(source.startIndex, source.endIndex));
    if (!resolved || typeof resolved.then === 'function' || ['sourceId', 'sourceFingerprint', 'bindingFingerprint', 'sha256', 'chars'].some(key => resolved[key] !== source[key])
      || (resolved.offset !== undefined && resolved.offset !== 0) || typeof resolved.content !== 'string' || !resolved.content.length || !exact.startsWith(resolved.content)) {
      fail('CONTEXT_HISTORY_UNAVAILABLE', 'History retrieval did not verify the exact current source. Original history is retained.');
    }
  }
  const projected = [], starts = new Map(sources.map(source => [source.startIndex, source]));
  let inserted = false;
  for (let index = 0; index < messages.length;) {
    const source = starts.get(index);
    // Every retained turn is recent, current, native, incomplete or otherwise
    // irreducible. Restore its original tool bodies as well as its native IDs;
    // request-relative duplicate references must not survive removed sources.
    if (!source) { projected.push(structuredClone(sourceMessages[index++])); continue; }
    if (!inserted) { projected.push({ role: 'user', content: current.content }); inserted = true; }
    index = source.endIndex;
  }
  return { messages: projected, synopsis: current,
    compactions: sources.map(source => ({ sourceId: source.sourceId, startIndex: source.startIndex, endIndex: source.endIndex, messageCount: source.messageCount, sha256: source.sha256, representation: 'extractive-history-synopsis' })),
    bytes: Buffer.byteLength(json(projected)), warnings: [] };
}
