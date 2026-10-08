#!/usr/bin/env node
// CetaMesh Desktop —— GitCode 发布 / 同步脚本（分发运行时 v1）。
//
// 职责（离线部分永远可跑）：
//   - 组装**统一 Release Manifest**（平台中立：windows-x64 / android 共用一份，schemaVersion=1）；
//   - 计算产物 sha256 / bytes，生成 SHA256SUMS.txt 与 release-assets.json（Release Asset 元数据）；
//   - 用 --signing-key 给出的 Ed25519 私钥签名清单（签名算法与 src/update/manifest.js 完全一致）；
//   - 输出精确的人工发布命令（GitCode Release 创建 + 附件上传 + 清单入库 + 验证）。
//
// 凭据与红线：
//   - **不把凭据写进源码**：只用环境变量 GITCODE_TOKEN（可选，用于远端核对）；
//   - 没有凭据 / 未提供 --publish 时：如实输出 NOT_RUN_ENVIRONMENT，并给出精确人工步骤；
//   - **不把大文件 commit 进 Git 历史**：脚本只产出小体积 manifest/checksums；
//     30MB APK、100MB+ Windows installer 一律走 Release Asset 附件，脚本会显式拒绝把
//     超过阈值（默认 1 MiB）的产物当作"清单文件"处理。
//
// 用法：
//   node scripts/sync-gitcode-release.mjs --version 1.0.0 \
//     --source-commit <sha> --signing-key <pem> \
//     --artifact windows-x64=dist/app/WhaleBridge-Setup-x64.exe \
//     --artifact android=<path/to.apk> \
//     --notes "..." --out dist/gitcode-release [--publish]
//
// 产物（--out 目录下）：
//   releases/stable.json     统一清单（提交到 GitCode 仓库 main 分支的 releases/ 目录）
//   SHA256SUMS.txt           产物 + 清单的 sha256
//   release-assets.json      Release Asset 元数据（filename/bytes/sha256/版本/commit）

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { signManifest } from '../src/update/manifest.js';

const GITCODE_OWNER = 'ygdnn';
const GITCODE_REPO = 'CetaMesh';
const GITCODE_WEB = `https://gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}`;
const GITCODE_API = `https://api.gitcode.com/api/v5/repos/${GITCODE_OWNER}/${GITCODE_REPO}`;
const MANIFEST_IN_REPO = 'releases/stable.json';
const MAX_MANIFEST_BYTES = 1024 * 1024; // 超过 1 MiB 的产物绝不进 Git 历史

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
function argAll(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]);
  }
  return values;
}

const version = argValue('--version');
const channel = argValue('--channel', 'stable');
const sourceCommit = argValue('--source-commit', '');
const signingKeyPath = argValue('--signing-key');
const outDir = argValue('--out', path.join('dist', 'gitcode-release'));
const publish = args.includes('--publish');
const artifactSpecs = argAll('--artifact');
const assetUrlOverrides = {};
for (const spec of argAll('--asset-url')) {
  const separator = spec.indexOf('=');
  if (separator > 0) assetUrlOverrides[spec.slice(0, separator)] = spec.slice(separator + 1);
}
const notes = argAll('--notes');

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('用法：node scripts/sync-gitcode-release.mjs --version <x.y.z> --artifact <platform>=<file> [...]');
  console.error('必需参数：--version；可选：--channel --source-commit --signing-key --notes --out --publish --asset-url');
  process.exit(2);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!artifactSpecs.length) {
  console.error('至少需要一个 --artifact <platform>=<file>（例如 windows-x64=dist/app/WhaleBridge-Setup-x64.exe）');
  process.exit(2);
}

const artifacts = {};
const assetMetadata = [];
const oversized = [];
for (const spec of artifactSpecs) {
  const separator = spec.indexOf('=');
  const platform = separator > 0 ? spec.slice(0, separator) : '';
  const file = separator > 0 ? spec.slice(separator + 1) : '';
  if (!platform || !file || !fs.existsSync(file)) {
    console.error('非法或不存在的产物：' + spec);
    process.exit(2);
  }
  const bytes = fs.statSync(file).size;
  const filename = path.basename(file);
  if (bytes > MAX_MANIFEST_BYTES) oversized.push(filename + '（' + bytes + ' 字节）');
  // 清单里默认使用"发布时人工核对"的 Release Asset 下载地址模板；--asset-url 可覆盖为实测 URL。
  const url = assetUrlOverrides[platform] || `${GITCODE_WEB}/releases/download/v${version}/${filename}`;
  if (!url.startsWith('https://')) {
    console.error('产物 URL 必须 https：' + url);
    process.exit(2);
  }
  const sha256 = sha256File(file);
  artifacts[platform] = { filename, url, sha256, bytes };
  assetMetadata.push({ platform, filename, url, sha256, bytes, sourceFile: file });
}

const manifest = {
  schemaVersion: 1,
  product: 'CetaMesh',
  channel,
  version,
  publishedAt: new Date().toISOString(),
  sourceCommit,
  notes: notes.length ? notes : ['CetaMesh ' + version + ' ' + channel],
  artifacts
};

