import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {isSea} from 'node:sea';
import {createMinimalAgentEnv, findCliExecutable} from './cli-agent-process.js';
import {readJsonFile} from '../storage/json-file.js';

export const DSH_SDK_VERSION = '0.2.2-rc.1';
// Published npm artifacts reviewed against dsh-v0.2.2-rc.1. A package version
// alone cannot establish the mandatory pre-execution interception contract.
const PINNED = Object.freeze([
  ['dsh', 'lib/bin.js', 'b6640801a5a65aae9f53ca21bcce3b2ea28bd9e9554c939c1ff7c4448d91fa18'],
  ['dsh-sdk-minimal', 'cordis.patch.yml', 'e4d4af718a8876ab280df474b5902aaf2fb47a899301962a6ff919f7f2beabd5'],
  ['dsh-sdk-jsonrpc-server', 'lib/index.js', '17475b5675836c9c9c59f71f6f265f0d9fbddf6ae001e9e1a213e4cfa3784d9b'],
  ['dsh-user-approval', 'lib/index.js', '45b7c170b6897f15a338037b1951997a1b99018c30b5fc95f7e08ad798075be2'],
  ['dsh-tools', 'lib/index.js', '1889cbf718d64518dd83245d4dba1e1f080b2c5326259c3ed5b1be7a7666a2bd'],
  ['dsh-tools', 'lib/pipeline.js', 'f6c850cefce30831c4c5f160e831856b105935331bacd1ae0823129001614bc6'],
  ['dsh-tools', 'lib/shared-DTdn5dXO.js', 'd02f0d8f36878313b0dae3a1bba5b77f7db4cffc77a0b72772048a36bacf2cf0'],
  ['dsh-tool-executor-native', 'lib/index.js', 'db667cb6545bb642bc2609d49f797b1d7e852e4197d5d38bf541abc7ec078599'],
  ['dsh-tool-fs', 'lib/index.js', '0e866969b6bf1aa93407ccd9c944b50bc27a1d961b7e4209ed60bd2b73d28805']
]);
const MANIFESTS = Object.freeze({
  dsh: '3e14837ceb3bbc0ba419ed08e9b5ba164338369b1268b93c3c25d89f7b1c9953',
  'dsh-sdk-minimal': '38632d238cca9e4383fc2a7a703261e2453a6175256cd10c094bd599af5acb5b',
  'dsh-sdk-jsonrpc-server': 'dd564787138a46f7d11270f17f2d626f7c5684d562c5fb73c3213a3b840b58c3',
  'dsh-user-approval': '75a7feea47883d56068028ce21446f5c7e311f74719d3c1a686ce681af757385',
  'dsh-tools': 'fe2268802ba2d9259e413464e9ab0411440a81904785a2fee78f68a39ad30655',
  'dsh-tool-executor-native': '1efe6e6d45e027d96e5b70c45fef8768605f47556514a7e3b74d528142125b46',
  'dsh-tool-fs': '47fee03cc69f85136bdc61451bcc8b57099821ebf375411757f9a796ba4e86c8'
});
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => {throw Object.assign(new Error(message), {code});};

function checkedBytes(file, limit = 2 * 1024 * 1024) {
  const canonical = fs.realpathSync(file), fd = fs.openSync(canonical, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) fail('dsh_sdk_runtime_unverified', 'DSH runtime file is not a bounded regular file');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('dsh_sdk_runtime_changed', 'DSH runtime changed during verification');
    }
    return {path: canonical, sha256: digest(bytes)};
  } finally {fs.closeSync(fd);}
}

function runtimePackage(runtimePath) {
  const supplied = fs.realpathSync(runtimePath);
  const manifestFile = path.basename(supplied) === 'package.json' ? supplied
    : path.join(path.dirname(path.dirname(supplied)), 'package.json');
  let manifest = readJsonFile(manifestFile, {maxBytes: 65536});
  // An explicit SDK-client package also identifies its exact paired runtime.
  const require = createRequire(manifestFile);
  const file = manifest.name === '@deepseek-ai/dsh-sdk-client' ? require.resolve('@deepseek-ai/dsh/package.json') : manifestFile;
  if (file !== manifestFile) manifest = readJsonFile(file, {maxBytes: 65536});
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== DSH_SDK_VERSION) fail('dsh_sdk_version_unsupported', 'DSH task approval requires the verified 0.2.2-rc.1 runtime');
  if (manifest.bin?.dsh !== 'lib/bin.js') fail('dsh_sdk_runtime_unverified', 'DSH CLI entry is not the verified module');
  return {file, root: path.dirname(file), require: createRequire(file)};
}

