import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleFile = path.join(root, 'src/simulation/persona-assets.js');
assert.ok(fs.existsSync(moduleFile), 'Simulation persona asset implementation is required');
const { createPersonaLibrary } = await import('../src/simulation/persona-assets.js');
const dirs = [];
const fresh = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulation-persona-')); dirs.push(dir); return dir; };
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const library = (options = {}) => createPersonaLibrary({ stateDir: fresh(), legacyRoots: [], ...options });
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

test('persona module loads in the CJS format used by Core SEA without import.meta', () => {
  const temp = fresh();
  const bundle = path.join(temp, 'persona.cjs');
  buildSync({ entryPoints: [moduleFile], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    logOverride: { 'empty-import-meta': 'silent' } });
  const result = spawnSync(process.execPath, ['-e', `
    const { createPersonaLibrary } = require(process.argv[1]);
    const library = createPersonaLibrary({ stateDir: process.argv[2], legacyRoots: [] });
    process.stdout.write(JSON.stringify(library.list()));
  `, bundle, path.join(temp, 'state')], { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).roles, []);
});

// Catches the former 6000-character prefix loss and false positive recommendations.
test('original repository card retains exact source and all positive/negative tail examples', () => {
  const stateDir = fresh();
  const lib = createPersonaLibrary({ stateDir, legacyRoots: [path.join(root, 'roles')] });
  assert.deepEqual(lib.list().roles, []);
  const inventory = lib.inventoryLegacy();
  const asset = inventory.assets.find(row => row.name === '小鲸鱼');
  assert.ok(asset?.requiresOwnershipConfirmation);
  assert.equal(Object.hasOwn(asset, 'sourceText'), false);
  const raw = fs.readFileSync(path.join(root, 'roles/小鲸鱼.md'), 'utf8');
  assert.ok(raw.length > 6000);
  const imported = lib.importLegacy({ assetId: asset.id, expectedSha256: asset.sha256, confirm: true, ownershipConfirmed: true });
  const role = imported.role;
  assert.equal(role.sourceText, raw);
  assert.equal(role.sha256, hash(raw));
  assert.equal(imported.backup.sha256, hash(raw));
  assert.ok(role.examples.some(row => row.kind === 'negative' && row.content.includes('哈哈是的呢～') && row.recommended === false));
  assert.ok(role.examples.some(row => row.kind === 'positive' && row.content.includes('这叫鲸鱼该有的丰满')));
  assert.equal(createPersonaLibrary({ stateDir, legacyRoots: [] }).get({ id: role.id }).role.sourceText, raw);
});

test('save versions examples independently, searches edited text and restores without rewriting old revisions', () => {
  const lib = library();
  const first = lib.save({ name: '角色', sourceText: '# 身份\n冷静的观察者', examples: [{ id: 'ex_a', kind: 'positive', input: '你好', output: '在呢', tags: ['greeting'] }] }).role;
  const second = lib.save({ id: first.id, expectedRev: first.rev, name: '角色二', sourceText: first.sourceText, examples: [{ id: 'ex_a', kind: 'negative', content: '不要复制这句：菠萝星云', tags: ['edited'] }] }).role;
  assert.equal(second.rev, 2);
  assert.equal(second.examples[0].revision, 2);
  assert.equal(second.examples[0].recommended, false);
  assert.equal(lib.searchExamples({ roleId: first.id, query: '菠萝星云' }).examples[0].id, 'ex_a');
  assert.equal(lib.searchExamples({ roleId: first.id, revision: 1, query: '菠萝星云' }).examples.length, 0);
  const restored = lib.restoreRole({ id: first.id, revision: 1, expectedRev: 2 }).role;
  assert.equal(restored.rev, 3);
  assert.equal(restored.name, '角色');
  assert.equal(restored.examples[0].messages[1].content, '在呢');
  assert.equal(lib.get({ id: first.id, revision: 2 }).role.name, '角色二');
  assert.deepEqual(restored.versions.map(v => v.rev), [1, 2, 3]);
  code(() => lib.save({ id: first.id, expectedRev: 1, name: 'stale', sourceText: '' }), 'ROLE_CONFLICT');
  code(() => lib.save({ id: first.id, name: 'missing rev', sourceText: '' }), 'REVISION_REQUIRED');
});

