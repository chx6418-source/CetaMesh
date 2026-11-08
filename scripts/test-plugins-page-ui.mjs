// The production fact components must render observed/current evidence and retain
// an explicit unknown fallback; dropping these components catches lost DTO facts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
const requireUi = createRequire(new URL('../desktop-ui/package.json', import.meta.url));
const { build } = requireUi('esbuild');
const result = await build({ entryPoints: [fileURLToPath(new URL('../desktop-ui/src/app/PluginsPage.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' } });
const module = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: requireUi, window: {}, console, setTimeout, clearTimeout });
assert.equal(typeof module.exports.PluginRuntimeFacts, 'function', 'Plugin detail must consume lifecycle evidence instead of fixed unverified copy');
assert.equal(typeof module.exports.McpRuntimeFacts, 'function', 'MCP detail must consume lifecycle evidence');
const React = requireUi('react');
const { renderToStaticMarkup } = requireUi('react-dom/server');
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const settingsApplication = { support: 'restart-and-ack', status: 'applied', generation: 8, effectiveGeneration: 8,
  desiredRevision: 'a'.repeat(64), effectiveRevision: 'a'.repeat(64), secretConsumption: 'unsupported', errorCode: null };
const appliedSettings = render(module.exports.ExtensionSettingsFacts, { application: settingsApplication });
assert.match(appliedSettings, /公开设置已由当前宿主确认/);
assert.match(appliedSettings, /当前不支持插件消费秘密字段/);
assert.match(appliedSettings, /内容相同则保留当前宿主/);
const failedSettings = render(module.exports.ExtensionSettingsFacts, { application: { ...settingsApplication,
  status: 'needs-reconciliation', generation: 9, errorCode: 'EXTENSION_SETTINGS_ACK_TIMEOUT' } });
assert.match(failedSettings, /应用失败/);
assert.match(failedSettings, /EXTENSION_SETTINGS_ACK_TIMEOUT/);
assert.doesNotMatch(failedSettings, /公开设置已由当前宿主确认/);
assert.match(render(module.exports.ExtensionSettingsFacts, {}), /尚无设置生效证据/);
assert.doesNotMatch(render(module.exports.ExtensionSettingsFacts, { application: settingsApplication, enabled: false }), /公开设置已由当前宿主确认/);
assert.doesNotMatch(render(module.exports.ExtensionSettingsFacts, { application: settingsApplication, runtimeGeneration: 9 }), /公开设置已由当前宿主确认/);
const receiptCases = [
  ['revision mismatch', { ...settingsApplication, effectiveRevision: 'b'.repeat(64) }],
  ['internal generation mismatch', { ...settingsApplication, generation: 9 }],
  ['missing receipt', { ...settingsApplication, effectiveRevision: null, effectiveGeneration: null, generation: null }],
  ['unsupported applied', { ...settingsApplication, support: 'unsupported' }],
  ['missing desired revision', { ...settingsApplication, desiredRevision: null }],
  ['invalid matching revisions', { ...settingsApplication, desiredRevision: 'invalid', effectiveRevision: 'invalid' }],
  ['zero generation', { ...settingsApplication, generation: 0, effectiveGeneration: 0 }],
  ['unsafe generation', { ...settingsApplication, generation: Number.MAX_SAFE_INTEGER + 1, effectiveGeneration: Number.MAX_SAFE_INTEGER + 1 }],
  ['negative generation', { ...settingsApplication, generation: -1, effectiveGeneration: -1 }]
];
const receiptFailures = [];
for (const [name, application] of [...receiptCases, ['valid', settingsApplication]]) {
  const ui = createDesktopUiService({ services: { extensionService: {
    execute: async ({ method }) => method === 'ext.settings.describe' ? { fields: [] }
      : { id: 'test.settings-receipt', values: {}, application }
  } } });
  const shouldBeApplied = name === 'valid';
  for (const method of ['ui.extensions.settings.get', 'ui.extensions.settings.update']) {
    const projected = await ui.execute({ method, params: { id: 'test.settings-receipt', values: {} } });
    if ((projected.application.status === 'applied') !== shouldBeApplied) receiptFailures.push(name + ': ' + method + ' DTO');
    const markup = render(module.exports.ExtensionSettingsFacts, { application: projected.application, enabled: true, runtimeGeneration: 8 });
    if (markup.includes('公开设置已由当前宿主确认') !== shouldBeApplied) receiptFailures.push(name + ': ' + method + ' projected SSR');
  }
  if (render(module.exports.ExtensionSettingsFacts, { application }).includes('公开设置已由当前宿主确认') !== shouldBeApplied)
    receiptFailures.push(name + ': direct SSR');
}
for (const [name, currentFacts] of [['unknown catalog generation', { runtimeGeneration: null }],
  ['invalid catalog generation', { runtimeGeneration: Number.NaN }], ['zero catalog generation', { runtimeGeneration: 0 }],
  ['disabled catalog', { enabled: false }]]) {
  if (render(module.exports.ExtensionSettingsFacts, { application: settingsApplication, ...currentFacts }).includes('公开设置已由当前宿主确认'))
    receiptFailures.push(name + ': catalog SSR');
}
assert.deepEqual(receiptFailures, [], 'Only a complete matching current configuration receipt may be presented as applied');
const availability = { installed: true, enabled: true, loaded: false, runtime: { state: 'stopped', generation: 4 },
  connection: 'not-applicable', authentication: 'not-applicable', discoveredCapabilities: ['content.read'],
  lastCall: { capability: 'content.read', status: 'completed', generation: 4, current: true }, error: null };
