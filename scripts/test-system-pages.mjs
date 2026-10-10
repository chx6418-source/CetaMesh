// CetaMesh Desktop — 系统页面（Settings / About / Update / Diagnostics / 日志脱敏）验收测试（阶段 12）。
// 用法：node scripts/test-system-pages.mjs
//
// 覆盖验收项：
//   Settings 重启持久化 / About Version 与构建版本一致 / Update 网络异常时不影响主应用启动。
// 另覆盖：安全更新流程（签名、版本比较、release notes、下载链接与安装器接力）、
//         工程页面归位、日志默认脱敏。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  createSettingsService,
  createSettingsStore,
  defaultSettings,
  describeFields,
  engineeringPlacement,
  PRIMARY_PAGES,
  ENGINEERING_PAGES
} from '../src/settings/index.js';
import { createAboutInfo, createAboutService, readShellVersion, PRODUCT_NAME } from '../src/about/index.js';
import {
  createUpdateChecker, createUpdateService, signManifest, validateManifest,
  verifyManifestSignature, UPDATE_MANIFEST_VERSION, compareVersions
} from '../src/update/index.js';
import { createRedactingSink, redactLogLine, redactObject, redactText } from '../src/logging/index.js';
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-system-test-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pinnedPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com'];

function makeManifest(over = {}) {
  const base = {
    schemaVersion: UPDATE_MANIFEST_VERSION,
    channel: 'stable',
    version: '1.0.0',
    releasedAt: '2026-10-04T00:00:00Z',
    notes: ['修复已知问题', '新增 About 与更新页面'],
    downloadUrl: 'https://github.com/chx6418-source/whalebridge/releases/download/v1.0.0/CetaMesh-Setup.exe',
    sha256: 'a'.repeat(64),
    ...over
  };
  base.signature = signManifest(base, privateKeyPem);
  return base;
}
const jsonResponse = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, text: async () => body });
const fetchOnce = (manifest) => async () => jsonResponse(JSON.stringify(manifest));

