// Records exact commands and exit codes. Environment exceptions are reviewed,
// never inferred from a failing assertion or converted into PASS.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const release = process.argv.includes('--release');
const npmTests = ['test-config', 'test-agent', 'test-memory', 'test-task', 'test-extension', 'test-mesh', 'test-workspace'];
const nodeTests = ['test-model-runtime', 'test-smart-router', 'test-continuity-auto-rollover', 'test-agent-broker',
  'test-capability-broker', 'test-workshop-runtime', 'test-memory-link', 'test-managed-agent-provider',
  'test-desktop-platform-integration', 'test-smart-platform-routing', 'test-extension-capability',
  'test-desktop-chat-product', 'test-owner-agent-mode', 'test-workspace-reconciliation', 'test-continuity-rollover',
  'test-ipc-protocol', 'test-control-service', 'test-system-pages', 'test-desktop-architecture'];
const commands = release ? ['npm run build:core', 'npm run desktop:build', 'npm run build:release', 'npm run test-release-candidate']
  : [...npmTests.map(name => 'npm run ' + name), ...nodeTests.map(name => 'node scripts/' + name + '.mjs'),
    ...['test-core-entry', 'test-privilege', 'test-dsh-integration', 'desktop:check', 'desktop:test'].map(name => 'npm run ' + name)];
const dir = path.resolve('output/session3-validation-20261005');
fs.mkdirSync(dir, { recursive: true });
const results = [];
for (const [index, command] of commands.entries()) {
  console.log('START ' + command);
  const start = Date.now();
  const execution = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', command], { encoding: 'utf8', windowsHide: true, timeout: release ? 900000 : 180000, maxBuffer: 16 * 1024 * 1024 })
    : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: release ? 900000 : 180000, maxBuffer: 16 * 1024 * 1024 });
  const log = path.join(dir, (release ? 'release-' : 'regression-') + String(index + 1).padStart(2, '0') + '.log');
  fs.writeFileSync(log, execution.stdout + '\n' + execution.stderr + (execution.error ? '\n' + execution.error.message : ''));
  const row = { command, status: execution.status === 0 ? 'PASS' : 'FAIL', exitCode: execution.status,
    error: execution.error?.code ?? null, elapsedMs: Date.now() - start, log };
  results.push(row);
  fs.writeFileSync(path.join(dir, release ? 'results-release.json' : 'results-regression.json'), JSON.stringify(results, null, 2));
  console.log(row.status + ' ' + command + ' (' + row.elapsedMs + 'ms)');
  if (row.status !== 'PASS') console.log((execution.stdout + execution.stderr).slice(-3000));
}
console.log(JSON.stringify({ total: results.length, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status !== 'PASS').length }));
process.exitCode = results.some(r => r.status !== 'PASS') ? 1 : 0;
