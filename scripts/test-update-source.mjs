// CetaMesh Desktop —— 分发运行时（UpdateSource：GitCode 主 + GitHub 备用）回归套件。
//
// 覆盖（全部离线、确定性，不访问真实网络）：
//   - 源顺序与 URL 构造（GitCode → GitHub）；
//   - GitCode 成功（统一 artifacts 清单）/ 合法无更新时**不**访问备用源；
//   - GitCode 超时、5xx、清单损坏、验签失败、404、缺本平台安装包 → GitHub 降级；
//   - 404 / JSON 损坏 / SHA 不匹配**绝不**被静默当作「无更新」（结构化 sources）；
//   - 所有源失败 → 结构化 per-source 诊断；旧扁平清单兼容；版本回退 / 同版本；
//   - 下载：https 强制、主机白名单、重定向逐跳校验（跳数上限）、体积上限、超时、
//     SHA256 必填与流式校验、原子落盘、部分文件清理、目标已存在拒绝覆盖。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUpdateChecker } from '../src/update/checker.js';
import { createArtifactDownloader } from '../src/update/download.js';
import {
  DEFAULT_GITHUB_FALLBACK_MANIFEST_URL,
  DEFAULT_GITCODE_MANIFEST_URL,
  buildUpdateSources
} from '../src/update/sources.js';
import { signManifest } from '../src/update/manifest.js';
import { createUpdateService } from '../src/update/service.js';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name + (detail ? ' :: ' + detail : ''));
}
function equal(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected)
  );
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pinnedPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const GITCODE_URL = 'https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/releases/stable.json?ref=main';
const GITHUB_URL = 'https://raw.githubusercontent.com/chx6418-source/whalebridge/main/releases/stable.json';
const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'gitcode.com', 'raw.gitcode.com'];

function manifest(over = {}) {
  const doc = {
    schemaVersion: 1,
    product: 'CetaMesh',
    channel: 'stable',
    version: '1.0.0',
    publishedAt: '2026-10-08T12:00:00Z',
    sourceCommit: 'e8a122af6b70cef73ac1b5dd559e14f9e5f5e60f',
    notes: ['离线更新源'],
    artifacts: {
      'windows-x64': {
        filename: 'WhaleBridge-Setup-x64.exe',
        url: 'https://gitcode.com/ygdnn/CetaMesh/releases/download/v1.0.0/WhaleBridge-Setup-x64.exe',
        sha256: 'a'.repeat(64),
        bytes: 123456789
      },
      android: {
        filename: 'cetamesh-mobile-1.0.0.apk',
        url: 'https://gitcode.com/ygdnn/CetaMesh/releases/download/v1.0.0/cetamesh-mobile-1.0.0.apk',
        sha256: 'b'.repeat(64),
        bytes: 30 * 1024 * 1024
      }
    },
    ...over
  };
  if (doc.signature === undefined) doc.signature = signManifest(doc, privatePem);
  return doc;
}

function legacyManifest(over = {}) {
  const doc = {
    schemaVersion: 1,
    channel: 'stable',
    version: '1.0.0',
    releasedAt: '2026-10-08',
    notes: ['旧格式', '扁平字段'],
    downloadUrl: 'https://github.com/chx6418-source/whalebridge/releases/download/v1.0.0/WhaleBridge-Setup-x64.exe',
    sha256: 'c'.repeat(64),
    ...over
  };
  if (doc.signature === undefined) doc.signature = signManifest(doc, privatePem);
  return doc;
}

const jsonResponse = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

function routedFetch(routes, calls) {
  return async (url) => {
    const key = String(url);
    calls.push(key);
    const hit = routes.find(([match]) => key.includes(match));
    if (!hit) throw new Error('no route for ' + key);
    return typeof hit[1] === 'function' ? hit[1]() : hit[1];
  };
}

function checkerWith(fetchImpl, currentVersion = '0.9.0', currentBuildNumber = 0) {
  return createUpdateChecker({ currentVersion, currentBuildNumber, fetchImpl });
}

