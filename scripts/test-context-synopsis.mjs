import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectMessageBudget } from '../src/context/message-budget.js';
import { buildContextSynopsis, fingerprintHistorySource, projectHistoryLayers, readHistorySource } from '../src/context/history-synopsis.js';
import { createToolEvidenceStore, evidenceSummary, sanitizeToolEvidence } from '../src/context/tool-evidence.js';

const binding = { actorKind: 'owner', actorId: 'user:desktop', sessionId: 'chat-synopsis', taskId: 'task-synopsis', workspaceId: 'workspace-synopsis' };
const task = { id: 'task-synopsis', rev: 3, goal: 'Preserve the Owner goal exactly: repair history continuity.',
  requirements: ['Keep all original history.', 'Retain the current instruction and exact native tool associations.'],
  currentPhase: 'context projection', checkpoint: { summary: 'A checkpoint is a retained report, not verified completion.', nextAction: 'Read the original receipt before claiming it passed.' },
  acceptance: [{ id: 'a1', text: 'Old history is retrievable.', met: false }, { id: 'a2', text: 'Already met condition.', met: true }],
  decisions: [{ at: 7, decision: 'Use deterministic extracts.', rationale: 'No hidden model requests.' }],
  keyFiles: [{ path: 'src/context/message-budget.js', sha256: 'a'.repeat(64) }],
  executionEvidence: [{ eventId: 'test-receipt-1', source: 'core-test', capability: 'test.run', status: 'failed', resultSha256: 'b'.repeat(64), sessionId: 'old-run-session', runId: 'old-run' }],
  memoryRefs: [{ memoryId: 'linked-fact-1', scope: 'task:task-synopsis', type: 'working', revision: 2 }] };

function conversation(turns = 18) {
  const messages = [{ role: 'system', content: 'Live permissions are authoritative.' }];
  for (let i = 0; i < turns; i++) messages.push(
    { role: 'user', id: `owner-${i}`, content: `Owner discussion ${i}: ${'bounded historical detail. '.repeat(120)} OWNER-END-${i}` },
    { role: 'assistant', id: `assistant-${i}`, content: `Unverified discussion ${i}: ${'reported detail for reference. '.repeat(100)} ASSISTANT-END-${i}` });
  messages.push({ role: 'user', id: 'current-owner', content: 'CURRENT OWNER: continue with source retrieval, do not infer approval.' });
  return messages;
}

const sourceResolver = (history, sourceBinding = binding) => request => readHistorySource({ ...request, messages: history, sourceBinding, authorizeSource: () => true });
function toolTurn(history, turn, id, content, native = false) {
  const index = history.findIndex(row => row.id === `assistant-${turn}`);
  history.splice(index, 0,
    { role: 'assistant', tool_calls: [{ id, function: { name: 'cap_filesystem_read', arguments: '{"path":"fixture.txt"}' } }],
      ...(native ? { modelContinuation: { reasoningContent: 'PRIVATE NATIVE REASONING', signature: 'opaque-signed-state' } } : {}) },
    { role: 'tool', tool_call_id: id, content });
}

// Break caught: the ordinary byte guard previously refused conversation-heavy
// histories even when their old closed turns had authorized retained sources.
const messages = conversation();
const original = JSON.stringify(messages);
assert.throws(() => projectMessageBudget(messages, { maxBytes: 40000 }), { code: 'CONTEXT_BUDGET_EXCEEDED' });
const projected = projectMessageBudget(messages, { maxBytes: 40000, synopsis: true, task, sourceBinding: binding,
  sourceResolver: sourceResolver(messages) });
assert.ok(projected.bytes < 40000, 'a retained-source synopsis must permit a valid smaller conversation request');
assert.equal(JSON.stringify(messages), original, 'raw history must remain byte-identical');
assert.deepEqual(projected.messages.slice(-9), messages.slice(-9), 'four recent complete turns and the current Owner instruction stay exact');
assert.ok(projected.synopsis?.content.includes(task.goal), 'the exact Owner goal is available to the next request');
assert.ok(projected.synopsis.content.length <= 8000, 'the extractive synopsis has an explicit hard bound');
console.log('context synopsis: ordinary long history becomes a smaller retained-source request');

