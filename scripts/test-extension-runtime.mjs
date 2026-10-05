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
  scanEntrySource,
  validateManifest,
  buildReview,
  reviewSummaryLines
} from '../src/extension/index.js';
import { startIpcProtocol, IPC_PROTOCOL_VERSION } from '../src/control/ipc-protocol.js';

let passed = 0;
let failed = 0;
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
const fakeFetch = async (url) => ({
  status: 200,
  body: '<html><head><title>Example Domain</title></head><body>hi</body></html>',
  url
});

try {
  const store = createExtensionStore({ stateDir: root });
  const runtime = createExtensionRuntime({ store, fetchImpl: fakeFetch });

  // ── 1. 无敏感权限的简单 Tool：审查 -> 安装 ─────────────────────────────
  const helloReview = runtime.review({ sourceDir: HELLO });
  equal('Tool 扩展审查风险等级为 low', helloReview.review.riskLevel, 'low');
  equal('Tool 扩展不需要显式批准', helloReview.review.requiresExplicitApproval, false);
  equal('Tool 扩展可安装（无 blocker）', helloReview.review.installable, true);
  equal('Tool 扩展声明能力', helloReview.review.capabilities.map((c) => c.id), ['hello.greet']);
  equal('Tool 扩展权限仅 log', helloReview.review.permissions.map((p) => p.name), ['log']);
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
  const disabled = runtime.disable({ id: 'cetamesh.hello-tool' });
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
  const notNewer = capture(() => runtime.update({ sourceDir: v1Same }));
  check('同版本更新被拒绝', notNewer.threw && notNewer.code === 'VERSION_NOT_NEWER', String(notNewer.code));

  const v11 = writeExtension('upd-110', baseManifest({ id: 'test.updatable', version: '1.1.0', permissions: ['storage'] }), 'module.exports.handlers={"sample.run":()=>({v:11})};');
  const escalate = capture(() => runtime.update({ sourceDir: v11 }));
  check('新增权限的更新需要重新批准', escalate.threw && escalate.code === 'APPROVAL_REQUIRED', String(escalate.code));
  check('拒绝信息点明新增权限', escalate.message.includes('storage'), escalate.message);

  const v11Review = runtime.review({ sourceDir: v11 }).review;
  const updated = runtime.update({ sourceDir: v11, approval: { approved: true, token: v11Review.token } });
  equal('批准后更新成功', updated.entry.version, '1.1.0');
  equal('记录了权限差异', updated.permissionDelta.added, ['storage']);

  // ── 13. 重启持久化 ────────────────────────────────────────────────────
  const restartedStore = createExtensionStore({ stateDir: root });
  const restarted = createExtensionRuntime({ store: restartedStore, fetchImpl: fakeFetch });
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
  const uninstalled = restarted.uninstall({ id: 'cetamesh.hello-tool' });
  equal('卸载返回被移除的版本', uninstalled.version, '1.0.0');
  check('注册表条目已移除', restartedStore.get('cetamesh.hello-tool') === null);
  check('受管包目录已删除', fs.existsSync(packageDir) === false);
  check('用户的来源目录未被触碰', fs.existsSync(path.join(HELLO, 'extension.json')) === true);
  const uninstallAgain = capture(() => restarted.uninstall({ id: 'cetamesh.hello-tool' }));
  check('重复卸载被拒绝', uninstallAgain.threw && uninstallAgain.code === 'NOT_INSTALLED', String(uninstallAgain.code));

  const overview = restarted.overview();
  equal('overview 总数正确', overview.total, restartedStore.list().length);
  check('overview 列出已启用数量', typeof overview.enabled === 'number');

  // ── 15. Service 层 + IPC 往返 ─────────────────────────────────────────
  const svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ext-svc-'));
  const service = createExtensionService({ stateDir: svcDir, fetchImpl: fakeFetch });
  const svcReview = await service.execute({ method: 'ext.review', params: { sourceDir: HELLO } });
  check('service ext.review 可用', svcReview.review.id === 'cetamesh.hello-tool');
  const svcInstall = await service.execute({ method: 'ext.install', params: { sourceDir: HELLO } });
  equal('service ext.install 可用', svcInstall.entry.id, 'cetamesh.hello-tool');
  await service.execute({ method: 'ext.enable', params: { id: 'cetamesh.hello-tool' } });
  const svcInvoke = await service.execute({ method: 'ext.invoke', params: { id: 'cetamesh.hello-tool', capability: 'hello.greet', input: { name: 'IPC' } } });
  equal('service ext.invoke 可用', svcInvoke.result.greeting, 'Hello, IPC!');
  const svcOverview = await service.execute({ method: 'ext.overview', params: {} });
  equal('service ext.overview 可用', svcOverview.total, 1);
  const unknownMethod = await asyncCapture(() => service.execute({ method: 'ext.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknownMethod.threw && unknownMethod.code === 'METHOD_NOT_FOUND', String(unknownMethod.code));

  const ipcService = createExtensionService({ stateDir: svcDir, fetchImpl: fakeFetch });
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
  fs.rmSync(svcDir, { recursive: true, force: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('Desktop Extension v1 验收全部通过（阶段 10）');
