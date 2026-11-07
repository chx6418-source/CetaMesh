import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DSH_GATE_POLICY_VERSION, DSH_TOOL_GATE_SOURCE } from './dsh-sdk-tool-gate.js';

export { DSH_GATE_POLICY_VERSION, DSH_TOOL_GATE_SOURCE } from './dsh-sdk-tool-gate.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const DEFAULT_API_KEY_ENV = 'CETAMESH_DSH_TASK_API_KEY';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'DSH_SDK_PROFILE_INVALID' });
}

/** Build only the owned launch overlay. Never reuse an existing DSH home. */
export async function createDshSdkProfile({ directory, sessionId, nonce, modelProvider, model, baseUrl,
  apiKeyEnvName = DEFAULT_API_KEY_ENV, allowLoopbackHttpForTests = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || typeof sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(sessionId)
    || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
    || modelProvider !== 'deepseek-official' || typeof model !== 'string'
    || !/^[^\u0000-\u0020\u007f]{1,256}$/.test(model)
    || typeof baseUrl !== 'string' || /[\u0000-\u0020\u007f]/.test(baseUrl)
    || typeof apiKeyEnvName !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnvName)
    || typeof allowLoopbackHttpForTests !== 'boolean') {
    throw invalid('DSH SDK requires a fresh absolute directory and explicit supported model route');
  }
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw invalid('DSH SDK model endpoint is invalid'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) throw invalid('DSH SDK model endpoint contains unsupported fields');
  if (endpoint.protocol === 'http:' && (!allowLoopbackHttpForTests
    || !['127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw invalid('DSH SDK requires HTTPS; plaintext HTTP is limited to an explicit loopback test');
  }

  const parent = await fs.realpath(path.dirname(directory));
  const root = path.join(parent, path.basename(directory));
  try { await fs.mkdir(root, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw invalid('DSH SDK profile requires a fresh directory; an existing home is never modified');
    throw error;
  }
  const canonicalRoot = await fs.realpath(root);
  const homeDir = path.join(canonicalRoot, 'home');
  const gatePath = path.join(canonicalRoot, 'cetamesh-task-gate.mjs');
  const patchPath = path.join(canonicalRoot, 'cetamesh-task.patch.yml');
  const policyFingerprint = sha256(JSON.stringify({ policyVersion: DSH_GATE_POLICY_VERSION,
    sourceSha256: sha256(DSH_TOOL_GATE_SOURCE), directory: canonicalRoot, sessionId, nonce,
    modelProvider, model, baseUrl: endpoint.href, apiKeyEnvName, allowLoopbackHttpForTests,
    tools: ['read', 'write', 'edit'] }));
  // JSON is a YAML entry-list subset. Keeping this overlay declarative avoids
  // evaluating arbitrary expressions or writing any credential into the file.
  const patches = [
    { id: 'persistent-bash', disabled: true },
    { id: 'persistent-pwsh', disabled: true },
    { id: 'terminal-bash', disabled: true },
    { id: 'terminal-pwsh', disabled: true },
    { id: 'mcp-resources', disabled: true },
    { id: 'tool-working-directory', disabled: true },
    { id: 'tool-fs', config: { read: true, readImage: false, write: true, edit: true, applyPatch: false } },
    { id: 'llm-deepseek', config: { apiKeyEnv: apiKeyEnvName, baseURL: endpoint.href,
      models: [{ id: model, inputModalities: ['text'] }] } },
    { insert: [
      { id: 'cetamesh-user-approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } },
      { id: 'cetamesh-task-gate', name: './cetamesh-task-gate.mjs', config: { sessionId, nonce, policyFingerprint } },
    ] },
    { id: 'sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader', 'cetameshDshTaskGateReady'] },
  ];
  const patchBytes = JSON.stringify(patches, null, 2) + '\n';
  await fs.mkdir(homeDir, { mode: 0o700 });
  await fs.writeFile(gatePath, DSH_TOOL_GATE_SOURCE, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(patchPath, patchBytes, { flag: 'wx', mode: 0o600 });
  const directories = await Promise.all([canonicalRoot, homeDir].map(async directoryPath => {
    const stat = await fs.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino) throw invalid('DSH SDK directory identity is unavailable');
    return { path: directoryPath, dev: stat.dev, ino: stat.ino };
  }));
  const files = await Promise.all([[gatePath, DSH_TOOL_GATE_SOURCE], [patchPath, patchBytes]].map(async ([file, bytes]) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.ino) throw invalid('DSH SDK artifact identity is unavailable');
    return Object.freeze({ path: file, sha256: sha256(bytes), bytes: stat.size, dev: stat.dev, ino: stat.ino });
  }));

  async function verify() {
    try {
      if (await fs.realpath(canonicalRoot) !== canonicalRoot || await fs.realpath(homeDir) !== homeDir) throw new Error('profile root changed');
      for (const directoryIdentity of directories) {
        const stat = await fs.lstat(directoryIdentity.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directoryIdentity.dev
          || stat.ino !== directoryIdentity.ino) throw new Error('profile directory changed');
      }
      for (const file of files) {
        const stat = await fs.lstat(file.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== file.dev || stat.ino !== file.ino
          || stat.size !== file.bytes
          || sha256(await fs.readFile(file.path)) !== file.sha256) throw new Error('profile artifact changed');
      }
      return true;
    } catch {
      throw Object.assign(new Error('The owned DSH SDK profile changed; create a new controlled runtime'),
        { code: 'DSH_SDK_PROFILE_CHANGED' });
    }
  }

  return Object.freeze({ homeDir, patchPath, gatePath, profile: 'sdk-minimal', policyFingerprint,
    files: Object.freeze(files), verify });
}