// Break caught: request-relative duplicate indexes become dangling if old
// source turns are omitted. New deduplication must reference the FINAL request.
const duplicates = conversation();
const duplicateBody = JSON.stringify({ status: 'completed', result: { content: 'real source bytes '.repeat(350) } });
for (const turn of [1, 15, 16]) toolTurn(duplicates, turn, `duplicate-${turn}`, duplicateBody);
const withDuplicates = projectMessageBudget(duplicates, { maxBytes: 50000, synopsis: true, task, sourceBinding: binding, sourceResolver: sourceResolver(duplicates) });
const retainedTools = withDuplicates.messages.filter(row => row.role === 'tool');
assert.equal(retainedTools.length, 2, 'recent assistant/tool pairs remain present');
assert.ok(retainedTools.every(row => row.content === duplicateBody), 'four recent complete turns remain verbatim, including their full tool bodies');
for (const row of retainedTools) {
  const value = JSON.parse(row.content);
  if (value.representation !== 'exact-duplicate-tool-result') { assert.equal(row.content, duplicateBody); continue; }
  const source = withDuplicates.messages[value.sourceMessageIndex];
  assert.equal(source?.role, 'tool', 'a duplicate must point to an actual retained tool result');
  assert.equal(source.content, duplicateBody, 'a duplicate must resolve to the retained full source body');
  assert.equal(value.sourceToolCallId, source.tool_call_id);
}
console.log('context synopsis: duplicate references remain valid after omitted spans');

const built = buildContextSynopsis({ task, messages, sourceBinding: binding });
const body = JSON.parse(built.content);
assert.deepEqual(body.task.goal, task.goal);
assert.deepEqual(body.task.requirements, task.requirements);
assert.deepEqual(body.task.checkpoint, task.checkpoint);
assert.deepEqual(body.task.decisions, task.decisions, 'only the stored Task decisions are represented as decisions');
assert.deepEqual(body.task.unmetAcceptance, [task.acceptance[0]]);
assert.deepEqual(body.task.evidenceRefs, task.executionEvidence, 'exact existing evidence references preserve their failed status and old Run identity');
assert.deepEqual(body.task.keyFiles, task.keyFiles);
assert.deepEqual(body.task.linkedFacts, task.memoryRefs);
assert.ok(body.incomplete && body.note.includes('not verified decisions'), 'extracts are explicitly attributed references');
assert.equal(body.omitted.messages, 28, 'all fourteen omitted turns have source references');
assert.equal(body.sources.reduce((sum, source) => sum + source.messageCount, 0), 28);
assert.ok(JSON.stringify(built).length <= 8000, 'the entire persisted optional synopsis, including hashes, is bounded');
assert.deepEqual(buildContextSynopsis({ task, messages, sourceBinding: binding, previous: built }), built, 'a second identical build is deterministic');
assert.deepEqual(projectHistoryLayers(messages, { synopsis: built, task, sourceBinding: binding, sourceResolver: sourceResolver(messages) }).messages, projected.messages, 'the direct pure projection and ordinary message budget use the same layer');
const reference = body.sources[0];
let fullSource = '', offset = 0;
while (offset !== null) {
  const page = readHistorySource({ messages, sourceBinding: binding, sourceId: reference.sourceId, offset, maxChars: 8000, authorizeSource: () => true });
  assert.ok(page.content.length <= 8000);
  assert.equal(page.sha256, reference.sha256);
  fullSource += page.content; offset = page.nextOffset;
}
assert.equal(fullSource, JSON.stringify(messages.slice(reference.startIndex, reference.endIndex)), 'all omitted originals are retrievable through the narrow paged interface');
const appendedHistory = [...structuredClone(messages), { role: 'assistant', tool_calls: [{ id: 'read-original-source', function: { name: 'cap_context_history_read', arguments: JSON.stringify({ sourceId: reference.sourceId, offset: 0, maxChars: 8000 }) } }] }];
assert.equal(readHistorySource({ messages: appendedHistory, sourceBinding: binding, sourceId: reference.sourceId, authorizeSource: () => true }).content,
  fullSource.slice(0, 8000), 'the model can retrieve an old source after its own tool call appends to the live transcript');