test('two live libraries detect concurrent edits from disk instead of overwriting', () => {
  const stateDir = fresh(); const one = createPersonaLibrary({ stateDir, legacyRoots: [] });
  const first = one.save({ name: 'first', sourceText: 'a' }).role;
  const two = createPersonaLibrary({ stateDir, legacyRoots: [] });
  assert.equal(two.get({ id: first.id }).role.rev, 1);
  one.save({ id: first.id, expectedRev: 1, name: 'winner', sourceText: 'b' });
  code(() => two.save({ id: first.id, expectedRev: 1, name: 'loser', sourceText: 'c' }), 'ROLE_CONFLICT');
  assert.equal(two.get({ id: first.id }).role.sourceText, 'b');
});

test('bounded retrieval finds relevant tail segments without losing raw source or recommending negatives', () => {
  const lib = library();
  const source = '# 身份\n我是谨慎观察者。\n\n' + Array.from({ length: 24 }, (_, n) => `## 普通章节${n}\n${'日常聊天。'.repeat(110)}\n`).join('')
    + '\n## 潜水和冷却\n天文彗星接近时先观察，没人点名就沉默。\n\n## 回复示例\n群友：彗星来了\n你不要：保证撞地球\n你可以：先看看轨道\n';
  const role = lib.save({ name: '观察者', sourceText: source, behavior: { willingness: 0.25, interests: ['天文'], cooldownMs: 1500 } }).role;
  const context = lib.buildContext({ roleId: role.id, query: '天文彗星', scene: '潜水', maxChars: 2400 });
  assert.ok(context.messages.reduce((n, row) => n + row.content.length, 0) <= 2400);
  assert.ok(context.messages.some(row => row.content.includes('先观察')));
  assert.ok(context.messages.some(row => row.content.includes('谨慎观察者')));
  assert.ok(context.sourceOmitted && context.omittedSegments > 0);
  assert.ok(context.selectedSegments.every(row => row.id && row.sha256 && row.revision === 1));
  assert.ok(context.selectedExamples.some(row => row.kind === 'negative' && row.recommended === false));
  assert.equal(context.sourceHash, hash(source));
  assert.equal(context.behavior.cooldownMs, 1500);
  assert.equal(lib.get({ id: role.id }).role.sourceText, source);
  code(() => lib.buildContext({ roleId: role.id, maxChars: 20 }), 'CONTEXT_BUDGET_INVALID');
});

test('multi-turn dialogue is one ordered versioned example and source text remains exact', () => {
  const lib = library();
  const text = '# 身份\r\n旁观者\r\n\r\n## 多轮对话示例\r\n用户：来了\r\n你：嗯\r\n用户：还在吗\r\n你：在\r\n';
  const role = lib.save({ name: '多轮', sourceText: text }).role;
  const example = role.examples.find(row => row.kind === 'multi-turn');
  assert.deepEqual(example.messages.map(row => row.content), ['来了', '嗯', '还在吗', '在']);
  assert.equal(role.sourceText, text);
  assert.ok(example.content.includes('用户：还在吗'));
});

test('export/import preserves full source hashes, original histories and edited examples with explicit confirmation', () => {
  const lib = library();
  const first = lib.save({ name: '源', sourceText: '\uFEFF# 原文\r\n' + '鲸'.repeat(7000), allowedTools: ['filesystem.write'], memoryScopes: ['global'], model: { provider: 'p', model: 'm' } }).role;
  lib.save({ id: first.id, expectedRev: 1, name: '新版', sourceText: 'new', examples: [{ kind: 'negative', content: 'unsafe example' }] });
  const bundle = lib.exportRole({ id: first.id }).bundle;
  const target = library();
  code(() => target.importRole({ bundle }), 'CONFIRMATION_REQUIRED');
  const imported = target.importRole({ bundle, confirm: true }).role;
  assert.equal(imported.sha256, hash('new'));
  assert.equal(target.get({ id: imported.id, revision: 1 }).role.sha256, first.sha256);
  assert.equal(target.get({ id: imported.id, revision: 1 }).role.sourceText, first.sourceText);
  assert.equal(imported.examples[0].content, 'unsafe example');
  assert.deepEqual(imported.allowedTools, []);
  const context = target.buildContext({ roleId: imported.id, query: 'unsafe' });
  assert.ok(context.messages[0].content.includes('not authorization'));
  assert.equal(context.tools, undefined);
  const tampered = structuredClone(bundle); tampered.role.versions[0].sourceText += 'tamper';
  code(() => target.importRole({ bundle: tampered, confirm: true }), 'BUNDLE_INVALID');
});

