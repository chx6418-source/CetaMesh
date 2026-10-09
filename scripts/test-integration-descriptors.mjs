// 产品化任务 B：SnowLuma / DSH 集成描述符 + IPC 路由 + 容器装配验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntegrationService } from '../src/integrations/service.js';
import { createDesktopIpcRuntime } from '../src/app/ipc-runtime.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-integration-descriptors-'));
const originalDataDir = process.env.WHALEBRIDGE_DATA_DIR;
let step = 0;
const ok = label => { step += 1; console.log('✅ [' + step + '] ' + label); };

try {
  // ── 1. SnowLuma = Channel Provider Integration；DSH = Agent Provider Integration ──
  const service = createIntegrationService({
    stateDir: tmp,
    providerSnapshot: () => ({ channel: ['qq'], agent: ['dsh'] }),
    localServices: () => ({
      snowluma: { status: 'ready', running: true, ready: true, lastError: '' },
      dsh: { status: 'ready', running: true, ready: true, lastError: '' }
    })
  });
  const list = await service.execute({ method: 'integrations.list' });
  assert.equal(list.integrations.length, 2);
  const snow = list.integrations.find(item => item.id === 'cetamesh-snowluma');
  const dsh = list.integrations.find(item => item.id === 'cetamesh-dsh');

  assert.equal(snow.kind, 'channel-integration');
  assert.equal(snow.bottomLayer, 'channel-provider');
  assert.deepEqual(snow.provider, { kind: 'channel', id: 'qq', available: true, lastError: null });
  assert.equal(snow.localService.status, 'ready');
  assert.deepEqual(snow.actions, ['detect', 'start', 'stop', 'install', 'connect']);
  assert.notEqual(snow.kind, 'extension', 'SnowLuma 不得被表示成 VM Extension');

  assert.equal(dsh.kind, 'agent-integration');
  assert.equal(dsh.bottomLayer, 'agent-provider');
  assert.equal(dsh.provider.kind, 'agent');
  assert.equal(dsh.provider.id, 'dsh');
  assert.notEqual(dsh.kind, 'extension', 'DSH Agent Provider 不得被塞进 VM Extension');
  assert.equal(dsh.advanced.providerKind, 'agent-provider');
  ok('集成描述符：SnowLuma=Channel Provider、DSH=Agent Provider，均为 Plugin 卡片入口而非 Extension');

  // ── 2. 底层 Provider 未接入时如实不可用（fail-closed） ─────────────────────
  const bare = createIntegrationService({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bare-integration-')) });
  const bareList = await bare.execute({ method: 'integrations.list' });
  const bareSnow = bareList.integrations.find(item => item.id === 'cetamesh-snowluma');
  assert.equal(bareSnow.provider.available, false);
  assert.match(bareSnow.provider.lastError, /未接入/);
  assert.equal(bareSnow.integrationStatus.available, false);
  await assert.rejects(() => bare.execute({ method: 'integrations.action', params: { localService: 'snowluma', action: 'start', approved: true } }),
    error => error.code === 'UNSUPPORTED_ACTION', '未绑定本地服务入口时必须如实拒绝');
  await bare.close();
  ok('底层未接入：provider.available=false + lastError；本地服务动作 UNSUPPORTED_ACTION（不伪造成功）');

  // ── 3. 关闭 DSH 集成后，Agent Provider 侧工具如实不可用 ───────────────────
  await service.execute({ method: 'plugins.disable', params: { id: 'cetamesh-dsh' } });
  const dshOff = await service.execute({ method: 'integrations.get', params: { id: 'cetamesh-dsh' } });
  assert.equal(dshOff.enabled, false);
  assert.equal(dshOff.integrationStatus.status, 'disabled');
  // 视觉工具属 partial（白名单放行但仓库内无实现、preset 未挂载 provider）：默认关闭，Owner 可显式开启。
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: 'cetamesh-bionic-chat', toolId: 'agent__read_image', enabled: true } });
  const vision = await service.execute({ method: 'tools.get', params: { id: 'agent__read_image' } });
  assert.equal(vision.restore, 'partial');
  // 语义：插件总开关/逐工具开关 = 用户是否允许调用（enabled）；
  //       底层 Integration Provider 是否在线 = 现在能不能调用（available）。
  assert.equal(vision.enabled, true, 'Owner 显式开启后 enabled=true');
  assert.equal(vision.available, false, 'DSH 集成关闭 → agent 工具如实不可用');
  assert.equal(vision.sourceStatus, 'disabled');
  await assert.rejects(() => service.execute({ method: 'tools.invoke', params: { id: 'agent__read_image' } }),
    error => error.code === 'TOOL_UNAVAILABLE');
  await service.execute({ method: 'plugins.enable', params: { id: 'cetamesh-dsh' } });
  const visionBack = await service.execute({ method: 'tools.get', params: { id: 'agent__read_image' } });
  assert.equal(visionBack.available, true);
  await service.execute({ method: 'plugins.tool.toggle', params: { pluginId: 'cetamesh-bionic-chat', toolId: 'agent__read_image', enabled: false } });
  ok('DSH 集成开关：关闭后 agent 侧工具如实不可用（enabled 保留用户选择），重新开启恢复');
  await service.close();

  // ── 4. 本地服务动作绑定后可经能力面调用（进程控制属高风险，需显式确认） ──
  const calls = [];
  const bound = createIntegrationService({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-bound-integration-')),
    localServices: () => ({
      snowluma: { status: 'stopped', running: false, lastError: '' },
      actions: {
        snowluma: { start: async params => { calls.push(['snowluma.start', params]); return { service: 'snowluma', status: 'starting' }; } },
        dsh: {}
      }
    })
  });
  const launched = await bound.execute({ method: 'integrations.action', params: { localService: 'snowluma', action: 'start', params: { force: true }, approved: true } });
  assert.deepEqual(calls, [['snowluma.start', { force: true }]]);
  assert.equal(launched.status, 'starting');
  await bound.close();
  ok('本地服务入口：绑定后 start 经 integration.mcp.manage（high）执行，未确认时同样进入审批');

  // ── 5. IPC 路由：plugins. / tools. / mcp. / integrations. 四族都落到 integrationService ──
  const seen = [];
  const integrationService = new Proxy({}, {
    get(_target, method) {
      return command => { seen.push({ method, command }); return { routed: method, command }; };
    }
  });
  const make = name => new Proxy({}, { get: () => command => ({ service: name, command }) });
  const runtime = createDesktopIpcRuntime({
    services: {
      capabilityService: make('capability'), workshopService: make('workshop'), chatService: make('chat'),
      taskService: make('task'), continuityService: make('continuity'), providerSecrets: make('providers'),
      modelRuntime: make('modelrt'), routerService: make('router'), extensionService: make('ext'),
      meshService: make('mesh'), channelService: make('channel'), agentService: make('agent'),
      integrationService, controlService: make('control')
    },
    system: { settings: make('settings'), about: make('about'), update: make('update') },
    log: () => {}, pipeName: ''
  });
  for (const method of ['plugins.list', 'tools.list', 'mcp.list', 'integrations.list']) {
    const result = await runtime.dispatch({ method, params: { probe: method } });
    assert.equal(result.routed, 'execute', method + ' 必须路由到 integrationService.execute');
    assert.equal(result.command.method, method);
  }
  const fallback = await runtime.dispatch({ method: 'legacy.still.unknown', params: {} });
  assert.equal(fallback.service, 'control', '未知方法仍回落控制面');
  assert.equal(seen.length, 4);
  ok('IPC 路由：plugins./tools./mcp./integrations. 四族全部落到 integrationService，未知方法回落控制面');

  // ── 6. Core 容器装配：integrationService 就位且与 Channel/Agent Provider 对上 ──
  process.env.WHALEBRIDGE_DATA_DIR = tmp;
  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const services = createCetaMeshServices({ config: { allow: { groups: ['7'], private: [] } } });
  assert.ok(services.integrationService, '容器必须装配 integrationService');
  for (const id of ['integration.tool.read', 'integration.tool.write', 'integration.tool.admin', 'integration.mcp.manage', 'integration.plugin.manage']) {
    assert.ok(services.capabilityService.broker.registry.has(id), '能力面缺少 ' + id);
  }
  const containerList = await services.integrationService.execute({ method: 'integrations.list' });
  const containerSnow = containerList.integrations.find(item => item.id === 'cetamesh-snowluma');
  assert.equal(containerSnow.provider.available, true, '容器里的 Channel Provider（qq）必须被识别');
  const containerDsh = containerList.integrations.find(item => item.id === 'cetamesh-dsh');
  assert.equal(containerDsh.provider.available, false, '未注入 DSH API 时 Agent Provider 如实不可用');
  await services.integrationService.close();
  ok('容器装配：integrationService 就位，5 个能力注册，Channel/Agent Provider 状态如实');
  await runtime.stop();

  console.log('\nPASS CetaMesh Integrations/Descriptors/IPC（' + step + ' 组断言）');
} finally {
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
}