const baseCheck = (extra = {}) => ({
  manifestUrl: GITCODE_URL,
  fallbackManifestUrl: GITHUB_URL,
  pinnedPublicKey,
  channel: 'stable',
  allowedHosts: ALLOWED_HOSTS,
  ...extra
});

// A release without an Owner-controlled signing key must remain blocked before network trust.
{
  let fetches = 0;
  const unsignedDeployment = await checkerWith(async () => { fetches += 1; throw new Error('must not fetch'); })
    .check(baseCheck({ pinnedPublicKey: '' }));
  equal('无正式公钥时更新检查安全拒绝', [unsignedDeployment.ok, unsignedDeployment.code, fetches], [false, 'NO_PINNED_KEY', 0]);
}

// Same product SemVer may still advance by monotonic build number. Stable feeds never surface prerelease channels.
{
  const newerBuild = manifest({ buildNumber: 1054 });
  const buildResult = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse(newerBuild)]], []), '1.0.0', 1053)
    .check(baseCheck());
  equal('同 SemVer 的更高 build number 可更新', [buildResult.ok, buildResult.updateAvailable, buildResult.latestBuildNumber], [true, true, 1054]);

  const rc = manifest({ channel: 'rc', version: '1.0.1-rc.1', buildNumber: 1055 });
  const stableResult = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse(rc)]], []), '1.0.0', 1054)
    .check(baseCheck({ channel: 'stable' }));
  equal('stable feed 不提供 RC', [stableResult.ok, stableResult.updateAvailable, stableResult.reason], [true, false, 'CHANNEL_MISMATCH']);
}

// ── 0. 源构造 ───────────────────────────────────────────────────────────────
equal(
  '源顺序：GitCode → GitHub（顺序即优先级）',
  buildUpdateSources({ manifestUrl: GITCODE_URL, fallbackManifestUrl: GITHUB_URL }).map((s) => s.id),
  ['gitcode', 'github']
);
equal(
  '只配置备用源时 id 是 github',
  buildUpdateSources({ fallbackManifestUrl: GITHUB_URL }).map((s) => s.id),
  ['github']
);
check(
  '默认主源指向 GitCode 官方 raw API（实测端点）',
  DEFAULT_GITCODE_MANIFEST_URL.startsWith('https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/'),
  DEFAULT_GITCODE_MANIFEST_URL
);
check(
  '默认备用源指向 GitHub raw 清单',
  DEFAULT_GITHUB_FALLBACK_MANIFEST_URL.startsWith('https://raw.githubusercontent.com/chx6418-source/whalebridge/'),
  DEFAULT_GITHUB_FALLBACK_MANIFEST_URL
);

// ── 1. GitCode 成功（统一 artifacts 清单） ──────────────────────────────────
{
  const calls = [];
  const fetchImpl = routedFetch([[GITCODE_URL, jsonResponse(manifest())]], calls);
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('GitCode 成功：有新版', [result.ok, result.updateAvailable, result.source], [true, true, 'gitcode']);
  equal(
    'GitCode 成功：下载信息来自 windows-x64 安装包',
    [result.download.filename, result.download.sha256, result.download.bytes],
    ['WhaleBridge-Setup-x64.exe', 'a'.repeat(64), 123456789]
  );
  equal('GitCode 成功后不访问备用源', calls.length, 1);
  check(
    '接力信息仍要求用户确认且不静默执行',
    result.handoff.requiresUserConfirmation === true && result.handoff.note.includes('不会静默执行')
  );
}

// ── 2. 合法「无更新」→ 不访问备用源 ─────────────────────────────────────────
{
  const calls = [];
  const fetchImpl = routedFetch([[GITCODE_URL, jsonResponse(manifest())]], calls);
  const sameVersion = await checkerWith(fetchImpl, '1.0.0').check(baseCheck());
  equal('同版本 → UP_TO_DATE（source=gitcode）', [sameVersion.ok, sameVersion.reason, sameVersion.source], [true, 'UP_TO_DATE', 'gitcode']);
  equal('合法无更新不访问备用源', calls.length, 1);

  const calls2 = [];
  const fetchImpl2 = routedFetch([[GITCODE_URL, jsonResponse(manifest())]], calls2);
  const downgrade = await checkerWith(fetchImpl2, '2.0.0').check(baseCheck());
  equal('版本回退（清单更旧）→ UP_TO_DATE，不提示旧版本', [downgrade.ok, downgrade.reason, downgrade.updateAvailable], [true, 'UP_TO_DATE', false]);
  equal('版本回退也不访问备用源', calls2.length, 1);
}