test('source byte limits reject without truncation and malformed metadata never grants authority', () => {
  const lib = library();
  const text = 'x'.repeat(256 * 1024);
  assert.equal(lib.save({ name: 'max', sourceText: text }).role.sourceText.length, text.length);
  code(() => lib.save({ name: 'too large', sourceText: text + 'x' }), 'SOURCE_TOO_LARGE');
  code(() => lib.save({ id: '../escape', name: 'bad', sourceText: '' }), 'ROLE_ID_INVALID');
  code(() => lib.save({ id: 'CON', name: 'bad', sourceText: '' }), 'ROLE_ID_INVALID');
  code(() => lib.save({ name: 'bad', sourceText: '', behavior: { willingness: 2 } }), 'BEHAVIOR_INVALID');
  code(() => lib.save({ name: 'bad', sourceText: '', examples: [{ kind: 'tool', content: 'execute' }] }), 'EXAMPLE_INVALID');
});

test('legacy import requires ownership, fresh inventory hash, whitelist and exact backup', () => {
  const temp = fresh(); const roleDir = path.join(temp, 'roles'); fs.mkdirSync(roleDir);
  const file = path.join(roleDir, 'owned.md'); fs.writeFileSync(file, '# Owned\nhello');
  fs.writeFileSync(path.join(roleDir, 'private-message.json'), '{"private":"body"}');
  fs.writeFileSync(path.join(roleDir, 'README.md'), 'not a card');
  const stateDir = fresh(); const lib = createPersonaLibrary({ stateDir, legacyRoots: [roleDir] });
  const asset = lib.inventoryLegacy().assets[0];
  assert.equal(lib.inventoryLegacy().assets.length, 1);
  code(() => lib.importLegacy({ assetId: asset.id, expectedSha256: asset.sha256, confirm: true }), 'OWNERSHIP_REQUIRED');
  code(() => lib.importLegacy({ assetId: '../../owned.md', expectedSha256: asset.sha256, confirm: true, ownershipConfirmed: true }), 'LEGACY_ASSET_NOT_FOUND');
  fs.appendFileSync(file, '\nchanged');
  code(() => lib.importLegacy({ assetId: asset.id, expectedSha256: asset.sha256, confirm: true, ownershipConfirmed: true }), 'LEGACY_HASH_MISMATCH');
  const current = lib.inventoryLegacy().assets[0];
  const result = lib.importLegacy({ assetId: current.id, expectedSha256: current.sha256, confirm: true, ownershipConfirmed: true });
  const backup = JSON.parse(fs.readFileSync(path.join(stateDir, 'simulation/legacy-backups', result.backup.id + '.json'), 'utf8'));
  assert.equal(backup.sourceText, fs.readFileSync(file, 'utf8'));
  assert.equal(backup.sha256, current.sha256);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Owned\nhello\nchanged');
  code(() => createPersonaLibrary({ stateDir: fresh(), legacyRoots: [temp] }).inventoryLegacy(), 'LEGACY_ROOT_INVALID');
});

test('legacy preset inventory is fixed filenames only and never reads runtime/social state', () => {
  const temp = fresh(); const presets = path.join(temp, 'agent-presets'); const preset = path.join(presets, 'whale'); fs.mkdirSync(preset, { recursive: true });
  fs.writeFileSync(path.join(preset, 'agent.cordis.yml'), 'persona: safe reference');
  fs.writeFileSync(path.join(preset, 'preset.yml'), 'name: whale');
  fs.writeFileSync(path.join(preset, 'messages.json'), '["private body"]');
  fs.mkdirSync(path.join(preset, 'state')); fs.writeFileSync(path.join(preset, 'state/secret.md'), 'private');
  const assets = library({ legacyRoots: [presets] }).inventoryLegacy().assets;
  assert.equal(assets.length, 2);
  assert.ok(assets.every(row => row.kind === 'dsh-preset'));
  assert.equal(JSON.stringify(assets).includes('private body'), false);
});

