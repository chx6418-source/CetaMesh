import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, MANIFEST_FILENAMES } from '../extension/manifest.js';
import { EXTENSION_LIMITS } from '../extension/types.js';
import { compareProductVersions } from '../release/version.js';
import { pluginCenterError } from './catalog.js';

const FORBIDDEN_FILE_RE = /(^|[\\/])(\.env(?:\.|$)|\.git|node_modules|\.ssh)([\\/]|$)|\.(?:pem|key|p12|pfx|crt|cer|secret|secrets|credentials)$/i;

function walk(root, relative = '', out = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const full = path.join(root, rel);
    if (entry.isSymbolicLink()) throw pluginCenterError('PLUGIN_FILE_FORBIDDEN', `symbolic links are not allowed: ${rel}`);
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
    else throw pluginCenterError('PLUGIN_FILE_FORBIDDEN', `unsupported file entry: ${rel}`);
  }
  return out;
}

export function validatePluginDirectory(directory, { currentVersion = '1.0.0' } = {}) {
  const issues = [];
  try {
    const root = path.resolve(String(directory ?? ''));
    if (!directory || !fs.statSync(root).isDirectory()) throw pluginCenterError('PLUGIN_DIRECTORY_INVALID', 'plugin path must be a directory');
    const files = walk(root);
    if (files.length > EXTENSION_LIMITS.sourceFiles) throw pluginCenterError('PLUGIN_TOO_LARGE', 'plugin contains too many files');
    let packageBytes = 0;
    for (const file of files) {
      if (FORBIDDEN_FILE_RE.test(file.replace(/\\/g, '/'))) throw pluginCenterError('PLUGIN_FILE_FORBIDDEN', `plugin contains a forbidden file: ${file}`);
      packageBytes += fs.statSync(path.join(root, file)).size;
      if (packageBytes > EXTENSION_LIMITS.sourceBytes) throw pluginCenterError('PLUGIN_TOO_LARGE', 'plugin exceeds the Extension Runtime source size limit');
    }
    const manifestFile = MANIFEST_FILENAMES.find(name => files.includes(name));
    if (!manifestFile) throw pluginCenterError('MANIFEST_MISSING', 'extension.json or manifest.json is required');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(root, manifestFile), 'utf8')); }
    catch (error) { throw pluginCenterError('MANIFEST_INVALID', `plugin manifest cannot be parsed: ${error.message}`); }
    const checked = validateManifest(raw);
    if (!checked.ok) throw pluginCenterError(checked.issues[0]?.code ?? 'MANIFEST_INVALID', checked.issues[0]?.message ?? 'invalid extension manifest');
    if (!files.includes(checked.manifest.entry)) throw pluginCenterError('ENTRY_MISSING', `manifest entry not found: ${checked.manifest.entry}`);
    if (raw.minCetaMeshVersion && compareProductVersions(currentVersion, raw.minCetaMeshVersion) < 0) {
      throw pluginCenterError('PLUGIN_INCOMPATIBLE', `CetaMesh ${currentVersion} is below required version ${raw.minCetaMeshVersion}`);
    }
    if (raw.maxCetaMeshVersion && compareProductVersions(currentVersion, raw.maxCetaMeshVersion) > 0) {
      throw pluginCenterError('PLUGIN_INCOMPATIBLE', `CetaMesh ${currentVersion} is newer than supported version ${raw.maxCetaMeshVersion}`);
    }
    for (const field of ['minCetaMeshVersion', 'maxCetaMeshVersion']) {
      const value = raw[field];
      if (value && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value))) {
        throw pluginCenterError('MANIFEST_INVALID', `${field} must be SemVer`);
      }
    }
    return { ok: true, issues, manifest: checked.manifest, packageBytes, maxPackageBytes: EXTENSION_LIMITS.sourceBytes, files };
  } catch (error) {
    issues.push({ code: error.code ?? 'PLUGIN_VALIDATION_FAILED', message: error.message ?? String(error) });
    return { ok: false, issues, manifest: null, packageBytes: 0, maxPackageBytes: EXTENSION_LIMITS.sourceBytes, files: [] };
  }
}
