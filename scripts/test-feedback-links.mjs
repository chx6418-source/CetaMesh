// CetaMesh Desktop —— 反馈功能修正验收：**只提供入口**，点击用系统默认浏览器打开官网页面。
// 用法：node scripts/test-feedback-links.mjs
//
// 覆盖：
//   四个入口（反馈与建议 / Bug 反馈 / 功能建议 / 安全漏洞）由发行配置构造 URL
//   域名只有一个来源：release-config 的 feedback.baseUrl（缺省回落 website），页面不硬编码
//   query 白名单只有 version / build / platform；Key/token/聊天/Memory/路径/插件配置/device secret/日志
//   一律没有进入 URL 的路径（即使上游数据被污染）
//   未配置 / Core 未就绪时的兜底文案；安全漏洞入口单独提示
//   结构性保证：容器里**没有** FeedbackService / Outbox / 应用内表单；软件不自动上传日志
//   IPC product.feedbackLinks 可达

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_OPEN_FAILURE_MESSAGE,
  FEEDBACK_ALLOWED_QUERY_KEYS,
  FEEDBACK_NOT_CONFIGURED_MESSAGE,
  SECURITY_NOTICE,
  buildEntryUrl,
  buildFeedbackLinks,
  entryById,
  platformTag,
  safeQueryValue,
  sanitizeQueryValue
} from '../src/product/feedback-links.js';
import { loadReleaseConfig, resolveFeedbackBaseUrl, DEFAULT_FEEDBACK_PATHS } from '../src/product/release-config.js';
import { createProductService } from '../src/product/service.js';
import { createAboutInfo } from '../src/about/index.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';

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
const capture = async (fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (error) { return { threw: true, code: error && error.code, message: String(error && error.message) }; }
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const workDirs = [];
const originalDataDir = process.env.WHALEBRIDGE_DATA_DIR;
const track = (dir) => { workDirs.push(dir); return dir; };

const CONFIG = Object.freeze({
  schemaVersion: 1,
  product: 'CetaMesh',
  edition: 'Desktop',
  website: 'https://cetamesh.example.com',
  feedback: { baseUrl: '', paths: { ...DEFAULT_FEEDBACK_PATHS } }
});

const ABOUT = Object.freeze({
  product: 'CetaMesh',
  version: '1.0.0',
  build: { buildId: '1052' },
  platform: { os: 'win32', arch: 'x64' }
});

try {
  // ── 1. 四个入口与官方 URL ──────────────────────────────────────────────
  const links = buildFeedbackLinks({ config: { ...CONFIG, feedback: { baseUrl: 'https://cetamesh.example.com', paths: { ...DEFAULT_FEEDBACK_PATHS } } }, aboutInfo: ABOUT });
  equal('入口顺序：反馈与建议 / Bug 反馈 / 功能建议 / 安全漏洞',
    links.entries.map((entry) => entry.label), ['反馈与建议', 'Bug 反馈', '功能建议', '安全漏洞']);
  check('入口已配置且都是 https 官网地址',
    links.configured === true && links.entries.every((entry) => String(entry.url).startsWith('https://cetamesh.example.com/')));
  equal('反馈与建议 → /feedback', entryById(links, 'general').url,
    'https://cetamesh.example.com/feedback?version=1.0.0&build=1052&platform=windows');
  equal('Bug 反馈使用官方反馈页且 query 只带构建元数据', entryById(links, 'bug').url,
    'https://cetamesh.example.com/feedback?version=1.0.0&build=1052&platform=windows');
  equal('功能建议使用官方反馈页且 query 只带构建元数据', entryById(links, 'feature').url,
    'https://cetamesh.example.com/feedback?version=1.0.0&build=1052&platform=windows');
  equal('安全漏洞 → /security（单独一类）', [entryById(links, 'security').url, entryById(links, 'security').kind],
    ['https://cetamesh.example.com/security?version=1.0.0&build=1052&platform=windows', 'security']);
  check('安全漏洞入口单独给出提示原文', links.securityNotice === SECURITY_NOTICE && SECURITY_NOTICE.includes('不要在公开 Issue 中披露敏感漏洞'));
  check('提供浏览器打开失败的原文', links.messages.openFailure === BROWSER_OPEN_FAILURE_MESSAGE
    && BROWSER_OPEN_FAILURE_MESSAGE === '无法打开浏览器，请稍后访问 CetaMesh 官方网站。');

  // ── 2. query 白名单：只有 version / build / platform ───────────────────
  equal('允许的 query 键就是这三个', [...FEEDBACK_ALLOWED_QUERY_KEYS], ['version', 'build', 'platform']);
  equal('返回结果也声明这三个键', links.allowedQueryKeys, ['version', 'build', 'platform']);
  const bugUrl = new URL(entryById(links, 'bug').url);
  equal('每个入口链接的 query 键只有白名单三项',
    [...bugUrl.searchParams.keys()].sort(), ['build', 'platform', 'version'].sort());
  equal('链接里没有别的参数', bugUrl.searchParams.get('version'), '1.0.0');

  // ── 3. 禁止字段没有进入 URL 的路径（构造层面） ──────────────────────────
  const hostile = {
    version: '1.0.0&token=SECRET-TOKEN',
    build: { buildId: 'b#1?apiKey=sk-live-abcdef1234567890' },
    platform: { os: 'win32' },
    // 下面是"绝不允许出现"的东西：builder 不接受这些字段，因此无从进入 URL
    apiKey: 'sk-live-abcdef1234567890',
    token: 'ghp_abcdefghijklmnopqrst',
    chatContent: '聊天正文',
    memory: '长期记忆正文',
    filePath: 'C:\\Users\\me\\secret.txt',
    pluginConfig: { token: 'x' },
    deviceSecret: 'pairing-secret-0123456789',
    logBody: 'FATAL: something happened'
  };
  const hostileLinks = buildFeedbackLinks({
    config: { ...CONFIG, feedback: { baseUrl: 'https://cetamesh.example.com', paths: { ...DEFAULT_FEEDBACK_PATHS } } },
    aboutInfo: hostile
  });
  const hostileText = hostileLinks.entries.map((entry) => entry.url).join('\n');
  const hostileBug = new URL(entryById(hostileLinks, 'bug').url);
  equal('形状非法的 version/build 被整体丢弃（不注入、也不残留片段）',
    [hostileBug.searchParams.get('version'), hostileBug.searchParams.get('build')], [null, null]);
  equal('污染值被丢弃后只剩有效的 platform', [...hostileBug.searchParams.keys()].sort(), ['platform']);
  check('链接里绝不含 apiKey / token / device secret / 日志正文 / 聊天或记忆内容',
    !/sk-live|ghp_|pairing-secret|FATAL|聊天正文|长期记忆正文|secret\.txt|SECRET-TOKEN/.test(hostileText));
  check('平台标签被归一化成稳定取值', hostileLinks.query.platform === 'windows');
  equal('字符层白名单仍在（值层）', sanitizeQueryValue('1.0.0&token=SECRET-TOKEN'), '1.0.0tokenSECRET-TOKEN');
  equal('形状校验拒绝污染值', [safeQueryValue('version', '1.0.0&token=SECRET-TOKEN'), safeQueryValue('version', '1.0.0-rc.1+build.5')], ['', '1.0.0-rc.1+build.5']);
  equal('platform 映射', [platformTag('win32'), platformTag('darwin'), platformTag('linux')], ['windows', 'macos', 'linux']);

  // ── 4. 站点根只有一个来源；路径不可越界 ────────────────────────────────
  const viaWebsite = buildFeedbackLinks({ config: { ...CONFIG, feedback: { baseUrl: '', paths: { ...DEFAULT_FEEDBACK_PATHS } } }, aboutInfo: ABOUT });
  check('feedback.baseUrl 缺省时回落 website', viaWebsite.entries[0].url.startsWith('https://cetamesh.example.com/'));
  equal('两者的站点根一致', resolveFeedbackBaseUrl({ ...CONFIG, feedback: { baseUrl: '' } }), 'https://cetamesh.example.com');
  equal('显式 baseUrl 优先于 website', resolveFeedbackBaseUrl({ ...CONFIG, feedback: { baseUrl: 'https://feedback.example.com' } }), 'https://feedback.example.com');
  const packagedConfig = loadReleaseConfig({ rootDir: repoRoot });
  equal('仓库打包配置未提供官方站点且反馈路由无 query', [resolveFeedbackBaseUrl(packagedConfig.config),
    packagedConfig.config.feedback.paths.bug, packagedConfig.config.feedback.paths.feature], [null, '/feedback', '/feedback']);

  const hijacked = loadReleaseConfig({
    rootDir: repoRoot,
    read: () => ({
      website: 'https://cetamesh.example.com',
      feedback: { paths: { bug: '//evil.example/steal', security: 'https://evil.example/security', general: '/feedback?token=leak' } }
    })
  });
  equal('协议相对路径被拒绝（回落到默认 /feedback）', hijacked.config.feedback.paths.bug, DEFAULT_FEEDBACK_PATHS.bug);
  equal('绝对 URL 被拒绝（回落到默认 /security）', hijacked.config.feedback.paths.security, DEFAULT_FEEDBACK_PATHS.security);
  equal('路径中附带任意 query 被拒绝', hijacked.config.feedback.paths.general, DEFAULT_FEEDBACK_PATHS.general);
  check('buildEntryUrl 只接受 https 站点', buildEntryUrl('http://cetamesh.example.com', '/feedback', {}) === null);
  check('buildEntryUrl 对空站点返回 null', buildEntryUrl(null, '/feedback', {}) === null);
  check('buildEntryUrl 拒绝带 query/fragment 的路径和含凭据的 HTTPS 地址',
    buildEntryUrl('https://cetamesh.example.com', '/feedback?token=secret', {}) === null
      && buildEntryUrl('https://user:pass@cetamesh.example.com', '/feedback', {}) === null);
  const malformedConfig = loadReleaseConfig({
    rootDir: repoRoot,
    read: () => ({
      website: 'https://user:pass@cetamesh.example.com',
      feedback: { baseUrl: 'https://user:pass@feedback.example.com', paths: { general: '/feedback?apiKey=secret' } }
    })
  });
  equal('发行配置拒绝含凭据 URL 和带 query 页面路径', [malformedConfig.config.website, malformedConfig.config.feedback.baseUrl,
    malformedConfig.config.feedback.paths.general], [null, null, DEFAULT_FEEDBACK_PATHS.general]);

  // ── 5. 未配置 / Core 未就绪时的兜底 ────────────────────────────────────
  const unconfigured = buildFeedbackLinks({ config: { ...CONFIG, website: '', feedback: { baseUrl: '', paths: { ...DEFAULT_FEEDBACK_PATHS } } }, aboutInfo: ABOUT });
  equal('未配置站点：configured=false 且没有 URL', [unconfigured.configured, unconfigured.entries.every((entry) => entry.url === null)], [false, true]);
  equal('未配置提示原文', unconfigured.messages.notConfigured, FEEDBACK_NOT_CONFIGURED_MESSAGE);
  check('未配置提示不猜域名', !FEEDBACK_NOT_CONFIGURED_MESSAGE.includes('http'));
  const empty = buildFeedbackLinks({});
  equal('无参数也不抛错，仍给四个入口', empty.entries.length, 4);
  check('无参数时文案仍是产品原文',
    empty.messages.openFailure === BROWSER_OPEN_FAILURE_MESSAGE && empty.securityNotice === SECURITY_NOTICE);

  // ── 6. 结构性保证：没有 FeedbackService / Outbox / 应用内表单 ───────────
  check('仓库里不存在 src/feedback（服务 / Outbox / 传输已删除）', fs.existsSync(path.join(repoRoot, 'src', 'feedback')) === false);
  const containerDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-fblinks-')));
  process.env.WHALEBRIDGE_DATA_DIR = containerDir;
  const { createCetaMeshServices } = await import('../src/app/service-container.js');
  const services = createCetaMeshServices({ config: { allow: { private: [], groups: [] } } });
  equal('容器不再装配 FeedbackService', [services.feedbackService, services.systemServices.feedback], [undefined, undefined]);
  check('容器仍装配 onboarding/product', Boolean(services.onboardingService && services.productService));

  // ── 7. 产品服务与 IPC ──────────────────────────────────────────────────
  const aboutInfo = createAboutInfo({ rootDir: repoRoot, execGit: () => 'abc1234' }).info();
  const product = createProductService({
    aboutInfo: () => aboutInfo,
    releaseConfig: { ...CONFIG, feedback: { baseUrl: 'https://cetamesh.example.com', paths: { ...DEFAULT_FEEDBACK_PATHS } } }
  });
  const response = await product.execute({ method: 'product.feedbackLinks', params: {} });
  equal('product.feedbackLinks 返回四个入口', response.links.entries.map((entry) => entry.id), ['general', 'bug', 'feature', 'security']);
  check('返回值带 query 摘要与允许键', response.links.query.platform === 'windows' && response.links.allowedQueryKeys.length === 3);
  const unavailableProduct = createProductService({
    releaseConfig: { ...CONFIG, website: null, feedback: { baseUrl: null, paths: { ...DEFAULT_FEEDBACK_PATHS } } }
  });
  const unavailableUi = createDesktopUiService({ system: { product: unavailableProduct } });
  const unavailableLinks = await unavailableUi.execute({ method: 'ui.feedback.links', params: {} });
  equal('typed UI projection 保留 disabled 无 URL 状态', [unavailableLinks.configured, unavailableLinks.entries.every((entry) => entry.url === null), unavailableLinks.message],
    [false, true, FEEDBACK_NOT_CONFIGURED_MESSAGE]);
  const aboutUi = fs.readFileSync(path.join(repoRoot, 'desktop-ui', 'src', 'app', 'HarborApp.tsx'), 'utf8');
  const typedClient = fs.readFileSync(path.join(repoRoot, 'desktop-ui', 'src', 'bridge', 'typed-client.ts'), 'utf8');
  const nativeUi = fs.readFileSync(path.join(repoRoot, 'desktop-shell', 'src', 'webview_ui.rs'), 'utf8');
  const nativeLinks = fs.readFileSync(path.join(repoRoot, 'desktop-shell', 'src', 'external_link.rs'), 'utf8');
  check('About 只读取 ui.feedback.links，缺失 URL 禁用按钮并交给 Native HTTPS Host',
    aboutUi.includes('feedbackClient.links()') && aboutUi.includes('disabled={!entry.url}')
      && /url\?\.startsWith\('https:\/\/'\).*openExternal\(url\)/s.test(aboutUi)
      && typedClient.includes("bridge.invoke('app.openExternal', { url })")
      && nativeUi.includes('crate::external_link::open_in_default_browser(url)')
      && nativeLinks.includes('strip_prefix("https://")') && nativeLinks.includes("host.contains('@')"));
  const unknown = await capture(() => product.execute({ method: 'product.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknown.threw && unknown.code === 'METHOD_NOT_FOUND', String(unknown.code));

  const { createDesktopIpcRuntime } = await import('../src/app/ipc-runtime.js');
  const ipc = createDesktopIpcRuntime({ services, system: services.systemServices, log: () => {} });
  const viaIpc = await ipc.dispatch({ method: 'product.feedbackLinks', params: {} });
  equal('IPC product.feedbackLinks 可达', viaIpc.links.entries.length, 4);
  const viaTypedUi = await services.desktopUiService.execute({ method: 'ui.feedback.links', params: {} });
  equal('仓库未配置官方 URL 时，typed UI 仍返回四个 disabled 入口', [viaTypedUi.configured, viaTypedUi.entries.length,
    viaTypedUi.entries.every(entry => entry.url === null), viaTypedUi.message], [false, 4, true, FEEDBACK_NOT_CONFIGURED_MESSAGE]);
  const legacy = await capture(() => ipc.dispatch({ method: 'feedback.submit', params: { type: 'bug' } }));
  check('旧的 feedback.* 命名空间不再可用（无收集通道）', legacy.threw === true, String(legacy.code));
} finally {
  if (originalDataDir === undefined) delete process.env.WHALEBRIDGE_DATA_DIR;
  else process.env.WHALEBRIDGE_DATA_DIR = originalDataDir;
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('反馈入口（官网链接 / query 白名单 / 无软件内收集 / 兜底文案 / IPC）验收全部通过');
