#!/usr/bin/env node
// Public source hygiene regression gate. Check tracked paths, not developer scratch files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\0').filter(Boolean).map(name => name.replaceAll('\\', '/'));
const paths = new Set(tracked);
const forbidden = [
  'design-demos/',
  'docs/archive/',
  'docs/repair-evidence/',
  'docs/repairs/',
  'docs/superpowers/',
  'apps/mobile/docs/superpowers/'
];
const approvedRoot = new Set([
  '.gitignore', '.npmrc', 'AGENTS.md', 'AGENT_NATIVE_SECURITY_POLICY.md',
  'CAPABILITY_COVERAGE.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md',
  'LICENSE', 'OPEN_SOURCE.md', 'OPEN_SOURCE.zh-CN.md', 'PROJECT_STATE.md',
  'README.md', 'README.en.md', 'README.zh-CN.md', 'RULES.md', 'SECURITY.md',
  'THIRD_PARTY_NOTICES.md', 'UI_SOURCE_OF_TRUTH.md',
  'config.example.json', 'package-lock.json', 'package.json', 'release-config.json',
  'start.bat', 'restart.bat', '启动桥接.vbs', '重启桥接.vbs'
]);
for (const name of tracked) {
  assert.ok(!forbidden.some(prefix => name.startsWith(prefix)), 'Private-only historical path is tracked: ' + name);
  if (!name.includes('/')) {
    assert.ok(approvedRoot.has(name), 'New root file requires explicit public-content review: ' + name);
  }
}
for (const required of [
  'desktop-ui/src/app/HarborApp.tsx',
  'desktop-shell/src/theme/themes.rs',
  'apps/mobile/package.json',
  'docs/protocol/UNIFIED_PAIRING_V1_1.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md'
]) assert.ok(paths.has(required), 'Essential source or document missing: ' + required);
for (const filename of ['README.md', 'README.en.md', 'README.zh-CN.md']) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const links = source.matchAll(/\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1].trim().split(/\s+"/)[0];
    if (!raw || /^(https?:|mailto:|#)/i.test(raw)) continue;
    const target = raw.split('#')[0].split('?')[0];
    if (!target) continue;
    const file = path.resolve(root, decodeURIComponent(target));
    assert.ok(file.startsWith(root + path.sep) || file === root, 'Relative link escapes repo: ' + filename + ' -> ' + raw);
    assert.ok(fs.existsSync(file), 'README link is broken: ' + filename + ' -> ' + raw);
  }
}
console.log('PASS: tracked public paths and README links are clean; runtime source preserved.');
