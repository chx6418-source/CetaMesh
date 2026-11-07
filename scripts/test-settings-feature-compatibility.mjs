import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSettingsStore } from '../src/settings/store.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-settings-feature-compat-')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const connection = { id: 'owned-fixture', label: 'Owned fixture', protocolProfile: 'openai-compatible-v1', enabled: true,
  models: [{ id: 'fixture', enabled: false }] };
function legacyShape(raw) {
  assert.equal(raw.schemaVersion, 1);
  assert.ok(Number.isSafeInteger(raw.revision) && raw.revision > 0);
  assert.equal(Object.hasOwn(raw.settings.models, 'connections'), false);
  assert.equal(Object.hasOwn(raw.settings.models, 'modelPreferences'), false);
  assert.equal(Object.hasOwn(raw.settings.extensions, 'skillSources'), false);
}
try {
  const state = path.join(root, 'state'), store = createSettingsStore({ stateDir: state });
  store.update('general', { theme: 'dark' });
  const initial = fs.readFileSync(store.file);
  const old = JSON.parse(initial);
  legacyShape(old);
  assert.equal(store.get().settings.models.connections, null, 'new reader supplies optional defaults without persisting inactive features');
  assert.deepEqual(store.get().settings.extensions.skillSources, []);
  assert.equal(store.compatibility().requiresUpgradeReader, false);
  store.update('models', { connections: [connection] });
  const advanced = fs.readFileSync(store.file);
  const compatibility = store.compatibility();
  assert.equal(compatibility.requiresUpgradeReader, true);
  assert.ok(compatibility.features.includes('model-connections'));
  assert.equal(compatibility.baseline.available, true);
  const backup = fs.readFileSync(compatibility.baseline.path);
  assert.equal(digest(backup), compatibility.baseline.sha256);
  const rollback = JSON.parse(backup);
  legacyShape(rollback);
  assert.deepEqual(rollback.settings, old.settings, 'the pre-feature configuration keeps every prior value');
  assert.equal(rollback.settings.general.theme, 'dark');
  const backupHash = digest(backup);
  const library = [{ sourceId: 'owned-library', root: path.join(root, 'library'), enabled: false, revision: 3 }];
  store.update('extensions', { skillSources: library });
  store.update('general', { theme: 'light' });
  assert.equal(digest(fs.readFileSync(compatibility.baseline.path)), backupHash, 'later changes never replace the first rollback point');
  assert.ok(store.compatibility().features.includes('skill-sources'));
  assert.equal(store.get().settings.models.connections[0].id, connection.id);
  assert.deepEqual(store.get().settings.extensions.skillSources, library);
  const loaded = createSettingsStore({ stateDir: state });
  assert.equal(loaded.get().recoveryRequired, false);
  assert.equal(loaded.get().settings.general.theme, 'light');
  assert.equal(loaded.compatibility().baseline.sha256, backupHash);
  assert.equal(loaded.get().settings.models.connections[0].id, connection.id);
  assert.notEqual(digest(fs.readFileSync(store.file)), digest(advanced), 'advanced active configuration remains independent of the older snapshot');
  const rollbackState = path.join(root, 'rollback-copy');
  fs.mkdirSync(path.join(rollbackState, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(rollbackState, 'settings', 'settings.json'), backup);
  const restored = createSettingsStore({ stateDir: rollbackState });
  assert.equal(restored.get().recoveryRequired, false);
  assert.equal(restored.get().settings.general.theme, 'dark');
  assert.equal(restored.get().settings.models.connections, null);
  assert.deepEqual(restored.get().settings.extensions.skillSources, []);
  assert.equal(digest(fs.readFileSync(store.file)), digest(fs.readFileSync(loaded.file)), 'the isolated rollback copy never overwrites the active file');
  console.log('PASS inactive feature serialization, immutable prior configuration, advanced restart and isolated rollback copy');

  const blockedState = path.join(root, 'blocked'), blocked = createSettingsStore({ stateDir: blockedState });
  blocked.update('general', { theme: 'dark' });
  const before = fs.readFileSync(blocked.file), revision = blocked.get().revision;
  fs.mkdirSync(path.join(blocked.dir, 'settings.pre-features-v1.json'));
  assert.throws(() => blocked.update('models', { connections: [connection] }), { code: 'SETTINGS_COMPATIBILITY_UNAVAILABLE' });
  assert.equal(digest(fs.readFileSync(blocked.file)), digest(before));
  assert.equal(blocked.get().revision, revision);
  assert.equal(blocked.get().settings.models.connections, null);
  console.log('PASS an unavailable rollback point refuses the first feature write without altering active settings');

  const existingState = path.join(root, 'existing-advanced');
  fs.mkdirSync(path.join(existingState, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(existingState, 'settings', 'settings.json'), advanced);
  const existing = createSettingsStore({ stateDir: existingState });
  assert.equal(existing.get().recoveryRequired, false);
  assert.equal(existing.compatibility().requiresUpgradeReader, true);
  assert.equal(existing.compatibility().baseline.available, false, 'an already advanced file cannot invent its missing historical configuration');
  existing.update('general', { theme: 'dark' });
  assert.equal(existing.get().settings.models.connections[0].id, connection.id);
  assert.equal(existing.compatibility().baseline.available, false);
  console.log('PASS existing advanced data stays usable without a fabricated historical rollback point');

  const fresh = createSettingsStore({ stateDir: path.join(root, 'fresh') });
  fresh.update('models', { connections: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh.file)).settings.models.connections, [], 'an explicitly all-disabled connection set is not a legacy default');
  assert.equal(fresh.compatibility().baseline.available, true);
  assert.equal(JSON.parse(fs.readFileSync(fresh.compatibility().baseline.path)).settings.general.theme, 'system', 'a new state directory preserves its pre-feature default configuration');
  const firstHash = fresh.compatibility().baseline.sha256;
  fresh.reset('models');
  assert.equal(fresh.compatibility().requiresUpgradeReader, false);
  legacyShape(JSON.parse(fs.readFileSync(fresh.file)));
  assert.equal(fresh.compatibility().baseline.sha256, firstHash, 'disabling the feature preserves its original configuration snapshot');
  console.log('PASS first-write defaults, explicit all-disabled models and feature removal retain their distinct meanings');

  const malformed = createSettingsStore({ stateDir: path.join(root, 'malformed') });
  malformed.update('general', { theme: 'dark' });
  fs.writeFileSync(path.join(malformed.dir, 'settings.pre-features-v1.json'), '{truncated');
  const unchanged = fs.readFileSync(malformed.file);
  assert.throws(() => malformed.update('models', { connections: [connection] }), { code: 'SETTINGS_COMPATIBILITY_UNAVAILABLE' });
  assert.equal(fs.readFileSync(path.join(malformed.dir, 'settings.pre-features-v1.json'), 'utf8'), '{truncated', 'a preexisting snapshot is never replaced');
  assert.deepEqual(fs.readFileSync(malformed.file), unchanged);
  console.log('PASS incomplete pre-feature snapshot blocks only activation and preserves all original bytes');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