let signature = '';
let signatureStatus = 'NOT_SIGNED';
if (signingKeyPath) {
  if (!fs.existsSync(signingKeyPath)) {
    console.error('签名私钥不存在：' + signingKeyPath);
    process.exit(2);
  }
  signature = signManifest(manifest, fs.readFileSync(signingKeyPath, 'utf8'));
  manifest.signature = signature;
  signatureStatus = 'SIGNED';
}

fs.mkdirSync(path.join(outDir, 'releases'), { recursive: true });
const manifestPath = path.join(outDir, 'releases', 'stable.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const sums = [
  ...assetMetadata.map((asset) => `${asset.sha256}  ${asset.filename}  (${asset.sourceFile})`),
  `${sha256File(manifestPath)}  releases/stable.json`
];
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8');
fs.writeFileSync(
  path.join(outDir, 'release-assets.json'),
  JSON.stringify({ product: 'CetaMesh', channel, version, sourceCommit, generatedAt: manifest.publishedAt, signatureStatus, assets: assetMetadata }, null, 2) + '\n',
  'utf8'
);

console.log('── GitCode 发布准备 ─────────────────────────────────────────');
console.log('清单：' + manifestPath);
console.log('平台：' + Object.keys(artifacts).join(', '));
console.log('签名：' + signatureStatus + (signatureStatus === 'NOT_SIGNED' ? '（Desktop 客户端只接受已签名清单，发布前必须 --signing-key）' : ''));
console.log('产物元数据：' + path.join(outDir, 'release-assets.json'));
console.log('校验和：' + path.join(outDir, 'SHA256SUMS.txt'));
if (oversized.length) {
  console.log('');
  console.log('提醒：以下产物超过 1 MiB，只能作为 GitCode Release 附件（Release Asset）上传，');
  console.log('      禁止 commit 进 Git 历史（GitCode 仓库里只入库小体积 ' + MANIFEST_IN_REPO + '）：');
  for (const entry of oversized) console.log('      - ' + entry);
}

const token = process.env.GITCODE_TOKEN;
if (publish && token) {
  // 有凭据时做**已验证端点**的远端核对：GET releases 列表（实测端点，见 src/update/sources.js 注释）。
  const response = await fetch(`${GITCODE_API}/releases`, { headers: { 'PRIVATE-TOKEN': token } });
  const releases = response.ok ? await response.json() : null;
  const existing = Array.isArray(releases) ? releases.find((release) => release && release.tag_name === `v${version}`) : null;
  console.log('远端核对：releases HTTP ' + response.status + (existing ? '，已存在 tag v' + version : '，尚未创建 tag v' + version));
  if (!response.ok) {
    console.log('NOT_RUN_ENVIRONMENT：release 状态核对失败（HTTP ' + response.status + '）——上传端点未经本机验证，请按人工步骤执行。');
    process.exitCode = 3;
  }
} else {
  console.log('');
  console.log(
    token
      ? '已检测到 GITCODE_TOKEN，但未指定 --publish：仅生成清单与元数据，未做远端写入。'
      : 'NOT_RUN_ENVIRONMENT：本机未提供 GitCode 凭据（环境变量 GITCODE_TOKEN），发布未执行。'
  );
  console.log('精确人工发布步骤：');
  console.log('  1) 创建 Release（网页）：' + GITCODE_WEB + '/releases/new?tag=v' + version);
  console.log('     标题：CetaMesh ' + version + '　说明：' + JSON.stringify(manifest.notes.join(' / ')));
  console.log('  2) 在该 Release 上传附件（Release Asset，绝不 commit 进 Git 历史）：');
  for (const asset of assetMetadata) console.log('     - ' + asset.filename + '（' + asset.bytes + ' 字节，sha256 ' + asset.sha256 + '）');
  console.log('  3) 上传后复制真实附件下载 URL，并用 --asset-url <platform>=<url> 重新生成清单：');
  console.log('     node scripts/sync-gitcode-release.mjs --version ' + version + ' --source-commit ' + (sourceCommit || '<sha>') + ' \\');
  for (const asset of assetMetadata) console.log('       --artifact ' + asset.platform + '=' + asset.sourceFile + ' --asset-url ' + asset.platform + '=<实测URL> \\');
  console.log('       --signing-key <pem> --notes "..." --out ' + outDir);
  console.log('  4) 把签名后的清单提交到 GitCode 仓库 main 分支的 ' + MANIFEST_IN_REPO + '：');
  console.log('     git -C <gitcode-clone> add ' + MANIFEST_IN_REPO + ' && git -C <gitcode-clone> commit -m "release: CetaMesh ' + version + ' ' + channel + ' manifest" && git -C <gitcode-clone> push origin main');
  console.log('  5) 验证（无需凭据）：');
  console.log('     curl -sS "' + GITCODE_API + '/raw/' + MANIFEST_IN_REPO + '?ref=main"');
  console.log('     —— 应返回签名清单 JSON；无效则客户端会走 GitHub 备用源而不是静默当作无更新。');
  console.log('  6) （可选，带凭据核对）GITCODE_TOKEN=*** node scripts/sync-gitcode-release.mjs ... --publish');
}
