// CetaMesh Desktop — Extension v1 验收测试（阶段 10）。
// 用法：node scripts/test-extension-runtime.mjs
//
// 验收：两个测试 Extension（无敏感权限的 Tool / 需要明确 Permission 的扩展）的
//       安装 -> 启用 -> 调用 -> 禁用 -> 卸载 全链路。
// 安全：禁止权限、未批准的高风险权限、review token 不一致、权限提升、
//       源码静态预检、vm 上下文遏制、网络主机白名单。
//
// 只用隔离临时目录；网络用注入的假 fetch，不产生真实请求。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createExtensionRuntime,
  createExtensionService,
  createExtensionStore,
  createExtensionHost,
  createProcessExtensionHost,
  createInProcessTransportPair,
  scanEntrySource,
  validateManifest,
  buildReview,
  reviewSummaryLines,
  manifestFingerprint
} from '../src/extension/index.js';
import { readJsonFile, writeJsonAtomic } from '../src/storage/json-file.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { startIpcProtocol, IPC_PROTOCOL_VERSION } from '../src/control/ipc-protocol.js';
import { createCapabilityBroker } from '../src/capability/index.js';

let passed = 0;
let failed = 0;
const runtimeCleanups = [];
const check = (name, condition, extra = '') => {
  if (condition) { passed += 1; console.log('PASS ' + name + (extra ? ' — ' + extra : '')); }
  else { failed += 1; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : 'got ' + a + ' want ' + b);
};
const capture = (fn) => {
  try { return { threw: false, value: fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};
const asyncCapture = async (fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const HELLO = path.join(repoRoot, 'extensions', 'cetamesh-hello-tool');
const HTTP_META = path.join(repoRoot, 'extensions', 'cetamesh-http-meta');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ext-test-'));
const sourcesDir = path.join(root, 'sources');

function baseManifest(over = {}) {
  return {
    manifestVersion: 1, id: 'test.sample', name: 'Sample', version: '1.0.0', type: 'tool',
    entry: 'index.js', permissions: [], network: { hosts: [] }, scope: { paths: [] },
    capabilities: [{ id: 'sample.run', kind: 'tool', title: 'Run', requires: [] }],
    ...over
  };
}
function writeExtension(folder, manifest, source) {
  const dir = path.join(sourcesDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, manifest.entry || 'index.js'), source, 'utf8');
  return dir;
}
async function waitUntil(predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const fakeFetch = async (url) => ({
  // Production safeFetch returns statusCode/body; the host exposes a Response.
  statusCode: 200,
  body: '<html><head><title>Example Domain</title></head><body>hi</body></html>',
  url
});

try {
  const store = createExtensionStore({ stateDir: root });
  const runtime = createExtensionRuntime({ store, fetchImpl: fakeFetch });
  runtimeCleanups.push(() => runtime.close());

  // ── 1. 无敏感权限的简单 Tool：审查 -> 安装 ─────────────────────────────
  const helloReview = runtime.review({ sourceDir: HELLO });
  equal('Tool 扩展审查风险等级为 low', helloReview.review.riskLevel, 'low');
  equal('Tool 扩展不需要显式批准', helloReview.review.requiresExplicitApproval, false);
  equal('Tool 扩展可安装（无 blocker）', helloReview.review.installable, true);
  equal('Tool 扩展声明能力', helloReview.review.capabilities.map((c) => c.id), ['hello.greet']);
  equal('Tool 扩展权限仅 log', helloReview.review.permissions.map((p) => p.name), ['log']);
  equal('Extension Review explicitly denies OS sandbox isolation', helloReview.review.executionBoundary.osSandbox, false);
  check('Owner review displays the OS sandbox limitation', helloReview.summary.some(line => /OS/.test(line) && /AppContainer/.test(line)));
  check('Tool 扩展源码预检通过', helloReview.scan.ok === true);

  const helloInstalled = runtime.install({ sourceDir: HELLO });
  equal('安装后状态 installed', helloInstalled.entry.status, 'installed');
  equal('安装记录指纹', helloInstalled.entry.fingerprint.length, 64);
  check('受管目录已复制文件', fs.existsSync(path.join(helloInstalled.entry.sourceRoot, 'index.js')));
  check('受管目录位于 stateDir/extensions/packages 下', helloInstalled.entry.sourceRoot.startsWith(path.join(root, 'extensions', 'packages')));

  const duplicate = capture(() => runtime.install({ sourceDir: HELLO }));
  check('重复安装被拒绝', duplicate.threw && duplicate.code === 'ALREADY_INSTALLED', String(duplicate.code));

  // ── 2. 启用 -> 调用 ────────────────────────────────────────────────────
  const enabled = runtime.enable({ id: 'cetamesh.hello-tool' });
  equal('启用后状态 enabled', enabled.extension.status, 'enabled');
  check('启用后宿主已加载', runtime.get({ id: 'cetamesh.hello-tool' }).loaded === true);

  const greeting = await runtime.invoke({ id: 'cetamesh.hello-tool', capability: 'hello.greet', input: { name: 'CetaMesh' } });
  equal('调用返回问候', greeting.result.greeting, 'Hello, CetaMesh!');
  equal('调用带扩展 id', greeting.result.from, 'cetamesh.hello-tool');
  const greeting2 = await runtime.invoke({ id: 'cetamesh.hello-tool', capability: 'hello.greet', input: {} });
  equal('缺省输入回退 world', greeting2.result.greeting, 'Hello, world!');

  const undeclared = await asyncCapture(() => runtime.invoke({ id: 'cetamesh.hello-tool', capability: 'nope.nope' }));
  check('调用未声明能力被拒绝', undeclared.threw && undeclared.code === 'CAPABILITY_NOT_DECLARED', String(undeclared.code));

  const logs = runtime.logs({ id: 'cetamesh.hello-tool' });
  check('扩展日志被记录', logs.logs.length >= 2);

  // ── 3. 禁用 -> 卸载 ────────────────────────────────────────────────────
  const disabled = await runtime.disable({ id: 'cetamesh.hello-tool' });
  equal('禁用后状态 disabled', disabled.extension.status, 'disabled');
  const afterDisable = await asyncCapture(() => runtime.invoke({ id: 'cetamesh.hello-tool', capability: 'hello.greet' }));
  check('禁用后调用被拒绝', afterDisable.threw && afterDisable.code === 'EXTENSION_DISABLED', String(afterDisable.code));
  runtime.enable({ id: 'cetamesh.hello-tool' });
  check('可重新启用', runtime.get({ id: 'cetamesh.hello-tool' }).extension.status === 'enabled');

  // ── 4. 需要明确 Permission 的扩展：审查 ────────────────────────────────
  const metaReview = runtime.review({ sourceDir: HTTP_META });
  equal('HTTP 扩展风险等级为 high', metaReview.review.riskLevel, 'high');
  equal('HTTP 扩展需要显式批准', metaReview.review.requiresExplicitApproval, true);
  equal('HTTP 扩展权限集合', metaReview.review.permissions.map((p) => p.name), ['log', 'storage', 'network']);
  equal('network 为高风险', metaReview.review.permissions.find((p) => p.name === 'network').risk, 'high');
  equal('网络白名单被带出', metaReview.review.network.hosts, ['example.com']);
  check('审查摘要是人读文本', metaReview.summary.length >= 4 && metaReview.summary.join('\n').includes('network'));
  equal('已实现的权限标记 enforced=true',
    metaReview.review.permissions.filter((p) => p.enforced).map((p) => p.name), ['log', 'storage', 'network']);
  // fs / memory 权限目前只有声明与审查面，review 必须如实标注，不能让用户误以为已放开磁盘。
  const declarativeOnly = (await import('../src/extension/index.js')).buildReview(validateManifest(baseManifest({
    id: 'test.declarative', permissions: ['filesystem.read', 'memory.read'],
    scope: { workspace: null, paths: ['src'] }, capabilities: [{ id: 'd.r', kind: 'tool', title: 'R', requires: ['filesystem.read'] }]
  })).manifest);
  equal('Workspace/Memory 权限经 Capability Broker 执行',
    declarativeOnly.permissions.filter((p) => p.enforced).map((p) => p.name), ['filesystem.read', 'memory.read']);
  check('审查摘要不再将已接线能力标成未实现', !reviewSummaryLines(declarativeOnly).join('\n').includes('宿主尚未提供该能力'));

  // ── 5. 未批准 / 凭据不符 -> 拒绝安装 ───────────────────────────────────
  const noApproval = capture(() => runtime.install({ sourceDir: HTTP_META }));
  check('未批准时拒绝安装', noApproval.threw && noApproval.code === 'APPROVAL_REQUIRED', String(noApproval.code));
  const wrongToken = capture(() => runtime.install({ sourceDir: HTTP_META, approval: { approved: true, token: 'deadbeef' } }));
  check('凭据不符时拒绝安装', wrongToken.threw && wrongToken.code === 'REVIEW_MISMATCH', String(wrongToken.code));

  const metaInstalled = runtime.install({ sourceDir: HTTP_META, approval: { approved: true, token: metaReview.review.token } });
  equal('批准后安装成功', metaInstalled.entry.status, 'installed');
  equal('安装记录了批准凭据', metaInstalled.entry.reviewToken, metaReview.review.token);

  // ── 6. 启用 -> 调用（注入假 fetch） -> 主机白名单 ──────────────────────
  runtime.enable({ id: 'cetamesh.http-meta' });
  const fetched = await runtime.invoke({ id: 'cetamesh.http-meta', capability: 'meta.fetch-title', input: { url: 'https://example.com/' } });
  equal('network 权限下可调用并解析标题', fetched.result.title, 'Example Domain');
  equal('HTTP sample preserves the production Response status', fetched.result.status, 200);
  check('HTTP sample consumes the production Response body', fetched.result.bytes > 0);
  const stored = await runtime.invoke({ id: 'cetamesh.http-meta', capability: 'meta.last-title', input: {} });
  equal('storage 权限下可读写私有存储', stored.result.title, 'Example Domain');

  const blockedHost = await asyncCapture(() => runtime.invoke({
    id: 'cetamesh.http-meta', capability: 'meta.fetch-title', input: { url: 'https://not-allowed.example.net/' }
  }));
  check('未声明主机被拒绝', blockedHost.threw && blockedHost.code === 'HOST_NOT_ALLOWED', String(blockedHost.code));
  const badScheme = await asyncCapture(() => runtime.invoke({
    id: 'cetamesh.http-meta', capability: 'meta.fetch-title', input: { url: 'file:///C:/windows/win.ini' }
  }));
  check('非 http/https 协议被拒绝', badScheme.threw && badScheme.code === 'INVALID_URL', String(badScheme.code));

  // ── 7. 禁止权限：不可授予 ──────────────────────────────────────────────
  for (const [name, permission] of [['Shell', 'shell'], ['Native DLL', 'native'], ['下载执行', 'download'], ['宿主进程', 'process']]) {
    const dir = writeExtension('forbidden-' + permission, baseManifest({ id: 'test.forbidden', permissions: [permission] }), 'module.exports.handlers={};');
    const blocked = capture(() => runtime.install({ sourceDir: dir }));
    check('禁止权限被拒绝（' + name + '）', blocked.threw && blocked.code === 'FORBIDDEN_PERMISSION', String(blocked.code));
  }

  // ── 8. 源码静态预检：引入宿主能力即拒绝 ────────────────────────────────
  const scanCases = [
    ['require', "const fs = require('fs');\nmodule.exports.handlers={};"],
    ['import', "import fs from 'node:fs';\nmodule.exports.handlers={};"],
    ['child_process', "const cp = child_process;\nmodule.exports.handlers={};"],
    ['process', "const home = process.env.HOME;\nmodule.exports.handlers={};"],
    ['eval', "module.exports.handlers={ r: () => eval('1+1') };"]
  ];
  for (const [label, source] of scanCases) {
    const dir = writeExtension('scan-' + label, baseManifest({ id: 'test.scan-' + label.toLowerCase().replace(/_/g, '-') }), source);
    const rejected = capture(() => runtime.install({ sourceDir: dir }));
    check('源码预检拒绝 ' + label, rejected.threw && rejected.code === 'SOURCE_SCAN_FAILED', String(rejected.code));
  }
  const scanResult = scanEntrySource("const fs = require('fs');");
  check('scanEntrySource 可直接用于诊断', scanResult.ok === false && scanResult.findings[0].rule === 'require');

  // ── 9. 能力不得声明未授权权限 ──────────────────────────────────────────
  const undeclaredCap = writeExtension('undeclared-cap', baseManifest({
    id: 'test.undeclared', capabilities: [{ id: 'x.y', kind: 'tool', title: 'X', requires: ['network'] }]
  }), 'module.exports.handlers={};');
  const undeclaredInstall = capture(() => runtime.install({ sourceDir: undeclaredCap }));
  check('能力声明未声明权限时被拒绝', undeclaredInstall.threw && undeclaredInstall.code === 'UNDECLARED_CAPABILITY_PERMISSION', String(undeclaredInstall.code));

  // ── 10. manifest 层校验 ────────────────────────────────────────────────
  const noHosts = validateManifest(baseManifest({ permissions: ['network'] }));
  check('network 未声明 hosts 被拒绝', noHosts.ok === false && noHosts.issues[0].code === 'INCOMPLETE_PERMISSION_DECLARATION', JSON.stringify(noHosts.issues[0]));
  const badId = validateManifest(baseManifest({ id: 'Bad ID' }));
  check('非法扩展 id 被拒绝', badId.ok === false && badId.issues[0].code === 'INVALID_EXTENSION_ID');
  const badVersion = validateManifest(baseManifest({ version: 'v1' }));
  check('非法版本号被拒绝', badVersion.ok === false && badVersion.issues[0].code === 'INVALID_VERSION');
  const escapeEntry = validateManifest(baseManifest({ entry: '../../evil.js' }));
  check('entry 目录穿越被拒绝', escapeEntry.ok === false && escapeEntry.issues[0].code === 'INVALID_ENTRY');
  const traversalScope = validateManifest(baseManifest({ permissions: ['filesystem.read'], scope: { paths: ['../outside'] } }));
  check('scope.paths 穿越被拒绝', traversalScope.ok === false && traversalScope.issues[0].code === 'INVALID_SCOPE');
  const unknownType = validateManifest(baseManifest({ type: 'kernel-module' }));
  check('未知扩展类型被拒绝', unknownType.ok === false && unknownType.issues[0].code === 'INVALID_EXTENSION_TYPE');
  const settingsSchema = [
    { key: 'enabled', label: '启用功能', type: 'boolean', default: true },
    { key: 'displayName', label: '显示名称', type: 'string', required: true, maxLength: 60, default: 'Harbor' },
    { key: 'interval', label: '同步间隔', type: 'number', min: 1, max: 60, default: 10 },
    { key: 'mode', label: '工作模式', type: 'enum', options: ['safe', 'fast'], default: 'safe' },
    { key: 'apiToken', label: 'API Token', type: 'secretRef' }
  ];
  const validSettingsManifest = validateManifest(baseManifest({ id: 'test.settings', settingsSchema }));
  check('settingsSchema accepts boolean, string, number, enum, and secretRef fields', validSettingsManifest.ok === true
    && validSettingsManifest.manifest.settingsSchema?.length === 5);
  equal('settingsSchema preserves declared types', validSettingsManifest.manifest?.settingsSchema?.map(field => field.type),
    ['boolean', 'string', 'number', 'enum', 'secretRef']);
  const emptySettingsManifest = validateManifest(baseManifest({ settingsSchema: [] }));
  check('empty settingsSchema remains valid and empty', emptySettingsManifest.ok === true
    && Array.isArray(emptySettingsManifest.manifest.settingsSchema) && emptySettingsManifest.manifest.settingsSchema.length === 0);
  const unknownSettingField = validateManifest(baseManifest({ settingsSchema: [
    { key: 'safe', label: 'Safe', type: 'string', placeholder: 'unknown field' }
  ] }));
  check('unknown settingsSchema fields are rejected', unknownSettingField.ok === false);
  const duplicateSettingKeys = validateManifest(baseManifest({ settingsSchema: [
    { key: 'mode', label: 'Mode', type: 'string' }, { key: 'mode', label: 'Mode again', type: 'boolean' }
  ] }));
  check('duplicate settingsSchema keys are rejected', duplicateSettingKeys.ok === false);
  const invalidSettingType = validateManifest(baseManifest({ settingsSchema: [
    { key: 'mode', label: 'Mode', type: 'object' }
  ] }));
  check('unsupported settingsSchema types are rejected', invalidSettingType.ok === false);
  const invalidSettingRange = validateManifest(baseManifest({ settingsSchema: [
    { key: 'interval', label: 'Interval', type: 'number', min: 10, max: 2 }
  ] }));
  check('invalid settingsSchema number ranges are rejected', invalidSettingRange.ok === false);
  const invalidSettingDefault = validateManifest(baseManifest({ settingsSchema: [
    { key: 'mode', label: 'Mode', type: 'enum', options: ['safe', 'fast'], default: 'unsafe' }
  ] }));
  check('settingsSchema defaults must match declared types and enum options', invalidSettingDefault.ok === false);

  // ── 11. vm 上下文遏制（直接构造 host，绕过安装期预检） ──────────────────
  const probeSource = [
    "module.exports.handlers = {",
    "  'probe.check': () => {",
    "    let evalOutcome = 'allowed';",
    "    try { eval('1+1'); } catch (e) { evalOutcome = 'blocked'; }",
    "    let fnOutcome = 'allowed';",
    "    try { new Function('return 1')(); } catch (e) { fnOutcome = 'blocked'; }",
    "    return {",
    "      requireType: typeof require,",
    "      processType: typeof process,",
    "      fetchType: typeof fetch,",
    "      storageType: typeof storage,",
    "      moduleType: typeof module,",
    "      evalOutcome, fnOutcome",
    "    };",
    "  }",
    "};"
  ].join('\n');
  const probeManifest = baseManifest({
    id: 'test.probe', permissions: [],
    capabilities: [{ id: 'probe.check', kind: 'tool', title: 'Probe', requires: [] }]
  });
  const probeHost = createExtensionHost({ manifest: probeManifest, source: probeSource });
  check('受限宿主加载成功', probeHost.available() === true, JSON.stringify(probeHost.loadError()));
  const probe = await probeHost.invoke('probe.check', null);
  equal('上下文中没有 require', probe.result.requireType, 'undefined');
  equal('上下文中没有 process', probe.result.processType, 'undefined');
  equal('未授予 network 时没有 fetch', probe.result.fetchType, 'undefined');
  equal('未授予 storage 时没有 storage', probe.result.storageType, 'undefined');
  equal('vm 中 eval 被禁用', probe.result.evalOutcome, 'blocked');
  equal('vm 中 new Function 被禁用', probe.result.fnOutcome, 'blocked');

  // ── 12. Update：版本与权限提升 ─────────────────────────────────────────
  const v1Same = writeExtension('upd-same', baseManifest({ id: 'test.updatable' }), 'module.exports.handlers={"sample.run":()=>({v:1})};');
  runtime.install({ sourceDir: v1Same });
  await runtime.enable({ id: 'test.updatable' });
  runtime.review({ sourceDir: v1Same });
  const notNewer = await asyncCapture(() => runtime.update({ sourceDir: v1Same }));
  check('同版本更新被拒绝', notNewer.threw && notNewer.code === 'VERSION_NOT_NEWER', String(notNewer.code));

  const v11 = writeExtension('upd-110', baseManifest({ id: 'test.updatable', version: '1.1.0', permissions: ['storage'] }), 'module.exports.handlers={"sample.run":()=>({v:11})};');
  const escalate = await asyncCapture(() => runtime.update({ sourceDir: v11 }));
  check('新增权限的更新需要重新批准', escalate.threw && escalate.code === 'APPROVAL_REQUIRED', String(escalate.code));
  check('拒绝信息点明新增权限', escalate.message.includes('storage'), escalate.message);

  const v11Review = runtime.review({ sourceDir: v11 }).review;
  const updated = await runtime.update({ sourceDir: v11, approval: { approved: true, token: v11Review.token } });
  equal('Update keeps the installed Extension enabled', updated.entry.status, 'enabled');
  equal('Update launches the new version in a real Process Worker', runtime.get({ id: 'test.updatable' }).provider, 'process-child');
  equal('new version is active after atomic switch', (await runtime.invoke({ id: 'test.updatable', capability: 'sample.run', input: {} })).result.v, 11);
  const v12 = writeExtension('v12-changed-after-review', baseManifest({ id: 'test.updatable', version: '1.2.0', permissions: ['storage'] }),
    'module.exports.handlers={"sample.run":()=>({v:12})};');
  runtime.review({ sourceDir: v12 });
  fs.writeFileSync(path.join(v12, 'index.js'), 'module.exports.handlers={"sample.run":()=>({v:120})};');
  const changedAfterReview = await asyncCapture(() => runtime.update({ sourceDir: v12 }));
  check('package content changed after review is rejected before update',
    changedAfterReview.threw && changedAfterReview.code === 'REVIEW_MISMATCH');
  check('previous immutable package remains available for rollback', fs.existsSync(path.join(store.packagesDir, 'test.updatable', '1.0.0')));
  runtime.review({ sourceDir: v11 });
  const sameVersion = await asyncCapture(() => runtime.update({ sourceDir: v11 }));
  check('same-version update is rejected after activation', sameVersion.threw && sameVersion.code === 'VERSION_NOT_NEWER');
  runtime.reviewRollback({ id: 'test.updatable' });
  const rolledBack = await runtime.rollback({ id: 'test.updatable' });
  equal('rollback atomically restores the previous version', rolledBack.entry.version, '1.0.0');
  equal('rollback preserves enabled state', rolledBack.entry.status, 'enabled');
  equal('rollback runs the restored version', (await runtime.invoke({ id: 'test.updatable', capability: 'sample.run', input: {} })).result.v, 1);
  const silentReExpansion = await asyncCapture(() => runtime.update({ sourceDir: v11, approval: { approved: true, token: v11Review.token } }));
  check('permission expansion requires a fresh Owner Review after rollback', silentReExpansion.threw && silentReExpansion.code === 'APPROVAL_REQUIRED');
  const freshV11Review = runtime.review({ sourceDir: v11 }).review;
  const reUpdated = await runtime.update({ sourceDir: v11, approval: { approved: true, token: freshV11Review.token } });
  equal('fresh review permits the exact new version', reUpdated.entry.version, '1.1.0');

  const failedStartStore = createExtensionStore({ stateDir: path.join(root, 'failed-worker-start-state') });
  const failedStartRuntime = createExtensionRuntime({
    store: failedStartStore, monitorIntervalMs: 0,
    processHostFactory: ({ manifest }) => ({
      manifest, available: () => true,
      health: () => ({ available: true, closed: false, crashed: false, inflight: 0, provider: 'test-process-host' }),
      ping: async () => manifest.version === '1.0.0',
      invoke: async () => ({ result: null }),
      shutdown: async () => {}
    })
  });
  runtimeCleanups.push(() => failedStartRuntime.close());
  const startFailureV1 = writeExtension('worker-start-v1', baseManifest({ id: 'test.worker-start-rollback' }),
    'module.exports.handlers={"sample.run":()=>1};');
  const startFailureV2 = writeExtension('worker-start-v2', baseManifest({ id: 'test.worker-start-rollback', version: '2.0.0' }),
    'module.exports.handlers={"sample.run":()=>2};');
  failedStartRuntime.install({ sourceDir: startFailureV1 });
  await failedStartRuntime.enable({ id: 'test.worker-start-rollback' });
  failedStartRuntime.review({ sourceDir: startFailureV2 });
  const failedStart = await asyncCapture(() => failedStartRuntime.update({ sourceDir: startFailureV2 }));
  check('failed new Worker startup reports the switch failure', failedStart.threw && failedStart.code === 'WORKER_START_FAILED');
  equal('failed new Worker startup restores the prior active version', failedStartStore.get('test.worker-start-rollback').version, '1.0.0');
  equal('failed update rollback keeps the Extension enabled', failedStartStore.get('test.worker-start-rollback').status, 'enabled');
  equal('failed update rollback restarts the previous host', failedStartRuntime.get({ id: 'test.worker-start-rollback' }).provider, 'test-process-host');
  await failedStartRuntime.close();

  const failingStateDir = path.join(root, 'registry-write-failure-state');
  const failingStore = createExtensionStore({ stateDir: failingStateDir });
  const failingRuntime = createExtensionRuntime({ store: failingStore, monitorIntervalMs: 0 });
  runtimeCleanups.push(() => failingRuntime.close());
  const failureV1 = writeExtension('registry-failure-v1', baseManifest({ id: 'test.registry-failure' }),
    'module.exports.handlers={"sample.run":()=>({v:1})};');
  const failureV2 = writeExtension('registry-failure-v2', baseManifest({ id: 'test.registry-failure', version: '2.0.0' }),
    'module.exports.handlers={"sample.run":()=>({v:2})};');
  failingRuntime.install({ sourceDir: failureV1 });
  failingRuntime.review({ sourceDir: failureV2 });
  const registryBackup = failingStore.file + '.backup';
  fs.renameSync(failingStore.file, registryBackup);
  fs.mkdirSync(failingStore.file);
  try {
    const failedSwitch = await asyncCapture(() => failingRuntime.update({ sourceDir: failureV2 }));
    check('registry write failure is reported in the Extension domain', failedSwitch.threw && failedSwitch.code === 'REGISTRY_WRITE_FAILED');
    equal('registry write failure restores the in-memory active version', failingStore.get('test.registry-failure').version, '1.0.0');
    check('failed registry switch removes the staged version directory', !fs.existsSync(path.join(failingStore.packagesDir, 'test.registry-failure', '2.0.0')));
  } finally {
    fs.rmSync(failingStore.file, { recursive: true, force: true });
    fs.renameSync(registryBackup, failingStore.file);
  }

  const enableFailureStore = createExtensionStore({ stateDir: path.join(root, 'enable-registry-failure') });
  let enableHostAlive = false;
  let enableHostShutdowns = 0;
  const enableFailureRuntime = createExtensionRuntime({
    store: enableFailureStore, monitorIntervalMs: 0,
    processHostFactory: () => {
      enableHostAlive = true;
      return {
        available: () => enableHostAlive,
        health: () => ({ available: enableHostAlive, closed: !enableHostAlive, crashed: false, inflight: 0, provider: 'test-process-host' }),
        ping: async () => enableHostAlive,
        shutdown: async () => { enableHostAlive = false; enableHostShutdowns += 1; }
      };
    }
  });
  runtimeCleanups.push(() => enableFailureRuntime.close());
  const enableFailureSource = writeExtension('enable-registry-failure', baseManifest({ id: 'test.enable-registry-failure' }),
    'module.exports.handlers={"sample.run":()=>1};');
  enableFailureRuntime.install({ sourceDir: enableFailureSource });
  const enableRegistryBackup = enableFailureStore.file + '.backup';
  fs.renameSync(enableFailureStore.file, enableRegistryBackup);
  fs.mkdirSync(enableFailureStore.file);
  try {
    const enableFailure = await asyncCapture(() => enableFailureRuntime.enable({ id: 'test.enable-registry-failure' }));
    check('enable reports registry persistence failure', enableFailure.threw && enableFailure.code === 'REGISTRY_WRITE_FAILED');
    check('failed enable stops its newly started Worker', enableHostShutdowns === 1 && !enableHostAlive);
    equal('failed enable leaves the Extension unenabled', enableFailureStore.get('test.enable-registry-failure').status, 'installed');
  } finally {
    fs.rmSync(enableFailureStore.file, { recursive: true, force: true });
    fs.renameSync(enableRegistryBackup, enableFailureStore.file);
  }
  equal('批准后更新成功', updated.entry.version, '1.1.0');
  equal('记录了权限差异', updated.permissionDelta.added, ['storage']);

  // ── 13. 重启持久化 ────────────────────────────────────────────────────
  await runtime.close();
  const restartedStore = createExtensionStore({ stateDir: root });
  const restarted = createExtensionRuntime({ store: restartedStore, fetchImpl: fakeFetch });
  runtimeCleanups.push(() => restarted.close());
  const restored = restarted.get({ id: 'cetamesh.http-meta' }).extension;
  equal('重启后扩展仍在', restored.id, 'cetamesh.http-meta');
  equal('重启后状态保持 enabled', restored.status, 'enabled');
  equal('重启后权限声明保持', restored.permissions, ['log', 'storage', 'network']);
  const restoredCall = await restarted.invoke({ id: 'cetamesh.http-meta', capability: 'meta.last-title', input: {} });
  equal('重启后惰性重建宿主并可调用', restoredCall.result.title, 'Example Domain');
  equal('重启后更新版本保持', restarted.get({ id: 'test.updatable' }).extension.version, '1.1.0');

  // ── 14. 卸载 ──────────────────────────────────────────────────────────
  const helloEntry = restarted.get({ id: 'cetamesh.hello-tool' }).extension;
  const packageDir = helloEntry.sourceRoot;
  const uninstalled = await restarted.uninstall({ id: 'cetamesh.hello-tool' });
  equal('卸载返回被移除的版本', uninstalled.version, '1.0.0');
  check('注册表条目已移除', restartedStore.get('cetamesh.hello-tool') === null);
  check('受管包目录已删除', fs.existsSync(packageDir) === false);
  check('用户的来源目录未被触碰', fs.existsSync(path.join(HELLO, 'extension.json')) === true);
  const uninstallAgain = await asyncCapture(() => restarted.uninstall({ id: 'cetamesh.hello-tool' }));
  check('重复卸载被拒绝', uninstallAgain.threw && uninstallAgain.code === 'NOT_INSTALLED', String(uninstallAgain.code));

  const overview = restarted.overview();
  equal('overview 总数正确', overview.total, restartedStore.list().length);
  check('overview 列出已启用数量', typeof overview.enabled === 'number');

  // ── 15. Service 层 + IPC 往返 ─────────────────────────────────────────
  // Host selection keeps Memory Packs data-only, routes regular Extensions to processes,
  // and permits VM execution only through an explicit trusted predicate.
  const selectionStore = createExtensionStore({ stateDir: path.join(root, 'selection-state') });
  const selectedKinds = [];
  const selectedHost = (manifest, provider) => ({
    manifest, logs: [], capabilities: () => manifest.capabilities.map(capability => capability.id),
    available: () => true, loadError: () => null,
    health: () => ({ available: true, closed: false, crashed: false, inflight: 0, provider }),
    invoke: async (capability, input) => ({ capability, result: input }),
    shutdown: async () => {}
  });
  const selectionRuntime = createExtensionRuntime({
    store: selectionStore, monitorIntervalMs: 0,
    processHostFactory: ({ manifest }) => { selectedKinds.push('process'); return selectedHost(manifest, 'process-child'); },
    vmHostFactory: ({ manifest }) => { selectedKinds.push('vm'); return selectedHost(manifest, 'vm'); },
    memoryPackHostFactory: ({ manifest }) => { selectedKinds.push('memory-pack'); return selectedHost(manifest, 'memory-pack'); },
    isTrustedVmExtension: entry => entry.id === 'test.trusted-vm'
  });
  runtimeCleanups.push(() => selectionRuntime.close());
  const ordinarySource = writeExtension('runtime-ordinary', baseManifest({ id: 'test.ordinary' }), 'module.exports.handlers={"sample.run":()=>1};');
  const trustedSource = writeExtension('runtime-trusted', baseManifest({ id: 'test.trusted-vm' }), 'module.exports.handlers={"sample.run":()=>1};');
  selectionRuntime.install({ sourceDir: ordinarySource });
  selectionRuntime.install({ sourceDir: trustedSource });
  selectionRuntime.enable({ id: 'test.ordinary' });
  selectionRuntime.enable({ id: 'test.trusted-vm' });
  const memoryPackRoot = path.join(root, 'selection-memory-pack');
  fs.mkdirSync(memoryPackRoot, { recursive: true });
  writeJsonAtomic(path.join(memoryPackRoot, 'pack.json'), { schemaVersion: 1, kind: 'memory-pack', base: { summary: '', entries: [] } });
  const memoryPackManifest = { ...baseManifest({ id: 'test.memory-pack', type: 'memory-pack', entry: 'pack.json',
    capabilities: [{ id: 'memory.list', kind: 'memory', title: 'List', requires: [] }] }) };
  // Host selection must use the real reviewed installer, including Memory Packs.
  // A hand-inserted sourceRoot outside packages/id/version has no install authority.
  writeJsonAtomic(path.join(memoryPackRoot, 'extension.json'), memoryPackManifest);
  const memoryPackReview = selectionRuntime.review({ sourceDir: memoryPackRoot });
  const memoryPackInstalled = selectionRuntime.install({ sourceDir: memoryPackRoot,
    approval: { approved: true, token: memoryPackReview.review.token } });
  equal('Memory Pack selection fixture uses the managed immutable version directory',
    memoryPackInstalled.entry.sourceRoot, path.join(selectionStore.packagesDir, memoryPackManifest.id, memoryPackManifest.version));
  equal('Memory Pack selection fixture retains the exact reviewed package binding',
    memoryPackInstalled.entry.reviewToken, memoryPackReview.review.token);
  selectionRuntime.enable({ id: memoryPackManifest.id });
  equal('ordinary, trusted VM, and Memory Pack host selection', selectedKinds, ['process', 'vm', 'memory-pack']);
  const selectedOverview = selectionRuntime.overview();
  equal('overview exposes process provider and runtime state',
    selectedOverview.extensions.find(entry => entry.id === 'test.ordinary')?.provider, 'process-child');
  check('overview exposes runtimeState', typeof selectedOverview.extensions.find(entry => entry.id === 'test.ordinary')?.runtimeState === 'string');
  await selectionRuntime.close();

  // Reverse capability requests are bound to the installed identity and reviewed grants.
  const bindingStore = createExtensionStore({ stateDir: path.join(root, 'binding-state') });
  const bindingPair = createInProcessTransportPair();
  const bindingBroker = createCapabilityBroker();
  bindingBroker.register({ id: 'memory.read', permission: 'memory.read', provider: 'test', risk: 'low',
    execute: request => ({ actorId: request.actor.id, input: request.input }) });
  const bindingRuntime = createExtensionRuntime({
    store: bindingStore, capabilityBroker: bindingBroker, monitorIntervalMs: 0,
    processHostFactory: ({ manifest, capabilityExecutor }) => createProcessExtensionHost({
      manifest, transport: bindingPair.host, capabilityExecutor
    })
  });
  runtimeCleanups.push(() => bindingRuntime.close());
  const boundSource = writeExtension('runtime-bound', baseManifest({
    id: 'test.bound-worker', permissions: ['memory.read'],
    capabilities: [{ id: 'bound.run', kind: 'tool', title: 'Bound', requires: ['memory.read'] }]
  }), 'module.exports.handlers={"bound.run":(input,ctx)=>ctx.memory.read(input)};');
  bindingRuntime.install({ sourceDir: boundSource });
  bindingRuntime.enable({ id: 'test.bound-worker' });
  let sequence = 0;
  const waiters = new Map();
  bindingPair.child.onMessage(raw => {
    const frame = JSON.parse(raw);
    const resolve = waiters.get(frame.id);
    if (resolve) { waiters.delete(frame.id); resolve(frame); }
  });
  const reverseCapability = extra => new Promise(resolve => {
    const id = 'runtime-bound-' + (++sequence);
    const timeout = setTimeout(() => { waiters.delete(id); resolve({ kind: 'timeout', error: { code: 'TEST_TIMEOUT' } }); }, 3000);
    waiters.set(id, frame => { clearTimeout(timeout); resolve(frame); });
    bindingPair.child.send(JSON.stringify({ v: 1, id, kind: 'invoke', capability: 'memory.read', input: { probe: sequence }, ...extra }));
  });
  const boundResult = await reverseCapability({ extensionId: 'spoofed-id', actor: { kind: 'owner', id: 'desktop' }, grants: ['*'] });
  equal('Worker-supplied identity cannot replace the host-bound actor', boundResult.result?.actorId, 'test.bound-worker');
  const installedBinding = bindingStore.get('test.bound-worker');
  bindingStore.put({ ...installedBinding, permissions: [] });
  const deniedGrant = await reverseCapability({});
  equal('removed approved grant denies reverse capability', deniedGrant.error.code, 'PERMISSION_DENIED');
  bindingStore.put({ ...installedBinding, permissions: ['memory.read', 'storage'] });
  const expandedGrant = await reverseCapability({});
  equal('expanded approved grant invalidates the running Worker', expandedGrant.error.code, 'STALE_EXTENSION_GRANTS');
  bindingStore.put({ ...installedBinding, version: '2.0.0' });
  const staleVersion = await reverseCapability({});
  equal('stale active version denies reverse capability', staleVersion.error.code, 'STALE_EXTENSION_HOST');
  bindingStore.put({ ...installedBinding, fingerprint: 'stale-fingerprint' });
  const staleFingerprint = await reverseCapability({});
  equal('stale active fingerprint denies reverse capability', staleFingerprint.error.code, 'STALE_EXTENSION_HOST');
  await bindingRuntime.close();

  // Health monitors distinguish heartbeat misses and bound automatic recovery to a rolling window.
  const recoveryStore = createExtensionStore({ stateDir: path.join(root, 'recovery-state') });
  const recoveryHosts = [];
  let recoveryNow = 0;
  const recoveryRuntime = createExtensionRuntime({
    store: recoveryStore, monitorIntervalMs: 0, now: () => recoveryNow,
    maxAutomaticRestarts: 3, restartWindowMs: 300_000, stableWindowMs: 300_000,
    maxHeartbeatMisses: 3,
    processHostFactory: ({ manifest }) => {
      const worker = {
        manifest, alive: true, responds: true,
        available() { return this.alive; },
        health() { return { available: this.alive, closed: !this.alive, crashed: !this.alive, inflight: 0, provider: 'process-child' }; },
        async ping() { return this.alive && this.responds; },
        invoke: async () => ({ result: null }),
        async shutdown() { this.alive = false; }
      };
      recoveryHosts.push(worker);
      return worker;
    }
  });
  runtimeCleanups.push(() => recoveryRuntime.close());
  const recoverySource = writeExtension('runtime-recovery', baseManifest({ id: 'test.recovery' }), 'module.exports.handlers={"sample.run":()=>1};');
  recoveryRuntime.install({ sourceDir: recoverySource });
  recoveryRuntime.enable({ id: 'test.recovery' });
  check('runtime exposes heartbeat check', typeof recoveryRuntime.checkHealth === 'function');
  if (typeof recoveryRuntime.checkHealth === 'function') {
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    equal('healthy heartbeat sets healthy state', recoveryRuntime.overview().extensions.find(entry => entry.id === 'test.recovery')?.runtimeState, 'healthy');
    recoveryHosts.at(-1).responds = false;
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    equal('missed heartbeat exposes unresponsive state', recoveryRuntime.overview().extensions.find(entry => entry.id === 'test.recovery')?.runtimeState, 'unresponsive');
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    check('three heartbeat misses restart the Worker', recoveryHosts.length === 2);
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    recoveryNow = 300_001;
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    for (let i = 0; i < 3; i += 1) {
      recoveryHosts.at(-1).alive = false;
      await recoveryRuntime.checkHealth({ id: 'test.recovery' });
      await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    }
    equal('five stable minutes reset the restart window', recoveryStore.get('test.recovery').status, 'enabled');
    for (let i = 0; i < 4; i += 1) {
      recoveryHosts.at(-1).alive = false;
      await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    }
    equal('fourth restart inside the rolling limit disables crash loop', recoveryStore.get('test.recovery').status, 'disabled_due_to_crash');
    check('crash loop state is visible', recoveryRuntime.overview().extensions.find(entry => entry.id === 'test.recovery')?.runtimeState === 'crashed');
    const explicitRestart = await recoveryRuntime.restart?.({ id: 'test.recovery' });
    check('explicit Restart clears crash-disabled state for one start', explicitRestart?.extension.status === 'enabled');
    recoveryHosts.at(-1).alive = false;
    await recoveryRuntime.checkHealth({ id: 'test.recovery' });
    equal('explicit Restart preserves automatic restart history', recoveryStore.get('test.recovery').status, 'disabled_due_to_crash');
  }
  await recoveryRuntime.close();

  // Crash recovery and the automatic restart limit are exercised with real Worker child processes.
  const processRecoveryState = path.join(root, 'process-recovery-state');
  const processRecoveryStore = createExtensionStore({ stateDir: processRecoveryState });
  const crashWorkerEntry = path.join(root, 'crash-on-invoke-worker.mjs');
  const sanitizerUrl = new URL('../src/extension/worker-env.js', import.meta.url).href;
  fs.writeFileSync(crashWorkerEntry, [
    `import { sanitizeExtensionWorkerEnv } from '${sanitizerUrl}';`,
    'sanitizeExtensionWorkerEnv();',
    'let buffered = "";',
    "process.stdin.on('data', chunk => {",
    '  buffered += chunk.toString();',
    '  let newline;',
    "  while ((newline = buffered.indexOf('\\n')) >= 0) {",
    '    const frame = JSON.parse(buffered.slice(0, newline));',
    '    buffered = buffered.slice(newline + 1);',
    "    if (frame.kind === 'ping') process.stdout.write(JSON.stringify({v:1,id:frame.id,kind:'pong'})+'\\n');",
    "    else if (frame.kind === 'shutdown') process.exit(0);",
    "    else if (frame.kind === 'invoke') process.exit(23);",
    '  }',
    '});'
  ].join('\n'), 'utf8');
  let realChildHosts = 0;
  const processRecoveryRuntime = createExtensionRuntime({
    store: processRecoveryStore, monitorIntervalMs: 0,
    maxAutomaticRestarts: 3, restartWindowMs: 300_000, stableWindowMs: 300_000,
    processHostFactory: (options) => {
      realChildHosts += 1;
      return createProcessExtensionHost({ ...options, packaged: false, workerEntry: crashWorkerEntry, timeoutMs: 2000 });
    }
  });
  runtimeCleanups.push(() => processRecoveryRuntime.close());
  const processRecoverySource = writeExtension('real-process-recovery', baseManifest({ id: 'test.real-process-recovery' }),
    'module.exports.handlers={"sample.run":()=>1};');
  processRecoveryRuntime.install({ sourceDir: processRecoverySource });
  processRecoveryRuntime.enable({ id: 'test.real-process-recovery' });
  for (let crash = 1; crash <= 4; crash += 1) {
    await asyncCapture(() => processRecoveryRuntime.invoke({ id: 'test.real-process-recovery', capability: 'sample.run', input: {} }));
    if (crash < 4) {
      await waitUntil(() => realChildHosts === crash + 1);
    } else {
      await waitUntil(() => processRecoveryStore.get('test.real-process-recovery')?.status === 'disabled_due_to_crash');
    }
  }
  equal('three real child crashes trigger only three automatic restarts', realChildHosts, 4);
  equal('real child crash loop persists disabled_due_to_crash', processRecoveryStore.get('test.real-process-recovery').status, 'disabled_due_to_crash');
  await processRecoveryRuntime.restart({ id: 'test.real-process-recovery' });
  equal('explicit restart starts a new real Worker', realChildHosts, 5);
  await asyncCapture(() => processRecoveryRuntime.invoke({ id: 'test.real-process-recovery', capability: 'sample.run', input: {} }));
  await waitUntil(() => processRecoveryStore.get('test.real-process-recovery')?.status === 'disabled_due_to_crash');
  equal('real Worker crash after explicit restart still respects stored restart history', processRecoveryStore.get('test.real-process-recovery').status, 'disabled_due_to_crash');
  await processRecoveryRuntime.close();

  const svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ext-svc-'));
  const service = createExtensionService({ stateDir: svcDir, fetchImpl: fakeFetch });
  runtimeCleanups.push(() => service.close());
  const svcReview = await service.execute({ method: 'ext.review', params: { sourceDir: HELLO } });
  check('service ext.review 可用', svcReview.review.id === 'cetamesh.hello-tool');
  const svcInstall = await service.execute({ method: 'ext.install', params: { sourceDir: HELLO } });
  equal('service ext.install 可用', svcInstall.entry.id, 'cetamesh.hello-tool');
  await service.execute({ method: 'ext.enable', params: { id: 'cetamesh.hello-tool' } });
  const svcInvoke = await service.execute({ method: 'ext.invoke', params: { id: 'cetamesh.hello-tool', capability: 'hello.greet', input: { name: 'IPC' } } });
  equal('service ext.invoke 可用', svcInvoke.result.greeting, 'Hello, IPC!');
  const svcOverview = await service.execute({ method: 'ext.overview', params: {} });
  const svcRestart = await service.execute({ method: 'ext.restart', params: { id: 'cetamesh.hello-tool' } });
  equal('service ext.restart keeps the Extension enabled', svcRestart.extension.status, 'enabled');
  const svcDisabled = await service.execute({ method: 'ext.disable', params: { id: 'cetamesh.hello-tool' } });
  equal('service ext.disable stops and disables the Extension', svcDisabled.extension.status, 'disabled');
  await service.execute({ method: 'ext.enable', params: { id: 'cetamesh.hello-tool' } });
  equal('service ext.overview 可用', svcOverview.total, 1);
  const unknownMethod = await asyncCapture(() => service.execute({ method: 'ext.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknownMethod.threw && unknownMethod.code === 'METHOD_NOT_FOUND', String(unknownMethod.code));

  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ext-settings-'));
  const settingsSource = writeExtension('settings-sample', baseManifest({ id: 'test.settings', settingsSchema }), 'module.exports.handlers={};');
  const settingsService = createExtensionService({ stateDir: settingsDir, fetchImpl: fakeFetch });
  runtimeCleanups.push(() => settingsService.close());
  await settingsService.execute({ method: 'ext.install', params: { sourceDir: settingsSource } });
  const settingsDescriptionResult = await asyncCapture(() => settingsService.execute({ method: 'ext.settings.describe', params: { id: 'test.settings' } }));
  check('ext.settings.describe returns the validated schema', !settingsDescriptionResult.threw
    && settingsDescriptionResult.value?.fields?.length === 5, String(settingsDescriptionResult.code));
  const initialSettingsResult = await asyncCapture(() => settingsService.execute({ method: 'ext.settings.get', params: { id: 'test.settings' } }));
  check('ext.settings.get applies public defaults and hides unset secrets', !initialSettingsResult.threw
    && initialSettingsResult.value?.values?.enabled === true
    && initialSettingsResult.value?.values?.displayName === 'Harbor'
    && initialSettingsResult.value?.values?.interval === 10
    && initialSettingsResult.value?.values?.mode === 'safe'
    && initialSettingsResult.value?.values?.apiToken?.configured === false, String(initialSettingsResult.code));
  const emptySchemaResult = await asyncCapture(() => service.execute({ method: 'ext.settings.describe', params: { id: 'cetamesh.hello-tool' } }));
  check('extensions without settings expose an empty schema', !emptySchemaResult.threw
    && Array.isArray(emptySchemaResult.value?.fields) && emptySchemaResult.value.fields.length === 0, String(emptySchemaResult.code));
  const unknownSettingUpdate = await asyncCapture(() => settingsService.execute({
    method: 'ext.settings.update', params: { id: 'test.settings', values: { unknownKey: 'blocked' } }
  }));
  check('ext.settings.update rejects undeclared keys', unknownSettingUpdate.threw && unknownSettingUpdate.code === 'UNKNOWN_EXTENSION_SETTING', String(unknownSettingUpdate.code));
  const invalidSettingUpdates = await Promise.all([
    asyncCapture(() => settingsService.execute({ method: 'ext.settings.update', params: { id: 'test.settings', values: { displayName: '' } } })),
    asyncCapture(() => settingsService.execute({ method: 'ext.settings.update', params: { id: 'test.settings', values: { interval: 61 } } })),
    asyncCapture(() => settingsService.execute({ method: 'ext.settings.update', params: { id: 'test.settings', values: { mode: 'unsafe' } } })),
    asyncCapture(() => settingsService.execute({ method: 'ext.settings.update', params: { id: 'test.settings', values: { enabled: 'yes' } } })),
    asyncCapture(() => settingsService.execute({ method: 'ext.settings.update', params: { id: 'test.settings', values: { displayName: 'x'.repeat(61) } } }))
  ]);
  check('required, bounded, length, enum, and boolean setting values reject invalid updates', invalidSettingUpdates.every(result =>
    result.threw && result.code === 'INVALID_EXTENSION_SETTING'), JSON.stringify(invalidSettingUpdates.map(result => result.code)));
  const secretSentinel = 'extension-secret-sentinel-value';
  const savedSettingsResult = await asyncCapture(() => settingsService.execute({
    method: 'ext.settings.update',
    params: { id: 'test.settings', values: { enabled: false, displayName: 'CetaMesh', interval: 25, mode: 'fast', apiToken: secretSentinel } }
  }));
  check('ext.settings.update persists all public types and accepts a secretRef', !savedSettingsResult.threw
    && savedSettingsResult.value?.values?.enabled === false
    && savedSettingsResult.value?.values?.displayName === 'CetaMesh'
    && savedSettingsResult.value?.values?.interval === 25
    && savedSettingsResult.value?.values?.mode === 'fast'
    && savedSettingsResult.value?.values?.apiToken?.configured === true, String(savedSettingsResult.code));
  check('secretRef value never appears in Extension settings DTOs', !JSON.stringify(savedSettingsResult.value ?? {}).includes(secretSentinel));
  const publicSettingsFile = path.join(settingsDir, 'extensions', 'settings', 'test.settings.json');
  const publicSettings = readJsonFile(publicSettingsFile, { missing: null });
  check('public settings persist only through JSON Storage Primitive and contain no secret', Boolean(publicSettings)
    && !JSON.stringify(publicSettings).includes(secretSentinel));
  const privateSettingsFile = path.join(settingsDir, 'extensions', 'private-settings', 'test.settings.json');
  const privateSettings = readJsonFile(privateSettingsFile, { missing: null });
  check('secretRef is persisted in Extension private storage', Boolean(privateSettings)
    && Object.values(privateSettings).includes(secretSentinel));
  const desktopUiSettings = createDesktopUiService({ services: { extensionService: settingsService } });
  const rendererSettingsResult = await asyncCapture(() => desktopUiSettings.execute({
    method: 'ui.extensions.settings.get', params: { id: 'test.settings' }
  }));
  check('Harbor DTO contains a configured marker and never the secret value', !rendererSettingsResult.threw
    && rendererSettingsResult.value?.values?.apiToken?.configured === true
    && !JSON.stringify(rendererSettingsResult.value ?? {}).includes(secretSentinel), String(rendererSettingsResult.code));
  const restoredSettingsService = createExtensionService({ stateDir: settingsDir, fetchImpl: fakeFetch });
  runtimeCleanups.push(() => restoredSettingsService.close());
  const restoredSettings = await asyncCapture(() => restoredSettingsService.execute({
    method: 'ext.settings.get', params: { id: 'test.settings' }
  }));
  check('public settings and secretRef configured status survive service restart', !restoredSettings.threw
    && restoredSettings.value?.values?.displayName === 'CetaMesh'
    && restoredSettings.value?.values?.apiToken?.configured === true, String(restoredSettings.code));
  const clearedSettings = await asyncCapture(() => restoredSettingsService.execute({
    method: 'ext.settings.update', params: { id: 'test.settings', values: { apiToken: null } }
  }));
  check('secretRef can be cleared without disclosing it', !clearedSettings.threw
    && clearedSettings.value?.values?.apiToken?.configured === false
    && !JSON.stringify(clearedSettings.value ?? {}).includes(secretSentinel), String(clearedSettings.code));
  const ipcService = createExtensionService({ stateDir: svcDir, fetchImpl: fakeFetch });
  runtimeCleanups.push(() => ipcService.close());
  const dispatch = ({ method, params }) => {
    if (method.startsWith('ext.')) return ipcService.execute({ method, params });
    throw new Error('unexpected method ' + method);
  };
  const input = new PassThrough({ autoDestroy: false });
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(Buffer.from(c)));
  const ipc = startIpcProtocol({ input, output, dispatch });
  const encode = (payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); return frame;
  };
  const req = (id, method, params) => ({ version: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params }) });
  input.write(encode(req('e1', 'ext.overview', {})));
  input.write(encode(req('e2', 'ext.invoke', { id: 'cetamesh.hello-tool', capability: 'hello.greet', input: { name: 'IPC2' } })));
  input.end();
  await ipc.done;
  const frames = [];
  {
    const buffer = Buffer.concat(chunks); let offset = 0;
    while (offset + 4 <= buffer.length) {
      const size = buffer.readUInt32LE(offset);
      frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString('utf8')));
      offset += 4 + size;
    }
  }
  const ovFrame = frames.find((f) => f.id === 'e1');
  const invFrame = frames.find((f) => f.id === 'e2');
  check('IPC ext.overview 往返成功', Boolean(ovFrame && ovFrame.ok === true), JSON.stringify(ovFrame && ovFrame.error));
  check('IPC ext.invoke 往返成功', Boolean(invFrame && invFrame.ok === true), JSON.stringify(invFrame && invFrame.error));
  equal('IPC ext.invoke 结果正确', invFrame && invFrame.result.result.greeting, 'Hello, IPC2!');
  await ipcService.close();
  const svcRemoved = await service.execute({ method: 'ext.uninstall', params: { id: 'cetamesh.hello-tool' } });
  check('service ext.uninstall removes the registry row and managed package', svcRemoved.removedFiles && service.store.get('cetamesh.hello-tool') === null);
  await service.close();
  await runtime.close();
  await restarted.close();
  fs.rmSync(svcDir, { recursive: true, force: true });
} finally {
  for (const close of runtimeCleanups) {
    try { await close(); } catch (error) { console.warn('Extension runtime cleanup failed:', error?.message || error); }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('Desktop Extension v1 验收全部通过（阶段 10）');
