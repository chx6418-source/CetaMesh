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
const historicalPlanningDocuments = new Set([
  'docs/DESKTOP_ACCEPTANCE.md',
  'docs/desktop/DESKTOP_V1_PLAN.md',
  'docs/roadmap/CETAMESH_DESKTOP_CODEX_WORKPLAN_v3.0.md',
  'docs/roadmap/CETAMESH_MOBILE_CODEX_WORKPLAN_v1.0.md'
]);
for (const name of tracked) {
  assert.ok(!historicalPlanningDocuments.has(name), 'Obsolete project planning document is tracked: ' + name);
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
for (const filename of ['README.md', 'README.en.md', 'README.zh-CN.md',
  'apps/mobile/README.md', 'apps/mobile/README.zh-CN.md', 'docs/PROJECT_GUIDE.md']) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const links = source.matchAll(/\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1].trim().split(/\s+"/)[0];
    if (!raw || /^(https?:|mailto:|#)/i.test(raw)) continue;
    const target = raw.split('#')[0].split('?')[0];
    if (!target) continue;
    const file = path.resolve(path.dirname(path.join(root, filename)), decodeURIComponent(target));
    assert.ok(file.startsWith(root + path.sep) || file === root, 'Relative link escapes repo: ' + filename + ' -> ' + raw);
    assert.ok(fs.existsSync(file), 'README link is broken: ' + filename + ' -> ' + raw);
  }
}
// Protect the most commonly regressed product-introduction claims.
const cn = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const mobileEn = fs.readFileSync(path.join(root, 'apps/mobile/README.md'), 'utf8');
const mobileCn = fs.readFileSync(path.join(root, 'apps/mobile/README.zh-CN.md'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'docs/PROJECT_GUIDE.md'), 'utf8');
assert.match(cn, /开发中|开发与测试/);
assert.match(cn, /apps\/mobile/);
assert.doesNotMatch(mobileEn, /private CetaMesh\s+monorepo|Congratulations!|First, you will need to run Metro/);
assert.doesNotMatch(mobileCn, /公开仓库的根目录是\s*\*\*CetaMesh Mobile\*\*/);
assert.match(guide, /CetaMesh/);
assert.match(guide, /无需 DSH|不必先安装 DSH/);
console.log('PASS: public paths, introductions, and relative Markdown links are clean; runtime source preserved.');