// ── 3. GitCode 超时 → GitHub 降级 ───────────────────────────────────────────
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = String(url);
    calls.push(key);
    if (key.includes('gitcode.com')) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return jsonResponse(manifest());
  };
  const result = await checkerWith(fetchImpl).check(baseCheck({ timeout: 60 }));
  equal('GitCode 超时 → GitHub 降级成功', [result.ok, result.updateAvailable, result.source], [true, true, 'github']);
  equal('超时后确实尝试了两个源', calls.length, 2);
}

// ── 4. GitCode 5xx → GitHub 降级 ────────────────────────────────────────────
{
  const calls = [];
  const fetchImpl = routedFetch(
    [
      [GITCODE_URL, jsonResponse('boom', 503)],
      [GITHUB_URL, jsonResponse(manifest())]
    ],
    calls
  );
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('GitCode 5xx → GitHub 降级成功', [result.ok, result.updateAvailable, result.source], [true, true, 'github']);
  equal('5xx 后确实尝试了两个源', calls.length, 2);
}

// ── 5. GitCode 清单损坏 → GitHub 降级；单源时结构化失败（绝不当作无更新） ───
{
  const calls = [];
  const fetchImpl = routedFetch(
    [
      [GITCODE_URL, jsonResponse('<html>not json</html>')],
      [GITHUB_URL, jsonResponse(manifest())]
    ],
    calls
  );
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('清单损坏 → GitHub 降级成功', [result.ok, result.updateAvailable, result.source], [true, true, 'github']);

  const broken = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse('<html>not json</html>')]], [])).check(
    baseCheck({ fallbackManifestUrl: '' })
  );
  check(
    '单源清单损坏 → BODY_INVALID 结构化失败（不是无更新）',
    broken.ok === false && broken.code === 'BODY_INVALID' && broken.updateAvailable === undefined,
    JSON.stringify(broken).slice(0, 200)
  );
}

// ── 6. 验签失败 → GitHub 降级；单源时 SIGNATURE_INVALID ─────────────────────
{
  const tampered = manifest();
  tampered.version = '9.9.9';
  const calls = [];
  const fetchImpl = routedFetch(
    [
      [GITCODE_URL, jsonResponse(tampered)],
      [GITHUB_URL, jsonResponse(manifest())]
    ],
    calls
  );
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('验签失败 → GitHub 降级成功（latest 来自合法源）', [result.ok, result.updateAvailable, result.source, result.latest], [true, true, 'github', '1.0.0']);

  const single = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse(tampered)]], [])).check(baseCheck({ fallbackManifestUrl: '' }));
  check('单源验签失败 → SIGNATURE_INVALID', single.ok === false && single.code === 'SIGNATURE_INVALID', String(single.code));
}

// ── 7. 404 → 降级；单源 404 不是「无更新」──────────────────────────────────
{
  const calls = [];
  const fetchImpl = routedFetch(
    [
      [GITCODE_URL, jsonResponse('{"error_code":404}', 404)],
      [GITHUB_URL, jsonResponse(manifest())]
    ],
    calls
  );
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('404 → GitHub 降级成功', [result.ok, result.updateAvailable, result.source], [true, true, 'github']);

  const single = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse('{"error_code":404}', 404)]], [])).check(
    baseCheck({ fallbackManifestUrl: '' })
  );
  check(
    '单源 404 → 结构化 HTTP_ERROR + sources 诊断（绝非无更新）',
    single.ok === false && single.code === 'HTTP_ERROR' && single.sources.length === 1 && single.sources[0].code === 'HTTP_ERROR',
    JSON.stringify(single).slice(0, 200)
  );
}

