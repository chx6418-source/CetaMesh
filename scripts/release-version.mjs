#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bumpBuildNumber,
  bumpPrerelease,
  bumpProductVersion,
  loadReleaseVersion,
  setProductVersion,
  validateVersionMirrors
} from '../src/release/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'show', argument] = process.argv.slice(2);
try {
  let result;
  if (command === 'show') result = loadReleaseVersion({ rootDir: ROOT });
  else if (command === 'validate') {
    const validation = validateVersionMirrors({ rootDir: ROOT });
    if (!validation.ok) throw Object.assign(new Error(validation.issues.map(issue => `${issue.code}: ${issue.expected ?? ''} (actual ${issue.actual ?? ''})`).join('\n')), { code: 'VERSION_MISMATCH' });
    result = validation.release;
  } else if (command === 'set') result = setProductVersion({ rootDir: ROOT, productVersion: argument });
  else if (command === 'bump') result = bumpProductVersion({ rootDir: ROOT, kind: argument || 'patch' });
  else if (command === 'prerelease') result = bumpPrerelease({ rootDir: ROOT, channel: argument || 'rc' });
  else if (command === 'bump-build') result = bumpBuildNumber({ rootDir: ROOT });
  else throw Object.assign(new Error(`unknown command: ${command}`), { code: 'COMMAND_INVALID' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[release-version] ${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
}
