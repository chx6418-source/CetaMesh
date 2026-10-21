import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDshDesktopIntegration, DSH_OFFICIAL_DOWNLOAD_URL, parseDshVersion } from '../src/integrations/dsh-desktop.js';
import { createIntegrationService } from '../src/integrations/service.js';
import { createSettingsService } from '../src/settings/service.js';
import { createChatService } from '../src/desktop/chat-service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];
function tempDir(prefix) {
  const value = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || '.', prefix));
  tempDirs.push(value);
  return value;
}
let passed = 0;
function ok(name) { passed += 1; console.log('PASS ' + name); }

function makeDesktop(overrides = {}) {
  const calls = { discover: 0, running: 0, cli: 0, launch: [] };
  const suppliedDiscovery = overrides.discoverDesktop ?? (async () => null);
  const options = {
    platform: 'win32',
    now: () => 1_800_000_000_000,
    discoverDesktop: async () => null,
    isRunning: async () => { calls.running += 1; return false; },
    discoverCli: async () => { calls.cli += 1; return null; },
    pathExists: async () => true,
    launchExecutable: async executablePath => { calls.launch.push(executablePath); return { started: true }; },
    ...overrides
  };
  options.discoverDesktop = async () => {
    calls.discover += 1;
    const result = await suppliedDiscovery();
    return result && result.installed === undefined && result.executablePath
      ? { ...result, installed: true }
      : result;
  };
  const desktop = createDshDesktopIntegration(options);
  return { desktop, calls };
}

{
  const { desktop, calls } = makeDesktop();
  const state = await desktop.status();
  assert.equal(state.status, 'not_installed');
  assert.equal(state.installed, false);
  assert.equal(state.running, false);
  assert.equal(state.cli.available, false);
  assert.equal((await desktop.open()).opened, false);
  assert.equal(calls.launch.length, 0);
  ok('未安装 Desktop 和未安装 CLI 都以可用状态结构优雅返回');
}

{
  const { desktop, calls } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', version: '0.2.0-rc.2', source: 'uninstall-registry' }),
    discoverCli: async () => { calls.cli += 1; return { available: true, executablePath: 'C:\\Users\\test\\npm\\dsh.cmd', version: '0.1.5-rc.1' }; }
  });
  const state = await desktop.status();
  assert.equal(state.status, 'installed');
  assert.equal(state.version, '0.2.0-rc.2');
  assert.equal(state.installed, true);
  assert.equal(state.running, false);
  assert.deepEqual(state.cli, { available: true, executablePath: 'C:\\Users\\test\\npm\\dsh.cmd', version: '0.1.5-rc.1', diagnosticsError: null });
  assert.equal(calls.discover, 1);
  assert.equal(calls.cli, 1);
  assert.equal((await desktop.status()).lastCheckedAt, state.lastCheckedAt);
  assert.equal(calls.discover, 1, 'repeated status reads use the short-lived cache');
  ok('安装状态、版本和 CLI 信息读取且受短期缓存保护');
}

{
  const { desktop, calls } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', version: '0.2.0-rc.2', source: 'app-paths' }),
    isRunning: async () => true
  });
  const result = await desktop.open();
  assert.equal(result.action, 'already_running');
  assert.equal(result.opened, true);
  assert.equal(calls.launch.length, 0, 'must not start a second process');
  ok('应用已运行时不重复启动');
}

{
  const target = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
  const { desktop, calls } = makeDesktop({
    discoverDesktop: async () => ({ installed: true, executablePath: target, version: '0.2.0-rc.2', source: 'app-paths' })
  });
  const result = await desktop.open();
  assert.equal(result.action, 'launched');
  assert.equal(result.opened, true);
  assert.deepEqual(calls.launch, [target]);
  ok('未运行时只把发现的可执行文件路径交给直接启动器');
}

{
  const { desktop, calls } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: 'C:\\missing\\DeepSeek Harness.exe', version: '0.2.0-rc.2', source: 'uninstall-registry' }),
    pathExists: async () => false
  });
  const state = await desktop.status({ refresh: true });
  assert.equal(state.status, 'unavailable');
  assert.equal(state.installed, true, 'registration and executable presence are reported separately');
  assert.equal(state.lastError, 'EXECUTABLE_MISSING');
  assert.equal(state.running, false);
  const result = await desktop.open();
  assert.equal(result.opened, false);
  assert.equal(calls.launch.length, 0);
  ok('注册残留但可执行文件缺失时优雅降级');
}

