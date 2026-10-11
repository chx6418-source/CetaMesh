#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseVersion } from '../src/release/version.js';
import { validatePluginDirectory } from '../src/plugin-center/validator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target || target === '--help' || target === '-h') {
  process.stdout.write('Usage: npm run plugin:validate -- <plugin-directory>\n');
  process.exitCode = target ? 0 : 2;
} else {
  const currentVersion = loadReleaseVersion({ rootDir: ROOT }).productVersion;
  const result = validatePluginDirectory(path.resolve(target), { currentVersion });
  if (!result.ok) {
    process.stderr.write(JSON.stringify({ ok: false, issues: result.issues }, null, 2) + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({
      ok: true,
      id: result.manifest.id,
      version: result.manifest.version,
      type: result.manifest.type,
      permissions: result.manifest.permissions,
      capabilities: result.manifest.capabilities.map(item => item.id),
      packageBytes: result.packageBytes,
      maxPackageBytes: result.maxPackageBytes,
      files: result.files.length
    }, null, 2) + '\n');
  }
}