test('linked state directories and legacy files fail closed without reading outside bodies', () => {
  const stateDir = fresh(); const outside = fresh();
  fs.symlinkSync(outside, path.join(stateDir, 'simulation'), process.platform === 'win32' ? 'junction' : 'dir');
  code(() => createPersonaLibrary({ stateDir, legacyRoots: [] }).save({ name: 'escape', sourceText: 'no' }), 'PATH_UNSAFE');
  assert.deepEqual(fs.readdirSync(outside), []);
  const temp = fresh(); const roles = path.join(temp, 'roles'); fs.mkdirSync(roles); fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  fs.symlinkSync(outside, path.join(roles, 'linked.md'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(library({ legacyRoots: [roles] }).inventoryLegacy().assets, []);
});

test('corrupt and oversized store is preserved and errors exclude paths and raw private data', () => {
  const stateDir = fresh(); const dir = path.join(stateDir, 'simulation'); fs.mkdirSync(dir);
  const file = path.join(dir, 'personas.json'); const invalid = '{PRIVATE_BODY secret-token'; fs.writeFileSync(file, invalid);
  const lib = createPersonaLibrary({ stateDir, legacyRoots: [] });
  let caught; try { lib.list(); } catch (error) { caught = error; }
  assert.equal(caught.code, 'STORE_CORRUPT');
  assert.equal(caught.message.includes('PRIVATE_BODY'), false);
  assert.equal(caught.message.includes(stateDir), false);
  code(() => lib.save({ name: 'overwrite', sourceText: 'no' }), 'STORE_CORRUPT');
  assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  fs.writeFileSync(file, ' '.repeat(32 * 1024 * 1024 + 1));
  code(() => lib.list(), 'STORE_TOO_LARGE');
});

// Catches oversized IPC projections and insufficient output room without changing raw source.
test('list returns bounded summaries and single-revision get never expands all source history', () => {
  const lib = library();
  const sourceText = 'a'.repeat(256 * 1024);
  const first = lib.save({ name: 'large', sourceText }).role;
  lib.save({ id: first.id, expectedRev: 1, name: 'large two', sourceText });
  const summary = lib.list().roles[0];
  assert.equal(summary.sourceText, undefined);
  assert.equal(summary.examples, undefined);
  assert.equal(summary.revisionCount, 2);
  const role = lib.get({ id: first.id }).role;
  assert.equal(role.versions[0].sourceText, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(role)) < 800 * 1024);
  const third = lib.save({ id: first.id, expectedRev: 2, name: 'large three', sourceText }).role;
  lib.save({ id: first.id, expectedRev: third.rev, name: 'large four', sourceText });
  code(() => lib.exportRole({ id: first.id }), 'BUNDLE_TOO_LARGE');
  assert.equal(lib.exportRole({ id: first.id, revision: 1 }).bundle.role.versions.length, 1);
  code(() => lib.save({ name: 'many examples', sourceText, examples: Array.from({ length: 30 }, (_, n) => ({ kind: 'positive', content: `${n}:` + 'x'.repeat(30000) })) }), 'ROLE_TOO_LARGE');
});

test('state lock is exclusive and unsuccessful writes never publish a role or replace existing data', () => {
  const stateDir = fresh(); const lib = createPersonaLibrary({ stateDir, legacyRoots: [] });
  const first = lib.save({ name: 'before', sourceText: 'before' }).role;
  const file = path.join(stateDir, 'simulation/personas.json'); const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(stateDir, 'simulation/personas.lock'), 'existing writer');
  code(() => lib.save({ id: first.id, expectedRev: 1, name: 'blocked', sourceText: 'after' }), 'STORE_BUSY');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.unlinkSync(path.join(stateDir, 'simulation/personas.lock'));
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('unavailable volume'), { code: 'ENOSPC' }); };
  try { code(() => lib.save({ id: first.id, expectedRev: 1, name: 'failed', sourceText: 'after' }), 'STORE_WRITE_FAILED'); }
  finally { fs.renameSync = rename; }
  assert.equal(lib.get({ id: first.id }).role.sourceText, 'before');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(fs.readdirSync(path.dirname(file)).every(name => !name.endsWith('.tmp') && !name.endsWith('.lock')));
});

test('negative example headings never relabel rejected multi-turn text as a recommended reply', () => {
  const lib = library();
  const sourceText = '# 身份\n观察者\n\n## 反例：不要这样说\n用户：想听点啥\n助手：保证你满意\n用户：真的吗\n助手：绝对有效\n\n## 正例示范\n用户：来了\n助手：嗯\n';
  const role = lib.save({ name: 'negative headings', sourceText }).role;
  const bad = role.examples.find(row => row.content.includes('保证你满意'));
  assert.ok(bad, 'explicit negative heading must be indexed');
  assert.equal(bad.kind, 'negative');
  assert.equal(bad.recommended, false);
  assert.deepEqual(bad.messages.map(row => row.content), ['想听点啥', '保证你满意', '真的吗', '绝对有效']);
});

