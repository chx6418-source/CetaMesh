// CetaMesh Desktop —— 构建信息（阶段 12）。
//
// 「About 的 Version 必须与构建版本一致」这件事只能靠**单一事实源**保证：
//   - 版本号只从 package.json 读（运行时/打包时都是同一份）；
//   - 桌面壳版本从 desktop-shell/Cargo.toml 读，用来**交叉核对**两者是否一致；
//   - commit / 构建时间优先来自 build-info.json（发布构建写入）；开发态可回退到 git；
//     两者都拿不到就如实报 'unknown' —— 绝不编造一个看起来像真的构建号。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PRODUCT_NAME = 'CetaMesh';
export const PRODUCT_EDITION = 'Desktop';

export const UNKNOWN = 'unknown';

function readJsonFile(file) {
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
    const text = fs.readFileSync(cargoTomlFile, 'utf8');
    const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(text);
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

function defaultGitCommit(rootDir) {
  try {
    return text(execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir, timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).toString());
  } catch {
    return null;
  }
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
  execGit = null,
  packaged = false,
  now = () => Date.now()
} = {}) {
  const root = rootDir || process.cwd();
  const pkgFile = packageFile || path.join(root, 'package.json');
  const buildFile = buildInfoFile || path.join(root, 'build-info.json');
  const cargoFile = cargoTomlFile || path.join(root, 'desktop-shell', 'Cargo.toml');
  const licFile = licenseFile || path.join(root, 'LICENSE');

  function info() {
    const pkg = readJsonFile(pkgFile) || {};
    const version = text(pkg.version) || UNKNOWN;
    const shellVersion = readShellVersion(cargoFile) || UNKNOWN;
    const build = readJsonFile(buildFile) || {};

    let commit = text(build.commit);
    let commitSource = commit ? 'build-info' : null;
    if (!commit && !packaged) {
      const git = (execGit || (() => defaultGitCommit(root)))();
      if (git) { commit = git; commitSource = 'git'; }
    }
    if (!commit) { commit = UNKNOWN; commitSource = 'unavailable'; }

    const license = readLicenseName({ packageJson: pkg, licenseFile: licFile });
    const repository = text(pkg.repository && (pkg.repository.url || pkg.repository)) || UNKNOWN;

    return {
      product: PRODUCT_NAME,
      edition: PRODUCT_EDITION,
      version,
      shellVersion,
      // 一致性是**计算出来的**，不是文案承诺：两个版本源必须吻合。
      versionConsistent: version !== UNKNOWN && shellVersion !== UNKNOWN && version === shellVersion,
      build: {
        commit,
        commitSource,
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
      license,
      repository,
      updateChannelHint: null
    };
  }

  return { info, paths: { packageFile: pkgFile, buildInfoFile: buildFile, cargoTomlFile: cargoFile, licenseFile: licFile } };
}
