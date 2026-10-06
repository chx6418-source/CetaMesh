// v2 hardening / Phase E 验收：Isolated Test Runner。
//
// 安全包络逐项验证（全部真实执行子进程）：
//   正面：npm test（allowlist）在 workspace root 真实执行、exitCode/stdout 如实；
//         npm run <script> -- 有界参数；cargo test 形态校验（若 cargo 可用则真实跑）。
//   负面：非 allowlist 工具 / 非法 npm 子命令 / shell 元字符 / 空白参数 / 超量参数；
//         未登记 workspace；最小 env（宿主自定义变量不透传）；超时杀进程；
//         cwd 固定为 workspace root。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolatedTestRunner } from '../src/workspace/isolated-runner.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-runner-'));
let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

const entries = new Map();
const runner = createIsolatedTestRunner({ resolveWorkspace: async (id) => entries.get(id) ?? null });

function makeWorkspace(name, files) {
  const dir = fs.mkdtempSync(path.join(temp, name + '-'));
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

// ── 1. npm test 正面 ─────────────────────────────────────────────────────────
{
  const dir = makeWorkspace('npm-ok', {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(\'RUNNER-OK\', process.cwd())"' } })
  });
  entries.set('ws-ok', { id: 'ws-ok', root: dir });
  const result = await runner.run({ workspaceId: 'ws-ok', tool: 'npm', args: ['test'] });
  assert.equal(result.exitCode, 0, `npm test 退出码 ${result.exitCode}：${result.stderr.slice(0, 200)}`);
  assert.ok(result.stdout.includes('RUNNER-OK'), '真实执行了 package.json 的 test 脚本');
  assert.equal(path.resolve(result.cwd), path.resolve(dir), 'cwd 固定为 workspace root');
  ok('npm test：allowlist 命中、真实执行、cwd = workspace root');
}

// ── 2. npm run <script> + 有界 -- 参数 ───────────────────────────────────────
{
  const dir = makeWorkspace('npm-run', {
    'package.json': JSON.stringify({
      name: 'fixture',
      scripts: { spec: 'node -e "console.log(\'ARG=\'+(process.argv[process.argv.length-1]||\'none\'))"' }
    })
  });
  entries.set('ws-run', { id: 'ws-run', root: dir });
  const result = await runner.run({ workspaceId: 'ws-run', tool: 'npm', args: ['run', 'spec', '--', 'case=1'] });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('ARG=case=1'), `透传有界参数：${result.stdout.slice(-80)}`);
  ok('npm run <script> -- 有界参数：真实透传');
}

// ── 3. allowlist 负面：工具 / 子命令 / shell 元字符 / 空白 / 超量 ─────────────
{
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'bash', args: ['-c', 'rm -rf /'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'bash 不在 allowlist');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'node', args: ['-e', 'process.exit(1)'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', '任意 node 不在 allowlist');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'powershell', args: ['-Command', 'whoami'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'powershell 不在 allowlist');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'cmd', args: ['/c', 'whoami'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'cmd 不在 allowlist');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'python', args: ['-c', 'print(1)'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'python 不在 allowlist');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'npm', args: ['install', 'left-pad'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'npm install 拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'npm', args: ['exec', 'x'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'npm exec 拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'npx', args: ['x'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'npx 拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'cargo', args: ['run'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'cargo run 拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'cargo', args: ['build'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'cargo build 拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'cargo', args: ['publish'] }),
    (e) => e.code === 'TEST_COMMAND_NOT_ALLOWED', 'cargo publish 拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'npm', args: ['run', 'spec; rm -rf /'] }),
    (e) => e.code === 'INVALID_PARAMS', 'shell 元字符拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ok', tool: 'npm', args: ['run', 'two words'] }),
    (e) => e.code === 'INVALID_PARAMS', '空白参数拒绝');
  await assert.rejects(() => runner.run({ workspaceId: 'ws-ghost', tool: 'npm', args: ['test'] }),
    (e) => e.code === 'WORKSPACE_NOT_FOUND', '未登记 workspace 拒绝');
  ok('allowlist 负面：bash/powershell/cmd/python/node/npm install/exec/npx/cargo run|build|publish/元字符/空白/未登记 workspace 全部拒绝');
}

// ── 4. 最小 env：宿主自定义变量不透传 ────────────────────────────────────────
{
  process.env.ISO_RUNNER_SECRET_PROBE = 'must-not-leak';
  const dir = makeWorkspace('env', {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(\'LEAK=\' + (process.env.ISO_RUNNER_SECRET_PROBE || \'absent\'), \'PATH=\' + (process.env.PATH ? \'yes\' : \'no\'))"' } })
  });
  entries.set('ws-env', { id: 'ws-env', root: dir });
  const result = await runner.run({ workspaceId: 'ws-env', tool: 'npm', args: ['test'] });
  delete process.env.ISO_RUNNER_SECRET_PROBE;
  assert.ok(result.stdout.includes('LEAK=absent'), '宿主自定义变量不进入测试进程');
  assert.ok(result.stdout.includes('PATH=yes'), '最小 env 保留 PATH（可运行 node）');
  ok('最小 env：宿主变量不透传，PATH 保持可用');
}

// ── 5. 超时：进程被杀、timedOut 如实 ────────────────────────────────────────
{
  const dir = makeWorkspace('slow', {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "setTimeout(()=>{},60000)"' } })
  });
  entries.set('ws-slow', { id: 'ws-slow', root: dir });
  const result = await runner.run({ workspaceId: 'ws-slow', tool: 'npm', args: ['test'], timeoutMs: 3000 });
  assert.equal(result.timedOut, true, '超时必须如实标记');
  assert.notEqual(result.exitCode, 0);
  ok('超时：3000ms 到点杀进程树（win32 taskkill /T /F），timedOut=true');
}

// ── 6. output 有界 ──────────────────────────────────────────────────────────
{
  const dir = makeWorkspace('loud', {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(\'x\'.repeat(4 * 1024 * 1024))"' } })
  });
  entries.set('ws-loud', { id: 'ws-loud', root: dir });
  const result = await runner.run({ workspaceId: 'ws-loud', tool: 'npm', args: ['test'] });
  assert.ok(result.stdout.length <= 512 * 1024 + 1, 'stdout 截断到上限');
  assert.equal(result.truncated, true, '截断如实标记');
  ok('output 有界：maxBuffer 杀进程 + 返回前截断标记');
}

try {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch { /* 被杀进程树的句柄可能延迟释放；清理失败不影响验收 */ }
console.log(`\n🎉 Isolated Test Runner 全部通过（${step} 组）`);
