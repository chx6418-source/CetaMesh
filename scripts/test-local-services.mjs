// DSH-only lifecycle regression with test-owned files, endpoints and optional fixture process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { createLocalServiceManager, DSH_INSTALL_HINT, createAdaptiveProcessDecoder, connectorProcessEnv } from '../src/local-services.js';

let passed = 0;
let failed = 0;
function check(name, condition, extra = '') {
  if (condition) { passed += 1; console.log(`✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed += 1; console.error(`❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-local-services-'));
try {
  const connectorEnv = connectorProcessEnv({ PATH: 'fixture-bin', WHALEBRIDGE_UI_AUTH_TOKEN: 'owner-secret', WHALEBRIDGE_UI_PIPE: 'owner-pipe', DSH_HOME: 'fixture-home' });
  check('外部 Connector 子进程不继承 Owner IPC 凭据', connectorEnv.PATH === 'fixture-bin' && connectorEnv.DSH_HOME === 'fixture-home' && !Object.hasOwn(connectorEnv, 'WHALEBRIDGE_UI_AUTH_TOKEN') && !Object.hasOwn(connectorEnv, 'WHALEBRIDGE_UI_PIPE'));
  const appData = path.join(temp, 'App Data', 'Roaming');
  const npmBin = path.join(appData, 'npm');
  const dshPackage = path.join(npmBin, 'node_modules', '@deepseek-ai', 'dsh');
  const dshHome = path.join(temp, '.dsh');
  fs.mkdirSync(dshPackage, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'),
    `client-connection/browser-session:\n  secret: ${Buffer.alloc(32, 7).toString('base64url')}\n`);
  fs.writeFileSync(path.join(dshPackage, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"3.2.1","bin":{"dsh":"cli.js"}}\n');
  fs.writeFileSync(path.join(dshPackage, 'cli.js'), '#!/usr/bin/env node\n');
  const dshExecutable = path.join(npmBin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  fs.writeFileSync(dshExecutable, process.platform === 'win32'
    ? '@echo off\necho DSH_START_OK:%1\necho DSH_HOME_OK:%DSH_HOME%\nexit /b 0\n'
    : '#!/bin/sh\necho DSH_START_OK:$1\n');

  // 端口 9（discard）必然连不上：让这些用例与「开发机上是否真跑着服务」彻底解耦。
  const DEAD_CONFIG = { dsh: { baseUrl: 'http://127.0.0.1:9' } };
  const config = {
    dsh: { baseUrl: 'http://127.0.0.1:9', homeDir: dshHome }
  };
  const manager = createLocalServiceManager({
    root: temp,
    config,
    detectionOptions: {
      userHome: temp,
      fullScanRoots: [],
      environment: { PATH: npmBin, APPDATA: appData, LOCALAPPDATA: path.join(temp, 'LocalAppData') }
    }
  });
  const initial = await manager.detectAll();
  check('检测 dsh npm 全局可执行文件并读取版本', initial.dsh.installed === true && initial.dsh.version === '3.2.1' && path.resolve(initial.dsh.executable) === path.resolve(dshExecutable));
  const cached = await manager.detectAll();
  check('第二次检测命中缓存层', cached.dsh.detection.layer === 'cache');
  const selected = await manager.selectDsh({ id: initial.dsh.selectedId });
  const persisted = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  check('DSH 所选版本使用原有 JSON 配置持久化', selected.selectedId === initial.dsh.selectedId
    && path.resolve(persisted.dsh.executable) === path.resolve(dshExecutable));
  if (process.platform === 'win32') {
    const dshStartedAt = Date.now();
    const dshStart = await manager.startDsh({ waitMs: 5000 });
    check('Windows 可启动 npm dsh.cmd 并正确传递 web 参数', dshStart.logs.some((item) => item.text.includes('DSH_START_OK:web')));
    check('dsh 启动显式传递所选 DSH_HOME', dshStart.logs.some((item) => item.text.includes(path.resolve(dshHome))));
    check('dsh 子进程退出后快速结束就绪等待', Date.now() - dshStartedAt < 4000);
  }
  check('dsh 安装提示包含 Node.js 前置依赖', manager.getDshInstallHint() === DSH_INSTALL_HINT && /Node\.js/.test(DSH_INSTALL_HINT) && /npx @deepseek-ai\/dsh web/.test(DSH_INSTALL_HINT));

  const missingManager = createLocalServiceManager({
    root: path.join(temp, 'empty'),
    config: DEAD_CONFIG,
    detectionOptions: { userHome: path.join(temp, 'empty-user'), fullScanRoots: [], environment: { PATH: '' } }
  });
  const missing = await missingManager.detectAll();
  check('缺少 DSH 时不抛错并标记未安装', missing.dsh.installed === false && missing.dsh.status === 'not-installed');

  // ── 就绪状态校正：外部已启动的服务不能被显示成“未运行” ──────────────────
  const http = await import('node:http');
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));
  // 模拟 DSH：根路径 401；真实 ready 探针必须走带鉴权的设置和 session API。
  const fakeDsh = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!String(req.headers.cookie ?? '').startsWith('dsh-auth-')) { res.writeHead(401); res.end('unauthorized'); return; }
      const request = JSON.parse(body);
      const value = request.method === 'session/list' ? { items: [] } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }));
    });
  });
  await listen(fakeDsh);
  const readyManager = createLocalServiceManager({
    root: path.join(temp, 'ready-root'),
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:' + fakeDsh.address().port, homeDir: dshHome }
    },
    detectionOptions: { userHome: temp, fullScanRoots: [], environment: { PATH: '', APPDATA: path.join(temp, 'no-appdata'), LOCALAPPDATA: '' } }
  });
  await readyManager.detectAll();
  const readySnapshot = readyManager.snapshot();
  check('DSH Ready 由已鉴权的 settings 与 session API 决定（根路径 401 不参与）', readySnapshot.dsh.ready === true && readySnapshot.dsh.running === true && readySnapshot.dsh.authenticated === true && readySnapshot.dsh.sessionCapable === true, 'status=' + readySnapshot.dsh.status);
  check('外部实例标记为非托管（不重复拉起、不显示停止按钮）', readySnapshot.dsh.managed === false);
  await closeServer(fakeDsh);
  await readyManager.reconcileReadiness({ force: true });
  const downSnapshot = readyManager.snapshot();
  check('外部服务停止后状态回落为未运行', downSnapshot.dsh.ready === false && downSnapshot.dsh.running === false);

  const rootOnly = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200); res.end('up'); return; }
    res.writeHead(404); res.end('not an authenticated DSH API');
  });
  await listen(rootOnly);
  const rootOnlyManager = createLocalServiceManager({ root: path.join(temp, 'root-only-root'),
    config: { dsh: { baseUrl: 'http://127.0.0.1:' + rootOnly.address().port, homeDir: dshHome } },
    detectionOptions: { userHome: temp, fullScanRoots: [], environment: { PATH: '', APPDATA: path.join(temp, 'no-appdata'), LOCALAPPDATA: '' } } });
  const rootOnlySnapshot = await rootOnlyManager.detectAll();
  check('只有 HTTP 根路径可达时 DSH Agent Session 仍为未就绪', rootOnlySnapshot.dsh.ready === false && rootOnlySnapshot.dsh.reachable === true && rootOnlySnapshot.dsh.sessionCapable === false);
  await closeServer(rootOnly);

  // ── .dsh 是数据目录而非安装目录：没有可用可执行文件时也不应误报“不完整安装” ──
  const homeOnly = path.join(temp, 'home-only');
  const homeOnlyDsh = path.join(homeOnly, '.dsh');
  fs.mkdirSync(homeOnlyDsh, { recursive: true });
  fs.writeFileSync(path.join(homeOnlyDsh, 'settings.yaml'), 'theme: light\n');
  fs.mkdirSync(path.join(homeOnlyDsh, 'profiles'), { recursive: true });
  const homeOnlyManager = createLocalServiceManager({
    root: path.join(temp, 'home-only-root'),
    config: DEAD_CONFIG,
    detectionOptions: { userHome: homeOnly, fullScanRoots: [], environment: { PATH: '', APPDATA: path.join(temp, 'no-appdata'), LOCALAPPDATA: '' } }
  });
  const homeOnlyResult = await homeOnlyManager.detectAll();
  // 注意：status 反映的是“实时就绪”（本机真实 dsh 可能正在跑），这里只断言“不把 .dsh 当安装”。
  check('只有 .dsh 数据目录时不误报“不完整安装”',
    homeOnlyResult.dsh.installations.every((item) => item.valid || path.basename(item.homeDir || '').toLowerCase() !== '.dsh')
    && homeOnlyResult.dsh.installations.filter((item) => item.valid).length === 0,
    'installations=' + homeOnlyResult.dsh.installations.length);

  // ── 子进程输出解码：Node(UTF-8) 与 cmd(GBK) 混排、跨块多字节都不能变乱码 ──
  // 截图里那条 cmd 报错就是“首行 ASCII 锁定 UTF-8、后面的中文全变 �”的典型症状。
  const mixed = createAdaptiveProcessDecoder();
  let mixedText = mixed.write(Buffer.from('D:\\repo>echo on\n'));
  mixedText += mixed.write(Buffer.from('✅ 全部通过\n', 'utf8'));
  mixedText += mixed.write(iconv.encode('不是内部或外部命令，也不是可运行的程序或批处理文件。\n', 'gbk'));
  mixedText += mixed.end();
  check('混排编码按行自适应解码（UTF-8 与 GBK 混排）',
    mixedText.includes('✅ 全部通过') && mixedText.includes('不是内部或外部命令，也不是可运行的程序或批处理文件。') && !mixedText.includes('\uFFFD'),
    JSON.stringify(mixedText.slice(-40)));
  const split = createAdaptiveProcessDecoder();
  const utf8Bytes = Buffer.from('中文测试\n', 'utf8');
  let splitText = split.write(utf8Bytes.subarray(0, 3));
  splitText += split.write(utf8Bytes.subarray(3));
  splitText += split.end();
  check('跨数据块的多字节字符不被截断', splitText.includes('中文测试') && !splitText.includes('\uFFFD'), JSON.stringify(splitText));
  const tailOnly = createAdaptiveProcessDecoder();
  const tailText = tailOnly.write(Buffer.from('no newline tail', 'utf8')) + tailOnly.end();
  check('无换行残留内容在流结束时输出', tailText.includes('no newline tail'));

  check('管理器仅提供 DSH 检测和生命周期',
    ['detectAll', 'snapshot', 'selectDsh', 'startDsh', 'stopDsh'].every(name => typeof manager[name] === 'function')
    && Object.keys(manager.snapshot()).join(',') === 'dsh');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
// 用 exitCode 而不是 process.exit：后者会在仍有活动句柄时中断事件循环，
// 在 Windows 上表现为 libuv 的 !(handle->flags & UV_HANDLE_CLOSING) 断言崩溃。
if (failed) process.exitCode = 1;
