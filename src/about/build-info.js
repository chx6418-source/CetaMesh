// CetaMesh Desktop —— 构建信息（阶段 12 / 产品化任务 D）。
//
// 「About 的 Version 必须与构建版本一致」这件事只能靠**单一事实源**保证：
//   - 版本号只从 package.json 读（运行时/打包时都是同一份）；
//   - 桌面壳版本从 desktop-shell/Cargo.toml 读，用来**交叉核对**两者是否一致；
//   - commit / 构建时间优先来自 build-info.json（发布构建写入）；开发态可回退到 git；
//     两者都拿不到就如实报 'unknown' —— 绝不编造一个看起来像真的构建号。
//
// 产品化任务 D 补齐 About 页需要但原实现没有的部分：
//   开发者 / 官方网站 / GitCode / GitHub / 平台与架构 / 许可证 / 隐私说明 / 安全说明 /
//   诊断信息入口 / 发布清单（release-manifest.json）。这些全部来自**发行配置与构建产物**：
//   没有配置的字段如实返回 null（UI 显示「未配置」），**绝不在代码里写死一个看起来真的官网或邮箱**。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJsonFile } from '../storage/json-file.js';
import {
  DEFAULT_RELEASE_CONFIG,
  configReadiness,
  loadReleaseConfig,
  resolveSecurityContact
} from '../product/release-config.js';

export const PRODUCT_NAME = 'CetaMesh';
export const PRODUCT_EDITION = 'Desktop';

export const UNKNOWN = 'unknown';

function readJsonFileLenient(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function text(value) {
  const trimmed = String(value === null || value === undefined ? '' : value).trim();
  return trimmed || null;
}

/** 从 Cargo.toml 里抽出 [package] 的 version（用于与 package.json 交叉核对）。 */
export function readShellVersion(cargoTomlFile) {
  try {
    const source = fs.readFileSync(cargoTomlFile, 'utf8');
    const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(source);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** 从 LICENSE 首行推断展示用的许可证名称（package.json 未声明时的兜底）。 */
export function readLicenseName({ packageJson = null, licenseFile = null } = {}) {
  const declared = text(packageJson && packageJson.license);
  if (declared) return declared;
  try {
    const head = fs.readFileSync(licenseFile, 'utf8').split('\n').slice(0, 3).join(' ').trim();
    if (!head) return UNKNOWN;
    return head.slice(0, 120);
  } catch {
    return UNKNOWN;
  }
}

/**
 * 读一段「说明文档摘要」：取第一段正文（跳过 Markdown 标题/空行），有界截断。
 * 用途：About 页要显示「隐私说明 / 安全说明」，但把整份文档塞进 IPC 没有意义。
 */
export function readDocSummary(file, maxChars = 400) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const paragraph = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (paragraph.length) break;
        continue;
      }
      if (/^#{1,6}\s/.test(trimmed)) {
        if (paragraph.length) break;
        continue;
      }
      paragraph.push(trimmed.replace(/^[-*>]\s*/, ''));
    }
    const joined = paragraph.join(' ').trim();
    return joined ? joined.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

/** 平台/架构的展示描述：给 UI 用，但只描述**事实**（不猜 Windows 版本号文案）。 */
export function describePlatform(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  const archName = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'ARM64' : arch;
  let osVersion = null;
  try {
    osVersion = text(os.release());
  } catch {
    osVersion = null; // 极端受限运行时下 os.release() 不可用：缺就报 null，不编造。
  }
  return { os: platform, arch, label: osName + ' · ' + archName, osVersion };
}

function defaultGitCommit(rootDir) {
  try {
    return text(execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir, timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).toString());
  } catch {
    return null;
  }
}

/** 发布清单（build-release.mjs 产出）：只取展示需要的字段，不整份透传。 */
export function readReleaseManifest(file) {
  let raw = null;
  try {
    raw = readJsonFile(file, { missing: null });
  } catch {
    return { file, available: false, corrupt: true };
  }
  if (!raw || typeof raw !== 'object') return { file, available: false, corrupt: false };
  return {
    file,
    available: true,
    corrupt: false,
    product: text(raw.product),
    version: text(raw.version),
    channel: text(raw.channel),
    buildNumber: Number.isSafeInteger(Number(raw.buildNumber)) ? Number(raw.buildNumber) : null,
    buildId: text(raw.buildId),
    commit: text(raw.commit ?? raw.commitShort),
    builtAt: text(raw.builtAt),
    platform: text(raw.platform)
  };
}

/**
 * 组装 About 信息。所有外部依赖都可注入，便于测试覆盖"有/无构建元数据"两条路径。
 */