// ── 8. 缺本平台安装包 → 降级；单源时 NO_PLATFORM_ARTIFACT ────────────────────
{
  const androidOnly = manifest({ artifacts: { android: manifest().artifacts.android } });
  const calls = [];
  const fetchImpl = routedFetch(
    [
      [GITCODE_URL, jsonResponse(androidOnly)],
      [GITHUB_URL, jsonResponse(manifest())]
    ],
    calls
  );
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('清单缺 windows-x64 → GitHub 降级成功', [result.ok, result.updateAvailable, result.source], [true, true, 'github']);

  const single = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse(androidOnly)]], [])).check(baseCheck({ fallbackManifestUrl: '' }));
  check('单源缺本平台安装包 → NO_PLATFORM_ARTIFACT', single.ok === false && single.code === 'NO_PLATFORM_ARTIFACT', String(single.code));

  const asAndroid = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse(androidOnly)]], [])).check(baseCheck({ fallbackManifestUrl: '', platform: 'android' }));
  equal('android 平台选择 android 安装包', [asAndroid.ok, asAndroid.download.filename], [true, 'cetamesh-mobile-1.0.0.apk']);
}

// ── 9. 所有源失败 → 每个源的结构化诊断 ──────────────────────────────────────
{
  const calls = [];
  const fetchImpl = routedFetch(
    [
      [GITCODE_URL, jsonResponse('boom', 500)],
      [GITHUB_URL, jsonResponse('{"error_code":404}', 404)]
    ],
    calls
  );
  const result = await checkerWith(fetchImpl).check(baseCheck());
  equal('全部失败：ok=false 且带 per-source 诊断', [result.ok, result.sources.map((s) => s.id + '=' + s.code)], [false, ['gitcode=HTTP_ERROR', 'github=HTTP_ERROR']]);
  equal('全部失败：记录尝试过的源', result.tried, ['gitcode', 'github']);
  check('全部失败：消息明确说明所有源均失败', String(result.message).includes('所有更新源均失败'));
}

// ── 10. 旧扁平清单兼容 ──────────────────────────────────────────────────────
{
  const result = await checkerWith(routedFetch([[GITCODE_URL, jsonResponse(legacyManifest())]], [])).check(baseCheck());
  equal('旧格式扁平清单仍可用', [result.ok, result.updateAvailable, result.source], [true, true, 'gitcode']);
  equal('旧格式下载信息直通', result.download.url, legacyManifest().downloadUrl);
  equal('旧格式没有 bytes 时如实为 null', result.download.bytes, null);
  equal('旧格式 notes 保留', result.notes, ['旧格式', '扁平字段']);
}

// ── 11. 下载器 ──────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-update-source-'));
const chunked = function* chunked(bytes, size) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
};
const streamBody = async function* (bytes, size) {
  for (const chunk of chunked(bytes, size)) yield chunk;
};
const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const downloadResponse = (bytes, headers = {}) => ({
  status: 200,
  ok: true,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  body: streamBody(bytes, 8 * 1024)
});
const ARTIFACT_URL = 'https://gitcode.com/ygdnn/CetaMesh/releases/download/v1.0.0/setup.exe';

{
  const payload = crypto.randomBytes(64 * 1024);
  const sha = sha256Of(payload);
  const downloader = createArtifactDownloader({ fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS });
  const target = path.join(tmpRoot, 'setup-ok.exe');
  const result = await downloader.download({ url: ARTIFACT_URL, sha256: sha, bytes: payload.length, targetPath: target });
  equal('下载成功 + SHA256 校验通过', [result.ok, result.bytes, result.sha256], [true, payload.length, sha]);
  check('落盘内容与下载字节完全一致', fs.readFileSync(target).equals(payload));
  equal('成功下载无临时文件残留', fs.readdirSync(tmpRoot).filter((name) => name.includes('.part-')), []);
}

