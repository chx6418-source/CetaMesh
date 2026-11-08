import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createExtensionService } from '../../src/extension/service.js';
import { createExtensionPrivateStorage } from '../../src/extension/private-storage.js';
import { createDesktopUiService } from '../../src/desktop/ui-service.js';
import { createProcessExtensionHost, createInProcessTransportPair } from '../../src/extension/process-host.js';
import { createExtensionSettingsService } from '../../src/extension/settings.js';
import { validateSettingsConfiguration } from '../../src/extension/settings-protocol.js';
import { createExtensionRuntime } from '../../src/extension/runtime.js';
import { createExtensionStore } from '../../src/extension/store.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Settings fixture timed out'); };

export async function testEffectiveExtensionSettings(root) {
  const source = path.join(root, 'effective-source'); fs.mkdirSync(source);
  const manifest = { manifestVersion: 1, id: 'test.effective', name: 'Settings fixture', version: '1.0.0',
    type: 'tool', entry: 'index.js', permissions: [], network: { hosts: [] }, scope: { paths: [] },
    capabilities: [{ id: 'read', kind: 'tool', title: 'Read', requires: [] }],
    settingsSchema: [{ key: 'label', label: 'Label', type: 'string', default: 'default' },
      { key: 'count', label: 'Count', type: 'number', default: 1 },
      { key: 'credential', label: 'Credential', type: 'secretRef' },
      { key: 'otherCredential', label: 'Other credential', type: 'secretRef' }] };
  fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'index.js'), 'module.exports.handlers={read:async(input,ctx)=>{if(input.wait)await new Promise(()=>{});return {label:ctx.settings?.label??"MISSING_SETTINGS",secret:ctx.settings?.credential??null,frozen:Object.isFrozen(ctx.settings)};}};');
  const stateDir = path.join(root, 'effective-state');
  const created = [];
  const factory = options => { const host = createProcessExtensionHost(options); created.push({ id: options.extensionId, host }); return host; };
  let service = createExtensionService({ stateDir, monitorIntervalMs: 0, processHostFactory: factory });
  const call = (method, params = {}) => service.execute({ method, params: { id: manifest.id, ...params } });
  try {
    await call('ext.install', { sourceDir: source });
    await call('ext.settings.update', { values: { label: 'first', credential: 'synthetic-secret-never-delivered' } });
    await call('ext.enable');
    let result = await call('ext.invoke', { capability: 'read', input: {} });
    assert.equal(result.result.label, 'first', 'real Worker must receive Owner configuration');
    assert.equal(result.result.secret, null, 'raw credentials never enter the Worker context');
    assert.equal(result.result.frozen, true);
    const before = await call('ext.get');
    const pid = created.at(-1).host.pid;
    let snapshot = await call('ext.settings.get');
    assert.equal(snapshot.application.status, 'applied');
    assert.equal(snapshot.application.secretConsumption, 'unsupported');
    const noop = await call('ext.settings.update', { values: { label: 'first' }, expectedRevision: snapshot.revision });
    assert.equal((await call('ext.get')).availability.runtime.generation, before.availability.runtime.generation);
    assert.equal(created.at(-1).host.pid, pid, 'no-op retains the actual child PID');
    assert.equal(noop.application.effectiveRevision, snapshot.application.effectiveRevision);
    const ui = createDesktopUiService({ services: { extensionService: service } });
    snapshot = await ui.execute({ method: 'ui.extensions.settings.update', params: {
      id: manifest.id, values: { label: 'second' }, expectedRevision: noop.revision } });
    assert.equal(snapshot.application.status, 'applied', 'Owner UI save waits for exact ACK');
    assert.notEqual(snapshot.application.generation, before.availability.runtime.generation);
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'second');
    await assert.rejects(call('ext.settings.update', { values: { label: 'stale' }, expectedRevision: noop.revision }), { code: 'EXTENSION_SETTINGS_CONFLICT' });
    assert.equal((await call('ext.settings.get')).values.label, 'second');
    const secretOnly = await call('ext.settings.update', { values: { credential: 'synthetic-secret-rotation' }, expectedRevision: snapshot.revision });
    assert.equal(secretOnly.application.generation, snapshot.application.generation, 'unsupported secret storage change does not restart the public host');
    assert.equal(secretOnly.application.desiredRevision, snapshot.application.desiredRevision);
    assert.notEqual(secretOnly.revision, snapshot.revision, 'edit CAS still observes secret storage changes');
    assert.ok(!JSON.stringify(snapshot).includes('synthetic-secret-never-delivered'));
    assert.ok(!JSON.stringify(await call('ext.logs')).includes('synthetic-secret-never-delivered'));
    assert.deepEqual((await call('ext.get')).extension.permissions, [], 'settings do not grant capabilities');
    await service.close();
    service = createExtensionService({ stateDir, monitorIntervalMs: 0 });
    await call('ext.enable');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'second');
    assert.equal((await call('ext.settings.get')).application.status, 'applied');
    await call('ext.disable');
    snapshot = await call('ext.settings.update', { values: { label: 'next-start' } });
    assert.equal(snapshot.application.status, 'pending');
    await call('ext.enable');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'next-start');
  } finally { await service.close(); }

  const vmService = createExtensionService({ stateDir: path.join(root, 'settings-vm'), monitorIntervalMs: 0,
    isTrustedVmExtension: () => true, processHostFactory: () => { throw new Error('Trusted VM should not start a process'); } });
  try {
    await vmService.execute({ method: 'ext.install', params: { sourceDir: source } });
    await vmService.execute({ method: 'ext.settings.update', params: { id: manifest.id, values: { label: 'trusted-vm' } } });
    await vmService.execute({ method: 'ext.enable', params: { id: manifest.id } });
    const result = await vmService.execute({ method: 'ext.invoke', params: { id: manifest.id, capability: 'read', input: {} } });
    assert.equal(result.result.label, 'trusted-vm');
    assert.equal(result.result.frozen, true);
  } finally { await vmService.close(); }
  const profiles = createExtensionStore({ stateDir: path.join(root, 'settings-profiles') });
  for (const [id, type, entryFile, expected] of [['test.data', 'external-api', 'data.json', 'unsupported'],
    ['test.pack', 'memory-pack', 'pack.json', 'not-applicable'], ['test.legacy', 'tool', 'index.js', 'not-applicable']]) {
    profiles.put({ id, version: '1.0.0', status: 'disabled', type,
      manifest: { ...manifest, id, type, entry: entryFile, ...(id === 'test.legacy' ? { settingsSchema: [] } : {}) } });
    const runtime = createExtensionRuntime({ store: profiles, monitorIntervalMs: 0, hostFactory: () => { throw new Error('Profile projection cannot execute'); } });
    assert.equal(runtime.settingsState({ id }).status, expected);
    await runtime.close();
  }

  // Exact package/schema binding preserves legacy bytes until explicit save.
  const legacyDir = path.join(root, 'legacy-settings');
  const entry = { id: manifest.id, version: manifest.version, manifest, packageFingerprint: '1'.repeat(64) };
  const desired = createExtensionSettingsService({ stateDir: legacyDir, getExtension: () => entry });
  const publicFile = path.join(legacyDir, 'extensions', 'settings', manifest.id + '.json');
  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  const legacyBytes = '{"schemaVersion":1,"values":{"label":"legacy-unbound","count":9}}';
  fs.writeFileSync(publicFile, legacyBytes);
  assert.equal(desired.get({ id: entry.id }).values.label, 'legacy-unbound');
  assert.throws(() => desired.runtimeSnapshot({ id: entry.id }), { code: 'EXTENSION_SETTINGS_REVIEW_REQUIRED' });
  assert.equal(fs.readFileSync(publicFile, 'utf8'), legacyBytes);
  desired.update({ id: entry.id, values: { count: 2, credential: 'old-one', otherCredential: 'old-two' } });
  assert.equal(desired.runtimeSnapshot({ id: entry.id }).values.label, 'default', 'partial save cannot adopt unbound legacy values');
  const compatibilityRecord = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
  assert.equal(compatibilityRecord.schemaVersion, 1);
  assert.equal(compatibilityRecord.values.count, 2, 'legacy v1 values envelope remains readable');
  const stableRevision = desired.get({ id: entry.id }).revision;
  const privateSettingsFile = path.join(legacyDir, 'extensions', 'private-settings', manifest.id + '.json');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === publicFile) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' }); return rename(from, to); };
    assert.throws(() => desired.update({ id: entry.id, values: { count: 3, credential: 'new-one' } }), { code: 'EXTENSION_SETTINGS_WRITE_FAILED' });
  } finally { fs.renameSync = rename; }
  assert.equal(desired.get({ id: entry.id }).revision, stableRevision);
  assert.deepEqual(JSON.parse(fs.readFileSync(privateSettingsFile, 'utf8')), { credential: 'old-one', otherCredential: 'old-two' });
  let privateWrites = 0;
  try {
    fs.renameSync = (from, to) => { if (to === privateSettingsFile && ++privateWrites === 2) throw Object.assign(new Error('synthetic second secret failure'), { code: 'EIO' }); return rename(from, to); };
    assert.throws(() => desired.update({ id: entry.id, values: { credential: 'new-one', otherCredential: 'new-two', count: 4 } }), { code: 'EXTENSION_SETTINGS_WRITE_FAILED' });
  } finally { fs.renameSync = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(privateSettingsFile, 'utf8')), { credential: 'old-one', otherCredential: 'old-two' });
  assert.equal(desired.get({ id: entry.id }).revision, stableRevision);
  entry.packageFingerprint = '2'.repeat(64);
  assert.throws(() => desired.update({ id: entry.id, values: { count: 5 }, expectedRevision: stableRevision }), { code: 'EXTENSION_SETTINGS_CONFLICT' });
  assert.throws(() => desired.runtimeSnapshot({ id: entry.id }), { code: 'EXTENSION_SETTINGS_REVIEW_REQUIRED' });
  entry.packageFingerprint = '1'.repeat(64);
  entry.manifest = { ...manifest, settingsSchema: [...manifest.settingsSchema, { key: 'added', label: 'Added', type: 'boolean' }] };
  assert.throws(() => desired.runtimeSnapshot({ id: entry.id }), { code: 'EXTENSION_SETTINGS_REVIEW_REQUIRED' });
  entry.manifest = manifest;
  const configuration = { ...desired.runtimeSnapshot({ id: entry.id }), generation: 1 };
  assert.equal(validateSettingsConfiguration(configuration, manifest, entry.packageFingerprint).values.count, 2);
  for (const bad of [{ ...configuration, version: '9.0.0' }, { ...configuration, generation: 0 },
    { ...configuration, schemaFingerprint: '0'.repeat(64) }, { ...configuration, revision: '0'.repeat(64) },
    { ...configuration, values: { ...configuration.values, credential: 'synthetic-secret' } },
    { ...configuration, values: { ...configuration.values, count: 'invalid' } }]) {
    assert.throws(() => validateSettingsConfiguration(bad, manifest, entry.packageFingerprint), { code: 'EXTENSION_SETTINGS_ACK_MISMATCH' });
  }
  // A responsive legacy host cannot turn ping into a configuration receipt.
  const pair = createInProcessTransportPair();
  pair.child.onMessage(raw => { const frame = JSON.parse(raw); if (frame.kind === 'ping') pair.child.send({ v: 1, id: frame.id, kind: 'pong' }); });
  const oldHost = createProcessExtensionHost({ manifest, transport: pair.host });
  assert.equal(await oldHost.ping(), true);
  await assert.rejects(oldHost.configure(configuration, { timeoutMs: 20 }), { code: 'EXTENSION_SETTINGS_ACK_TIMEOUT' });
  await assert.rejects(oldHost.invoke('read', {}), { code: 'EXTENSION_SETTINGS_PENDING' });
  await oldHost.shutdown();

  await testSettingsRaces(root, source, manifest);

  const privateFile = path.join(root, 'private-cache.json');
  const storage = createExtensionPrivateStorage({ file: privateFile });
  storage.set('synthetic', 'old');
  fs.renameSync(privateFile, privateFile + '.original'); fs.mkdirSync(privateFile);
  assert.throws(() => storage.set('synthetic', 'new'));
  assert.equal(storage.get('synthetic'), 'old', 'failed private write must not publish cache');
  assert.throws(() => storage.delete('synthetic'));
  assert.equal(storage.get('synthetic'), 'old', 'failed private delete must not publish cache');
  console.log('PASS effective settings actual Worker, Owner DTO, CAS, no-op, reload, disabled save, private failure');
}

