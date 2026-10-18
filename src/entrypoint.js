import path from 'node:path';
import { fileURLToPath } from 'node:url';

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True only when the module is the script Node was asked to execute. */
export function isMainModule(metaUrl, argv = process.argv) {
  const entry = argv?.[1];
  if (!entry) return false;
  try {
    return comparablePath(fileURLToPath(metaUrl)) === comparablePath(entry);
  } catch {
    return false;
  }
}

export function reportEntrypointError(label, error) {
  console.error(`[${label}] 启动失败:`, error?.stack ?? error?.message ?? error);
  process.exitCode = error?.code === 'STATE_DIR_BUSY' ? 2 : 1;
}