try {
  // ── 1. Settings 模型 ──────────────────────────────────────────────────
  const defaults = defaultSettings();
  equal('设置分区为 10 个', Object.keys(defaults).length, 10);
  equal('分区顺序符合要求', Object.keys(defaults), ['general', 'models', 'agents', 'memory', 'workspace', 'devices', 'extensions', 'security', 'updates', 'advanced']);
  equal('默认日志脱敏开启', defaults.security.redactLogs, true);
  equal('默认长期记忆需确认开启', defaults.memory.requireConfirmationForLongTerm, true);
  equal('默认远程能力需批准开启', defaults.devices.requireApprovalForRemoteCapabilities, true);
  equal('默认扩展高风险需批准开启', defaults.extensions.requireReviewApproval, true);
  equal('默认不自动检查更新', defaults.updates.autoCheck, false);

  const described = describeFields();
  const lockedKeys = described.flatMap((s) => s.fields.filter((f) => f.locked).map((f) => s.section + '.' + f.key));
  equal('有 4 个锁定安全项', lockedKeys.length, 4);
  check('字段元数据带 label 与描述', described.every((s) => s.label && s.fields.every((f) => f.description !== undefined)));

  // ── 2. Settings 持久化与校验 ───────────────────────────────────────────
  const store = createSettingsStore({ stateDir: root });
  const before = store.get();
  equal('初始 revision 为 0', before.revision, 0);
  const updated = store.update('general', { theme: 'dark', startMinimized: true });
  equal('更新后 revision 递增', updated.revision, 1);
  equal('更新生效', [updated.settings.general.theme, updated.settings.general.startMinimized], ['dark', true]);

  const restarted = createSettingsStore({ stateDir: root });
  const reloaded = restarted.get();
  equal('重启后设置保持', [reloaded.settings.general.theme, reloaded.settings.general.startMinimized], ['dark', true]);
  equal('重启后 revision 保持', reloaded.revision, 1);
  check('设置文件已落盘', fs.existsSync(path.join(root, 'settings', 'settings.json')));

  const locked = capture(() => restarted.update('security', { redactLogs: false }));
  check('锁定项不能关闭', locked.threw && locked.code === 'LOCKED_SETTING', String(locked.code));
  equal('锁定项保持安全默认', restarted.get().settings.security.redactLogs, true);

  const badEnum = capture(() => restarted.update('general', { theme: 'neon' }));
  check('枚举校验生效', badEnum.threw && badEnum.code === 'SETTINGS_INVALID', String(badEnum.code));
  const badSection = capture(() => restarted.update('nope', { a: 1 }));
  check('未知分区被拒绝', badSection.threw && badSection.code === 'UNKNOWN_SECTION', String(badSection.code));
  const badKey = capture(() => restarted.update('general', { nope: 1 }));
  check('未知设置项被拒绝', badKey.threw && badKey.code === 'UNKNOWN_SETTING', String(badKey.code));
  const conflict = capture(() => restarted.update('general', { theme: 'light' }, { expectedRev: 99 }));
  check('rev 冲突被拒绝', conflict.threw && conflict.code === 'SETTINGS_CONFLICT', String(conflict.code));
  const badRange = capture(() => restarted.update('memory', { retrievalLimit: 999 }));
  check('数值范围校验生效', badRange.threw && badRange.code === 'SETTINGS_INVALID', String(badRange.code));

  restarted.update('models', { defaultModel: 'deepseek-x' });
  equal('整节恢复默认', restarted.reset('models').settings.models.defaultModel, 'deepseek-flash');

  // 损坏的 settings.json 不能阻断启动
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-system-corrupt-'));
  fs.mkdirSync(path.join(corruptDir, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'settings', 'settings.json'), '{ not json', 'utf8');
  const corruptStore = createSettingsStore({ stateDir: corruptDir });
  const corruptGet = capture(() => corruptStore.get());
  check('损坏设置文件不抛错', corruptGet.threw === false);
  equal('损坏后回落默认值', corruptGet.value.settings.security.redactLogs, true);
  check('损坏情况如实上报', typeof corruptGet.value.lastError === 'string' && corruptGet.value.lastError.length > 0);
  fs.rmSync(corruptDir, { recursive: true, force: true });

  // ── 3. About：Version 与构建版本一致 ──────────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const cargoVersion = readShellVersion(path.join(repoRoot, 'desktop-shell', 'Cargo.toml'));
  const about = createAboutInfo({ rootDir: repoRoot, execGit: () => 'abc1234' });
  const info = about.info();
  equal('About 产品名', [info.product, info.edition], [PRODUCT_NAME, 'Desktop']);
  equal('About Version 来自 package.json', info.version, pkg.version);
  equal('About shellVersion 来自 Cargo.toml', info.shellVersion, cargoVersion);
  equal('Version 与构建版本一致', info.versionConsistent, true);
  equal('About commit 来自构建元数据来源', info.build.commit, 'abc1234');
  equal('About 许可证', info.license, 'GPL-3.0-only');
  check('About 给出开源仓库地址', info.repository.includes('github.com'));
  check('About 给出运行时信息', Boolean(info.runtime.node && info.runtime.platform && info.runtime.arch));
  equal('打包态且无 build-info 时 commit 不编造', createAboutInfo({ rootDir: repoRoot, packaged: true, execGit: () => 'abc1234' }).info().build.commit, 'unknown');

  const withBuildInfo = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-system-build-'));
  fs.writeFileSync(path.join(withBuildInfo, 'build-info.json'), JSON.stringify({ commit: 'deadbee', buildTime: '2026-10-04T12:00:00Z', buildId: 'ci-42' }), 'utf8');
  const bi = createAboutInfo({ rootDir: repoRoot, buildInfoFile: path.join(withBuildInfo, 'build-info.json'), packaged: true }).info();
  equal('build-info.json 优先于 git', [bi.build.commit, bi.build.buildTime, bi.build.buildId], ['deadbee', '2026-10-04T12:00:00Z', 'ci-42']);
  fs.rmSync(withBuildInfo, { recursive: true, force: true });

  // ── 4. Update：安全边界 ───────────────────────────────────────────────
  equal('版本比较：预发布递增', compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1);
  equal('版本比较：正式版高于预发布', compareVersions('1.0.0', '1.0.0-rc.2'), 1);
  equal('版本比较：预发布仍高于更早的正式版', compareVersions('1.0.0-rc.1', '0.9.9'), 1);
  equal('版本比较：相同版本为 0', compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  equal('版本比较：忽略 build metadata', compareVersions('1.0.0+build.5', '1.0.0'), 0);
  equal('版本比较：数字标识小于字母标识', compareVersions('1.0.0-1', '1.0.0-alpha'), -1);

  const checker = createUpdateChecker({ currentVersion: pkg.version, fetchImpl: fetchOnce(makeManifest()) });
  equal('更新能力边界：不下载、不执行', [checker.capabilities().canDownload, checker.capabilities().canExecuteInstaller], [false, false]);
  check('更新器没有 download/execute/install 入口',
    !('download' in checker) && !('execute' in checker) && !('install' in checker) && !('run' in checker));
  equal('更新器只暴露 check 与 capabilities', Object.keys(checker).sort(), ['capabilities', 'check', 'currentVersion']);

  const noKey = await checker.check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey: '', channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('未配置签名公钥 -> 拒绝检查', noKey.ok === false && noKey.code === 'NO_PINNED_KEY', String(noKey.code));
  const noUrl = await checker.check({ manifestUrl: '', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('未配置清单地址 -> 跳过', noUrl.ok === false && noUrl.code === 'NO_MANIFEST_URL', String(noUrl.code));
  const insecure = await checker.check({ manifestUrl: 'http://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('清单地址必须 https', insecure.ok === false && insecure.code === 'INSECURE_MANIFEST_URL', String(insecure.code));

  const good = await checker.check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('合法已签名清单 -> 有新版', good.ok === true && good.updateAvailable === true, JSON.stringify(good).slice(0, 160));
  equal('返回 release notes', good.notes.length, 2);
  equal('返回下载链接', good.download.url.startsWith('https://github.com/'), true);
  equal('安装器接力需要用户确认', good.handoff.requiresUserConfirmation, true);
  check('接力信息说明不会静默执行', good.handoff.note.includes('不会静默执行'));

  const tampered = makeManifest();
  tampered.version = '9.9.9';
  const badSig = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: fetchOnce(tampered) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('被篡改的清单 -> 签名失败', badSig.ok === false && badSig.code === 'SIGNATURE_INVALID', String(badSig.code));

  const otherKey = crypto.generateKeyPairSync('ed25519');
  const foreign = makeManifest();
  foreign.signature = signManifest(foreign, otherKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const foreignSig = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: fetchOnce(foreign) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('他人私钥签名的清单 -> 签名失败', foreignSig.ok === false && foreignSig.code === 'SIGNATURE_INVALID', String(foreignSig.code));

  const untrustedHost = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: fetchOnce(makeManifest()) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ['other.example'] });
  check('下载主机不在允许列表 -> 拒绝', untrustedHost.ok === false && untrustedHost.code === 'DOWNLOAD_HOST_NOT_ALLOWED', String(untrustedHost.code));

  const upToDate = await createUpdateChecker({ currentVersion: '99.0.0', fetchImpl: fetchOnce(makeManifest()) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  equal('版本更高时无更新', [upToDate.ok, upToDate.updateAvailable, upToDate.reason], [true, false, 'UP_TO_DATE']);

  const channelMiss = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: fetchOnce(makeManifest({ channel: 'beta' })) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  equal('通道不匹配', [channelMiss.updateAvailable, channelMiss.reason], [false, 'CHANNEL_MISMATCH']);

  const insecureUrl = makeManifest({ downloadUrl: 'http://github.com/x.exe' });
  const insecureDownload = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: fetchOnce(insecureUrl) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('下载地址必须 https', insecureDownload.ok === false && insecureDownload.code === 'MANIFEST_INSECURE_URL', String(insecureDownload.code));

  const badJson = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: async () => jsonResponse('<html>nope</html>') })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('非法 JSON -> BODY_INVALID', badJson.ok === false && badJson.code === 'BODY_INVALID', String(badJson.code));

  const http500 = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: async () => jsonResponse('{}', 500) })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('非 2xx -> HTTP_ERROR', http500.ok === false && http500.code === 'HTTP_ERROR', String(http500.code));

  // ── 5. Update：网络异常不影响主应用 ──────────────────────────────────
  const failingFetch = async () => { throw new Error('getaddrinfo ENOTFOUND example.com'); };
  const netCheck = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: failingFetch })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS });
  check('网络异常 -> 结构化失败而非抛出', netCheck.ok === false && netCheck.code === 'NETWORK_ERROR', String(netCheck.code));

  const timeoutFetch = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const timedOut = await createUpdateChecker({ currentVersion: pkg.version, fetchImpl: timeoutFetch, timeoutMs: 60 })
    .check({ manifestUrl: 'https://example.com/m.json', pinnedPublicKey, channel: 'stable', allowedHosts: ALLOWED_HOSTS, timeout: 60 });
  check('超时 -> TIMEOUT', timedOut.ok === false && timedOut.code === 'TIMEOUT', String(timedOut.code));

  // 网络完全不可用时，Settings 与 About 照常工作；且构造 Update 服务不发起任何网络请求
  let fetchCalls = 0;
  const countingFetch = async () => { fetchCalls += 1; throw new Error('offline'); };
  const settingsService = createSettingsService({ stateDir: root });
  const aboutService = createAboutService({ rootDir: repoRoot, execGit: () => 'abc1234' });
  const updateService = createUpdateService({ currentVersion: pkg.version, settingsStore: settingsService.store, fetchImpl: countingFetch });
  equal('构造 Update 服务不发网络请求', fetchCalls, 0);
  const offlineSettings = await settingsService.execute({ method: 'settings.get', params: {} });
  check('离线时 Settings 可用', offlineSettings.settings.security.redactLogs === true);
  const offlineAbout = await aboutService.execute({ method: 'about.info', params: {} });
  equal('离线时 About 可用', offlineAbout.about.version, pkg.version);
  // 先只配清单地址（不配公钥）：验证「没有固定公钥就不信任」这条 fail-closed 在服务层同样成立。
  settingsService.store.update('updates', { manifestUrl: 'https://example.com/m.json' });
  const offlineCheck = await updateService.execute({ method: 'update.check', params: {} });
  check('未配置公钥时不信任任何清单', offlineCheck.ok === false && offlineCheck.code === 'NO_PINNED_KEY', String(offlineCheck.code));
  equal('离线检查发生后其它功能仍正常', (await aboutService.execute({ method: 'about.info', params: {} })).about.product, 'CetaMesh');

  // 服务读取设置里的更新配置
  settingsService.store.update('updates', { pinnedPublicKey });
  settingsService.store.update('security', { allowedUpdateHosts: 'github.com,objects.githubusercontent.com' });
  const viaSettings = await updateService.execute({ method: 'update.check', params: {} });
  check('update.check 使用设置里的清单与公钥', viaSettings.ok === false && viaSettings.code === 'NETWORK_ERROR', String(viaSettings.code));
  equal('配置里不回显公钥明文', (await updateService.execute({ method: 'update.config', params: {} })).config.pinnedPublicKey, '[configured]');

  // ── 6. 日志默认脱敏 ───────────────────────────────────────────────────
  check('API key 被脱敏', redactText('apiKey=sk-live-abcdef1234567890').includes('[REDACTED:apiKey]'));
  check('token 被脱敏', redactText('access_token: abcdef1234567890').includes('[REDACTED:token]'));
  const bearer = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload');
  check('Bearer token 的值被抹掉（不是只抹掉 Bearer 这个词）', !bearer.includes('eyJhbGciOiJIUzI1NiJ9') && bearer.includes('[REDACTED:token]'), bearer);
  check('裸 Bearer 的值被抹掉', !redactText('Bearer abcd1234efgh').includes('abcd1234efgh'));
  check('Authorization 直接跟 token 也被抹掉', !redactText('Authorization: eyJhbGciOiJIUzI1NiJ9').includes('eyJhbGciOiJIUzI1NiJ9'));
  check('cookie 被抹掉', !redactText('cookie: session=abcdef123456').includes('abcdef123456'));
  check('配对密钥被脱敏', redactText('pairingSecret=0123456789abcdef').includes('[REDACTED:pairingSecret]'));
  check('凭据被脱敏', redactText('password = hunter2xyz').includes('[REDACTED:credential]'));
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkq9w==\n-----END PRIVATE KEY-----';
  const redactedPem = redactText(pem);
  check('私钥整块被脱敏', redactedPem.includes('[REDACTED:privateKey]') && !redactedPem.includes('MIIEvQIBADANBg'));
  check('普通文本不被误伤', redactText('任务 42 已完成，用时 3 分钟').includes('已完成'));

  const structured = redactObject({
    level: 'info',
    prompt: '这是完整的敏感 prompt 内容',
    messages: [{ role: 'user', content: 'x' }],
    nested: { token: 'abcdef1234567890', note: 'token=abcdef1234567890' },
    safe: 'nothing secret here'
  });
  check('字段层：prompt 整体替换为摘要', structured.prompt.includes('[REDACTED:sensitive') && !structured.prompt.includes('敏感 prompt 内容'));
  check('字段层：messages 只报条目数', String(structured.messages[0]).includes('items=1'));
  check('字段层：嵌套 token 被处理', String(structured.nested.token).includes('[REDACTED:sensitive'));
  check('文本层：嵌套字符串里的 token 被处理', String(structured.nested.note).includes('[REDACTED:token]'));
  equal('非敏感字段保持原样', structured.safe, 'nothing secret here');
  check('序列化后的日志行不含原始 prompt', !redactLogLine({ prompt: '绝密内容 AAAA' }).includes('绝密内容 AAAA'));

  const sinkOutput = [];
  const sink = createRedactingSink((entry) => sinkOutput.push(entry));
  sink({ event: 'call', apiKey: 'sk-abcdef1234567890' });
  sink('plain log with token=abcdef1234567890');
  check('脱敏 sink 对对象生效', JSON.stringify(sinkOutput[0]).includes('[REDACTED:sensitive') || JSON.stringify(sinkOutput[0]).includes('[REDACTED:apiKey]'));
  check('脱敏 sink 对字符串生效', sinkOutput[1].includes('[REDACTED:token]'));
  const disabledSink = capture(() => createRedactingSink(() => {}, { enabled: false }));
  check('脱敏不能被关闭', disabledSink.threw && disabledSink.code === 'REDACTION_REQUIRED', String(disabledSink.code));

  // ── 7. 工程页面归位 ───────────────────────────────────────────────────
  const placement = engineeringPlacement();
  equal('工程页面不变量成立', placement.ok, true);
  equal('没有工程页残留在产品主区', placement.leakedIntoPrimary, []);
  equal('产品导航统一为 CetaMesh Desktop 概念', [...PRIMARY_PAGES], ['home', 'chat', 'work', 'social', 'agents', 'plugins', 'memory', 'workspaces', 'devices', 'connections', 'security', 'settings']);
  equal('工程页面共 7 个', ENGINEERING_PAGES.length, 7);
  for (const label of ['Core status', 'DSH service', 'SnowLuma（Channel Adapter）', 'IPC', 'Logs', 'Whitelists', 'Runtime policy']) {
    check('工程页面已归位：' + label, ENGINEERING_PAGES.some((p) => p.label === label));
  }
  equal('Logs 归入 diagnostics', ENGINEERING_PAGES.find((p) => p.id === 'logs').area, 'diagnostics');
  equal('Runtime policy 归入 advanced', ENGINEERING_PAGES.find((p) => p.id === 'policy.runtime').area, 'advanced');

  // ── 8. IPC 往返 ───────────────────────────────────────────────────────
  const dispatch = ({ method, params }) => {
    if (method.startsWith('settings.')) return settingsService.execute({ method, params });
    if (method.startsWith('about.')) return aboutService.execute({ method, params });
    if (method.startsWith('update.')) return updateService.execute({ method, params });
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
  input.write(encode(req('s1', 'settings.get', {})));
  input.write(encode(req('s2', 'settings.describe', {})));
  input.write(encode(req('a1', 'about.info', {})));
  input.write(encode(req('u1', 'update.capabilities', {})));
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
  for (const [id, name] of [['s1', 'settings.get'], ['s2', 'settings.describe'], ['a1', 'about.info'], ['u1', 'update.capabilities']]) {
    const frame = frames.find((f) => f.id === id);
    check('IPC ' + name + ' 往返成功', Boolean(frame && frame.ok === true), JSON.stringify(frame && frame.error));
  }
  equal('IPC about.info 返回一致版本', frames.find((f) => f.id === 'a1').result.about.version, pkg.version);
  const unknown = await asyncCapture(() => settingsService.execute({ method: 'settings.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknown.threw && unknown.code === 'METHOD_NOT_FOUND', String(unknown.code));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('系统页面（Settings / About / Update / Diagnostics / 脱敏）验收全部通过（阶段 12）');