{
  const { desktop, calls } = makeDesktop({
    discoverDesktop: async () => { throw new Error('registry query failed'); }
  });
  const first = await desktop.status();
  assert.equal(first.status, 'unavailable');
  assert.equal(first.lastError, 'DETECTION_FAILED', 'ordinary status does not expose raw diagnostics');
  assert.ok(first.diagnostics.lastError.includes('registry query failed'));
  assert.equal(calls.discover, 1);
  await desktop.refresh();
  assert.equal(calls.discover, 2, 'explicit refresh forces a new probe');
  ok('检测异常只进入 diagnostics，显式刷新才重新探测');
}

{
  const { desktop } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', version: '0.2.0-rc.2', source: 'app-paths' }),
    launchExecutable: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); }
  });
  const result = await desktop.open();
  assert.equal(result.opened, false);
  assert.match(result.message, /无法启动 DeepSeek Harness/);
  assert.doesNotMatch(result.message, /ENOENT/);
  assert.match(result.diagnostics.lastError, /ENOENT/);
  ok('启动失败给出产品文案并保留底层诊断');
}

{
  const { desktop } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', version: '0.2.0-rc.2', source: 'app-paths' })
  });
  const settings = await desktop.settings({
    agentEnabled: true,
    agentHealth: { available: false, reason: 'not_installed' },
    workspaceBoundary: 'capability-broker'
  });
  assert.equal(settings.desktop.installed, true);
  assert.equal(settings.agent.available, false);
  assert.equal(settings.agent.enabled, true);
  assert.equal(settings.workspaceMode, 'capability-broker');
  assert.equal(settings.continuity.runtime, 'CetaMesh Continuity Runtime');
  assert.equal(settings.advanced.cli.available, false);
  assert.equal(DSH_OFFICIAL_DOWNLOAD_URL, 'https://www.deepseek.com/en/download/');
  ok('设置数据模型保留 Desktop / Agent / Workspace / Continuity 独立字段与官方下载入口');
}

{
  const availableAgent = await createIntegrationService({
    stateDir: tempDir('cetamesh-dsh-desktop-agent-ready-'),
    dshDesktop: makeDesktop({ discoverDesktop: async () => null }).desktop,
    providerSnapshot: () => ({ agent: ['dsh'], channel: [] }),
    agentHealth: async () => ({ provider: 'dsh', available: true, reason: null })
  });
  const noDesktop = await availableAgent.execute({ method: 'integrations.get', params: { id: 'cetamesh-dsh' } });
  assert.equal(noDesktop.integrationDescriptor.installed, false);
  assert.equal(noDesktop.integrationDescriptor.agentAvailable, true);
  assert.equal(noDesktop.desktopApp.installed, false);
  await availableAgent.close();

  const unavailableAgent = await createIntegrationService({
    stateDir: tempDir('cetamesh-dsh-desktop-agent-down-'),
    dshDesktop: makeDesktop({
      discoverDesktop: async () => ({ executablePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', version: '0.2.0-rc.2', source: 'uninstall-registry' })
    }).desktop,
    providerSnapshot: () => ({ agent: [], channel: [] }),
    agentHealth: async () => ({ provider: 'dsh', available: false, reason: 'not_installed' })
  });
  const installedButUnavailable = await unavailableAgent.execute({ method: 'integrations.get', params: { id: 'cetamesh-dsh' } });
  assert.equal(installedButUnavailable.integrationDescriptor.installed, true);
  assert.equal(installedButUnavailable.integrationDescriptor.agentAvailable, false);
  assert.equal(installedButUnavailable.desktopApp.installed, true);
  assert.equal(installedButUnavailable.agentIntegration.available, false);
  const settings = await unavailableAgent.execute({ method: 'integrations.dshDesktop.settings' });
  assert.equal(settings.settings.agent.available, false);
  assert.equal(settings.settings.agent.health, 'unavailable');
  await unavailableAgent.close();
  ok('Desktop 与 Agent 可分别处于缺失/就绪和已安装/不可用状态，并可查询二级设置数据');
}

{
  assert.equal(parseDshVersion('DeepSeek Harness 0.2.0-rc.2'), '0.2.0-rc.2');
  assert.equal(parseDshVersion('unknown build'), null);
  const { desktop } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', version: '1.0.0', source: 'app-paths' }),
    isSupportedVersion: version => version === '0.2.0-rc.2'
  });
  const state = await desktop.status();
  assert.equal(state.status, 'unsupported_version');
  assert.equal(state.installed, true);
  assert.equal((await desktop.open()).action, 'launched', 'an unverified version remains openable');
  ok('Desktop 版本解析与未验证版本提示不会阻止用户打开应用');
}