{
  const payload = crypto.randomBytes(1024);
  const target = path.join(tmpRoot, 'setup-short-write.exe');
  const downloader = createArtifactDownloader({
    fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS,
    fsImpl: {
      access: fs.promises.access, unlink: fs.promises.unlink, rename: fs.promises.rename,
      open: async (file, flags) => {
        const handle = await fs.promises.open(file, flags);
        if (flags !== 'w') return handle;
        return { close: () => handle.close(), write: (buffer, offset) => handle.write(buffer, offset, 1) };
      }
    }
  });
  const result = await downloader.download({ url: ARTIFACT_URL, sha256: sha256Of(payload), bytes: payload.length, targetPath: target });
  check('短写循环写完并校验磁盘内容', result.ok === true && fs.readFileSync(target).equals(payload), String(result.code));
}

{
  const payload = crypto.randomBytes(1024);
  const target = path.join(tmpRoot, 'setup-corrupt-disk.exe');
  const downloader = createArtifactDownloader({
    fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS,
    fsImpl: {
      access: fs.promises.access, unlink: fs.promises.unlink, rename: fs.promises.rename,
      open: async (file, flags) => {
        const handle = await fs.promises.open(file, flags);
        if (flags !== 'w') return handle;
        return { close: () => handle.close(), write: (buffer, offset, length) => handle.write(Buffer.alloc(length), 0, length) };
      }
    }
  });
  const result = await downloader.download({ url: ARTIFACT_URL, sha256: sha256Of(payload), targetPath: target });
  check('落盘内容与网络流不同则拒绝安装', result.ok === false && result.code === 'SHA_MISMATCH' && !fs.existsSync(target), String(result.code));
  equal('校验失败清除临时文件', fs.readdirSync(tmpRoot).filter((name) => name.startsWith('setup-corrupt-disk.exe.part-')), []);
}