const content = render(module.exports.PluginRuntimeFacts, { availability });
assert.match(content, /内容能力/);
assert.match(content, /不适用/);
assert.match(content, /本代次/);
assert.match(content, /成功/);
assert.doesNotMatch(content, /运行状态未验证/);
const stale = render(module.exports.PluginRuntimeFacts, { availability: { ...availability, loaded: true,
  runtime: { state: 'stopping', generation: 5 }, lastCall: { ...availability.lastCall, current: false },
  error: { code: 'EXTENSION_STOP_UNCONFIRMED', stage: 'stop' } } });
assert.match(stale, /停止尚未确认/);
assert.match(stale, /历史记录/);
assert.match(stale, /EXTENSION_STOP_UNCONFIRMED/);
const unknown = render(module.exports.PluginRuntimeFacts, {});
assert.match(unknown, /运行状态未验证/);
const mcp = render(module.exports.McpRuntimeFacts, { server: { connection: 'connected', authentication: 'unknown',
  generation: 2, configurationCurrent: true, discovery: { status: 'observed', toolCount: 1 },
  readiness: { state: 'ready', evidence: 'initialize-and-tool-discovery' }, lastCall: { capability: 'echo', generation: 2, current: true, status: 'completed' } } });
assert.match(mcp, /已连接/);
assert.match(mcp, /认证：未知/);
assert.match(mcp, /当前配置/);
assert.match(mcp, /echo/);
const richServer = { id: 'fixture-rich-mcp', name: 'Rich MCP fixture', status: 'running', runtimeStatus: 'running',
  enabled: true, running: true, available: true, toolCallable: true, eligible: true, configured: true,
  source: 'external', transport: 'stdio', reason: null, lastError: null, toolCount: 1, discoveredToolCount: 1,
  generation: 7, connection: 'connected', authentication: 'authenticated',
  configurationRevision: 'a'.repeat(64), liveConfigurationRevision: 'a'.repeat(64), configurationCurrent: true,
  discovery: { status: 'observed', toolCount: 1 }, readiness: { state: 'ready', evidence: 'initialize-and-tool-discovery' },
  lastCall: { capability: 'echo', status: 'completed', generation: 7, current: true,
    startedAt: 10, completedAt: 20, code: null, effectStatus: null } };
const currentMcp = render(module.exports.McpRuntimeFacts, { server: richServer });
assert.match(currentMcp, /连接：已连接/);
assert.match(currentMcp, /认证：已认证/);
assert.match(currentMcp, /当前配置：已生效/);
assert.match(currentMcp, /本代次/);
assert.equal(typeof module.exports.invalidateMcpObservation, 'function', 'both failed-refresh and missing-row fallbacks need lifecycle evidence invalidation');
for (const reason of ['CHECK_FAILED', 'not-checked']) {
  const invalidated = module.exports.invalidateMcpObservation(richServer, reason);
  assert.equal(invalidated.reason, reason);
  assert.equal(invalidated.running, false);
  assert.equal(invalidated.toolCallable, false);
  assert.equal(invalidated.runtimeStatus, 'unknown', 'observation failure cannot certify process exit');
  assert.equal(invalidated.connection, 'unknown', 'observation failure cannot fabricate disconnection');
  assert.equal(invalidated.authentication, 'unknown');
  assert.equal(invalidated.configurationCurrent, null);
  assert.equal(invalidated.discovery.status, 'unknown');
  assert.equal(invalidated.discovery.toolCount, null);
  assert.equal(invalidated.lastCall.current, false);
  assert.equal(invalidated.lastCall.generation, 7, 'prior-call attribution is retained');
  assert.equal(invalidated.lastCall.status, 'completed', 'prior success remains historical evidence');
  const historicalMcp = render(module.exports.McpRuntimeFacts, { server: invalidated });
  assert.match(historicalMcp, /连接：未知/);
  assert.match(historicalMcp, /认证：未知/);
  assert.match(historicalMcp, /当前配置：未知/);
  assert.match(historicalMcp, /发现：未知/);
  assert.match(historicalMcp, /成功/);
  assert.match(historicalMcp, /历史记录/);
  assert.doesNotMatch(historicalMcp, /连接：已连接|认证：已认证|当前配置：已生效|本代次|已停止|连接：未连接/);
}
console.log('PASS production React Plugin/MCP lifecycle evidence rendering (SSR; no native claim)');

// Exercise the real Plugins page with synthetic IPC replies and no runtime execution.
process.env.CETAMESH_GLOBAL_UI_PLUGIN_RACE_ONLY = '1';
for (const name of ['CETAMESH_GLOBAL_UI_BASELINE_DIR', 'CETAMESH_GLOBAL_UI_BASELINE_ONLY', 'CETAMESH_GLOBAL_UI_AGENT_ONLY', 'CETAMESH_GLOBAL_UI_PLUGIN_ONLY', 'CETAMESH_GLOBAL_UI_AGENT_RACE_ONLY', 'CETAMESH_GLOBAL_UI_HOST_SYNC_ONLY', 'CETAMESH_GLOBAL_UI_BEHAVIOR_ONLY', 'CETAMESH_GLOBAL_UI_EVIDENCE_DIR']) delete process.env[name];
if (process.env.CETAMESH_PLUGINS_PAGE_EVIDENCE_DIR) process.env.CETAMESH_GLOBAL_UI_EVIDENCE_DIR = process.env.CETAMESH_PLUGINS_PAGE_EVIDENCE_DIR;
await import('./test-global-ui-productization.mjs');
