// 本地子服务管理层纯逻辑测试：不联网、不启动 SnowLuma/dsh，不修改真实配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { createLocalServiceManager, pickSnowLumaReleaseAsset, DSH_INSTALL_HINT, SNOWLUMA_RELEASE_PAGE, createAdaptiveProcessDecoder } from '../src/local-services.js';

let passed = 0;
let failed = 0;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
function check(name, condition, extra = '') {
  if (condition) { passed += 1; console.log(`✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed += 1; console.error(`❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-local-services-'));
try {
  const snowDir = path.join(temp, 'SnowLuma');
  fs.mkdirSync(snowDir, { recursive: true });
  fs.writeFileSync(path.join(snowDir, 'launcher.bat'), '@echo off\necho SnowLuma test\n');
  fs.writeFileSync(path.join(snowDir, 'package.json'), '{"version":"1.0.0"}\n');
  const snowV2 = path.join(temp, 'Snow Luma-v2.1.0');
  fs.mkdirSync(snowV2, { recursive: true });
  fs.writeFileSync(path.join(snowV2, 'launcher.bat'), '@echo off\necho SNOWLUMA_START_OK\nexit /b 0\n');
  fs.writeFileSync(path.join(snowV2, 'package.json'), '{"version":"2.1.0"}\n');
  const invalidSnow = path.join(temp, 'SnowLuma-broken');
  fs.mkdirSync(invalidSnow, { recursive: true });
  fs.writeFileSync(path.join(invalidSnow, 'package.json'), '{"version":"9.9.9"}\n');

  const appData = path.join(temp, 'App Data', 'Roaming');
  const npmBin = path.join(appData, 'npm');
  const dshPackage = path.join(npmBin, 'node_modules', '@deepseek-ai', 'dsh');
  const dshHome = path.join(temp, '.dsh');
  fs.mkdirSync(dshPackage, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshPackage, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"3.2.1","bin":{"dsh":"cli.js"}}\n');
  fs.writeFileSync(path.join(dshPackage, 'cli.js'), '#!/usr/bin/env node\n');
  const dshExecutable = path.join(npmBin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  fs.writeFileSync(dshExecutable, process.platform === 'win32'
    ? '@echo off\necho DSH_START_OK:%1\necho DSH_HOME_OK:%DSH_HOME%\nexit /b 0\n'
    : '#!/bin/sh\necho DSH_START_OK:$1\n');

  // 端口 9（discard）必然连不上：让这些用例与「开发机上是否真跑着服务」彻底解耦。
  const DEAD_CONFIG = { snowluma: { httpUrl: 'http://127.0.0.1:9' }, dsh: { baseUrl: 'http://127.0.0.1:9' } };
  const config = {
    snowluma: {
      homeDir: snowDir,
      launcherPath: path.join(snowDir, 'launcher.bat'),
      customPaths: [snowV2, invalidSnow],
      httpUrl: 'http://127.0.0.1:9'
    },
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
  check('检测本地 SnowLuma launcher.bat', initial.snowluma.installed === true && initial.snowluma.launcherPath.endsWith('launcher.bat'));
  check('SnowLuma 与 dsh 并行检测均完成', initial.snowluma.detection.status === 'complete' && initial.dsh.detection.status === 'complete');
  check('检测 dsh npm 全局可执行文件并读取版本', initial.dsh.installed === true && initial.dsh.version === '3.2.1' && path.resolve(initial.dsh.executable) === path.resolve(dshExecutable));
  check('支持 SnowLuma 多版本共存', initial.snowluma.installations.filter((item) => item.valid).length >= 2 && initial.snowluma.installations.some((item) => item.version === '2.1.0'));
  check('损坏安装被标记为无效', initial.snowluma.installations.some((item) => !item.valid && /缺少/.test(item.invalidReason)));
  const cached = await manager.detectAll();
  check('第二次检测命中毫秒级缓存层', cached.snowluma.detection.layer === 'cache' && cached.dsh.detection.layer === 'cache');
  const selectedV2 = initial.snowluma.installations.find((item) => item.valid && item.version === '2.1.0');
  const selected = await manager.selectSnowLuma({ id: selectedV2?.id });
  check('可选择多版本并持久化为当前版本', selected.selectedId === selectedV2?.id && selected.version === '2.1.0');
  if (process.platform === 'win32') {
    const snowStartedAt = Date.now();
    const snowStart = await manager.startSnowLuma({ waitMs: 5000 });
    check('Windows 可启动含空格路径的 SnowLuma 批处理入口', snowStart.logs.some((item) => item.text.includes('SNOWLUMA_START_OK')));
    check('SnowLuma 子进程退出后快速结束就绪等待', Date.now() - snowStartedAt < 4000);
    const dshStartedAt = Date.now();
    const dshStart = await manager.startDsh({ waitMs: 5000 });
    check('Windows 可启动 npm dsh.cmd 并正确传递 web 参数', dshStart.logs.some((item) => item.text.includes('DSH_START_OK:web')));
    check('dsh 启动显式传递所选 DSH_HOME', dshStart.logs.some((item) => item.text.includes(path.resolve(dshHome))));
    check('dsh 子进程退出后快速结束就绪等待', Date.now() - dshStartedAt < 4000);
  }
  check('SnowLuma 发布页固定为 GitHub latest', manager.getSnowLumaReleasePage() === SNOWLUMA_RELEASE_PAGE && /github\.com\/SnowLuma\/SnowLuma/.test(SNOWLUMA_RELEASE_PAGE));
  check('dsh 安装提示包含 Node.js 前置依赖', manager.getDshInstallHint() === DSH_INSTALL_HINT && /Node\.js/.test(DSH_INSTALL_HINT) && /npx @deepseek-ai\/dsh web/.test(DSH_INSTALL_HINT));

  const asset = pickSnowLumaReleaseAsset({ assets: [
    { name: 'SnowLuma-linux-x64.zip', browser_download_url: 'https://example.invalid/linux.zip' },
    { name: 'SnowLuma-v1-win-x64-lite.zip', browser_download_url: 'https://example.invalid/win-lite.zip' },
    { name: 'SnowLuma-v1-win-x64.zip', browser_download_url: 'https://example.invalid/win.zip' }
  ] });
  check('最新发布版优先选择 Windows x64 ZIP', asset?.name === 'SnowLuma-v1-win-x64.zip');
  check('没有 ZIP 资产时安全返回空', pickSnowLumaReleaseAsset({ assets: [{ name: 'SnowLuma.tar.gz' }] }) === null);

  const missingManager = createLocalServiceManager({
    root: path.join(temp, 'empty'),
    config: DEAD_CONFIG,
    detectionOptions: { userHome: path.join(temp, 'empty-user'), fullScanRoots: [], environment: { PATH: '' } }
  });
  const missing = await missingManager.detectAll();
  check('缺少 SnowLuma 时不抛错并标记未安装', missing.snowluma.installed === false && missing.snowluma.status === 'not-installed');

  // ── 就绪状态校正：外部已启动的服务不能被显示成“未运行” ──────────────────
  const http = await import('node:http');
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));
  // 模拟 dsh web：根路径返回 401（真实 dsh 需要控制台令牌，也算“已监听”）
  const fakeDsh = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); });
  await listen(fakeDsh);
  // 模拟 SnowLuma OneBot HTTP API
  const fakeSnow = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no api'); });
  await listen(fakeSnow);
  const readyManager = createLocalServiceManager({
    root: path.join(temp, 'ready-root'),
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:' + fakeDsh.address().port },
      snowluma: { httpUrl: 'http://127.0.0.1:' + fakeSnow.address().port, homeDir: snowDir, launcherPath: path.join(snowDir, 'launcher.bat') }
    },
    detectionOptions: { userHome: temp, fullScanRoots: [], environment: { PATH: '', APPDATA: path.join(temp, 'no-appdata'), LOCALAPPDATA: '' } }
  });
  await readyManager.detectAll();
  const readySnapshot = readyManager.snapshot();
  check('外部已运行的 dsh 被判为 ready（401 也算已监听）', readySnapshot.dsh.ready === true && readySnapshot.dsh.running === true, 'status=' + readySnapshot.dsh.status);
  check('外部已运行的 SnowLuma 被判为 ready', readySnapshot.snowluma.ready === true && readySnapshot.snowluma.running === true, 'status=' + readySnapshot.snowluma.status);
  check('外部实例标记为非托管（不重复拉起、不显示停止按钮）', readySnapshot.dsh.managed === false && readySnapshot.snowluma.managed === false);
  await closeServer(fakeDsh);
  await closeServer(fakeSnow);
  await readyManager.reconcileReadiness({ force: true });
  const downSnapshot = readyManager.snapshot();
  check('外部服务停止后状态回落为未运行', downSnapshot.dsh.ready === false && downSnapshot.dsh.running === false && downSnapshot.snowluma.ready === false);

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

  // ── 服务管理边界：只负责本地进程与 OneBot/DSH API，不负责打开网页 ──────
  const managerMethods = Object.keys(manager);
  check('管理器保留服务检测、版本选择及进程生命周期 API',
    ['detectAll', 'snapshot', 'selectSnowLuma', 'selectDsh', 'startSnowLuma', 'stopSnowLuma', 'startDsh', 'stopDsh'].every((name) => managerMethods.includes(name)));
  check('管理器不暴露浏览器、应用窗口或网页 URL 打开入口',
    !managerMethods.some((name) => /open.*(?:web|monitor|window|browser)|resolveSnowLumaWebUrl/i.test(name)));
  const snapshot = manager.snapshot();
  check('服务快照不携带 SnowLuma / DSH 网页入口地址',
    !Object.hasOwn(snapshot.snowluma, 'webUrl') && !Object.hasOwn(snapshot.dsh, 'webUrl'));

  const bridgeSource = fs.readFileSync(path.join(scriptDir, '..', 'src', 'bridge.js'), 'utf8');
  const managerSource = fs.readFileSync(path.join(scriptDir, '..', 'src', 'local-services.js'), 'utf8');
  check('SnowLuma 与 dsh 使用同一并行调度批次', managerSource.includes('Promise.allSettled([') && managerSource.includes('timed(() => detectSnowLuma(force))') && managerSource.includes('timed(() => detectDshInstallations(force))'));
  check('检测采用缓存、优先路径、全量扫描三层策略', managerSource.includes("layer: 'cache'") && managerSource.includes("layer: 'priority'") && managerSource.includes("layer: 'full-scan'"));
  check('管理器提供就绪校正（外部服务不被显示成未运行）', managerSource.includes('reconcileReadiness') && managerSource.includes('applyReadiness') && managerSource.includes('probeDshUrl'));
  check('SnowLuma 就绪状态基于 OneBot HTTP/WebSocket 端点，而非 WebUI 端口', managerSource.includes('snowLumaHttpUrl()') && managerSource.includes('snowLumaWsUrl()') && managerSource.includes('probeUrl(snowLumaHttpUrl()') && managerSource.includes('probeTcp(snowLumaWsUrl())'));
  check('桥接端点暴露本地服务状态与 SSE', bridgeSource.includes("url.pathname === '/api/services'") && bridgeSource.includes("url.pathname === '/api/services/stream'"));
  check('桥接端点支持后台重检和版本选择', bridgeSource.includes("url.pathname === '/api/services/detect'") && bridgeSource.includes("url.pathname === '/api/services/snowluma/select'") && bridgeSource.includes("url.pathname === '/api/services/dsh/select'"));
  check('桥接不再暴露 SnowLuma / DSH 的浏览器打开接口',
    !bridgeSource.includes("url.pathname === '/api/services/snowluma/open'") && !bridgeSource.includes("url.pathname === '/api/services/dsh/open'"));
  check('桥接不再提供 HTML 监控页或网页内容类型',
    !bridgeSource.includes("url.pathname === '/dsh-monitor.html'") && !bridgeSource.includes('text/html'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
// 用 exitCode 而不是 process.exit：后者会在仍有活动句柄时中断事件循环，
// 在 Windows 上表现为 libuv 的 !(handle->flags & UV_HANDLE_CLOSING) 断言崩溃。
if (failed) process.exitCode = 1;
