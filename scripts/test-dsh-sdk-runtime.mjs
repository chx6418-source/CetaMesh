import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentRuntimeConfiguration} from '../src/agent/runtime-configuration.js';
import {createMinimalAgentEnv} from '../src/agent/cli-agent-process.js';
import {inspectDshSdkRuntime, createDshSdkRuntimeResolver} from '../src/agent/dsh-sdk-runtime.js';
import {createCodexSessionLifecycle} from '../src/agent/codex-session-lifecycle.js';
import {createConnectionLeases} from '../src/agent/runtime-auth-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dsh-runtime-'));
const secrets = new Map();
const providerSecrets = {
  list: () => [...secrets].map(([provider, row]) => ({provider, configured: true, baseUrl: row.baseUrl})),
  set: value => secrets.set(value.provider, {...value}),
  raw: provider => secrets.get(provider)
};
try {
  const connectionLeases = createConnectionLeases();
  const configuration = createAgentRuntimeConfiguration({stateDir: root, providerSecrets, connectionLeases, allowLoopbackHttpForTests: true});
  const initial = configuration.get('dsh');
  assert.equal(initial.credentialConfigured, false);
  assert.equal(initial.model, '');
  assert.equal(initial.baseUrl, 'https://api.deepseek.com/anthropic', 'DSH 0.2.2 uses the Messages endpoint, not the OpenAI endpoint');
  const before = fs.existsSync(path.join(root, 'agent-runtimes.json'));
  assert.equal(before, false, 'reading DSH settings must not migrate or write existing storage');
  configuration.configure('qwen', {model: 'unchanged-qwen'});
  const legacyRuntimeBytes = fs.readFileSync(path.join(root, 'agent-runtimes.json'));
  const saved = configuration.configure('dsh', {runtimePath: path.join(root, 'dsh', 'package.json'), nodePath: process.execPath,
    model: 'synthetic-dsh', baseUrl: 'http://127.0.0.1:3333', apiKey: 'synthetic-test-key'});
  assert.equal(saved.applied, true);
  assert.equal(saved.configuration.credentialConfigured, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'agent-runtimes.json')), legacyRuntimeBytes, 'DSH configuration must not add provider keys to an older reader\'s runtime document');
  const lease = connectionLeases.reserve({provider: 'dsh', kind: 'task', expectedEpoch: connectionLeases.epoch('dsh')});
  assert.throws(() => configuration.configure('dsh', {model: 'cannot-change-active-session'}), {code: 'AGENT_RUNTIME_BUSY'});
  lease.release({exitConfirmed: true});
  assert.equal(configuration.resolveCredential('dsh').apiKey, 'synthetic-test-key');
  const bytes = fs.readFileSync(path.join(root, 'agent', 'dsh-runtime.json'), 'utf8');
  assert.equal(bytes.includes('synthetic-test-key'), false, 'settings must only hold credential metadata');
  assert.throws(() => configuration.configure('dsh', {authMode: 'provider-login'}), {code: 'AGENT_RUNTIME_CONFIG_INVALID'});
  assert.throws(() => configuration.configure('dsh', {authMode: 'native-cli'}), {code: 'AGENT_RUNTIME_CONFIG_INVALID'});
  assert.throws(() => configuration.configure('dsh', {baseUrl: 'https://other.invalid'}), {code: 'AGENT_RUNTIME_CREDENTIAL_SCOPE_MISMATCH'});
  assert.equal(createAgentRuntimeConfiguration({stateDir: root, providerSecrets, allowLoopbackHttpForTests: true}).get('dsh').revision, 1);
  const inherited = {DSH_HOME: root, CETAMESH_DSH_TASK_API_KEY: 'ambient-secret'};
  assert.equal(createMinimalAgentEnv(inherited).DSH_HOME, undefined);
  assert.equal(createMinimalAgentEnv(inherited).CETAMESH_DSH_TASK_API_KEY, undefined);
  const overrides = {DSH_HOME: root, CETAMESH_DSH_TASK_API_KEY: 'explicit-test-secret'};
  assert.equal(createMinimalAgentEnv({}, overrides).DSH_HOME, undefined);
  assert.equal(createMinimalAgentEnv({}, overrides, {authorizedEnvKeys: Object.keys(overrides)}).DSH_HOME, root);
  assert.equal(createMinimalAgentEnv({}, overrides, {authorizedEnvKeys: Object.keys(overrides)}).CETAMESH_DSH_TASK_API_KEY, 'explicit-test-secret');
  assert.equal(createMinimalAgentEnv({}, {DSH_HOME: '../unsafe'}, {authorizedEnvKeys: ['DSH_HOME']}).DSH_HOME, undefined);
  const unconfigured = await inspectDshSdkRuntime({runtimePath: ''});
  assert.equal(unconfigured.compatible, false);
  assert.equal(unconfigured.reason, 'dsh_sdk_runtime_required');
  const fake = path.join(root, 'fake-dsh');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({name: '@deepseek-ai/dsh', version: '0.1.5-rc.1'}));
  const old = await inspectDshSdkRuntime({runtimePath: path.join(fake, 'package.json'), nodePath: process.execPath});
  assert.equal(old.compatible, false);
  assert.equal(old.reason, 'dsh_sdk_version_unsupported');
  fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', bin: {dsh: '../unowned.js'}}));
  const escaped = await inspectDshSdkRuntime({runtimePath: path.join(fake, 'package.json'), nodePath: process.execPath});
  assert.equal(escaped.compatible, false, 'manifest version is insufficient to trust a CLI');
  const wrongProtocol = createDshSdkRuntimeResolver({runtimeConfiguration: {
    get: () => ({...initial, enabled: true, baseUrl: 'https://api.deepseek.com', model: 'fixture'}),
    identity: () => 'fixture', resolveCredential: () => {throw new Error('the wrong protocol must not load credentials');}
  }});
  await assert.rejects(wrongProtocol(), {code: 'dsh_sdk_endpoint_protocol_mismatch'});
  const lifecycle = createCodexSessionLifecycle({stateDir: root, provider: 'dsh'});
  lifecycle.create({sessionId: 'sdk-session', taskId: 'dsh-task', workspaceId: 'dsh-workspace', transport: 'dsh-sdk', snapshotId: 'private-stage'});
  const running = lifecycle.begin({sessionId: 'sdk-session', runId: 'core-run', turnId: 'native-turn'});
  const binding = {sessionId: 'sdk-session', generation: running.generation, runId: running.runId};
  lifecycle.unknown(binding);
  assert.equal(createCodexSessionLifecycle({stateDir: root, provider: 'dsh'}).read('sdk-session').receipt, null);
  lifecycle.settle({...binding, proof: 'supervisor-close', staging: 'retained'});
  lifecycle.close({sessionId: 'sdk-session', staging: 'retained'});
  const restored = createCodexSessionLifecycle({stateDir: root, provider: 'dsh'}).read('sdk-session');
  assert.equal(restored.receipt.evidence, 'supervisor-close');
  assert.equal(restored.staging, 'retained');
  assert.equal(createCodexSessionLifecycle({stateDir: root}).read('sdk-session'), null, 'DSH stop proof cannot alter Codex session ownership');
  assert.equal(fs.existsSync(path.join(root, 'agent', 'dsh-session-lifecycle.json')), true);
  const savedLifecycle = fs.readFileSync(path.join(root, 'agent', 'dsh-session-lifecycle.json'));
  fs.writeFileSync(path.join(root, 'agent', 'dsh-session-lifecycle.json'), '{invalid');
  assert.throws(() => createCodexSessionLifecycle({stateDir: root, provider: 'dsh'}).read('sdk-session'), {code: 'DSH_LIFECYCLE_STORE_INVALID'});
  assert.equal(fs.readFileSync(path.join(root, 'agent', 'dsh-session-lifecycle.json'), 'utf8'), '{invalid');
  fs.writeFileSync(path.join(root, 'agent', 'dsh-session-lifecycle.json'), savedLifecycle);
  if (process.env.CETAMESH_TEST_DSH_RUNTIME) {
    const installedRoot = path.dirname(process.env.CETAMESH_TEST_DSH_RUNTIME);
    const sourceModules = path.dirname(installedRoot);
    const copyModules = path.join(root, 'runtime-copy', 'node_modules', '@deepseek-ai');
    fs.mkdirSync(copyModules, {recursive: true});
    for (const name of ['dsh', 'dsh-sdk-minimal', 'dsh-sdk-jsonrpc-server', 'dsh-user-approval', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-tool-fs', 'dsh-fs-local']) {
      fs.cpSync(path.join(sourceModules, name), path.join(copyModules, name), {recursive: true});
    }
    const runtimePath = path.join(copyModules, 'dsh', 'package.json');
    const verified = await inspectDshSdkRuntime({runtimePath, nodePath: process.execPath});
    assert.equal(verified.compatible, true, verified.reason);
    const readBackend = path.join(copyModules, 'dsh-fs-local', 'lib', 'index.js');
    const originalReadBackend = fs.readFileSync(readBackend);
    fs.appendFileSync(readBackend, '\n// controlled mutation of the classified read backend\n');
    assert.throws(() => verified.validate(), {code: 'DSH_SDK_RUNTIME_CHANGED'}, 'pure read classification requires its exact native backend');
    assert.equal((await inspectDshSdkRuntime({runtimePath, nodePath: process.execPath})).compatible, false);
    fs.writeFileSync(readBackend, originalReadBackend);
    const pipeline = path.join(copyModules, 'dsh-tools', 'lib', 'pipeline.js');
    const original = fs.readFileSync(pipeline);
    fs.appendFileSync(pipeline, '\n// controlled mutation of the mandatory pipeline\n');
    assert.throws(() => verified.validate(), {code: 'DSH_SDK_RUNTIME_CHANGED'}, 'the actual pre-execution pipeline must participate in runtime identity');
    assert.equal((await inspectDshSdkRuntime({runtimePath, nodePath: process.execPath})).compatible, false);
    fs.writeFileSync(pipeline, original);
    const manifestPath = path.join(copyModules, 'dsh-tools', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.exports['./pipeline'] = './lib/index.js';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verified.validate(), {code: 'DSH_SDK_RUNTIME_CHANGED'}, 'package routing must not bypass the reviewed pipeline');
    assert.equal((await inspectDshSdkRuntime({runtimePath, nodePath: process.execPath})).compatible, false);
    console.log('PASS installed official runtime and temporary pipeline/manifest mutations');
  } else console.log('NOT_RUN_ENVIRONMENT installed-runtime mutation cases require CETAMESH_TEST_DSH_RUNTIME');
  console.log('PASS DSH settings reuse protected Agent credential storage and reject implicit account or endpoint migration');
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