const nodeVersions = new Map();
async function nodeRuntime(nodePath, environment) {
  const candidate = nodePath || (!isSea() && /^node(?:\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : findCliExecutable(process.platform === 'win32' ? 'node.exe' : 'node', {env: environment}));
  if (!candidate || !path.isAbsolute(candidate) || !/^node(?:\.exe)?$/i.test(path.basename(candidate))) fail('dsh_sdk_node_required', 'DSH requires an installed standalone Node runtime, not the packaged Core');
  const identity = checkedBytes(candidate, 512 * 1024 * 1024);
  let version = nodeVersions.get(identity.sha256);
  if (!version) {
    version = await new Promise((resolve, reject) => execFile(identity.path, ['--version'], {windowsHide: true, timeout: 5000,
      maxBuffer: 1024, env: createMinimalAgentEnv(environment)}, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match || Number(match[1]) < 24 || Number(match[1]) === 24 && Number(match[2]) < 9) fail('dsh_sdk_node_unsupported', 'DSH 0.2.2 requires Node 24.9 or newer');
    nodeVersions.clear(); nodeVersions.set(identity.sha256, version);
  }
  return {...identity, version};
}

/** No CLI startup, model calls, user-profile reads, or dependency installation. */
export async function inspectDshSdkRuntime({runtimePath, nodePath, environment = process.env} = {}) {
  if (typeof runtimePath !== 'string' || !runtimePath) return {installed: false, compatible: false, reason: 'dsh_sdk_runtime_required'};
  try {
    if (!path.isAbsolute(runtimePath)) fail('dsh_sdk_runtime_unverified', 'Select an absolute DSH package or CLI path');
    const selected = runtimePackage(runtimePath);
    const manifestFiles = new Map();
    const files = PINNED.map(([name, relative, expected]) => {
      const manifestFile = name === 'dsh' ? selected.file : selected.require.resolve('@deepseek-ai/' + name + '/package.json');
      const manifest = readJsonFile(manifestFile, {maxBytes: 65536});
      if (manifest.name !== '@deepseek-ai/' + name || manifest.version !== DSH_SDK_VERSION) fail('dsh_sdk_version_unsupported', 'DSH task protocol packages must match the verified version');
      const manifestBytes = checkedBytes(manifestFile, 65536);
      if (manifestBytes.sha256 !== MANIFESTS[name]) fail('dsh_sdk_runtime_unverified', 'DSH module routing differs from the reviewed manifest');
      manifestFiles.set(manifestBytes.path, manifestBytes);
      const root = fs.realpathSync(path.dirname(manifestFile));
      const bytes = checkedBytes(path.join(root, relative));
      if (path.relative(root, bytes.path).startsWith('..') || path.isAbsolute(path.relative(root, bytes.path)) || bytes.sha256 !== expected) fail('dsh_sdk_runtime_unverified', 'DSH approval implementation differs from the verified artifact');
      return bytes;
    });
    const node = await nodeRuntime(nodePath, environment);
    const artifacts = [...files, ...manifestFiles.values(), node];
    const validate = () => {
      for (const file of artifacts) {
        try {if (checkedBytes(file.path, 512 * 1024 * 1024).sha256 === file.sha256) continue;} catch { /* Missing and replaced files revoke the same identity. */ }
        fail('DSH_SDK_RUNTIME_CHANGED', 'DSH task runtime changed; review it before another invocation');
      }
    };
    return {installed: true, compatible: true, reason: null, version: DSH_SDK_VERSION, dshBin: files[0].path,
      nodePath: node.path, nodeVersion: node.version, identity: digest(JSON.stringify(artifacts)), validate};
  } catch (error) {
    return {installed: fs.existsSync(runtimePath), compatible: false,
      reason: /^dsh_sdk_/.test(error?.code ?? '') ? error.code : 'dsh_sdk_runtime_unverified'};
  }
}

/** Reuses the existing explicit Agent configuration and protected secrets. */
export function createDshSdkRuntimeResolver({runtimeConfiguration, environment = process.env, allowLoopbackHttpForTests = false} = {}) {
  const configuration = () => runtimeConfiguration.get('dsh');
  const inspect = () => inspectDshSdkRuntime({...configuration(), environment});
  const resolve = async () => {
    const config = configuration(), expected = runtimeConfiguration.identity('dsh');
    if (!config.enabled) fail('runtime_disabled', 'DSH task execution is disabled');
    const runtime = await inspect();
    if (!runtime.compatible) fail(runtime.reason, 'Select the verified DSH SDK runtime in task connection settings');
    if (!config.model) fail('agent_model_required', 'Select the DSH task model');
    const credential = runtimeConfiguration.resolveCredential('dsh');
    if (!credential?.apiKey || credential.baseUrl !== config.baseUrl) fail('agent_credential_required', 'Configure the DSH task credential for its exact endpoint');
    const validate = () => {
      runtime.validate();
      if (runtimeConfiguration.identity('dsh') !== expected) fail('AGENT_RUNTIME_CHANGED', 'DSH task configuration changed during execution');
    };
    validate();
    return {...runtime, configuration: config, model: config.model, modelProvider: 'deepseek-official', baseUrl: credential.baseUrl, apiKey: credential.apiKey, allowLoopbackHttpForTests, validate};
  };
  return Object.assign(resolve, {configuration, inspect, configure: input => runtimeConfiguration.configure('dsh', input)});
}
