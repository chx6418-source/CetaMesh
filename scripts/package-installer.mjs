#!/usr/bin/env node
// Build a single-file Windows self-extracting installer with Windows' built-in IExpress.
// The extracted shell owns the branded installer flow; the application payload stays in one ZIP
// inside the setup executable until the user starts installation. Native/no-web builds validate
// that neither the payload nor shell embeds product HTML UI pages before creating the archive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoWebUiBinaryMarkers, assertNoWebUiHtmlArtifacts } from './no-web-release-policy.mjs';

const args = process.argv.slice(2);
const noWebUi = true;
let outputName = 'WhaleBridge-Setup-x64.exe';
const positionalArgs = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--no-web-ui') continue;
  if (args[index] === '--output-name') {
    outputName = String(args[index + 1] ?? '');
    index += 1;
    continue;
  }
  positionalArgs.push(args[index]);
}
const [outDirArg, payloadDirArg] = positionalArgs;
if (!outDirArg || !payloadDirArg) {
  process.stderr.write('用法：node scripts/package-installer.mjs <输出目录> <payload 目录>\n');
  process.exit(2);
}
const outDir = path.resolve(outDirArg);
const payloadDir = path.resolve(payloadDirArg);
const shellExe = path.join(outDir, 'WhaleBridge.exe');
if (path.basename(outputName) !== outputName || !/^[A-Za-z0-9._-]{1,180}\.exe$/i.test(outputName)) {
  process.stderr.write('[package-installer] output name must be a plain .exe filename\n');
  process.exit(2);
}
const outputExe = path.join(outDir, outputName);
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const iexpress = path.join(systemRoot, 'System32', 'iexpress.exe');
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const iconResourceScript = path.join(scriptsDir, 'set-exe-icon.ps1');
const setupIcon = path.resolve(scriptsDir, '..', 'desktop-shell', 'icons', 'icon.ico');

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function fail(message) {
  process.stderr.write(`[package-installer] ${message}\n`);
  process.exit(1);
}

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