assert.throws(() => projectHistoryLayers(appendedHistory, { synopsis: built, task, sourceBinding: binding, sourceResolver: sourceResolver(appendedHistory) }), { code: 'CONTEXT_SYNOPSIS_STALE' }, 'the next full request still recalculates after appended output');
console.log('context synopsis: deterministic exact Task fields and complete original source retrieval');

// Breaks caught: count/byte-only anchors, a changed native representation,
// changed Task facts, a tampered derivative or a cross-bound source are stale.
const edited = structuredClone(messages);
edited[2].content = edited[2].content.replace('Unverified', 'Unverifiex');
assert.equal(JSON.stringify(edited).length, original.length);
assert.notEqual(fingerprintHistorySource({ messages: edited, sourceBinding: binding }), built.sourceFingerprint);
assert.throws(() => projectHistoryLayers(edited, { synopsis: built, task, sourceBinding: binding, sourceResolver: sourceResolver(edited) }), { code: 'CONTEXT_SYNOPSIS_STALE' });
assert.throws(() => buildContextSynopsis({ task, messages: edited, sourceBinding: binding, sourceFingerprint: built.sourceFingerprint }), { code: 'CONTEXT_SYNOPSIS_STALE' });
assert.notEqual(buildContextSynopsis({ task, messages: edited, sourceBinding: binding, previous: built }).fingerprint, built.fingerprint);
for (const changedTask of [{ ...task, goal: task.goal.replace('repair', 'rework') }, { ...task, requirements: ['Changed Owner requirement.'] },
  { ...task, checkpoint: { ...task.checkpoint, nextAction: 'Changed next action.' } }]) {
  assert.throws(() => projectHistoryLayers(messages, { synopsis: built, task: changedTask, sourceBinding: binding, sourceResolver: sourceResolver(messages) }), { code: 'CONTEXT_SYNOPSIS_STALE' });
}
assert.throws(() => projectHistoryLayers(messages, { synopsis: { ...built, content: built.content.replace('No hidden model requests.', 'Invented model authority.') }, task, sourceBinding: binding, sourceResolver: sourceResolver(messages) }), { code: 'CONTEXT_SYNOPSIS_STALE' });
const otherBinding = { ...binding, workspaceId: 'other-workspace' };
assert.throws(() => readHistorySource({ messages, sourceBinding: otherBinding, sourceId: reference.sourceId, authorizeSource: () => true }), { code: 'CONTEXT_SYNOPSIS_STALE' });
assert.throws(() => projectHistoryLayers(messages, { synopsis: built, task, sourceBinding: otherBinding, sourceResolver: sourceResolver(messages, otherBinding) }), { code: 'CONTEXT_SYNOPSIS_STALE' });
console.log('context synopsis: same-length, Task, derivative and source-binding changes invalidate reuse');

let sourceAccesses = 0;
assert.throws(() => readHistorySource({ sourceBinding: binding, sourceId: reference.sourceId,
  resolveMessages: () => { sourceAccesses++; return messages; }, authorizeSource: () => false }), { code: 'CONTEXT_HISTORY_DENIED' });
assert.equal(sourceAccesses, 0, 'authorization precedes source access');
assert.throws(() => projectHistoryLayers(messages, { synopsis: built, task, sourceBinding: binding }), { code: 'CONTEXT_HISTORY_UNAVAILABLE' });
assert.throws(() => projectHistoryLayers(messages, { synopsis: built, task, sourceBinding: binding,
  sourceResolver: request => readHistorySource({ ...request, sourceBinding: binding, resolveMessages: () => null, authorizeSource: () => true }) }), { code: 'CONTEXT_HISTORY_UNAVAILABLE' });
assert.throws(() => projectHistoryLayers(messages, { synopsis: built, task, sourceBinding: binding,
  sourceResolver: request => readHistorySource({ ...request, messages, sourceBinding: binding, authorizeSource: () => false }) }), { code: 'CONTEXT_HISTORY_DENIED' });
