// Real Settings persistence/CAS and owned directories; no home discovery or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { createSettingsService } from '../src/settings/service.js';
import { normalizeSkillSources } from '../src/context/skill-sources.js';

const sandbox = createSuiteSandbox({ suiteId: 'skill-source-settings' });
let failed = true;
const owner = Object.freeze({ kind: 'owner', id: 'desktop' });
try {
  assert.deepEqual(normalizeSkillSources(undefined), []);
  const library = path.join(sandbox.root, 'library'); fs.mkdirSync(library);
  const file = path.join(library, 'keep.txt'); fs.writeFileSync(file, 'Owned reference remains.');
  const row = { sourceId: 'owned-library', root: library, revision: 1, enabled: true };
  assert.deepEqual(normalizeSkillSources([row]), [row]);
  for (const input of [[{ ...row, sourceId: 123 }], [{ ...row, root: '../relative' }], [{ ...row, root: library + '/..' }], [{ ...row, revision: -1 }],
    [{ ...row, enabled: 'true' }], [{ ...row, authorizedBy: 'owner' }], [row, row], Array.from({ length: 33 }, () => row)]) {
    assert.throws(() => normalizeSkillSources(input), { code: 'SKILL_SOURCE_CONFIG_INVALID' });
  }
  const settings = createSettingsService({ stateDir: path.join(sandbox.root, 'state') });
  const run = (method, params, actor = owner) => settings.execute({ method: 'settings.skillSources.' + method, params, actor });
  await settings.execute({ method: 'settings.update', params: { section: 'general', values: { language: 'en-US' } } });
  let current = settings.store.get();
  const before = structuredClone(current.settings);
  await assert.rejects(run('register', { sourceId: row.sourceId, root: library, enabled: true, expectedRev: current.revision }, { kind: 'agent', id: 'task:x' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(run('register', { sourceId: row.sourceId, root: library, enabled: true }), { code: 'SETTINGS_CONFLICT' });
  await assert.rejects(settings.execute({ method: 'settings.update', params: { section: 'extensions', values: { skillSources: [row] } } }), { code: 'SKILL_SOURCE_OWNER_COMMAND_REQUIRED' });
  current = await run('register', { sourceId: row.sourceId, root: library, enabled: true, expectedRev: current.revision });
  const registered = current.settings.extensions.skillSources[0];
  assert.equal(registered.revision, current.revision);
  assert.equal(registered.root, fs.realpathSync(library));
  assert.deepEqual({ ...current.settings, extensions: { ...current.settings.extensions, skillSources: [] } }, before);
  const reopened = createSettingsService({ stateDir: path.join(sandbox.root, 'state') });
  assert.deepEqual(reopened.store.get().settings.extensions.skillSources, [registered]);
  current = await settings.execute({ method: 'settings.update', params: { section: 'extensions', values: current.settings.extensions, expectedRev: current.revision } });
  assert.deepEqual(current.settings.extensions.skillSources, [registered], 'ordinary Settings roundtrip preserves unchanged explicit sources');
  await assert.rejects(run('setEnabled', { sourceId: row.sourceId, enabled: false, expectedRev: current.revision - 1 }), { code: 'SETTINGS_CONFLICT' });
  assert.deepEqual(settings.store.get().settings.extensions.skillSources, [registered]);
  current = await run('setEnabled', { sourceId: row.sourceId, enabled: false, expectedRev: current.revision });
  assert.equal(current.settings.extensions.skillSources[0].enabled, false);
  assert.ok(current.settings.extensions.skillSources[0].revision > registered.revision);
  current = await run('remove', { sourceId: row.sourceId, expectedRev: current.revision });
  assert.deepEqual(current.settings.extensions.skillSources, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Owned reference remains.');
  current = await run('register', { sourceId: row.sourceId, root: library, enabled: true, expectedRev: current.revision });
  assert.ok(current.settings.extensions.skillSources[0].revision > registered.revision, 'removed identities cannot revive an old reference');
  // A v1 file missing only the optional field loads without a repair/reset flow.
  const saved = JSON.parse(fs.readFileSync(settings.store.file, 'utf8')); delete saved.settings.extensions.skillSources;
  fs.writeFileSync(settings.store.file, JSON.stringify(saved));
  const old = createSettingsService({ stateDir: path.join(sandbox.root, 'state') }).store.get();
  assert.equal(old.recoveryRequired, false); assert.deepEqual(old.settings.extensions.skillSources, []);
  assert.equal(old.settings.general.language, 'en-US');
  console.log('PASS Skill source Settings: strict normalization, explicit Owner/CAS, real persistence, optional v1 read, unrelated settings and files retained');
  failed = false;
} finally { finalizeSuiteSandbox({ sandbox, failed }); }
