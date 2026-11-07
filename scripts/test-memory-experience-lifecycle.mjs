import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createMemoryRuntime, pruneDecidedCandidates } from '../src/memory/runtime.js';
import { createMemoryService } from '../src/memory/service.js';
import { experienceReferenceMetadata } from '../src/memory/experience.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-memory-experience-')));
const owner = { kind: 'user', id: 'desktop' };
const reader = { kind: 'agent', id: 'reader', grants: { scopes: ['workspace:alpha'], types: ['skill'] } };
const conditions = { workspaceId: 'alpha', platform: process.platform, tool: 'npm', configDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64) };
const context = { ...conditions };
let time = 1800000000000, passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }
function fixture(name) { const stateDir = path.join(root, name); return { stateDir, rt: createMemoryRuntime({ stateDir, now: () => ++time }) }; }
function proposal(rt, n = 1, extra = {}) {
  assert.equal(typeof rt.proposeExperienceCandidate, 'function', 'existing Memory candidate owner must accept trusted bounded experience suggestions');
  return rt.proposeExperienceCandidate({ type: 'skill', scope: 'workspace:alpha', content: 'Conditional reference ' + n + ': run the configured verifier before accepting this project change.',
    experience: { schemaVersion: 1, trigger: { id: String(n).padStart(64, '0'), kind: 'owner-correction', taskId: 'source-task-' + n, workspaceId: 'alpha',
      turnId: 'turn-' + n, provider: 'cetamesh', sessionId: 'session', runId: 'run-' + n, ownerMessageId: 'owner-' + n }, conditions, evidence: [] }, ...extra }).candidate;
}
function accept(rt, n = 1) { const candidate = proposal(rt, n); return rt.confirmCandidate({ principal: owner, id: candidate.id, decision: 'accept' }).memory; }