test('small allowed context budgets still select relevant source beyond a large first section', () => {
  const lib = library();
  const sourceText = '日常内容。'.repeat(300) + '\n## 天文\n彗星来了先观察轨道\n';
  const role = lib.save({ name: 'small context', sourceText }).role;
  const context = lib.buildContext({ roleId: role.id, query: '彗星', maxChars: 1200 });
  assert.ok(context.messages.some(row => row.content.includes('先观察轨道')));
  assert.ok(context.messages.reduce((sum, row) => sum + row.content.length, 0) <= 1200);
  assert.ok(context.selectedSegments.some(row => row.start > 1200));
});

test('legacy revision provenance binds original backup and remains across edits and bundle imports', () => {
  const temp = fresh(); const roles = path.join(temp, 'roles'); fs.mkdirSync(roles);
  fs.writeFileSync(path.join(roles, 'owned.md'), '\uFEFF# 原文\r\n独立内容\r\n');
  const lib = library({ legacyRoots: [roles] }); const asset = lib.inventoryLegacy().assets[0];
  const { role, backup } = lib.importLegacy({ assetId: asset.id, expectedSha256: asset.sha256, confirm: true, ownershipConfirmed: true });
  assert.deepEqual(role.origin, { kind: 'legacy', assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes, backupId: backup.id });
  assert.equal(role.sourceText.charCodeAt(0), 0xFEFF);
  const updated = lib.save({ id: role.id, expectedRev: role.rev, name: 'edited', sourceText: '# edited' }).role;
  assert.deepEqual(updated.origin, role.origin);
  const target = library(); const imported = target.importRole({ bundle: lib.exportRole({ id: role.id }).bundle, confirm: true }).role;
  assert.deepEqual(imported.origin, role.origin);
});

test('JSON null and malformed revision counters fail closed instead of initializing replacement data', () => {
  const stateDir = fresh(); const dir = path.join(stateDir, 'simulation'); fs.mkdirSync(dir);
  const file = path.join(dir, 'personas.json'); const lib = createPersonaLibrary({ stateDir, legacyRoots: [] });
  for (const raw of ['null', '{"schemaVersion":1,"revision":-1,"roles":[]}', '{"schemaVersion":1,"revision":9007199254740992,"roles":[]}']) {
    fs.writeFileSync(file, raw);
    code(() => lib.list(), 'STORE_CORRUPT');
    code(() => lib.save({ name: 'replacement', sourceText: '' }), 'STORE_CORRUPT');
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('unexpected legacy filesystem failures expose safe domain errors without raw paths or contents', () => {
  const temp = fresh(); const roles = path.join(temp, 'roles'); fs.mkdirSync(roles);
  const lib = library({ legacyRoots: [roles] }); const readdir = fs.readdirSync;
  fs.readdirSync = () => { throw Object.assign(new Error('PRIVATE_BODY at C:/private/path'), { code: 'EACCES' }); };
  try {
    assert.throws(() => lib.inventoryLegacy(), error => error.code === 'ASSET_OPERATION_FAILED' && !error.message.includes('PRIVATE_BODY') && !error.message.includes('private/path'));
  } finally { fs.readdirSync = readdir; }
});

test('combined bounded scene and query budgets still search examples from one selected revision', () => {
  const lib = library(); const role = lib.save({ name: 'combined', sourceText: '# source', examples: [{ kind: 'positive', content: 'comet orbit' }] }).role;
  const context = lib.buildContext({ roleId: role.id, query: 'q'.repeat(3900), scene: 'comet ' + 's'.repeat(3900), maxChars: 2400 });
  assert.ok(context.selectedExamples.some(row => row.revision === role.rev));
});

test('hardlinked state and legacy files cannot smuggle outside content through approved roots', () => {
  const stateDir = fresh(); const temp = fresh(); const outside = path.join(temp, 'outside.json');
  fs.writeFileSync(outside, '{"schemaVersion":1,"revision":0,"roles":[]}');
  fs.mkdirSync(path.join(stateDir, 'simulation')); fs.linkSync(outside, path.join(stateDir, 'simulation/personas.json'));
  code(() => createPersonaLibrary({ stateDir, legacyRoots: [] }).list(), 'PATH_UNSAFE');
  const roles = path.join(temp, 'roles'); fs.mkdirSync(roles); fs.linkSync(outside, path.join(roles, 'outside.md'));
  assert.deepEqual(library({ legacyRoots: [roles] }).inventoryLegacy().assets, []);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"schemaVersion":1,"revision":0,"roles":[]}');
});