assert.throws(() => projectHistoryLayers(messages, { synopsis: built, task, sourceBinding: binding,
  sourceResolver: request => ({ ...sourceResolver(messages)(request), bindingFingerprint: '0'.repeat(64) }) }), { code: 'CONTEXT_HISTORY_UNAVAILABLE' });
for (const options of [{ maxChars: 8001 }, { offset: -1 }, { offset: reference.chars + 1 }]) {
  assert.throws(() => readHistorySource({ messages, sourceBinding: binding, sourceId: reference.sourceId, authorizeSource: () => true, ...options }), { code: 'CONTEXT_HISTORY_PAGE_INVALID' });
}
assert.throws(() => readHistorySource({ messages, sourceBinding: binding, sourceId: 'C:\\other-session\\history.json', authorizeSource: () => true }), { code: 'CONTEXT_HISTORY_DENIED' });
assert.equal(JSON.stringify(messages), original, 'every refusal retains the exact caller-owned source');
console.log('context synopsis: revoked, missing, malformed and unavailable source reads refuse safely');

const protectedHistory = conversation();
toolTurn(protectedHistory, 4, 'native-call', JSON.stringify({ status: 'completed', result: 'native result bytes' }), true);
toolTurn(protectedHistory, 7, 'unknown-call', JSON.stringify({ status: 'unknown', result: 'An effect may have occurred.' }));
const gapIndex = protectedHistory.findIndex(row => row.id === 'assistant-9');
protectedHistory.splice(gapIndex, 0, { role: 'assistant', tool_calls: [{ id: 'missing-result', function: { name: 'cap_filesystem_read', arguments: '{"path":"fixture.txt"}' } }] });
protectedHistory.push({ role: 'assistant', tool_calls: [{ id: 'open-current-call', function: { name: 'cap_filesystem_read', arguments: '{"path":"fixture.txt"}' } }] });
const protectedRaw = JSON.stringify(protectedHistory);
const protectedProjection = projectMessageBudget(protectedHistory, { maxBytes: 65000, synopsis: true, task, sourceBinding: binding, sourceResolver: sourceResolver(protectedHistory) });
for (const turn of [4, 7, 9]) {
  const start = protectedHistory.findIndex(row => row.id === `owner-${turn}`), end = protectedHistory.findIndex(row => row.id === `owner-${turn + 1}`);
  const projectedStart = protectedProjection.messages.findIndex(row => row.id === `owner-${turn}`);
  assert.deepEqual(protectedProjection.messages.slice(projectedStart, projectedStart + end - start), protectedHistory.slice(start, end), `protected turn ${turn} and its actual/missing tool pairing stay exact`);
}
assert.deepEqual(protectedProjection.messages.at(-1), protectedHistory.at(-1));
assert.equal(JSON.stringify(protectedHistory), protectedRaw);
assert.equal(protectedProjection.synopsis.content.includes('PRIVATE NATIVE REASONING'), false, 'private protocol reasoning never enters a synopsis');
const nativeStart = protectedHistory.findIndex(row => row.id === 'owner-4'), nativeEnd = protectedHistory.findIndex(row => row.id === 'owner-5');
const nativeHash = createHash('sha256').update(JSON.stringify(protectedHistory.slice(nativeStart, nativeEnd))).digest('hex');
const nativeSourceId = `history:${fingerprintHistorySource({ messages: protectedHistory, sourceBinding: binding })}:${protectedHistory.length}:${nativeStart}:${nativeEnd}:${nativeHash}`;
assert.throws(() => readHistorySource({ messages: protectedHistory, sourceBinding: binding, sourceId: nativeSourceId, authorizeSource: () => true }), { code: 'CONTEXT_HISTORY_DENIED' });
const changedNative = structuredClone(protectedHistory);
changedNative.find(row => row.modelContinuation).modelContinuation.signature = 'opaque-signed-statz';
assert.throws(() => projectHistoryLayers(changedNative, { synopsis: protectedProjection.synopsis, task, sourceBinding: binding, sourceResolver: sourceResolver(changedNative) }), { code: 'CONTEXT_SYNOPSIS_STALE' });
console.log('context synopsis: native continuation, missing/unknown results and open tool groups stay exact');

