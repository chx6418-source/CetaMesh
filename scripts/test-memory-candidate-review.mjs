import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../src/memory/index.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';

// Real policy, store and service routes; all data belongs to this temporary fixture.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-candidate-review-'));
const owner = { kind: 'user', id: 'desktop' };
let failures = 0;
let passed = 0;
async function check(name, run) {
  const stateDir = fs.mkdtempSync(path.join(root, 'case-'));
  let clock = 1800000000000;
  const service = createMemoryService({ stateDir, now: () => clock });
  const call = (method, params = {}) => service.execute({ method, params });
  try {
    await run({ service, runtime: service.runtime, call, stateDir, advance: delta => { clock += delta; }, now: () => clock });
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failures++;
    console.error('FAIL ' + name + '\n' + error.stack);
  } finally { service.close(); }
}

const candidateInput = (content, overrides = {}) => ({
  type: 'workspace', scope: 'workspace:alpha', content, ...overrides
});
const proposedByOwner = (runtime, content, overrides) => runtime.proposeCandidate({
  principal: owner, ...candidateInput(content, overrides)
});
const pendingCandidate = async (call, id) => (await call('memory.candidates.list', { status: 'pending' })).candidates.find(row => row.id === id);
const hint = (memory, kind, code) => ({ kind, code, memoryId: memory.id, revision: memory.rev });

