import assert from 'node:assert/strict';
import { projectMessageBudget } from '../src/context/message-budget.js';
const content = JSON.stringify({ status: 'completed', result: { evidence: 'verified '.repeat(2000) } });
const messages = [{ role: 'system', content: 'live permissions' }, { role: 'user', content: 'original goal' }, { role: 'assistant', tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a', content }, { role: 'assistant', tool_calls: [{ id: 'b' }], modelContinuation: { opaque: 'keep' } }, { role: 'tool', tool_call_id: 'b', content }];
const projected = projectMessageBudget(messages, { maxBytes: 22000 });
assert.equal(projected.compactions.length, 1);
assert.equal(projected.messages[3].content, content);
assert.equal(projected.messages[5].tool_call_id, 'b');
assert.equal(JSON.parse(projected.messages[5].content).sourceMessageIndex, 3);
assert.deepEqual(projected.messages[4], messages[4]);
assert.deepEqual(messages[5].content, content, 'original history never mutated');
assert.throws(() => projectMessageBudget([{ role: 'user', content: 'X'.repeat(1000) }], { maxBytes: 500 }), { code: 'CONTEXT_BUDGET_EXCEEDED' });
assert.deepEqual(projectMessageBudget(Array.from({length: 60}, (_, i) => ({role:'user',content: 'goal'+i}))).messages.length, 60);
console.log('message context budget passed');
for (const status of ['pending','denied','failed']) {
 const body=JSON.stringify({status,result:'x'.repeat(2000)});
 const rows=[{role:'tool',tool_call_id:'a',content:body},{role:'tool',tool_call_id:'b',content:body}];
 assert.deepEqual(projectMessageBudget(rows).messages,rows,`never compact ${status} state`);
}
const signed = [{role:'tool',content,modelContinuation:{opaque:'native'}},{role:'tool',content,modelContinuation:{opaque:'native'}}];
assert.deepEqual(projectMessageBudget(signed).messages,signed,'native signed tool data unchanged');
// Persisted histories must not retain request-relative indexes: system prefixes
// and later turns change those indexes. Durable projection uses evidence IDs.
assert.throws(() => projectMessageBudget([{role:'tool',tool_call_id:'a',content},{role:'tool',tool_call_id:'b',content}], {maxBytes:22000,deduplicate:false}), {code:'CONTEXT_BUDGET_EXCEEDED'});