const productionUnknown = conversation();
toolTurn(productionUnknown, 3, 'actual-unknown-call', JSON.stringify({ status: 'outcome-unknown', code: 'OUTCOME_UNKNOWN', result: 'Unconfirmed actual tool effect.' }));
const unknownStart = productionUnknown.findIndex(row => row.id === 'owner-3');
const unknownEnd = productionUnknown.findIndex(row => row.id === 'owner-4');
const unknownProjection = projectHistoryLayers(productionUnknown, { synopsis: true, task, sourceBinding: binding, sourceResolver: sourceResolver(productionUnknown) });
const unknownProjectedStart = unknownProjection.messages.findIndex(row => row.id === 'owner-3');
assert.ok(unknownProjectedStart >= 0, 'the production outcome-unknown turn cannot be extracted away');
assert.deepEqual(unknownProjection.messages.slice(unknownProjectedStart, unknownProjectedStart + unknownEnd - unknownStart),
  productionUnknown.slice(unknownStart, unknownEnd), 'the original uncertain effect and tool pairing stay verbatim');
const uncertainHash = createHash('sha256').update(JSON.stringify(productionUnknown.slice(unknownStart, unknownEnd))).digest('hex');
const uncertainSource = 'history:' + fingerprintHistorySource({ messages: productionUnknown, sourceBinding: binding }) + ':'
  + productionUnknown.length + ':' + unknownStart + ':' + unknownEnd + ':' + uncertainHash;
assert.throws(() => readHistorySource({ messages: productionUnknown, sourceBinding: binding, sourceId: uncertainSource, authorizeSource: () => true }), { code: 'CONTEXT_HISTORY_DENIED' });
console.log('context synopsis: production outcome-unknown spelling preserves the uncertain turn and refuses synopsis source reads');

const oversized = conversation(); oversized.at(-1).content = 'IRREDUCIBLE CURRENT OWNER INSTRUCTION '.repeat(5000);
assert.throws(() => projectMessageBudget(oversized, { maxBytes: 40000, synopsis: true, task, sourceBinding: binding, sourceResolver: sourceResolver(oversized) }), { code: 'CONTEXT_BUDGET_EXCEEDED' });
assert.throws(() => buildContextSynopsis({ messages, sourceBinding: binding, task: { ...task, requirements: ['Exact Owner requirement '.repeat(800)] } }), { code: 'CONTEXT_SYNOPSIS_IRREDUCIBLE' });
const manyDecisions = { ...task, decisions: Array.from({ length: 20 }, (_, i) => ({ at: i, decision: `Stored decision ${i}: ${'exact decision content '.repeat(50)}` })) };
const boundedDecisions = JSON.parse(buildContextSynopsis({ task: manyDecisions, messages, sourceBinding: binding }).content).task;
assert.equal(boundedDecisions.decisions.length + boundedDecisions.omitted.decisions, 20);
for (const decision of boundedDecisions.decisions) assert.deepEqual(decision, manyDecisions.decisions.find(row => row.at === decision.at), 'bounded decisions are omitted whole rather than rewritten');
const short = [{ role: 'user', content: 'A normal question.' }, { role: 'assistant', content: 'A normal answer.' }, { role: 'user', content: 'Continue.' }];
assert.deepEqual(projectMessageBudget(short, { synopsis: true }).messages, short, 'optional on-demand synopsis does not change ordinary short requests or require new authority');
const chatBinding = { ...binding, taskId: null };
assert.throws(() => buildContextSynopsis({ task, messages, sourceBinding: chatBinding }), { code: 'CONTEXT_HISTORY_DENIED' },
  'a Chat with no Task binding cannot acquire facts from an unrelated supplied Task');
const ordinaryChat = projectMessageBudget(messages, { maxBytes: 40000, synopsis: true, sourceBinding: chatBinding, sourceResolver: sourceResolver(messages, chatBinding) });
assert.ok(ordinaryChat.bytes < 40000, 'ordinary long Chat history benefits without a Task');
assert.equal(JSON.parse(ordinaryChat.synopsis.content).task, null);
console.log('context synopsis: exact irreducible instructions refuse and ordinary short histories are unchanged');

