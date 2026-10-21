import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { pluginCenterError, PLUGIN_CATALOG_LIMITS } from './catalog.js';

const DEFAULT_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
const DEFAULT_FILE_COUNT = 200;
const FORBIDDEN_FILE_RE = /(^|\/)(\.env(?:\.|$)|\.git|node_modules|\.npm|\.ssh)(\/|$)|\.(?:pem|key|p12|pfx|crt|cer|secret|secrets|credentials)$/i;

export function verifyPluginPackage(input, { sha256, bytes, maxBytes = PLUGIN_CATALOG_LIMITS.maxPackageBytes } = {}) {
  const data = Buffer.from(input ?? []);
  if (!data.byteLength || data.byteLength > maxBytes) {
    return { ok: false, code: 'PACKAGE_TOO_LARGE', actualBytes: data.byteLength, maxBytes };
  }
  if (Number.isSafeInteger(bytes) && bytes !== data.byteLength) {
    return { ok: false, code: 'PACKAGE_SIZE_MISMATCH', expectedBytes: bytes, actualBytes: data.byteLength };
  }
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(String(sha256 ?? '')) || actual !== String(sha256).toLowerCase()) {
    return { ok: false, code: 'PACKAGE_SHA256_MISMATCH', expectedSha256: sha256 ?? null, actualSha256: actual };
  }
  return { ok: true, bytes: data.byteLength, sha256: actual };
}

function safeArchivePath(raw) {
  const name = String(raw ?? '').replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\0')) return null;
  const segments = name.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  const normalized = segments.join('/');
  if (FORBIDDEN_FILE_RE.test(normalized)) return { forbidden: true, name: normalized };
  return { name: normalized };
}

export function extractPluginPackage(input, {
  stagingRoot,
  maxPackageBytes = PLUGIN_CATALOG_LIMITS.maxPackageBytes,
  maxUncompressedBytes = DEFAULT_UNCOMPRESSED_BYTES,
  maxFiles = DEFAULT_FILE_COUNT
} = {}) {
  if (!stagingRoot || typeof stagingRoot !== 'string') throw pluginCenterError('PACKAGE_STAGE_INVALID', 'stagingRoot is required');
  const data = Buffer.from(input ?? []);
  if (!data.byteLength || data.byteLength > maxPackageBytes) throw pluginCenterError('PACKAGE_TOO_LARGE', 'compressed package exceeds the allowed size');
  let archive;
  let declaredBytes = 0;
  let declaredEntries = 0;
  const declaredPaths = new Set();
  try {
    archive = unzipSync(new Uint8Array(data), {
      filter(file) {
        declaredEntries += 1;
        if (declaredEntries > maxFiles) throw pluginCenterError('PACKAGE_TOO_LARGE', 'package contains too many archive entries');
        const directory = String(file.name).replace(/\\/g, '/').endsWith('/');
        const archivePath = directory ? String(file.name).replace(/\\/g, '/').replace(/\/+$/, '') : file.name;
        const checked = safeArchivePath(archivePath);
        if (!checked) throw pluginCenterError('PACKAGE_PATH_INVALID', `unsafe archive path: ${file.name}`);
        if (checked.forbidden) throw pluginCenterError('PACKAGE_FORBIDDEN_FILE', `package contains a forbidden file: ${checked.name}`);
        const folded = checked.name.toLowerCase();
        if (declaredPaths.has(folded)) throw pluginCenterError('PACKAGE_PATH_INVALID', `duplicate archive path: ${checked.name}`);
        declaredPaths.add(folded);
        if (!directory) {
          if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
            throw pluginCenterError('PACKAGE_INVALID', 'archive contains an invalid uncompressed file size');
          }
          declaredBytes += file.originalSize;
          if (declaredBytes > maxUncompressedBytes) {
            throw pluginCenterError('PACKAGE_TOO_LARGE', 'uncompressed package exceeds the allowed size');
          }
        }
        return true;
      }
    });
  } catch (error) {
    if (error?.code) throw error;
    throw pluginCenterError('PACKAGE_INVALID', 'package is not a valid ZIP archive');
  }
  const files = Object.keys(archive).filter(name => !name.endsWith('/'));
  if (files.length === 0 || files.length > maxFiles) throw pluginCenterError('PACKAGE_TOO_LARGE', 'package file count is outside the allowed limit');
  let totalBytes = 0;
  const normalizedFiles = [];
  const seen = new Set();
  for (const name of files) {
    const result = safeArchivePath(name);
    if (!result) throw pluginCenterError('PACKAGE_PATH_INVALID', `unsafe archive path: ${name}`);
    if (result.forbidden) throw pluginCenterError('PACKAGE_FORBIDDEN_FILE', `package contains a forbidden file: ${result.name}`);
    const folded = result.name.toLowerCase();
    if (seen.has(folded)) throw pluginCenterError('PACKAGE_PATH_INVALID', `duplicate archive path: ${result.name}`);
    seen.add(folded);
    const content = archive[name];
    totalBytes += content.byteLength;
    if (totalBytes > maxUncompressedBytes) throw pluginCenterError('PACKAGE_TOO_LARGE', 'uncompressed package exceeds the allowed size');
    normalizedFiles.push({ name: result.name, content });
  }

  fs.mkdirSync(stagingRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(path.resolve(stagingRoot), 'stage-'));
  try {
    const root = path.resolve(directory);
    for (const entry of normalizedFiles) {
      const destination = path.resolve(root, ...entry.name.split('/'));
      if (destination !== root && !destination.startsWith(root + path.sep)) {
        throw pluginCenterError('PACKAGE_PATH_INVALID', `archive path escapes staging: ${entry.name}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, entry.content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, files: normalizedFiles.map(entry => entry.name), uncompressedBytes: totalBytes };
}

export function cleanupPluginStage(directory) {
  if (!directory || typeof directory !== 'string') return false;
  fs.rmSync(directory, { recursive: true, force: true });
  return true;
}