try {
  await check('normalized duplicate is an explainable review hint without changing stored Memory', async ({ call, stateDir, runtime, service }) => {
    const evidence = await call('memory.create', candidateInput('Owner supplied build preference evidence'));
    const saved = await call('memory.create', candidateInput('Build command is alpha', {
      sourceRefs: [{ kind: 'memory', id: evidence.id, scope: 'workspace:alpha' }]
    }));
    const proposal = await call('memory.candidates.propose', candidateInput('  BUILD   command is alpha  ', {
      scopes: ['workspace:alpha'], agentId: 'review-agent', reason: 'Unverified proposal',
      review: { status: 'current' }, factKey: 'forged-truth'
    }));
    const beforeMemories = fs.readFileSync(path.join(stateDir, 'memory', 'memories.json'), 'utf8');
    const beforeCandidates = fs.readFileSync(path.join(stateDir, 'memory', 'candidates.json'), 'utf8');
    const candidate = await pendingCandidate(call, proposal.candidate.id);
    assert.deepEqual(candidate.review, {
      status: 'needs-review', method: 'deterministic-text-v1',
      hints: [hint(saved, 'possible-duplicate', 'normalized-text-match')], truncated: false
    });
    const desktop=await createDesktopUiService({services:{memoryService:service}}).execute({method:'ui.memory.overview',params:{scope:'workspace:alpha'}});
    assert.deepEqual(desktop.candidates.find(row=>row.id===candidate.id).review,candidate.review,'real Desktop DTO must preserve authorized review references');
    assert.equal(candidate.status, 'pending');
    assert.equal(candidate.proposedBy, 'agent:review-agent');
    assert.equal(candidate.reason, 'Unverified proposal');
    assert.equal(candidate.factKey, undefined);
    assert.deepEqual((await call('memory.get', { id: saved.id })).memory.sourceRefs, [{ kind: 'memory', id: evidence.id, scope: 'workspace:alpha' }]);
    assert.equal(runtime.countAll(), 2);
    assert.equal(runtime.assess({ principal: owner, id: saved.id }).status, 'current');
    assert.equal(fs.readFileSync(path.join(stateDir, 'memory', 'memories.json'), 'utf8'), beforeMemories);
    assert.equal(fs.readFileSync(path.join(stateDir, 'memory', 'candidates.json'), 'utf8'), beforeCandidates);
    assert.ok(!beforeCandidates.includes('deterministic-text-v1'), 'review hints must not become persisted authority');
  });

  await check('same simple attribute with a different value stays a possible conflict until Owner review', async ({ call, runtime }) => {
    const saved = await call('memory.create', candidateInput('Build command is npm run build'));
    const proposal = await call('memory.candidates.propose', candidateInput('Build command is npm run package', { scopes: ['workspace:alpha'] }));
    assert.equal(proposal.candidate.review, undefined, 'proposal permission must not imply read permission for workspace Memory');
    const candidate = await pendingCandidate(call, proposal.candidate.id);
    assert.deepEqual(candidate.review?.hints, [hint(saved, 'possible-conflict', 'same-subject-different-value')]);
    assert.equal(candidate.review?.status, 'needs-review');
    assert.deepEqual(runtime.retrieve({ principal: owner, scope: saved.scope, query: 'Build command' }).memories.map(row => row.id), [saved.id]);
    const accepted = await call('memory.candidates.confirm', { id: candidate.id, decision: 'accept' });
    assert.equal(accepted.candidate.review, undefined);
    assert.equal(accepted.memory.factKey, undefined, 'a heuristic must never manufacture an explicit semantic identity');
    assert.equal(accepted.memory.confirmedBy, 'user:desktop');
    assert.equal((await call('memory.get', { id: saved.id })).memory.rev, 1);
    assert.equal(runtime.assess({ principal: owner, id: saved.id }).status, 'current');
    const retrieved = runtime.retrieve({ principal: owner, scope: saved.scope, query: 'Build command' });
    assert.equal(retrieved.meta.conflicted, 0, 'review hints cannot invalidate already stored facts');
    assert.equal(retrieved.memories.length, 2);
  });

  await check('simple Chinese attribute statements produce the same bounded possible-conflict hint', async ({ call, runtime }) => {
    const saved = await call('memory.create', candidateInput('默认语言是中文。'));
    const proposal = proposedByOwner(runtime, '默认语言是英文。');
    assert.deepEqual(proposal.candidate.review?.hints, [hint(saved, 'possible-conflict', 'same-subject-different-value')]);
  });

  await check('negated, uncertain, conditional, compound and unsupported candidate statements abstain', async ({ call, runtime }) => {
    await call('memory.create', candidateInput('Build command is alpha'));
    await call('memory.create', candidateInput('构建命令是alpha'));
    await call('memory.create', candidateInput('Alice is an engineer'));
    for (const content of [
      'Build command is not beta', "Build command isn't beta", 'Maybe build command is beta',
      'If build command is beta', 'Build command is beta or gamma', 'Build command is beta and gamma',
      'Build command is beta?', 'Build command is beta. Release channel is next',
      'Build command is beta\nRelease channel is next', '"Build command is beta"',
      'Build command is beta when packaging', 'Build command is beta for release',
      'Build command is beta today', 'Build command is beta as an example',
      '构建命令不是beta', '也许构建命令是beta', '构建命令是beta或gamma',
      '构建命令是视情况选择的beta', 'Alice is a designer'
    ]) {
      assert.equal(proposedByOwner(runtime, content).candidate.review, undefined, content);
    }
  });

  await check('negated or ambiguous saved statements are not inferred to be positive facts', async ({ call, runtime }) => {
    for (const content of ['Build command is not alpha', 'Build command is alpha or gamma', 'Maybe build command is alpha', '构建命令不是alpha']) {
      await call('memory.create', candidateInput(content));
    }
    assert.equal(proposedByOwner(runtime, 'Build command is beta').candidate.review, undefined);
    assert.equal(proposedByOwner(runtime, '构建命令是beta').candidate.review, undefined);
  });

  await check('expiry is rechecked at projection and restart without restoring stale content', async ({ call, runtime, stateDir, advance, now }) => {
    const saved = await call('memory.create', candidateInput('Build command is alpha', { validUntil: now() + 50, pinned: true }));
    const proposal = proposedByOwner(runtime, 'Build command is beta');
    assert.deepEqual(proposal.candidate.review?.hints, [hint(saved, 'possible-conflict', 'same-subject-different-value')]);
    advance(100);
    assert.equal((await pendingCandidate(call, proposal.candidate.id)).review, undefined);
    assert.equal(runtime.assess({ principal: owner, id: saved.id }).status, 'expired');
    assert.equal(runtime.retrieve({ principal: owner, scope: saved.scope, query: '' }).memories.length, 0);
    const restarted = createMemoryService({ stateDir, now });
    try {
      assert.equal(restarted.runtime.listCandidates({ principal: owner }).candidates.find(row => row.id === proposal.candidate.id).review, undefined);
      assert.equal(restarted.runtime.assess({ principal: owner, id: saved.id }).status, 'expired');
    } finally { restarted.close(); }
  });

  await check('Owner supersedes and explicit factKey conflicts outrank text heuristics', async ({ call, runtime }) => {
    const older = await call('memory.create', candidateInput('Build command is alpha', { factKey: 'build-command' }));
    const newer = await call('memory.create', candidateInput('Build command is beta', { factKey: 'build-command' }));
    await call('memory.links.create', {
      source: { kind: 'memory', id: newer.id, scope: newer.scope },
      target: { kind: 'memory', id: older.id, scope: older.scope }, relation: 'supersedes'
    });
    const proposal = proposedByOwner(runtime, 'Build command is alpha');
    assert.deepEqual(proposal.candidate.review?.hints, [hint(newer, 'possible-conflict', 'same-subject-different-value')]);
    assert.equal(runtime.assess({ principal: owner, id: older.id }).status, 'superseded');
    const competing = await call('memory.create', candidateInput('Build command is gamma', { factKey: 'build-command' }));
    assert.equal((await pendingCandidate(call, proposal.candidate.id)).review, undefined);
    assert.equal(runtime.assess({ principal: owner, id: newer.id }).status, 'conflicted');
    assert.equal(runtime.assess({ principal: owner, id: competing.id }).status, 'conflicted');
    const page = runtime.retrieve({ principal: owner, scope: older.scope, query: '' });
    assert.equal(page.memories.length, 0);
    assert.equal(page.meta.conflicted, 2);
    assert.equal(page.meta.superseded, 1);
  });

  await check('review comparison cannot cross Workspace, User scope or Memory type even for Owner', async ({ call, runtime }) => {
    const visible = await call('memory.create', candidateInput('Build command is alpha'));
    const foreign = await call('memory.create', candidateInput('Build command is beta', { scope: 'workspace:beta' }));
    const otherType = await call('memory.create', candidateInput('Build command is gamma', { type: 'user' }));
    const otherUser = runtime.create({ principal: { kind: 'user', id: 'other-user' }, ...candidateInput('Build command is delta', { scope: 'user:other-user' }) });
    const proposal = proposedByOwner(runtime, 'Build command is beta');
    const projected = await pendingCandidate(call, proposal.candidate.id);
    assert.deepEqual(projected.review?.hints, [hint(visible, 'possible-conflict', 'same-subject-different-value')]);
    for (const hidden of [foreign, otherType, otherUser]) assert.ok(!JSON.stringify(projected.review).includes(hidden.id));
    assert.deepEqual(runtime._store.stats.lastScopeKeys, ['workspace:alpha'], 'only the candidate partition may be scanned');
  });

  await check('readOnlyRefs constrain hints without exposing the other same-scope records', async ({ call, runtime }) => {
    const visible = await call('memory.create', candidateInput('Build command is alpha'));
    const hidden = await call('memory.create', candidateInput('Build command is gamma'));
    const proposal = proposedByOwner(runtime, 'Build command is beta');
    const agent = { kind: 'agent', id: 'ref-reader', grants: {
      scopes: ['workspace:alpha'], types: ['workspace'], readOnlyRefs: { 'workspace:alpha': [visible.id] }
    } };
    const projected = runtime.listCandidates({ principal: agent }).candidates.find(row => row.id === proposal.candidate.id);
    assert.deepEqual(projected.review?.hints, [hint(visible, 'possible-conflict', 'same-subject-different-value')]);
    assert.ok(!JSON.stringify(projected).includes(hidden.id));
    agent.grants.readOnlyRefs['workspace:alpha'] = [];
    assert.equal(runtime.listCandidates({ principal: agent }).candidates[0].review, undefined);
  });

  await check('propose permission and authorship do not grant read access to saved Memory type', async ({ call, runtime }) => {
    const saved = await call('memory.create', candidateInput('Build command is alpha'));
    const agent = { kind: 'agent', id: 'proposer', grants: { scopes: ['workspace:alpha'] } };
    const proposal = runtime.proposeCandidate({ principal: agent, ...candidateInput('Build command is beta') });
    assert.equal(proposal.candidate.review, undefined);
    const visible = runtime.listCandidates({ principal: agent }).candidates.find(row => row.id === proposal.candidate.id);
    assert.equal(visible.review, undefined);
    assert.ok(!JSON.stringify(visible).includes(saved.id));
    assert.deepEqual((await pendingCandidate(call, proposal.candidate.id)).review?.hints, [hint(saved, 'possible-conflict', 'same-subject-different-value')]);
    const deniedScope = { kind: 'agent', id: 'other', grants: { scopes: ['workspace:beta'], types: ['workspace'] } };
    assert.equal(runtime.listCandidates({ principal: deniedScope }).candidates.length, 0);
  });

  await check('exact accepted duplicates retain their existing id only while readable and current', async ({ call, runtime }) => {
    const proposal = proposedByOwner(runtime, 'Build command is alpha');
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    const repeated = proposedByOwner(runtime, 'Build command is alpha');
    assert.deepEqual(repeated, { candidate: null, duplicate: true, existingMemoryId: accepted.memory.id });
    assert.equal(runtime.countAll(), 1);
  });

  await check('accepted but expired Memory is not returned as an existing current duplicate', async ({ call, runtime, now }) => {
    const proposal = proposedByOwner(runtime, 'Build command is alpha');
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    await call('memory.update', { id: accepted.memory.id, expectedRev: accepted.memory.rev, validUntil: now() - 1 });
    const repeated = proposedByOwner(runtime, 'Build command is alpha');
    assert.equal(repeated.candidate?.status, 'pending');
    assert.equal(repeated.existingMemoryId, undefined);
    assert.equal(repeated.candidate.review, undefined);
    assert.equal(runtime.countAll(), 1);
    assert.equal(runtime.retrieve({ principal: owner, scope: accepted.memory.scope, query: '' }).memories.length, 0);
  });

  await check('accepted but deleted Memory can only return as a fresh pending proposal', async ({ call, runtime }) => {
    const proposal = proposedByOwner(runtime, 'Build command is alpha');
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    await call('memory.delete', { id: accepted.memory.id, expectedRev: accepted.memory.rev });
    const repeated = proposedByOwner(runtime, 'Build command is alpha');
    assert.equal(repeated.candidate.status, 'pending');
    assert.notEqual(repeated.candidate.id, proposal.candidate.id);
    assert.equal(repeated.existingMemoryId, undefined);
    assert.equal(repeated.candidate.review, undefined);
    assert.equal(runtime.countAll(), 0);
  });

  await check('Owner correction changes review evidence without reviving the old accepted text', async ({ call, runtime }) => {
    const proposal = proposedByOwner(runtime, 'Build command is alpha');
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    const corrected = await call('memory.update', { id: accepted.memory.id, expectedRev: accepted.memory.rev, content: 'Build command is beta' });
    const repeated = proposedByOwner(runtime, 'Build command is alpha');
    assert.equal(repeated.candidate.status, 'pending');
    assert.deepEqual(repeated.candidate.review?.hints, [hint(corrected, 'possible-conflict', 'same-subject-different-value')]);
    assert.deepEqual(runtime.retrieve({ principal: owner, scope: corrected.scope, query: '' }).memories.map(row => row.content), ['Build command is beta']);
  });

  await check('accepted historical candidate cannot disclose unreadable long-term Memory identity', async ({ call, runtime }) => {
    const proposal = proposedByOwner(runtime, 'Build command is alpha');
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    const agent = { kind: 'agent', id: 'longterm-proposer', grants: { scopes: ['workspace:alpha'] } };
    const repeated = runtime.proposeCandidate({ principal: agent, ...candidateInput('Build command is alpha') });
    assert.equal(repeated.candidate?.status, 'pending');
    assert.equal(repeated.candidate.review, undefined);
    assert.equal(repeated.existingMemoryId, undefined);
    assert.ok(!JSON.stringify(repeated).includes(accepted.memory.id));
  });

  await check('same-author accepted replay returns only its historical receipt without granting Memory reads', async ({ call, runtime }) => {
    const agent = { kind: 'agent', id: 'original-proposer', grants: { scopes: ['user:desktop'] } };
    const input = candidateInput('我喜欢简洁的中文回答', { scope: 'user:desktop', type: 'user' });
    const proposal = runtime.proposeCandidate({ principal: agent, ...input });
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    const repeated = runtime.proposeCandidate({ principal: agent, ...input });
    assert.deepEqual(repeated, { candidate: null, duplicate: true, existingMemoryId: accepted.memory.id });
    assert.throws(() => runtime.get({ principal: agent, id: accepted.memory.id }), { code: 'MEMORY_NOT_FOUND' });
    assert.throws(() => runtime.retrieve({ principal: agent, scope: input.scope, types: ['user'], query: '' }), { code: 'TYPE_NOT_AUTHORIZED' });
    assert.equal(runtime.countAll(), 1);
    assert.equal(runtime.listCandidates({ principal: agent, status: 'pending' }).candidates.length, 0);
  });

  await check('same-author receipt cannot revive expired, deleted or corrected accepted content', async ({ call, runtime, now }) => {
    for (const action of ['expire', 'delete', 'correct']) {
      const scope = 'workspace:receipt-' + action;
      const agent = { kind: 'agent', id: 'original-proposer', grants: { scopes: [scope] } };
      const input = candidateInput('Build command is alpha', { scope });
      const proposal = runtime.proposeCandidate({ principal: agent, ...input });
      const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
      if (action === 'delete') await call('memory.delete', { id: accepted.memory.id, expectedRev: accepted.memory.rev });
      else await call('memory.update', { id: accepted.memory.id, expectedRev: accepted.memory.rev,
        ...(action === 'expire' ? { validUntil: now() - 1 } : { content: 'Build command is beta' }) });
      const repeated = runtime.proposeCandidate({ principal: agent, ...input });
      assert.equal(repeated.candidate?.status, 'pending', action);
      assert.equal(repeated.existingMemoryId, undefined, action);
      assert.equal(repeated.candidate.review, undefined, action);
    }
    assert.equal(runtime.countAll(), 2, 'new proposals must not create or restore Memory');
  });

  await check('unreadable receipt with explicit fact governance abstains instead of assuming current validity', async ({ call, runtime }) => {
    const agent = { kind: 'agent', id: 'original-proposer', grants: { scopes: ['workspace:alpha'] } };
    const input = candidateInput('Build command is alpha');
    const proposal = runtime.proposeCandidate({ principal: agent, ...input });
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept' });
    await call('memory.update', { id: accepted.memory.id, expectedRev: accepted.memory.rev, factKey: 'build-command' });
    await call('memory.create', candidateInput('Build command is beta', { factKey: 'build-command' }));
    const repeated = runtime.proposeCandidate({ principal: agent, ...input });
    assert.equal(repeated.candidate?.status, 'pending');
    assert.equal(repeated.existingMemoryId, undefined);
    assert.equal(repeated.candidate.review, undefined);
    assert.throws(() => runtime.get({ principal: agent, id: accepted.memory.id }), { code: 'MEMORY_NOT_FOUND' });
  });

  await check('same-author replay uses a fresh accepted receipt after an older identical Memory expires', async ({ call, runtime, now }) => {
    const agent = { kind: 'agent', id: 'original-proposer', grants: { scopes: ['user:desktop'] } };
    const input = candidateInput('我喜欢简洁的中文回答', { scope: 'user:desktop', type: 'user' });
    const first = runtime.proposeCandidate({ principal: agent, ...input });
    const older = await call('memory.candidates.confirm', { id: first.candidate.id, decision: 'accept' });
    await call('memory.update', { id: older.memory.id, expectedRev: older.memory.rev, validUntil: now() - 1 });
    const second = runtime.proposeCandidate({ principal: agent, ...input });
    assert.equal(second.candidate.status, 'pending');
    const fresh = await call('memory.candidates.confirm', { id: second.candidate.id, decision: 'accept' });
    assert.deepEqual(runtime.proposeCandidate({ principal: agent, ...input }), {
      candidate: null, duplicate: true, existingMemoryId: fresh.memory.id
    });
    assert.equal(runtime.assess({ principal: owner, id: older.memory.id }).status, 'expired');
    assert.deepEqual(runtime.retrieve({ principal: owner, scope: input.scope, query: '' }).memories.map(row => row.id), [fresh.memory.id]);
  });

  await check('pending exact dedup reprojects hints for the actual reader', async ({ call, runtime }) => {
    const saved = await call('memory.create', candidateInput('Build command is alpha'));
    const agent = { kind: 'agent', id: 'proposer', grants: { scopes: ['workspace:alpha'] } };
    const proposal = runtime.proposeCandidate({ principal: agent, ...candidateInput('Build command is beta') });
    const ownerRepeated = proposedByOwner(runtime, 'Build command is beta');
    assert.equal(ownerRepeated.duplicate, true);
    assert.equal(ownerRepeated.candidate.id, proposal.candidate.id);
    assert.deepEqual(ownerRepeated.candidate.review?.hints, [hint(saved, 'possible-conflict', 'same-subject-different-value')]);
    const agentRepeated = runtime.proposeCandidate({ principal: agent, ...candidateInput('Build command is beta') });
    assert.equal(agentRepeated.candidate.review, undefined);
  });

  await check('review references follow current revisions and disappear after deletion', async ({ call, runtime }) => {
    const saved = await call('memory.create', candidateInput('Build command is alpha'));
    const proposal = proposedByOwner(runtime, 'Build command is beta');
    assert.deepEqual(proposal.candidate.review?.hints, [hint(saved, 'possible-conflict', 'same-subject-different-value')]);
    const corrected = await call('memory.update', { id: saved.id, expectedRev: saved.rev, content: 'Build command is beta' });
    assert.deepEqual((await pendingCandidate(call, proposal.candidate.id)).review?.hints, [hint(corrected, 'possible-duplicate', 'normalized-text-match')]);
    await call('memory.delete', { id: corrected.id, expectedRev: corrected.rev });
    assert.equal((await pendingCandidate(call, proposal.candidate.id)).review, undefined);
  });

  await check('hint bounds remain deterministic across restart and expose only references', async ({ call, runtime, stateDir, now }) => {
    const saved = [];
    for (let i = 0; i < 7; i++) saved.push(await call('memory.create', candidateInput('Build command is alpha')));
    const proposal = proposedByOwner(runtime, 'BUILD command is alpha');
    const expected = saved.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 5).map(row => hint(row, 'possible-duplicate', 'normalized-text-match'));
    assert.deepEqual(proposal.candidate.review?.hints, expected);
    assert.equal(proposal.candidate.review?.truncated, true);
    assert.ok(!JSON.stringify(proposal.candidate.review).includes('Build command'));
    const restarted = createMemoryService({ stateDir, now });
    try {
      assert.deepEqual(restarted.runtime.listCandidates({ principal: owner }).candidates.find(row => row.id === proposal.candidate.id).review, proposal.candidate.review);
    } finally { restarted.close(); }
  });

  await check('Owner can correct a possible conflict on confirmation without editing the old Memory', async ({ call, runtime }) => {
    const saved = await call('memory.create', candidateInput('Build command is alpha'));
    const proposal = proposedByOwner(runtime, 'Build command is beta');
    assert.equal(proposal.candidate.review?.status, 'needs-review');
    const accepted = await call('memory.candidates.confirm', { id: proposal.candidate.id, decision: 'accept', content: 'Build command is gamma' });
    assert.equal(accepted.memory.content, 'Build command is gamma');
    assert.equal(accepted.memory.source, 'chat-candidate');
    assert.equal(accepted.memory.origin.proposedBy, 'user:desktop');
    assert.equal((await call('memory.get', { id: saved.id })).memory.content, 'Build command is alpha');
    assert.equal((await call('memory.get', { id: saved.id })).memory.rev, 1);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`Memory candidate review: ${passed} PASS / ${failures} FAIL`);
if (failures) process.exitCode = 1;
