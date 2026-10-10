// CetaMesh Desktop —— 产品化任务 D 验收：About / 更新公告 / 诊断（本机展示）/ 装配与 IPC。
// 用法：node scripts/test-product-services.mjs
//
// 反馈已改为"链接入口 + 系统浏览器"（见 scripts/test-feedback-links.mjs）：
// 本文件不再覆盖任何反馈收集 / 队列 / 重试行为。
//
// 覆盖验收项：
//   About build info（版本不写死、构建/发布清单、未配置不编造）
//   Update notes（title/version/publishedAt/notes + 纯文本安全渲染 + 离线缓存）
//   诊断快照（白名单 + 脱敏，只在本机展示）
//   装配与 IPC 可达性（onboarding. / product. 命名空间）

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
import { DIAGNOSTICS_POLICY, buildDiagnostics } from '../src/product/diagnostics.js';
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
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const jsonFetch = (status, body = '{}') => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

const repoRoot = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const newerUpdateVersion = (() => {
  const match = String(pkg.version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error('package.json version must be semantic for update checks');
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
})();
const workDirs = [];
const originalDataDir = process.env.WHALEBRIDGE_DATA_DIR;
const track = (dir) => { workDirs.push(dir); return dir; };

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
      feedback: { baseUrl: 'https://feedback.example.com' }
    })
  });
  equal('发行配置可提供开发者与官网', [configured.config.developer, configured.config.website], ['示例开发者', 'https://cetamesh.example.com']);
  equal('readiness 反映配置完整度', configured.readiness, {
    developerConfigured: true,
    websiteConfigured: true,
    feedbackBaseConfigured: true,
    securityContactConfigured: true,
    securityContactSource: 'configured'
  });
  const insecure = loadReleaseConfig({ rootDir: repoRoot, read: () => ({ website: 'http://cetamesh.example.com', feedback: { baseUrl: 'http://feedback.example.com' } }) });
  equal('非 https 的官方地址视为未配置', [insecure.config.website, insecure.config.feedback.baseUrl], [null, null]);
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
    version: newerUpdateVersion,
    title: '<b>CetaMesh 1.0 RC2</b>',
    publishedAt: '2026-10-09T00:00:00Z',
    notes: ['<script>alert(1)</script>安全渲染', '修复更新检查'],
    downloadUrl: `https://github.com/chx6418-source/whalebridge/releases/download/v${newerUpdateVersion}/CetaMesh-Setup.exe`,
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
  equal('About 离线显示最近一次更新公告', [aboutUpdate.update.cacheAvailable, aboutUpdate.update.announcement.version], [true, newerUpdateVersion]);
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

  // ── 4. 诊断快照：白名单 + 脱敏（只在本机展示，不再有任何上传通道） ───────
  const registry = createErrorRegistry();
  registry.record('TOOL_DENIED', { source: 'capability' });
  const diagnostics = buildDiagnostics({
    aboutInfo: info,
    // Provider label 里塞了凭据字样：字符串层必须被脱敏。
    providers: [{ id: 'deepseek-official', label: 'apiKey=sk-live-abcdef1234567890', hasKey: true }],
    extensions: [{ id: 'a', enabled: true }, { id: 'b', enabled: false }],
    settings: {
      general: { theme: 'dark' },
      updates: { autoCheck: false },
      security: { redactLogs: true },
      // 非白名单字段：构造时根本不会被读取。
      apiKey: 'sk-live-abcdef1234567890',
      chatContent: '用户与模型的聊天正文'
    },
    errorRegistry: registry
  });
  const flatDiagnostics = JSON.stringify(diagnostics);
  equal('诊断含最近错误码', [diagnostics.lastErrorCode, diagnostics.recentErrorCodes.includes('TOOL_DENIED')], ['TOOL_DENIED', true]);
  equal('诊断含插件启用/关闭计数', diagnostics.plugins, { total: 2, enabled: 1, disabled: 1 });
  equal('诊断只报 Provider 布尔状态', [diagnostics.providers[0].id, diagnostics.providers[0].hasKey], ['deepseek-official', true]);
  check('白名单字段内的凭据字样也被脱敏', flatDiagnostics.includes('[REDACTED:apiKey]'));
  check('诊断不含明文凭据与聊天内容', !flatDiagnostics.includes('sk-live-abcdef1234567890') && !flatDiagnostics.includes('聊天正文'));
  check('诊断策略向用户明示包含/排除项',
    DIAGNOSTICS_POLICY.includes.some((t) => t.includes('最近错误码')) &&
    DIAGNOSTICS_POLICY.excludes.some((t) => t.includes('API Key')) &&
    DIAGNOSTICS_POLICY.excludes.some((t) => t.includes('聊天内容')));

  // ── 5. 装配与 IPC 可达性 ──────────────────────────────────────────────
  const containerDir = track(tmpDir('cetamesh-d-container-'));
  process.env.WHALEBRIDGE_DATA_DIR = containerDir;
  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const services = createCetaMeshServices({ config: { allow: { private: [], groups: [] } } });
  check('容器装配 onboarding/product', Boolean(services.onboardingService && services.productService));
  check('容器装配最近错误码环', Boolean(services.errorRegistry));
  const { createDesktopIpcRuntime } = await import('../src/app/ipc-runtime.js');
  const ipc = createDesktopIpcRuntime({ services, system: services.systemServices, log: () => {} });
  const ipcAbout = await ipc.dispatch({ method: 'about.info', params: {} });
  check('IPC about.info 可达且版本一致', ipcAbout.about.version === pkg.version);
  const ipcAboutUpdate = await ipc.dispatch({ method: 'about.update', params: {} });
  check('IPC about.update 可达（离线）', ipcAboutUpdate.update.currentVersion === pkg.version);
  const ipcOnboarding = await ipc.dispatch({ method: 'onboarding.status', params: {} });
  equal('IPC onboarding.status 可达', [ipcOnboarding.status, ipcOnboarding.steps.length], ['not_started', 7]);
  const ipcEmpty = await ipc.dispatch({ method: 'product.emptyState', params: { key: 'chat.no-model' } });
  equal('IPC product.emptyState 可达', ipcEmpty.state.key, 'chat.no-model');
  await ipc.dispatch({ method: 'product.nope', params: {} }).catch(() => {});
  check('IPC 失败方法记录最近错误码', services.errorRegistry.list().some((entry) => entry.code === 'METHOD_NOT_FOUND'), JSON.stringify(services.errorRegistry.list()));
} finally {
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('产品服务（About / 更新公告 / 诊断本机展示 / 装配与 IPC）验收全部通过');