try {
  await check('Owner confirmation creates a trial reference, pending never recalls, and exact current conditions are required', () => {
    const { rt, stateDir } = fixture('trial'); const pending = proposal(rt);
    assert.equal(rt.retrieve({ principal: reader, query: '', experienceContext: context }).memories.length, 0);
    const row = rt.confirmCandidate({ principal: owner, id: pending.id, decision: 'accept' }).memory;
    assert.equal(row.experience.state, 'trial'); assert.equal(row.provenance.status, 'conditional-reference');
    assert.equal(rt.retrieve({ principal: reader, query: '' }).memories.length, 0, 'no trusted condition context is not a match');
    assert.deepEqual(rt.retrieve({ principal: reader, query: '', experienceContext: context }).memories.map(row => row.id), [row.id]);
    for (const patch of [{ workspaceId: 'other' }, { platform: 'other' }, { tool: 'cargo' }, { configDigest: 'c'.repeat(64) }, { sourceDigest: 'd'.repeat(64) }]) {
      assert.equal(rt.retrieve({ principal: reader, query: '', experienceContext: { ...context, ...patch } }).memories.length, 0);
    }
    const reopened = createMemoryRuntime({ stateDir });
    assert.equal(reopened.get({ principal: owner, id: row.id }).memory.experience.state, 'trial');
    assert.equal(reopened.assess({ principal: reader, id: row.id }).status, 'conditional');
  });
  await check('conditional recall shares the existing authorization and admits at most one trial and three total experiences', () => {
    const { rt } = fixture('limits'); const rows = [1, 2, 3, 4, 5, 6].map(n => accept(rt, n));
    for (const row of rows.slice(2)) rt.transitionExperience({ principal: owner, id: row.id, expectedRev: row.rev, state: 'active', experienceContext: context });
    rt.update({ principal: owner, id: rows[0].id, expectedRev: rows[0].rev, pinned: true });
    const found = rt.retrieve({ principal: reader, scope: 'workspace:alpha', limit: 50, experienceContext: context }).memories;
    assert.equal(found.length, 3); assert.equal(found.filter(row => row.experience.state === 'trial').length, 1);
    assert.throws(() => rt.retrieve({ principal: reader, scope: 'workspace:other', experienceContext: { ...context, workspaceId: 'other' } }), { code: 'SCOPE_NOT_AUTHORIZED' });
    const noSkill = { kind: 'agent', id: 'none', grants: { scopes: ['workspace:alpha'], types: ['working'] } };
    assert.equal(rt.retrieve({ principal: noSkill, experienceContext: context }).memories.length, 0);
    rt.create({ principal: owner, type: 'user', scope: 'user:desktop', content: 'Stable preference remains separate.' });
    assert.equal(rt.retrieve({ principal: owner, scope: 'user:desktop' }).memories[0].type, 'user');
  });
  await check('Owner CAS revision, retire/reactivate and retained rollback preserve later observations with bounded history', () => {
    const { rt, stateDir } = fixture('revisions'); let row = accept(rt);
    assert.throws(() => rt.transitionExperience({ principal: reader, id: row.id, expectedRev: row.rev, state: 'active', experienceContext: context }), { code: 'UNAUTHORIZED' });
    row = rt.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Conditional reference: revised by Owner.', experienceContext: context });
    assert.equal(row.experience.history[0].content.startsWith('Conditional reference 1'), true);
    assert.throws(() => rt.transitionExperience({ principal: owner, id: row.id, expectedRev: 1, state: 'retired' }), { code: 'MEMORY_CONFLICT' });
    const revision = row.rev;
    row = rt.transitionExperience({ principal: owner, id: row.id, expectedRev: row.rev, state: 'retired' });
    assert.equal(rt.retrieve({ principal: reader, experienceContext: context }).memories.length, 0);
    assert.equal(rt.get({ principal: owner, id: row.id }).memory.content, 'Conditional reference: revised by Owner.');
    assert.throws(() => rt.transitionExperience({ principal: owner, id: row.id, expectedRev: row.rev, state: 'active', experienceContext: { ...context, configDigest: 'c'.repeat(64) } }), { code: 'EXPERIENCE_CONDITIONS_CHANGED' });
    row = rt.rollbackExperience({ principal: owner, id: row.id, expectedRev: row.rev, revision, experienceContext: context });
    assert.equal(row.experience.state, 'trial'); assert.equal(row.rev, 4);
    for (let n = 0; n < 7; n++) row = rt.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Conditional reference: edit ' + n, experienceContext: context });
    assert.equal(row.experience.history.length, 4); assert.ok(row.experience.omittedHistory >= 5);
    assert.throws(() => rt.rollbackExperience({ principal: owner, id: row.id, expectedRev: row.rev, revision: 1, experienceContext: context }), { code: 'EXPERIENCE_REVISION_UNAVAILABLE' });
    const restarted = createMemoryRuntime({ stateDir }); assert.equal(restarted.get({ principal: owner, id: row.id }).memory.experience.history.length, 4);
  });
  await check('Core observation receipts count once, do not imply causality or promote a trial, and survive rollback', () => {
    const { rt } = fixture('observations'); let row = accept(rt);
    const reviewedAt = row.provenance.at;
    assert.equal(typeof rt.recordExperienceOutcome, 'function');
    const receipt = { eventId: 'core-test:later', taskId: 'later-task', workspaceId: 'alpha', provider: 'cetamesh', sessionId: 'later-session', runId: 'later-run',
      operationId: 'later-op', status: 'pass', resultSha256: 'e'.repeat(64), at: time };
    row = rt.recordExperienceOutcome({ id: row.id, expectedRev: row.rev, experienceContext: context, evidence: receipt });
    assert.equal(row.experience.state, 'trial'); assert.equal(row.experience.outcomes.length, 1);
    assert.equal(row.provenance.at, reviewedAt, 'machine observations cannot forge a later Owner review time');
    const duplicate = rt.recordExperienceOutcome({ id: row.id, expectedRev: row.rev, experienceContext: context, evidence: receipt });
    assert.equal(duplicate.rev, row.rev); assert.equal(duplicate.experience.outcomes.length, 1);
    row = rt.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Conditional reference: observations are not causal attribution.', experienceContext: context });
    row = rt.rollbackExperience({ principal: owner, id: row.id, expectedRev: row.rev, revision: 2, experienceContext: context });
    assert.equal(row.experience.outcomes.length, 1); assert.equal(row.experience.state, 'trial');
    assert.throws(() => rt.recordExperienceOutcome({ id: row.id, expectedRev: row.rev, experienceContext: context, evidence: { ...receipt, eventId: 'native:self-report', status: 'unknown' } }), { code: 'INVALID_EXPERIENCE' });
    for (let n = 1; n < 8; n++) row = rt.recordExperienceOutcome({ id: row.id, expectedRev: row.rev, experienceContext: context,
      evidence: { ...receipt, eventId: 'core-test:bounded-' + n, operationId: 'bounded-op-' + n } });
    const full = rt.recordExperienceOutcome({ id: row.id, expectedRev: row.rev, experienceContext: context,
      evidence: { ...receipt, eventId: 'core-test:ninth', operationId: 'ninth-op' } });
    assert.equal(full.observation.code, 'EXPERIENCE_OUTCOME_LIMIT'); assert.equal(full.rev, row.rev); assert.equal(full.experience.outcomes.length, 8);
  });
  await check('expired/conflicted/superseded sources never recall or become active through rollback', () => {
    const { rt } = fixture('stale'); let row = accept(rt);
    row = rt.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Conditional reference: newer wording.', experienceContext: context });
    const replacement = rt.create({ principal: owner, type: 'skill', scope: row.scope, content: 'Replacement reference' });
    rt.createLink({ principal: owner, source: { kind: 'memory', id: replacement.id, scope: replacement.scope }, target: { kind: 'memory', id: row.id, scope: row.scope }, relation: 'supersedes' });
    assert.ok(!rt.retrieve({ principal: reader, experienceContext: context }).memories.some(item => item.id === row.id));
    assert.throws(() => rt.rollbackExperience({ principal: owner, id: row.id, expectedRev: row.rev, revision: 1, experienceContext: context }), { code: 'EXPERIENCE_SOURCE_REVIEW_REQUIRED' });
    const expired = accept(rt, 2); rt.update({ principal: owner, id: expired.id, expectedRev: expired.rev, validUntil: time - 1 });
    assert.ok(!rt.retrieve({ principal: reader, experienceContext: context }).memories.some(item => item.id === expired.id));
  });
  await check('interrupted confirmation and failed revision writes preserve the single existing Memory row and recoverable metadata', () => {
    const { rt, stateDir } = fixture('recovery'); const pending = proposal(rt);
    const insert = rt._store.insert;
    rt._store.insert = (record, options) => { insert(record, options); throw Object.assign(new Error('fixture crash after Memory commit'), { code: 'EIO' }); };
    assert.throws(() => rt.confirmCandidate({ principal: owner, id: pending.id, decision: 'accept' }), /fixture crash/);
    const reopened = createMemoryRuntime({ stateDir }); assert.deepEqual(reopened.recoverConfirmations({ principal: owner }).recovered, [pending.id]);
    let row = reopened.get({ principal: owner, id: 'mem_' + pending.id }).memory;
    assert.equal(row.experience.state, 'trial'); assert.equal(reopened.countAll(), 1);
    const file = reopened._store.file, bytes = fs.readFileSync(file); fs.unlinkSync(file); fs.mkdirSync(file);
    try { assert.throws(() => reopened.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Must not become visible after failed write.', experienceContext: context })); }
    finally { fs.rmdirSync(file); fs.writeFileSync(file, bytes); }
    assert.equal(reopened.get({ principal: owner, id: row.id }).memory.rev, row.rev);
    assert.equal(reopened.get({ principal: owner, id: row.id }).memory.experience.history.length, 0);
    row = reopened.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Conditional reference: retry succeeds.', experienceContext: context });
    assert.equal(row.rev, 2);
  });
  await check('decided experience triggers remain durable under ordinary candidate retention and IPC cannot forge Core metadata', async () => {
    const { rt, stateDir } = fixture('retention'); const pending = proposal(rt);
    rt.confirmCandidate({ principal: owner, id: pending.id, decision: 'reject' });
    for (let n = 0; n < 205; n++) {
      const candidate = rt.proposeCandidate({ principal: { kind: 'agent', id: 'ordinary', grants: { scopes: ['workspace:alpha'] } }, type: 'workspace', scope: 'workspace:alpha', content: 'Ordinary distinct candidate ' + n }).candidate;
      rt.confirmCandidate({ principal: owner, id: candidate.id, decision: 'reject' });
    }
    const reopened = createMemoryRuntime({ stateDir }); assert.equal(proposal(reopened, 1, { content: 'Rewording the same source cannot undo an Owner rejection.' }).status, 'rejected');
    assert.throws(() => reopened.proposeCandidate({ principal: reader, scope: 'workspace:alpha', type: 'skill', content: 'forged', experience: pending.experience }), { code: 'EXPERIENCE_CORE_ONLY' });
    const service = createMemoryService({ stateDir });
    const untrusted = await service.execute({ method: 'memory.candidates.propose', params: { agentId: 'core-task-experience', scopes: ['workspace:alpha'], type: 'skill', scope: 'workspace:alpha', content: 'Caller cannot assign verified machine provenance.', experience: pending.experience } });
    assert.equal(untrusted.candidate.experience, undefined);
    assert.equal(pruneDecidedCandidates(Array.from({ length: 201 }, (_, n) => ({ id: String(n), status: 'rejected', decidedAt: n }))).length, 200);
  });
  await check('Memory Owner service ignores renderer principals and sources applicability from its injected current Workspace resolver', async () => {
    const { rt, stateDir } = fixture('service'); let row = accept(rt);
    const service = createMemoryService({ stateDir, resolveExperienceContext: () => context });
    row = await service.execute({ method: 'memory.experience.transition', params: { id: row.id, expectedRev: row.rev, state: 'active', principal: reader, experienceContext: { ...context, workspaceId: 'other' } } });
    assert.equal(row.experience.state, 'active');
    assert.equal(row.updatedBy === 'agent:reader', false);
  });
  await check('the v1 writer projection retains canonical origin metadata and ordinary origin parameters cannot mint experience', async () => {
    const { rt, stateDir } = fixture('v1-roundtrip'); const row = accept(rt);
    const file = rt._store.file, raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const saved = raw.memories.find(item => item.id === row.id);
    assert.equal(saved.experience, undefined, 'canonical metadata must have one owner inside the existing origin object');
    assert.equal(saved.origin.experience.state, 'trial');
    // Exact known-field projection used by the preceding v1 JSON store. It
    // copies origin intact while discarding unknown top-level record fields.
    raw.memories = raw.memories.map(item => Object.fromEntries(['id', 'type', 'scope', 'scopeKey', 'content', 'tags', 'source', 'pinned', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'rev', 'confirmedAt', 'confirmedBy', 'origin', 'sourceRefs', 'entityIds', 'factKey', 'validUntil']
      .filter(key => Object.hasOwn(item, key)).map(key => [key, structuredClone(item[key])])));
    fs.writeFileSync(file, JSON.stringify(raw));
    const restarted = createMemoryRuntime({ stateDir });
    assert.equal(restarted.get({ principal: owner, id: row.id }).memory.experience.state, 'trial');
    const ordinary = restarted.create({ principal: owner, type: 'skill', scope: 'workspace:alpha', content: 'Ordinary supplied origin is never a trusted experience.', origin: { experience: row.experience } });
    assert.equal(ordinary.experience, undefined);
    assert.throws(() => restarted._store.insert({ ...restarted._store.get(row.id), id: 'forged-origin', experience: undefined,
      origin: { experience: row.experience } }), { code: 'EXPERIENCE_CORE_ONLY' });
    assert.throws(() => restarted._store.insert({ ...restarted._store.get(row.id), id: 'forged-top-level' }), { code: 'EXPERIENCE_CORE_ONLY' });
    const detached = restarted._store.get(row.id); detached.experience.state = 'active';
    assert.equal(restarted.get({ principal: owner, id: row.id }).memory.experience.state, 'trial', 'returned metadata cannot alias the live store');
    assert.throws(() => restarted._store.update(row.id, row.rev, draft => { draft.experience.state = 'active'; return draft; }), { code: 'EXPERIENCE_CORE_ONLY' });
    assert.equal(restarted.get({ principal: owner, id: row.id }).memory.experience.state, 'trial', 'a refused write must not mutate nested live metadata');
    const service = createMemoryService({ stateDir });
    const request = await service.execute({ method: 'memory.create', params: { type: 'skill', scope: 'workspace:alpha', content: 'An IPC origin parameter does not install a trial.', origin: { experience: row.experience } } });
    assert.equal(request.experience, undefined);
  });
  await check('rendered experience detail identifies trial/reference scope, exact evidence and bounded revision actions', async () => {
    const uiRoot = path.resolve(import.meta.dirname, '../desktop-ui'), require = createRequire(path.join(uiRoot, 'package.json'));
    const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
    const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
    const vite = await createServer({ root: uiRoot, configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    try {
      const module = fs.existsSync(path.join(uiRoot, 'src/app/MemoryExperienceDetails.tsx')) ? await vite.ssrLoadModule('/src/app/MemoryExperienceDetails.tsx') : {};
      assert.equal(typeof module.MemoryExperienceDetails, 'function', 'Owner needs a rendered governed experience detail surface');
      const { rt } = fixture('rendered'); let row = accept(rt);
      row = rt.reviseExperience({ principal: owner, id: row.id, expectedRev: row.rev, content: 'Conditional reference: retained revision.', experienceContext: context });
      const html = renderToStaticMarkup(React.createElement(module.MemoryExperienceDetails, { id: row.id, revision: row.rev, content: row.content,
        experience: row.experience, onTransition() {}, onRevise() {}, onRollback() {} }));
      for (const expected of [/试用/, /条件参考/, /适用条件/, /alpha/, /npm/, /source-task-1/, /run-1/, /观察结果/, /修订历史/, /退役/, /回滚/]) assert.match(html, expected);
      assert.ok(!html.includes('已验证事实'));
    } finally { await vite.close(); }
  });
  await check('the context projection stays bounded without losing trial semantics or inventing truncated source identities', () => {
    const { rt } = fixture('context-projection'); const row = accept(rt);
    const experience = structuredClone(row.experience);
    experience.trigger.runId = 'r'.repeat(240); experience.trigger.taskId = 't'.repeat(128);
    experience.evidence = [1, 2].map(n => ({ eventId: 'core-test:' + String(n).repeat(220), taskId: experience.trigger.taskId, workspaceId: 'alpha', provider: 'cetamesh', sessionId: 's'.repeat(128), runId: 'r'.repeat(240), operationId: 'o'.repeat(160), status: n === 1 ? 'fail' : 'pass', resultSha256: 'c'.repeat(64), at: time }));
    const projected = experienceReferenceMetadata(experience);
    assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= 800, 'full receipts would consume all shared Memory context before advice can be used');
    assert.equal(projected.state, 'trial'); assert.equal(projected.meaning, 'conditional-reference');
    assert.equal(projected.source.taskId, experience.trigger.taskId); assert.equal(projected.source.runId, experience.trigger.runId);
    assert.equal(projected.evidence.length + projected.omittedEvidence, 2);
    assert.equal(Object.hasOwn(projected, 'history'), false);
  });
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
console.log(`Memory experience lifecycle: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