{
  const payload = crypto.randomBytes(1024);
  const target = path.join(tmpRoot, 'setup-disk-error.exe');
  const downloader = createArtifactDownloader({
    fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS,
    fsImpl: {
      access: fs.promises.access, unlink: fs.promises.unlink, rename: fs.promises.rename,
      open: async (file, flags) => {
        const handle = await fs.promises.open(file, flags);
        if (flags !== 'w') return handle;
        return { close: () => handle.close(), write: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
      }
    }
  });
  const result = await downloader.download({ url: ARTIFACT_URL, sha256: sha256Of(payload), targetPath: target });
  check('磁盘写入错误 -> WRITE_FAILED 且目标不存在', result.ok === false && result.code === 'WRITE_FAILED' && !fs.existsSync(target), String(result.code));
  equal('磁盘写入错误清除临时文件', fs.readdirSync(tmpRoot).filter((name) => name.startsWith('setup-disk-error.exe.part-')), []);
}

{
  const payload = crypto.randomBytes(8 * 1024);
  const downloader = createArtifactDownloader({ fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS });
  const target = path.join(tmpRoot, 'setup-sha-bad.exe');
  const result = await downloader.download({ url: ARTIFACT_URL, sha256: 'f'.repeat(64), targetPath: target });
  check('SHA 不匹配 → SHA_MISMATCH 且拒绝落盘', result.ok === false && result.code === 'SHA_MISMATCH', String(result.code));
  check('SHA 不匹配后目标文件不存在', !fs.existsSync(target));
  equal('SHA 不匹配后无部分文件残留', fs.readdirSync(tmpRoot).filter((name) => name.startsWith('setup-sha-bad.exe.part-')), []);

  const sizeMismatch = await downloader.download({ url: ARTIFACT_URL, sha256: sha256Of(payload), bytes: payload.length + 1, targetPath: path.join(tmpRoot, 'setup-size.exe') });
  check('bytes 与清单不符 → SIZE_MISMATCH', sizeMismatch.ok === false && sizeMismatch.code === 'SIZE_MISMATCH', String(sizeMismatch.code));
}

{
  const payload = crypto.randomBytes(32 * 1024);
  const downloader = createArtifactDownloader({ fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS, maxBytes: payload.length - 1 });
  const target = path.join(tmpRoot, 'setup-big.exe');
  const result = await downloader.download({ url: ARTIFACT_URL, sha256: sha256Of(payload), targetPath: target });
  check('超过体积上限 → TOO_LARGE', result.ok === false && result.code === 'TOO_LARGE', String(result.code));
  check('超限后目标文件不存在', !fs.existsSync(target));
  equal('超限后无部分文件残留', fs.readdirSync(tmpRoot).filter((name) => name.includes('setup-big.exe.part-')), []);

  const declared = createArtifactDownloader({
    fetchImpl: async () => downloadResponse(payload, { 'content-length': String(payload.length * 10) }),
    allowedHosts: ALLOWED_HOSTS,
    maxBytes: payload.length
  });
  const early = await declared.download({ url: ARTIFACT_URL, sha256: sha256Of(payload), targetPath: path.join(tmpRoot, 'setup-declared.exe') });
  check('Content-Length 超限 → 直接 TOO_LARGE（不下载）', early.ok === false && early.code === 'TOO_LARGE', String(early.code));
}

{
  const payload = crypto.randomBytes(4 * 1024);
  const sha = sha256Of(payload);
  const calls = [];
  const redirecting = createArtifactDownloader({
    fetchImpl: async (url) => {
      const key = String(url);
      calls.push(key);
      if (key.startsWith('https://gitcode.com/')) {
        return { status: 302, ok: false, headers: { get: (name) => (name.toLowerCase() === 'location' ? 'https://raw.gitcode.com/ygdnn/CetaMesh/blobs/deadbeef/setup.exe' : null) } };
      }
      return downloadResponse(payload);
    },
    allowedHosts: ALLOWED_HOSTS
  });
  const result = await redirecting.download({ url: ARTIFACT_URL, sha256: sha, bytes: payload.length, targetPath: path.join(tmpRoot, 'setup-redirect.exe') });
  equal('重定向到白名单内主机 → 逐跳校验后成功', [result.ok, calls.length], [true, 2]);

  const toHttp = createArtifactDownloader({
    fetchImpl: async () => ({ status: 302, ok: false, headers: { get: () => 'http://gitcode.com/insecure.exe' } }),
    allowedHosts: ALLOWED_HOSTS
  });
  const insecure = await toHttp.download({ url: ARTIFACT_URL, sha256: sha, targetPath: path.join(tmpRoot, 'setup-redir-http.exe') });
  check('重定向到 http → REDIRECT_INSECURE', insecure.ok === false && insecure.code === 'REDIRECT_INSECURE', String(insecure.code));

  const toForeign = createArtifactDownloader({
    fetchImpl: async () => ({ status: 302, ok: false, headers: { get: () => 'https://evil.example.com/x.exe' } }),
    allowedHosts: ALLOWED_HOSTS
  });
  const foreign = await toForeign.download({ url: ARTIFACT_URL, sha256: sha, targetPath: path.join(tmpRoot, 'setup-redir-foreign.exe') });
  check('重定向到白名单外主机 → REDIRECT_HOST_NOT_ALLOWED', foreign.ok === false && foreign.code === 'REDIRECT_HOST_NOT_ALLOWED', String(foreign.code));

  const noLocation = createArtifactDownloader({ fetchImpl: async () => ({ status: 302, ok: false, headers: { get: () => null } }), allowedHosts: ALLOWED_HOSTS });
  const missing = await noLocation.download({ url: ARTIFACT_URL, sha256: sha, targetPath: path.join(tmpRoot, 'setup-redir-none.exe') });
  check('重定向缺少 location → REDIRECT_INVALID', missing.ok === false && missing.code === 'REDIRECT_INVALID', String(missing.code));

  const looping = createArtifactDownloader({
    fetchImpl: async (url) => ({ status: 302, ok: false, headers: { get: () => String(url) + (String(url).includes('?hop=') ? '' : '?hop=1') } }),
    allowedHosts: ALLOWED_HOSTS,
    maxRedirects: 2
  });
  const looped = await looping.download({ url: ARTIFACT_URL, sha256: sha, targetPath: path.join(tmpRoot, 'setup-redir-loop.exe') });
  check('重定向超过跳数上限 → TOO_MANY_REDIRECTS', looped.ok === false && looped.code === 'TOO_MANY_REDIRECTS', String(looped.code));
}

{
  const payload = crypto.randomBytes(2 * 1024);
  const sha = sha256Of(payload);
  const downloader = createArtifactDownloader({ fetchImpl: async () => downloadResponse(payload), allowedHosts: ALLOWED_HOSTS });
  const noSha = await downloader.download({ url: ARTIFACT_URL, targetPath: path.join(tmpRoot, 'setup-nosha.exe') });
  check('缺少 sha256 → SHA256_REQUIRED（不校验不下载）', noSha.ok === false && noSha.code === 'SHA256_REQUIRED', String(noSha.code));
  const httpUrl = await downloader.download({ url: 'http://gitcode.com/x.exe', sha256: sha, targetPath: path.join(tmpRoot, 'setup-http.exe') });
  check('非 https → INSECURE_URL', httpUrl.ok === false && httpUrl.code === 'INSECURE_URL', String(httpUrl.code));
  const foreignHost = await downloader.download({ url: 'https://evil.example.com/x.exe', sha256: sha, targetPath: path.join(tmpRoot, 'setup-host.exe') });
  check('主机不在白名单 → HOST_NOT_ALLOWED', foreignHost.ok === false && foreignHost.code === 'HOST_NOT_ALLOWED', String(foreignHost.code));

  const existing = path.join(tmpRoot, 'setup-exists.exe');
  fs.writeFileSync(existing, 'already here');
  const exists = await downloader.download({ url: ARTIFACT_URL, sha256: sha, targetPath: existing });
  check('目标已存在 → TARGET_EXISTS（不覆盖用户文件）', exists.ok === false && exists.code === 'TARGET_EXISTS', String(exists.code));

  const timingOut = createArtifactDownloader({
    fetchImpl: (url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    allowedHosts: ALLOWED_HOSTS,
    timeoutMs: 50
  });
  const timedOut = await timingOut.download({ url: ARTIFACT_URL, sha256: sha, targetPath: path.join(tmpRoot, 'setup-timeout.exe') });
  check('下载超时 → TIMEOUT', timedOut.ok === false && timedOut.code === 'TIMEOUT', String(timedOut.code));
}

// ── 12. Update 服务：下载参数校验与配置暴露 ────────────────────────────────
{
  const service = createUpdateService({ currentVersion: '1.0.0' });
  const config = await service.execute({ method: 'update.config', params: {} });
  check(
    'update.config 暴露主源与备用源字段',
    Object.prototype.hasOwnProperty.call(config.config, 'manifestUrl') && Object.prototype.hasOwnProperty.call(config.config, 'fallbackManifestUrl')
  );
  const capabilities = await service.execute({ method: 'update.capabilities', params: {} });
  equal('服务能力：可下载校验安装包但永不执行安装器', [capabilities.canDownloadVerifiedArtifact, capabilities.canExecuteInstaller], [true, false]);

  const relative = await service.execute({ method: 'update.download', params: { targetDir: 'relative/dir', filename: 'a.exe', url: ARTIFACT_URL, sha256: 'a'.repeat(64) } });
  check('update.download 拒绝相对路径', relative.ok === false && relative.code === 'TARGET_REQUIRED', String(relative.code));
  const traversal = await service.execute({ method: 'update.download', params: { targetDir: tmpRoot, filename: 'sub/evil.exe', url: ARTIFACT_URL, sha256: 'a'.repeat(64) } });
  check('update.download 拒绝路径分隔符/穿越文件名', traversal.ok === false && traversal.code === 'INVALID_FILENAME', String(traversal.code));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\ntest-update-source: ' + passed + ' passed, ' + failures.length + ' failed');
for (const failure of failures) console.log('  FAIL ' + failure);
if (failures.length) process.exitCode = 1;
