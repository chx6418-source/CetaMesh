import path from 'node:path';

const ALLOWED_WORKER_ENV_KEYS = new Set([
  'PATH',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'CETAMESH_EXTENSION_ID',
  'CETAMESH_EXTENSION_VERSION',
  'CETAMESH_EXTENSION_FINGERPRINT',
  'CETAMESH_EXTENSION_STORAGE_FILE'
]);

function copyString(target, outputName, source, inputName = outputName) {
  const value = source?.[inputName];
  if (typeof value === 'string' && value.length > 0 && value.length <= 8192) target[outputName] = value;
}

/** Build a fresh Worker environment; no parent variables are inherited implicitly. */
export function buildExtensionWorkerEnv({ parentEnv = process.env, metadata = {}, platform = process.platform } = {}) {
  const env = {};
  copyString(env, 'TEMP', parentEnv, 'TEMP');
  copyString(env, 'TMP', parentEnv, 'TMP');
  if (platform === 'win32') {
    copyString(env, 'SystemRoot', parentEnv, 'SystemRoot');
    if (!env.SystemRoot) copyString(env, 'SystemRoot', parentEnv, 'SYSTEMROOT');
    if (!env.SystemRoot) throw new Error('Windows Extension Worker requires SystemRoot');
    env.PATH = path.win32.join(env.SystemRoot, 'System32');
  } else {
    env.PATH = '/usr/bin:/bin';
  }
  copyString(env, 'CETAMESH_EXTENSION_ID', metadata, 'extensionId');
  copyString(env, 'CETAMESH_EXTENSION_VERSION', metadata, 'version');
  copyString(env, 'CETAMESH_EXTENSION_FINGERPRINT', metadata, 'fingerprint');
  copyString(env, 'CETAMESH_EXTENSION_STORAGE_FILE', metadata, 'storageFile');
  return env;
}

/** Remove platform-added or injected variables before loading any Extension package code. */
export function sanitizeExtensionWorkerEnv(target = process.env) {
  for (const key of Object.keys(target)) {
    if (!ALLOWED_WORKER_ENV_KEYS.has(key.toUpperCase())) delete target[key];
  }
  return target;
}