const publicOnly = conversation();
toolTurn(publicOnly, 0, 'private-arguments', JSON.stringify({ status: 'completed', result: { token: 'SYNTHETIC-HISTORY-OUTPUT-SECRET', observed: 'PUBLIC-TOOL-OBSERVATION' } }));
publicOnly.find(row => row.tool_calls?.[0]?.id === 'private-arguments').tool_calls[0].function.arguments = '{"apiKey":"SYNTHETIC-HISTORY-PRIVATE-ARG"}';
const publicSynopsis = buildContextSynopsis({ task, messages: publicOnly, sourceBinding: binding });
const publicReference = JSON.parse(publicSynopsis.content).sources[0];
const publicPage = readHistorySource({ messages: publicOnly, sourceBinding: binding, sourceId: publicReference.sourceId, maxChars: 8000, authorizeSource: () => true });
assert.equal(publicPage.content.includes('SYNTHETIC-HISTORY-PRIVATE-ARG'), false, 'ordinary history pages exclude every raw tool argument');
assert.equal(publicPage.content.includes('SYNTHETIC-HISTORY-OUTPUT-SECRET'), false, 'tool result pages retain existing redaction');
assert.ok(publicPage.content.includes('PUBLIC-TOOL-OBSERVATION'));
assert.equal(publicSynopsis.content.includes('SYNTHETIC-HISTORY-OUTPUT-SECRET'), false, 'tool excerpts use the same public representation');
console.log('context synopsis: public history pages preserve text and tool IDs without raw private arguments or result secrets');

const tempRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(tempRoot, 'context-synopsis-'));
try {
  const evidenceStore = createToolEvidenceStore({ stateDir: directory });
  const retainedEvidence = sanitizeToolEvidence({ status: 'completed', result: { content: 'Original observed file bytes. '.repeat(4000) + 'FULL-EVIDENCE-END' } });
  const evidence = evidenceStore.put({ binding, content: retainedEvidence, sourceCapability: 'filesystem.read', sourceInput: { path: 'fixture.txt' } });
  const withEvidence = conversation(); toolTurn(withEvidence, 13, 'stored-evidence-call', evidenceSummary(retainedEvidence, evidence));
  const evidenceProjection = projectMessageBudget(withEvidence, { maxBytes: 45000, synopsis: true, task, binding, sourceBinding: binding,
    evidenceStore, canRetrieveEvidence: true, sourceResolver: sourceResolver(withEvidence) });
  const toolFact = JSON.parse(evidenceProjection.synopsis.content).sources.flatMap(source => source.excerpts).find(row => row.toolCallId === 'stored-evidence-call');
  assert.equal(toolFact?.status, 'completed');
  assert.equal(toolFact.evidence.id, evidence.id, 'the extract retains the actual existing evidence reference');
  assert.equal(toolFact.retrievalCapability, 'context.evidence.read');
  let evidenceText = '', evidenceOffset = 0;
  while (evidenceOffset !== null) {
    const page = evidenceStore.read({ binding, id: toolFact.evidence.id, offset: evidenceOffset, limit: 6000,
      authorizeSource: source => source.capability === 'filesystem.read' && source.input.path === 'fixture.txt' });
    evidenceText += page.content; evidenceOffset = page.nextOffset;
  }
  assert.equal(evidenceText, retainedEvidence, 'the real existing evidence store retrieves every original sanitized byte');
  assert.throws(() => evidenceStore.read({ binding, id: evidence.id, authorizeSource: () => false }), { code: 'TOOL_EVIDENCE_DENIED' });
  console.log('context synopsis: real retained history and actual tool evidence storage/page retrieval work together');
} finally {
  assert.equal(path.dirname(path.resolve(directory)), tempRoot, 'cleanup stays in the exact temporary fixture parent');
  assert.ok(path.basename(directory).startsWith('context-synopsis-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ fixture: 'ordinary-history-synopsis', originalBytes: Buffer.byteLength(original), projectedBytes: projected.bytes,
  recentCompleteTurns: 4, synopsisChars: JSON.stringify(built).length, omittedMessages: body.omitted.messages,
  sourcePagesVerified: true, actualToolEvidenceStore: true, liveModel: false }));