if (!fs.existsSync(shellExe)) fail(`未找到桌面壳：${shellExe}`);
if (!fs.existsSync(path.join(payloadDir, 'WhaleBridgeCore.exe'))
  || !fs.existsSync(path.join(payloadDir, 'resources'))) {
  fail(`payload 不完整：${payloadDir}`);
}
if (noWebUi) {
  try {
    assertNoWebUiHtmlArtifacts(listFiles(payloadDir), 'installer payload');
    assertNoWebUiBinaryMarkers(fs.readFileSync(shellExe), 'installer shell');
    assertNoWebUiBinaryMarkers(fs.readFileSync(path.join(payloadDir, 'WhaleBridgeCore.exe')), 'installer Core');
  } catch (error) {
    fail(error.message);
  }
}
if (process.platform !== 'win32') {
  process.stderr.write('单文件 Windows 安装器需要在 Windows 构建机上生成（使用系统自带 IExpress）。\n');
  process.exit(2);
}
if (!fs.existsSync(iexpress)) fail(`未找到 Windows 自带打包工具：${iexpress}`);
if (!fs.existsSync(iconResourceScript)) fail(`未找到安装器图标脚本：${iconResourceScript}`);
if (!fs.existsSync(setupIcon)) fail(`未找到安装器图标：${setupIcon}`);
fs.mkdirSync(outDir, { recursive: true });

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-setup-'));
function cleanupWorkDir() {
  if (process.env.WHALEBRIDGE_KEEP_SETUP_TEMP === '1') {
    process.stderr.write(`[package-installer] 保留诊断目录：${workDir}\n`);
    return;
  }
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.on('exit', cleanupWorkDir);
try {
  const archiveName = 'WhaleBridgePayload.zip';
  const archivePath = path.join(workDir, archiveName);
  const packagedExe = path.join(workDir, outputName);
  const archiveScript = path.join(workDir, 'make-payload-archive.ps1');
  const sedPath = path.join(workDir, 'WhaleBridge-Setup.sed');
  fs.copyFileSync(shellExe, path.join(workDir, 'WhaleBridge.exe'));

  const archiveScriptContents = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psLiteral(payloadDir)}, ${psLiteral(archivePath)}, [System.IO.Compression.CompressionLevel]::Fastest, $false)`,
    ''
  ].join('\r\n');
  // Windows PowerShell 5.1 treats BOM-less UTF-8 as the active ANSI code page.
  fs.writeFileSync(archiveScript, Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(archiveScriptContents, 'utf16le')
  ]));
  const archiveResult = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', archiveScript
  ], { encoding: 'utf8', timeout: 600000 });
  if (archiveResult.error) fail(`无法创建安装文件归档：${archiveResult.error.message}`);
  if (archiveResult.status !== 0 || !fs.existsSync(archivePath)) {
    fail(`创建安装文件归档失败：${archiveResult.stderr || archiveResult.stdout || `退出代码 ${archiveResult.status}`}`);
  }

  const setupArgs = `--installer-ui --payload-archive ${archiveName}`;
  const sed = [
    '[Version]',
    'Class=IEXPRESS',
    'SEDVersion=3',
    '',
    '[Options]',
    'PackagePurpose=InstallApp',
    'ShowInstallProgramWindow=1',
    'HideExtractAnimation=1',
    'UseLongFileName=1',
    'InsideCompressed=1',
    'CAB_FixedSize=0',
    'CAB_ResvCodeSigning=0',
    'RebootMode=N',
    'InstallPrompt=%InstallPrompt%',
    'DisplayLicense=%DisplayLicense%',
    'FinishMessage=%FinishMessage%',
    'TargetName=%TargetName%',
    'FriendlyName=%FriendlyName%',
    'AppLaunched=%AppLaunched%',
    'PostInstallCmd=%PostInstallCmd%',
    'AdminQuietInstCmd=',
    'UserQuietInstCmd=',
    'SourceFiles=SourceFiles',
    '',
    '[Strings]',
    'InstallPrompt=',
    'DisplayLicense=',
    'FinishMessage=',
    `TargetName=${packagedExe}`,
    'FriendlyName=CetaMesh 安装程序',
    `AppLaunched=WhaleBridge.exe ${setupArgs}`,
    'PostInstallCmd=<None>',
    'AdminQuietInstCmd=',
    'UserQuietInstCmd=',
    'FILE0="WhaleBridge.exe"',
    `FILE1="${archiveName}"`,
    '',
    '[SourceFiles]',
    `SourceFiles0=${workDir}${path.sep}`,
    '',
    '[SourceFiles0]',
    '%FILE0%=',
    '%FILE1%=',
    ''
  ].join('\r\n');
  fs.writeFileSync(sedPath, sed, 'utf8');

  const buildResult = spawnSync(iexpress, ['/N', sedPath], {
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true
  });
  if (buildResult.error) fail(`无法执行 IExpress：${buildResult.error.message}`);
  if (buildResult.status !== 0 || !fs.existsSync(packagedExe)) {
    fail(`IExpress 未能生成安装器：${buildResult.stderr || buildResult.stdout || `退出代码 ${buildResult.status}`}`);
  }

  const iconResult = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', iconResourceScript,
    '-ExecutablePath', packagedExe,
    '-IconPath', setupIcon
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (iconResult.error) fail(`无法写入安装器图标：${iconResult.error.message}`);
  if (iconResult.status !== 0) {
    fail(`写入安装器图标失败：${iconResult.stderr || iconResult.stdout || `退出代码 ${iconResult.status}`}`);
  }

  fs.copyFileSync(packagedExe, outputExe);
  fs.rmSync(packagedExe);
  process.stdout.write(`已生成 ${outputExe}（${(fs.statSync(outputExe).size / 1024 / 1024).toFixed(1)} MB）\n`);
} finally {
  cleanupWorkDir();
}