async function testSettingsRaces(root, source, manifest) {
  const hosts = [], acks = [], stops = [];
  let holdNextAck = false, wrongNextAck = false, rejectNextStop = false, holdNextStop = false;
  const service = createExtensionService({ stateDir: path.join(root, 'settings-races'), monitorIntervalMs: 0,
    processHostFactory(options) {
      const host = createProcessExtensionHost(options), configure = host.configure.bind(host), shutdown = host.shutdown.bind(host);
      hosts.push(host);
      host.configure = async (...args) => {
        const receipt = await configure(...args);
        if (holdNextAck) { holdNextAck = false; const gate = deferred(); acks.push(gate); await gate.promise; }
        if (wrongNextAck) { wrongNextAck = false; return { ...receipt, generation: receipt.generation + 1 }; }
        return receipt;
      };
      host.shutdown = async () => {
        if (holdNextStop) { holdNextStop = false; const gate = deferred(); stops.push(gate); await gate.promise; }
        if (rejectNextStop) { rejectNextStop = false; throw Object.assign(new Error('Synthetic stop unconfirmed'), { code: 'EXTENSION_STOP_UNCONFIRMED' }); }
        return shutdown();
      };
      return host;
    } });
  const call = (method, params = {}) => service.execute({ method, params: { id: manifest.id, ...params } });
  try {
    await call('ext.install', { sourceDir: source });
    await call('ext.settings.update', { values: { label: 'initial' } });
    await call('ext.enable');
    const otherSource = path.join(root, 'settings-other-source'); fs.mkdirSync(otherSource);
    fs.writeFileSync(path.join(otherSource, 'extension.json'), JSON.stringify({ ...manifest, id: 'test.unaffected' }));
    fs.copyFileSync(path.join(source, 'index.js'), path.join(otherSource, 'index.js'));
    await call('ext.install', { sourceDir: otherSource });
    await call('ext.enable', { id: 'test.unaffected' });
    const otherPid = hosts.at(-1).pid;
    const otherGeneration = (await call('ext.get', { id: 'test.unaffected' })).availability.runtime.generation;
    holdNextAck = true;
    const older = call('ext.settings.update', { values: { label: 'older' } });
    await until(() => acks.length === 1);
    assert.deepEqual((await call('ext.get')).availability.discoveredCapabilities, [], 'no effective capability publication before config ACK');
    const newer = call('ext.settings.update', { values: { label: 'newest' } });
    acks[0].resolve();
    await Promise.all([older, newer]);
    assert.equal((await call('ext.settings.get')).application.status, 'applied');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'newest');
    assert.equal((await call('ext.get', { id: 'test.unaffected' })).availability.runtime.generation, otherGeneration);
    assert.equal(hosts.find(host => host.pid === otherPid)?.available(), true, 'unrelated child retains actual identity');

    holdNextAck = true;
    const interrupted = call('ext.settings.update', { values: { label: 'disabled-during-ack' } });
    await until(() => acks.length === 2);
    await call('ext.disable');
    acks[1].resolve(); await interrupted;
    assert.equal((await call('ext.get')).extension.status, 'disabled');
    assert.equal((await call('ext.settings.get')).application.status, 'pending');
    await assert.rejects(call('ext.invoke', { capability: 'read', input: {} }), { code: 'EXTENSION_DISABLED' });
    await call('ext.enable');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'disabled-during-ack');

    wrongNextAck = true;
    const mismatch = await call('ext.settings.update', { values: { label: 'retry-current' } });
    assert.equal(mismatch.application.status, 'needs-reconciliation');
    assert.equal(mismatch.application.errorCode, 'EXTENSION_SETTINGS_ACK_MISMATCH');
    assert.notEqual(mismatch.application.desiredRevision, mismatch.application.effectiveRevision);
    assert.deepEqual((await call('ext.get')).availability.discoveredCapabilities, []);
    const retried = await call('ext.settings.update', { values: {}, expectedRevision: mismatch.revision });
    assert.equal(retried.application.status, 'applied');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'retry-current');
    rejectNextStop = true;
    const countBefore = hosts.length;
    const stopFailure = await call('ext.settings.update', { values: { label: 'after-stop-confirmation' } });
    assert.equal(stopFailure.application.status, 'needs-reconciliation');
    assert.equal(hosts.length, countBefore, 'unconfirmed exit must not start replacement');
    assert.equal((await call('ext.get')).runtimeState, 'stopping');
    const recovered = await call('ext.settings.update', { values: {} });
    assert.equal(recovered.application.status, 'applied');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'after-stop-confirmation');
    const inflightHost = hosts.at(-1);
    const inflight = call('ext.invoke', { capability: 'read', input: { wait: true } }).catch(error => error);
    await until(() => inflightHost._inflight().length === 1);
    const activeGeneration = (await call('ext.get')).availability.runtime.generation;
    await call('ext.settings.update', { values: { label: 'after-stop-confirmation' } });
    assert.equal((await call('ext.get')).availability.runtime.generation, activeGeneration, 'no-op does not interrupt in-flight call');
    await call('ext.settings.update', { values: { label: 'after-inflight-stop' } });
    assert.equal((await inflight).effectStatus, 'unknown', 'restart cannot claim earlier effects were undone');
    assert.equal(inflightHost.health().exitConfirmed, true);
    assert.equal(hosts.at(-1)._inflight().length, 0, 'configuration retry never replays the prior invocation');
    await hosts.at(-1).shutdown();
    holdNextStop = true;
    const recovering = service.runtime.checkHealth({ id: manifest.id });
    await until(() => stops.length === 1);
    const disabling = call('ext.disable');
    await until(() => service.store.get(manifest.id).status === 'disabled');
    const launchesBeforeRecovery = hosts.length;
    stops[0].resolve(); await Promise.all([recovering, disabling]);
    assert.equal(hosts.length, launchesBeforeRecovery, 'automatic recovery cannot launch after a concurrent Owner disable');
    await call('ext.enable');
    const versionSource = path.join(root, 'settings-version-source'); fs.mkdirSync(versionSource);
    fs.writeFileSync(path.join(versionSource, 'extension.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
    fs.copyFileSync(path.join(source, 'index.js'), path.join(versionSource, 'index.js'));
    await call('ext.review', { sourceDir: versionSource });
    holdNextStop = true;
    const versionChange = call('ext.update', { sourceDir: versionSource }).catch(error => error);
    await until(() => stops.length === 2);
    const disableVersion = call('ext.disable');
    await until(() => service.store.get(manifest.id).status === 'disabled');
    const launchesBeforeVersion = hosts.length;
    stops[1].resolve(); await Promise.all([versionChange, disableVersion]);
    assert.equal(service.store.get(manifest.id).status, 'disabled', 'version rollback cannot undo a concurrent Owner disable');
    assert.equal(hosts.length, launchesBeforeVersion, 'version cleanup cannot resurrect the prior host');
    await call('ext.review', { sourceDir: versionSource });
    await call('ext.update', { sourceDir: versionSource });
    assert.equal((await call('ext.settings.get')).application.status, 'needs-review');
    await assert.rejects(call('ext.enable'), { code: 'EXTENSION_SETTINGS_REVIEW_REQUIRED' });
    await call('ext.settings.update', { values: { label: 'reviewed-version-two' } });
    await call('ext.enable');
    assert.equal((await call('ext.invoke', { capability: 'read', input: {} })).result.label, 'reviewed-version-two');
    await call('ext.disable');
    await call('ext.rollback.review');
    await call('ext.rollback');
    assert.equal((await call('ext.settings.get')).application.status, 'needs-review', 'rollback cannot consume another package binding');
    await call('ext.settings.update', { values: { label: 'reviewed-rollback' } });
    await call('ext.enable');
    holdNextAck = true;
    const removedSave = call('ext.settings.update', { values: { label: 'removed-during-ack' } }).catch(error => error);
    await until(() => acks.length === 3);
    await call('ext.uninstall', { keepFiles: true });
    const launchesAtRemoval = hosts.length;
    acks[2].resolve();
    assert.ok(['NOT_INSTALLED', 'EXTENSION_NOT_FOUND'].includes((await removedSave).code));
    assert.equal(service.store.get(manifest.id), null);
    assert.equal(hosts.length, launchesAtRemoval, 'late ACK cannot recreate an uninstalled host');
  } finally {
    for (const ack of acks) ack.resolve();
    for (const stop of stops) stop.resolve();
    await service.close();
    assert.ok(hosts.every(host => host.health().exitConfirmed), 'all owned real children have confirmed exit');
  }
  console.log('PASS settings exact ACK, concurrent saves, disable/late ACK, wrong ACK/retry, affected-only and stop proof');
}