export function createAboutInfo({
  rootDir,
  packageFile = null,
  buildInfoFile = null,
  cargoTomlFile = null,
  licenseFile = null,
  releaseConfigFile = null,
  releaseConfig = null,
  releaseManifestFile = null,
  execGit = null,
  packaged = false,
  now = () => Date.now()
} = {}) {
  const root = rootDir || process.cwd();
  const pkgFile = packageFile || path.join(root, 'package.json');
  const buildFile = buildInfoFile || path.join(root, 'build-info.json');
  const cargoFile = cargoTomlFile || path.join(root, 'desktop-shell', 'Cargo.toml');
  const licFile = licenseFile || path.join(root, 'LICENSE');
  const manifestFile = releaseManifestFile || path.join(root, 'release-manifest.json');
  const versionSourceFile = path.join(root, 'release', 'version.json');

  // 发行配置只加载一次（进程内是常量事实）；调用方也可以直接注入已归一化的 config。
  const loaded = releaseConfig
    ? { config: releaseConfig, file: releaseConfigFile || null, source: 'injected', lastError: null, readiness: configReadiness(releaseConfig) }
    : loadReleaseConfig({ rootDir: root, file: releaseConfigFile, fallback: DEFAULT_RELEASE_CONFIG });
  const fallbackLicenseName = loaded.config?.license?.name || DEFAULT_RELEASE_CONFIG.license.name;

  function info() {
    const pkg = readJsonFileLenient(pkgFile) || {};
    let versionSource = {};
    try { versionSource = readJsonFile(versionSourceFile, { missing: {} }) || {}; }
    catch {
      // About remains renderable with missing or corrupt build metadata; release validation reports the defect.
      versionSource = {};
    }
    const shellVersion = readShellVersion(cargoFile) || UNKNOWN;
    const build = readJsonFileLenient(buildFile) || {};
    const version = text(versionSource.productVersion) || text(build.version) || text(pkg.version) || UNKNOWN;
    const buildNumber = Number.isSafeInteger(Number(build.buildNumber ?? versionSource.buildNumber))
      ? Number(build.buildNumber ?? versionSource.buildNumber)
      : null;
    const channel = text(build.channel) || text(versionSource.channel) || (packaged ? UNKNOWN : 'dev');

    let commit = text(build.commit);
    let commitSource = commit ? 'build-info' : null;
    if (!commit && !packaged) {
      const git = (execGit || (() => defaultGitCommit(root)))();
      if (git) { commit = git; commitSource = 'git'; }
    }
    if (!commit) { commit = UNKNOWN; commitSource = 'unavailable'; }

    const license = readLicenseName({ packageJson: pkg, licenseFile: licFile });
    const repository = text(pkg.repository && (pkg.repository.url || pkg.repository)) || loaded.config.repositories.primary;
    const platform = describePlatform();
    const release = readReleaseManifest(manifestFile);
    const contact = resolveSecurityContact(loaded.config);

    const privacyDoc = loaded.config.privacy?.doc ? path.join(root, loaded.config.privacy.doc) : null;
    const securityDoc = loaded.config.security?.doc ? path.join(root, loaded.config.security.doc) : null;
    const privacySummary = loaded.config.privacy?.summary || (privacyDoc ? readDocSummary(privacyDoc) : null);
    const securitySummary = securityDoc ? readDocSummary(securityDoc) : null;

    return {
      product: PRODUCT_NAME,
      edition: PRODUCT_EDITION,
      version,
      shellVersion,
      // 一致性是**计算出来的**，不是文案承诺：两个版本源必须吻合。
      versionConsistent: version !== UNKNOWN && shellVersion !== UNKNOWN && version === shellVersion && version === text(pkg.version),
      channel,
      buildNumber,
      build: {
        commit,
        commitSource,
        sourceCommit: text(build.sourceCommit) || commit,
        channel,
        buildNumber,
        buildTime: text(build.buildTime) || UNKNOWN,
        buildId: text(build.buildId) || UNKNOWN
      },
      runtime: {
        node: process.versions.node || UNKNOWN,
        v8: process.versions.v8 || UNKNOWN,
        platform: process.platform,
        arch: process.arch,
        packaged: packaged === true,
        pid: process.pid,
        reportedAt: now()
      },
      // UI「平台 / 架构」：runtime 是工程视角，platform 是展示视角。
      platform,
      // UI「开发者」：未配置就是未配置（configured=false），不改成产品名糊弄用户。
      developer: { name: loaded.config.developer ?? null, configured: Boolean(loaded.config.developer) },
      // UI「官方网站 / GitCode / GitHub」。
      links: {
        website: loaded.config.website ?? null,
        websiteConfigured: Boolean(loaded.config.website),
        gitcode: loaded.config.repositories.gitcode,
        github: loaded.config.repositories.github,
        primary: loaded.config.repositories.primary,
        repository
      },
      license,
      repository,
      // UI「许可证 / 隐私说明 / 安全说明」。
      legal: {
        license: {
          name: license === UNKNOWN ? fallbackLicenseName : license,
          file: loaded.config.license.file,
          url: loaded.config.license.url,
          available: fs.existsSync(path.join(root, loaded.config.license.file))
        },
        privacy: {
          doc: loaded.config.privacy?.doc ?? null,
          available: Boolean(privacySummary),
          summary: privacySummary
        },
        security: {
          doc: loaded.config.security?.doc ?? null,
          available: Boolean(securitySummary),
          summary: securitySummary,
          contact: contact.url,
          contactSource: contact.source,
          advisoryUrl: loaded.config.security?.advisoryUrl ?? contact.url
        }
      },
      // UI「更新」区块的构建侧事实（当前版本之外的版本信息来自 update 服务 / 公告缓存）。
      release: {
        file: release.file,
        available: release.available === true,
        corrupt: release.corrupt === true,
        version: release.version ?? null,
        buildId: release.buildId ?? null,
        commit: release.commit ?? null,
        builtAt: release.builtAt ?? null,
        platform: release.platform ?? null
      },
      // 发行配置完整度：UI 据此显示「未配置」，而不是显示空白。
      readiness: loaded.readiness,
      releaseConfigSource: loaded.source,
      releaseConfigError: loaded.lastError,
      updateChannelHint: null
    };
  }

  return {
    info,
    releaseConfig: loaded.config,
    paths: {
      packageFile: pkgFile,
      buildInfoFile: buildFile,
      cargoTomlFile: cargoFile,
      licenseFile: licFile,
      releaseConfigFile: loaded.file,
      releaseManifestFile: manifestFile
    }
  };
}