{
  const stateDir = tempDir('cetamesh-dsh-default-agent-setting-');
  const settings = createSettingsService({ stateDir });
  const chat = createChatService({
    stateDir,
    agentProviders: [{ id: 'dsh', eventProtocol: 'dsh-session-events' }],
    defaultAgentProvider: () => settings.store.get().settings.agents.defaultAgentProvider
  });
  const first = await chat.execute({ method: 'chat.sessions.create', params: {} });
  assert.equal(first.config.agentProvider, null);
  await settings.execute({ method: 'settings.update', params: { section: 'agents', values: { defaultAgentProvider: 'dsh' } } });
  const next = await chat.execute({ method: 'chat.sessions.create', params: {} });
  assert.equal(next.config.agentProvider, 'dsh');
  await settings.execute({ method: 'settings.update', params: { section: 'agents', values: { defaultAgentProvider: 'auto' } } });
  const automatic = await chat.execute({ method: 'chat.sessions.create', params: {} });
  assert.equal(automatic.config.agentProvider, null);
  ok('agents.defaultAgentProvider 经 SettingsStore 持久化并作用于后续新会话');
}

{
  let running = false;
  const target = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
  const { desktop, calls } = makeDesktop({
    discoverDesktop: async () => ({ executablePath: target, version: '0.2.0-rc.2', source: 'app-paths' }),
    isRunning: async () => running,
    launchExecutable: async executablePath => {
      calls.launch.push(executablePath);
      running = true;
      return { started: true };
    }
  });
  await Promise.all([desktop.open(), desktop.open()]);
  await desktop.open();
  assert.equal(calls.launch.length, 1, 'repeated and concurrent open actions must not spawn another process');
  ok('Concurrent and repeated open actions do not duplicate the Desktop process');
}

{
  const adapter = fs.readFileSync(path.join(ROOT, 'src/integrations/dsh-desktop.js'), 'utf8');
  assert.doesNotMatch(adapter, /(?:127\.0\.0\.1|localhost):19387/i);
  assert.doesNotMatch(adapter, /(?:\.credentials|session[_-]?cookie|host[_-]?token|readFileSync\([^)]*(?:cookie|credential|auth))/i);
  assert.doesNotMatch(adapter, /DevTools|debugging.?port|renderer.?injection|electron.?private.?state/i);
  assert.doesNotMatch(adapter, /cmd\.exe|powershell\.exe|cmd\s*\/c|Start-Process/i);
  assert.match(adapter, /nodeSpawn\(/);
  assert.match(adapter, /shell:\s*false/);
  assert.match(adapter, /minimalChildEnvironment/);
  ok('集成适配器无私有 Host、认证状态读取或 UI 自动化依赖，且使用直接无 Shell 启动');
}

if (process.platform === 'win32') {
  const detected = await createDshDesktopIntegration().refresh();
  assert.ok(['not_installed', 'installed', 'running', 'unavailable', 'unsupported_version'].includes(detected.status));
  console.log(`ENV DSH Desktop: status=${detected.status} installed=${detected.installed} running=${detected.running} version=${detected.version ?? 'unknown'} cli=${detected.cli.available ? detected.cli.version ?? 'version-unknown' : 'not-installed'}`);
}

console.log(`\nDSH Desktop integration: ${passed} PASS`);
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
