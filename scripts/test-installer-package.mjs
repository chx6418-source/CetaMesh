#!/usr/bin/env node
// Smoke-test the self-contained setup packaging using disposable fixture files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stdout.write('⏭️ 跳过：单文件 Windows 安装器只在 Windows 上构建。\n');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-installer-test-'));
const outDir = path.join(tempRoot, '发布输出');
const payloadDir = path.join(tempRoot, '应用数据', 'payload');
// The suite runner already supplies a long temporary parent. Keep this added
// component short while still forcing a space in IExpress's SED argument path.
const packagerTemp = path.join(tempRoot, 'p s');
fs.mkdirSync(packagerTemp, { recursive: true });
const packagerEnv = { ...process.env, TEMP: packagerTemp, TMP: packagerTemp, TMPDIR: packagerTemp };
fs.mkdirSync(path.join(payloadDir, 'resources', 'public'), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'WhaleBridge.exe'), Buffer.from([0x4d, 0x5a, 0, 0]));
fs.writeFileSync(path.join(payloadDir, 'WhaleBridgeCore.exe'), 'fixture core');

try {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'package-installer.mjs'), outDir, payloadDir
  ], { cwd: root, encoding: 'utf8', timeout: 600000, env: packagerEnv });
  assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const setupExe = path.join(outDir, 'WhaleBridge-Setup-x64.exe');
  assert.ok(fs.existsSync(setupExe), 'IExpress 应生成单文件安装器');
  assert.ok(fs.statSync(setupExe).size > 4096, '安装器中应包含压缩的壳与 payload');
  assert.deepEqual([...fs.readFileSync(setupExe).subarray(0, 2)], [0x4d, 0x5a], '输出应为 Windows PE 可执行文件');
  const iconProbe = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Drawing; '
      + '$icon=[System.Drawing.Icon]::ExtractAssociatedIcon($env:WHALEBRIDGE_ICON_PROBE); if($null -eq $icon){exit 2}; '
      + '$bitmap=$icon.ToBitmap(); try { '
      + '$pixels=0; for($x=0;$x -lt $bitmap.Width;$x++){for($y=0;$y -lt $bitmap.Height;$y++){'
      + '$color=$bitmap.GetPixel($x,$y); if($color.A -gt 0 -and ($color.G-$color.R) -gt 8 -and ($color.G-$color.B) -gt 5){$pixels++}}}; '
      + 'if($pixels -lt 20){exit 3} } finally {$bitmap.Dispose(); $icon.Dispose()}',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, WHALEBRIDGE_ICON_PROBE: setupExe }
  });
  assert.equal(iconProbe.status, 0,
    `安装器应带有可由 Windows 提取的绿色 CetaMesh 图标（退出代码 ${iconProbe.status}）：${iconProbe.stderr ?? ''}`);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['WhaleBridge-Setup-x64.exe', 'WhaleBridge.exe'].sort());
  process.stdout.write('✅ IExpress 生成了带绿色 CetaMesh 图标的单文件安装器，构建中间文件未进入发布目录。\n');

  // The package builder must fail closed if an upstream step accidentally reintroduces HTML UI.
  fs.writeFileSync(path.join(payloadDir, 'resources', 'public', 'console.html'), '<!doctype html>');
  const rejectedOutDir = path.join(tempRoot, '网页意外混入');
  fs.mkdirSync(rejectedOutDir, { recursive: true });
  fs.writeFileSync(path.join(rejectedOutDir, 'WhaleBridge.exe'), Buffer.from([0x4d, 0x5a, 0, 0]));
  const rejected = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'package-installer.mjs'), rejectedOutDir, payloadDir
  ], { cwd: root, encoding: 'utf8', timeout: 600000, env: packagerEnv });
  assert.equal(rejected.status, 1, '含产品 HTML 的 payload 必须在封包前被拒绝');
  assert.match(rejected.stderr ?? '', /contains product HTML UI assets/i);
  assert.equal(fs.existsSync(path.join(rejectedOutDir, 'WhaleBridge-Setup-x64.exe')), false);
  process.stdout.write('✅ no-web 安装器守卫：检测到 HTML 页面时在生成前拒绝。\n');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
