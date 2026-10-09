// CetaMesh Desktop —— 产品化任务 D 验收：About / 更新公告 / Feedback / 诊断 redaction / 离线队列 / 重试。
// 用法：node scripts/test-product-services.mjs
//
// 覆盖验收项（对应任务书第十节）：
//   About build info（版本不写死、构建/发布清单、未配置不编造）
//   Update notes（title/version/publishedAt/notes + 纯文本安全渲染 + 离线缓存）
//   Feedback redaction（白名单诊断，绝不带 Key/token/聊天/Memory/文件正文/私钥）
//   Offline feedback queue（无 endpoint 也能提交、落盘、不阻塞）
//   Retry（5xx 退避重试、4xx 不可重试、未到点不重发）
//   装配与 IPC 可达性（feedback./onboarding./product. 三个新命名空间）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAboutInfo, createAboutService, readReleaseManifest } from '../src/about/index.js';
import {
  DEFAULT_GITHUB_FALLBACK_MANIFEST_URL,
  UPDATE_MANIFEST_VERSION,
  buildReleaseAnnouncement,
  createNotesCache,
  createUpdateChecker,
  createUpdateService,
  plainTextFromMarkdown,
  signManifest
} from '../src/update/index.js';
import {
  createFeedbackOutbox,
  createFeedbackService,
  createFeedbackTransport
} from '../src/feedback/index.js';
import { DIAGNOSTICS_POLICY, buildDiagnostics, sanitizeDiagnostics } from '../src/product/diagnostics.js';
import { createErrorRegistry } from '../src/product/error-registry.js';
import { loadReleaseConfig } from '../src/product/release-config.js';

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
const asyncCapture = async (fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const jsonFetch = (status, body = '{}') => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

const repoRoot = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const workDirs = [];
const originalDataDir = process.env.WHALEBRIDGE_DATA_DIR;
const track = (dir) => { workDirs.push(dir); return dir; };

/** 故意"脏"的诊断来源：既含非白名单字段，也含应被二次脱敏的字符串。 */
const dirtyDiagnostics = () => ({
  schemaVersion: 1,
  generatedAt: '2026-10-09T00:00:00Z',
  product: { name: 'CetaMesh', edition: 'Desktop', version: '1.0.0-rc.1', shellVersion: '1.0.0-rc.1', versionConsistent: true },
  build: { buildId: 'ci-42', commit: 'deadbee', commitSource: 'build-info', buildTime: '2026-10-09T00:00:00Z' },
  platform: { os: 'win32', arch: 'x64', node: '24.19.0' },
  providers: [{ id: 'deepseek-official', label: 'apiKey=sk-live-abcdef1234567890', hasKey: true }],
  plugins: { total: 2, enabled: 1, disabled: 1 },
  settings: { theme: 'dark', autoCheckUpdates: false, redactLogs: true },
  lastErrorCode: 'TOOL_DENIED',
  recentErrorCodes: ['TOOL_DENIED'],
  // 以下字段**不在白名单**：任何一条出现在附件里都是缺陷。
  apiKey: 'sk-live-abcdef1234567890',
  token: 'ghp_abcdefghijklmnopqrst',
  chatContent: '用户与模型的聊天正文',
  memory: '长期记忆正文',
  fileBody: '文件正文内容',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
});

try {
  // ── 1. About：构建信息与发行事实 ────────────────────────────────────────
  const info = createAboutInfo({ rootDir: repoRoot, execGit: () => 'abc1234' }).info();
  equal('About 版本来自 package.json（不写死）', info.version, pkg.version);
  equal('About 平台含系统与架构', [info.platform.os, info.platform.arch], [process.platform, process.arch]);
  check('About 平台描述可直接展示', typeof info.platform.label === 'string' && info.platform.label.length > 0, info.platform.label);
  equal('开发者未配置时不编造', info.developer, { name: null, configured: false });
  equal('官网未配置时不编造', [info.links.website, info.links.websiteConfigured], [null, false]);
  check('About 给出 GitCode 与 GitHub', info.links.gitcode.includes('gitcode.com') && info.links.github.includes('github.com'));
  equal('About 许可证名称', info.legal.license.name, 'GPL-3.0-only');
  check('About 隐私说明读自文档', info.legal.privacy.available === true && String(info.legal.privacy.summary).length > 0);
  check('About 安全说明读自文档', info.legal.security.available === true && String(info.legal.security.summary).length > 0);
  equal('安全联系入口由 GitHub 私密报告推导', info.legal.security.contactSource, 'github-advisories');
  check('安全联系入口是 https', String(info.legal.security.contact).startsWith('https://'));
  equal('无发布清单时如实报不可用', [info.release.available, info.release.version], [false, null]);

  const buildDir = track(tmpDir('cetamesh-d-build-'));
  fs.writeFileSync(path.join(buildDir, 'build-info.json'), JSON.stringify({ commit: 'deadbee', buildTime: '2026-10-09T00:00:00Z', buildId: 'ci-42' }), 'utf8');
  const releaseDir = track(tmpDir('cetamesh-d-release-'));
  fs.writeFileSync(path.join(releaseDir, 'release-manifest.json'), JSON.stringify({
    product: 'CetaMesh', version: '1.0.0-rc.2', buildId: '1.0.0-rc.2+deadbee', commit: 'deadbee', builtAt: '2026-10-09T01:00:00Z', platform: 'windows-x64'
  }), 'utf8');
  const built = createAboutInfo({
    rootDir: repoRoot,
    buildInfoFile: path.join(buildDir, 'build-info.json'),
    releaseManifestFile: path.join(releaseDir, 'release-manifest.json'),
    packaged: true
  }).info();
  equal('build-info.json 提供 Build ID / Commit', [built.build.buildId, built.build.commit], ['ci-42', 'deadbee']);
  equal('读取发布清单（release manifest）', [built.release.available, built.release.version, built.release.buildId], [true, '1.0.0-rc.2', '1.0.0-rc.2+deadbee']);
  check('发布清单缺失路径不抛错', readReleaseManifest(path.join(releaseDir, 'nope.json')).available === false);

  const configured = loadReleaseConfig({
    rootDir: repoRoot,
    read: () => ({
      schemaVersion: 1,
      developer: '示例开发者',
      website: 'https://cetamesh.example.com',
      security: { contact: 'https://security.example.com/report' },
      feedback: { endpoint: 'https://feedback.example.com/v1/feedback' }
    })
  });
  equal('发行配置可提供开发者与官网', [configured.config.developer, configured.config.website], ['示例开发者', 'https://cetamesh.example.com']);
  equal('readiness 反映配置完整度', configured.readiness, {
    developerConfigured: true,
    websiteConfigured: true,
    feedbackEndpointConfigured: true,
    securityContactConfigured: true,
    securityContactSource: 'configured'
  });
  const insecure = loadReleaseConfig({ rootDir: repoRoot, read: () => ({ website: 'http://cetamesh.example.com', feedback: { endpoint: 'http://feedback.example.com' } }) });
  equal('非 https 的官方地址视为未配置', [insecure.config.website, insecure.config.feedback.endpoint], [null, null]);
  const corrupt = loadReleaseConfig({ rootDir: repoRoot, read: () => { throw Object.assign(new Error('bad json'), { code: 'CORRUPT' }); } });
  equal('发行配置损坏时如实上报并回落默认值', [corrupt.lastError, corrupt.source, corrupt.config.product], ['CORRUPT', 'defaults', 'CetaMesh']);

  // ── 2. 更新公告：安全渲染 ──────────────────────────────────────────────
  const announcement = buildReleaseAnnouncement({
    version: '1.0.0-rc.2',
    title: '<b>稳定性更新</b>',
    publishedAt: '2026-10-09T00:00:00Z',
    notes: ['修复更新检查', '<script>alert(1)</script>不可注入', '[点我](javascript:alert(2))不可执行', '<b>加粗</b>文本'],
    source: 'gitcode'
  });
  equal('公告含 version/title/publishedAt', [announcement.version, announcement.title, announcement.publishedAt], ['1.0.0-rc.2', '稳定性更新', '2026-10-09T00:00:00Z']);
  equal('公告声明为纯文本', announcement.format, 'plain-text');
  const flatNotes = announcement.notes.join('\n');
  check('公告不含 script 标签', !flatNotes.includes('<script') && !announcement.text.includes('<script'));
  check('公告不含可执行链接目标', !flatNotes.includes('javascript:') && !announcement.text.includes('javascript:'));
  check('公告保留可读的正常文本', flatNotes.includes('修复更新检查') && flatNotes.includes('加粗'));
  check('Markdown 渲染成纯文本', plainTextFromMarkdown('**粗体** 与 `代码`').includes('粗体'));

  // ── 3. 更新检查 → 公告缓存 → About 离线展示 ─────────────────────────────
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pinnedPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const manifest = {
    schemaVersion: UPDATE_MANIFEST_VERSION,
    channel: 'stable',
    version: '1.0.0-rc.2',
    title: '<b>CetaMesh 1.0 RC2</b>',
    publishedAt: '2026-10-09T00:00:00Z',
    notes: ['<script>alert(1)</script>安全渲染', '修复更新检查'],
    downloadUrl: 'https://github.com/chx6418-source/whalebridge/releases/download/v1.0.0-rc.2/CetaMesh-Setup.exe',
    sha256: 'a'.repeat(64)
  };
  manifest.signature = signManifest(manifest, privateKeyPem);

  const cacheDir = track(tmpDir('cetamesh-d-cache-'));
  const notesCache = createNotesCache({ stateDir: cacheDir });
  const settingsStore = {
    get: () => ({
      settings: {
        updates: { channel: 'stable', manifestUrl: 'https://example.com/stable.json', fallbackManifestUrl: DEFAULT_GITHUB_FALLBACK_MANIFEST_URL, pinnedPublicKey },
        security: { allowedUpdateHosts: 'github.com' }
      }
    })
  };
  const updateService = createUpdateService({
    currentVersion: pkg.version,
    settingsStore,
    notesCache,
    fetchImpl: jsonFetch(200, JSON.stringify(manifest))
  });
  const checkResult = await updateService.execute({ method: 'update.check', params: {} });
  check('检查更新返回公告标题', checkResult.ok === true && checkResult.updateAvailable === true && String(checkResult.title).includes('CetaMesh'));
  const cached = await updateService.execute({ method: 'update.notes', params: {} });
  check('公告已缓存且离线可读', cached.available === true && cached.record.announcement.notes.length === 2);
  check('缓存公告已安全渲染（无 script）', !JSON.stringify(cached.record.announcement).includes('<script'));
  equal('缓存记录下载源优先级', cached.record.sources.map((s) => s.id), ['gitcode', 'github']);

  const aboutService = createAboutService({ rootDir: repoRoot, notesCache });
  const aboutUpdate = await aboutService.execute({ method: 'about.update', params: {} });
  equal('About 离线显示最近一次更新公告', [aboutUpdate.update.cacheAvailable, aboutUpdate.update.announcement.version], [true, '1.0.0-rc.2']);
  equal('About 更新区块含当前版本', aboutUpdate.update.currentVersion, pkg.version);
  equal('About 更新状态为有新版本', aboutUpdate.update.status, 'update_available');
  check('About 离线也能给出下载源', aboutUpdate.update.sources.length === 2);

  const upToDateChecker = createUpdateChecker({ currentVersion: '99.0.0', fetchImpl: jsonFetch(200, JSON.stringify(manifest)) });
  const upToDate = await upToDateChecker.check({ manifestUrl: 'https://example.com/stable.json', pinnedPublicKey, channel: 'stable', allowedHosts: ['github.com'] });
  equal('无更新时也带上公告字段（About 才能展示）', [upToDate.reason, upToDate.notes.length], ['UP_TO_DATE', 2]);
  check('公告字段经渲染后不含 HTML', !buildReleaseAnnouncement({ version: upToDate.latest, title: upToDate.title, notes: upToDate.notes }).title.includes('<'));

  const failureCache = createNotesCache({ stateDir: track(tmpDir('cetamesh-d-cache2-')) });
  const failingService = createUpdateService({
    currentVersion: pkg.version,
    settingsStore,
    notesCache: failureCache,
    fetchImpl: async () => { throw new Error('offline'); }
  });
  await failingService.execute({ method: 'update.check', params: {} });
  const failedRecord = (await failingService.execute({ method: 'update.notes', params: {} })).record;
  equal('检查失败也如实缓存失败态', [failedRecord.status, failedRecord.failureCode], ['error', 'NETWORK_ERROR']);

  // ── 4. 诊断附件 redaction ─────────────────────────────────────────────
  const sanitized = sanitizeDiagnostics(dirtyDiagnostics());
  const flatDiagnostics = JSON.stringify(sanitized);
  check('丢弃非白名单字段：Key/token/私钥', !flatDiagnostics.includes('ghp_abcdefghijklmnopqrst') && !flatDiagnostics.includes('sk-live-abcdef1234567890') && !flatDiagnostics.includes('MIIEvQIBADANBg'));
  check('丢弃非白名单字段：聊天/Memory/文件正文', !flatDiagnostics.includes('聊天正文') && !flatDiagnostics.includes('长期记忆正文') && !flatDiagnostics.includes('文件正文内容'));
  check('保留白名单字段', sanitized.product.version === '1.0.0-rc.1' && sanitized.providers[0].hasKey === true && sanitized.lastErrorCode === 'TOOL_DENIED');
  check('白名单字段内的凭据字样也被二次脱敏', flatDiagnostics.includes('[REDACTED:apiKey]'));

  const registry = createErrorRegistry();
  registry.record('TOOL_DENIED', { source: 'capability' });
  const builtDiagnostics = buildDiagnostics({
    aboutInfo: info,
    providers: [{ id: 'deepseek-official', label: 'DeepSeek 官方', hasKey: true }],
    extensions: [{ id: 'a', enabled: true }, { id: 'b', enabled: false }],
    settings: { general: { theme: 'dark' }, updates: { autoCheck: false }, security: { redactLogs: true } },
    errorRegistry: registry
  });
  equal('诊断含最近错误码', [builtDiagnostics.lastErrorCode, builtDiagnostics.recentErrorCodes.includes('TOOL_DENIED')], ['TOOL_DENIED', true]);
  equal('诊断含插件启用/关闭计数', builtDiagnostics.plugins, { total: 2, enabled: 1, disabled: 1 });
  check('诊断 Provider 只报布尔状态', builtDiagnostics.providers.every((p) => typeof p.hasKey === 'boolean') && !JSON.stringify(builtDiagnostics).includes('sk-'));
  check('诊断策略向用户明示排除项', DIAGNOSTICS_POLICY.excludes.some((t) => t.includes('API Key')) && DIAGNOSTICS_POLICY.excludes.some((t) => t.includes('聊天内容')));

  // ── 5. Feedback：离线队列 / 安全类型 / 重试 ─────────────────────────────
  const baseConfig = loadReleaseConfig({ rootDir: repoRoot }).config;
  const offlineDir = track(tmpDir('cetamesh-d-fb-'));
  const offlineService = createFeedbackService({ stateDir: offlineDir, releaseConfig: baseConfig, diagnosticsProvider: dirtyDiagnostics });
  const fbConfig = await offlineService.execute({ method: 'feedback.config', params: {} });
  equal('反馈类型为 5 种', fbConfig.types.map((t) => t.id), ['bug', 'feature', 'experience', 'security', 'other']);
  equal('官方反馈地址未配置时如实标注', fbConfig.endpoint.configured, false);
  check('提供官方安全联系入口', String(fbConfig.security.contactUrl).startsWith('https://'));

  const submitted = await offlineService.execute({
    method: 'feedback.submit',
    params: { type: 'bug', title: '点开始就崩溃', description: '启动后立即退出', steps: '1. 双击图标', attachDiagnostics: true }
  });
  equal('反馈服务器不可用不阻塞提交（留本地队列）', [submitted.sent, submitted.queued, submitted.offline], [false, true, true]);
  check('给出用户可读的离线提示', String(submitted.message).includes('本地'));
  check('反馈队列文件已落盘', fs.existsSync(path.join(offlineDir, 'feedback', 'outbox.json')));
  const listed = await offlineService.execute({ method: 'feedback.list', params: {} });
  equal('队列保留用户填写的内容', [listed.entries[0].title, listed.entries[0].type, listed.entries[0].status], ['点开始就崩溃', 'bug', 'queued']);
  check('附加诊断已 redaction 且不含凭据', listed.entries[0].diagnosticsKind === 'full' && !JSON.stringify(listed.entries[0].diagnostics).includes('sk-live-abcdef1234567890'));

  const preview = await offlineService.execute({ method: 'feedback.previewDiagnostics', params: { type: 'bug', attachDiagnostics: false } });
  equal('未勾选时不附加诊断', [preview.kind, preview.payload], ['none', null]);

  const securitySubmit = await offlineService.execute({
    method: 'feedback.submit',
    params: { type: 'security', title: '越权访问', description: '详情仅提供给维护者', attachDiagnostics: true }
  });
  equal('安全反馈强制最小 metadata', [securitySubmit.diagnostics.kind, securitySubmit.diagnostics.attached], ['minimal', true]);
  check('安全反馈给出官方入口与"不要公开提交"提示', securitySubmit.security.notice.includes('不要公开提交') && String(securitySubmit.security.contactUrl).startsWith('https://'));
  const securityEntry = (await offlineService.execute({ method: 'feedback.list', params: {} })).entries.find((e) => e.type === 'security');
  check('安全反馈不自动附加日志', securityEntry.diagnostics.minimal === true && !JSON.stringify(securityEntry.diagnostics).includes('recentErrorCodes'));

  const invalid = await asyncCapture(() => offlineService.execute({ method: 'feedback.submit', params: { type: 'bug', title: '', description: '' } }));
  check('缺标题返回 FEEDBACK_INVALID', invalid.threw && invalid.code === 'FEEDBACK_INVALID', String(invalid.code));

  // 退避重试：5xx → 排队等待；到点 → 成功；4xx → 不可重试
  const clock = { t: 1_700_000_000_000 };
  const retryDir = track(tmpDir('cetamesh-d-retry-'));
  const outbox = createFeedbackOutbox({ stateDir: retryDir, maxEntries: 10, now: () => clock.t });
  const mode = { status: 503 };
  const transport = createFeedbackTransport({
    endpoint: 'https://feedback.example.com/v1/feedback',
    fetchImpl: async () => ({ ok: mode.status >= 200 && mode.status < 300, status: mode.status, text: async () => '{}' }),
    timeoutMs: 1000,
    now: () => clock.t
  });
  const retryService = createFeedbackService({ outbox, transport, releaseConfig: baseConfig, diagnosticsProvider: dirtyDiagnostics, now: () => clock.t });
  const firstAttempt = await retryService.execute({ method: 'feedback.submit', params: { type: 'feature', title: '希望支持导出', description: 'x' } });
  check('服务器 5xx 时留在队列并给出下次重试时间', firstAttempt.queued === true && firstAttempt.errorCode === 'HTTP_ERROR' && typeof firstAttempt.nextAttemptAt === 'string');
  const earlyRetry = await retryService.execute({ method: 'feedback.retry', params: {} });
  equal('未到重试时间不重复发送', earlyRetry.results.length, 0);
  clock.t += 31_000;
  mode.status = 200;
  const lateRetry = await retryService.execute({ method: 'feedback.retry', params: {} });
  check('到点重试后发送成功', lateRetry.results.length === 1 && lateRetry.results[0].sent === true, JSON.stringify(lateRetry.results[0] ?? null));
  equal('队列统计：已发送 1 条', lateRetry.outbox.sent, 1);
  mode.status = 400;
  const rejected = await retryService.execute({ method: 'feedback.submit', params: { type: 'other', title: '被服务器拒绝', description: 'x' } });
  equal('4xx 视为不可重试（标记 failed）', [rejected.queued, rejected.status], [false, 'failed']);

  // 队列上限与损坏文件
  const fullDir = track(tmpDir('cetamesh-d-full-'));
  const fullService = createFeedbackService({
    outbox: createFeedbackOutbox({ stateDir: fullDir, maxEntries: 1, now: () => clock.t }),
    transport: createFeedbackTransport({ endpoint: null }),
    releaseConfig: baseConfig,
    diagnosticsProvider: dirtyDiagnostics
  });
  await fullService.execute({ method: 'feedback.submit', params: { type: 'bug', title: '第一条', description: 'x' } });
  const overflow = await asyncCapture(() => fullService.execute({ method: 'feedback.submit', params: { type: 'bug', title: '第二条', description: 'x' } }));
  check('队列满时明确拒绝而不是静默丢弃', overflow.threw && overflow.code === 'FEEDBACK_QUEUE_FULL', String(overflow.code));

  const corruptDir = track(tmpDir('cetamesh-d-corrupt-'));
  fs.mkdirSync(path.join(corruptDir, 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'feedback', 'outbox.json'), '{ not json', 'utf8');
  const corruptService = createFeedbackService({ stateDir: corruptDir, releaseConfig: baseConfig, diagnosticsProvider: dirtyDiagnostics });
  const afterCorrupt = await corruptService.execute({ method: 'feedback.submit', params: { type: 'bug', title: '损坏后仍可提交', description: 'x' } });
  check('队列文件损坏后仍能提交反馈', afterCorrupt.queued === true);
  const corruptConfig = await corruptService.execute({ method: 'feedback.config', params: {} });
  check('队列损坏如实上报', typeof corruptConfig.lastError === 'string' && corruptConfig.lastError.length > 0, String(corruptConfig.lastError));
  check('损坏文件另存备查', fs.readdirSync(path.join(corruptDir, 'feedback')).some((name) => name.includes('.corrupt-')));

  // ── 6. 装配与 IPC 可达性 ──────────────────────────────────────────────
  const containerDir = track(tmpDir('cetamesh-d-container-'));
  process.env.WHALEBRIDGE_DATA_DIR = containerDir;
  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const services = createCetaMeshServices({ config: { allow: { private: [], groups: [] } } });
  check('容器装配 feedback/onboarding/product', Boolean(services.feedbackService && services.onboardingService && services.productService));
  check('容器装配最近错误码环', Boolean(services.errorRegistry));
  const { createDesktopIpcRuntime } = await import('../src/app/ipc-runtime.js');
  const ipc = createDesktopIpcRuntime({ services, system: services.systemServices, log: () => {} });
  const ipcAbout = await ipc.dispatch({ method: 'about.info', params: {} });
  check('IPC about.info 可达且版本一致', ipcAbout.about.version === pkg.version);
  const ipcAboutUpdate = await ipc.dispatch({ method: 'about.update', params: {} });
  check('IPC about.update 可达（离线）', ipcAboutUpdate.update.currentVersion === pkg.version);
  const ipcFeedback = await ipc.dispatch({ method: 'feedback.config', params: {} });
  check('IPC feedback.config 可达', Array.isArray(ipcFeedback.types) && ipcFeedback.types.length === 5);
  const ipcOnboarding = await ipc.dispatch({ method: 'onboarding.status', params: {} });
  equal('IPC onboarding.status 可达', [ipcOnboarding.status, ipcOnboarding.steps.length], ['not_started', 7]);
  const ipcEmpty = await ipc.dispatch({ method: 'product.emptyState', params: { key: 'chat.no-model' } });
  equal('IPC product.emptyState 可达', ipcEmpty.state.key, 'chat.no-model');
  await ipc.dispatch({ method: 'feedback.submit', params: { type: 'bug' } }).catch(() => {});
  check('IPC 失败方法记录最近错误码', services.errorRegistry.list().some((entry) => entry.code === 'FEEDBACK_INVALID'), JSON.stringify(services.errorRegistry.list()));
} finally {
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('产品服务（About / 更新公告 / Feedback / 诊断脱敏 / 离线队列 / 重试 / IPC）验收全部通过');
