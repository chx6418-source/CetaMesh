import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from '../storage/json-file.js';

export const RELEASE_CHANNELS = Object.freeze(['stable', 'rc', 'beta', 'dev']);
export const RELEASE_VERSION_FILE = path.join('release', 'version.json');

function releaseError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseSemVer(value) {
  const text = String(value ?? '').trim();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) throw releaseError('VERSION_INVALID', 'productVersion must be a SemVer without build metadata');
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(item => !item || !/^[0-9A-Za-z-]+$/.test(item) || (/^\d+$/.test(item) && item.length > 1 && item.startsWith('0')))) {
    throw releaseError('VERSION_INVALID', 'productVersion has an invalid SemVer prerelease');
  }
  return { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function channelForVersion(productVersion) {
  const { prerelease } = parseSemVer(productVersion);
  if (!prerelease.length) return 'stable';
  const id = prerelease[0].toLowerCase();
  if (id === 'rc') return 'rc';
  if (id === 'beta') return 'beta';
  if (id === 'alpha' || id === 'dev') return 'dev';
  throw releaseError('CHANNEL_INVALID', 'prerelease channel must begin with alpha, beta, rc, or dev');
}

export function validateReleaseVersion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw releaseError('VERSION_INVALID', 'release version must be an object');
  }
  const semver = parseSemVer(raw.productVersion);
  const channel = String(raw.channel ?? '').trim();
  if (!RELEASE_CHANNELS.includes(channel)) throw releaseError('CHANNEL_INVALID', 'channel is not supported');
  if (channel !== channelForVersion(semver.text)) {
    throw releaseError('CHANNEL_VERSION_MISMATCH', `channel ${channel} does not match ${semver.text}`);
  }
  const buildNumber = Number(raw.buildNumber);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw releaseError('BUILD_NUMBER_INVALID', 'buildNumber must be a positive safe integer');
  }
  return { productVersion: semver.text, channel, buildNumber };
}

export function loadReleaseVersion({ rootDir = process.cwd(), file = null } = {}) {
  const versionFile = file || path.join(rootDir, RELEASE_VERSION_FILE);
  let raw;
  try {
    raw = readJsonFile(versionFile, { maxBytes: 4096 });
  } catch (error) {
    throw releaseError('VERSION_SOURCE_INVALID', `cannot read release version source: ${error.message}`);
  }
  return validateReleaseVersion(raw);
}

export function readShellVersion(cargoTomlFile) {
  const source = fs.readFileSync(cargoTomlFile, 'utf8');
  const packageHeader = /^\[package\]\s*$/m.exec(source);
  if (!packageHeader) return null;
  const sectionStart = packageHeader.index + packageHeader[0].length;
  const nextSection = /^\[[^\]]+\]\s*$/gm;
  nextSection.lastIndex = sectionStart;
  const nextHeader = nextSection.exec(source);
  const section = source.slice(sectionStart, nextHeader?.index ?? source.length);
  return /^\s*version\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}

export function validateVersionMirrors({
  rootDir = process.cwd(),
  release = null,
  packageVersion = null,
  shellVersion = null
} = {}) {
  const issues = [];
  let canonical;
  try {
    canonical = release ? validateReleaseVersion(release) : loadReleaseVersion({ rootDir });
  } catch (error) {
    return { ok: false, issues: [{ code: error.code ?? 'VERSION_SOURCE_INVALID', message: error.message }] };
  }
  let resolvedPackageVersion = packageVersion;
  let resolvedShellVersion = shellVersion;
  if (resolvedPackageVersion === null) {
    try {
      resolvedPackageVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
    } catch {
      resolvedPackageVersion = null;
    }
  }
  if (resolvedShellVersion === null) {
    try {
      resolvedShellVersion = readShellVersion(path.join(rootDir, 'desktop-shell', 'Cargo.toml'));
    } catch {
      resolvedShellVersion = null;
    }
  }
  if (resolvedPackageVersion !== canonical.productVersion) {
    issues.push({ code: 'PACKAGE_VERSION_MISMATCH', expected: canonical.productVersion, actual: resolvedPackageVersion ?? null });
  }
  if (resolvedShellVersion !== canonical.productVersion) {
    issues.push({ code: 'SHELL_VERSION_MISMATCH', expected: canonical.productVersion, actual: resolvedShellVersion ?? null });
  }
  return { ok: issues.length === 0, release: canonical, issues };
}

function compareIdentifiers(a, b) {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) === Number(b) ? 0 : Number(a) > Number(b) ? 1 : -1;
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

export function compareProductVersions(a, b) {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function releaseParts(value) {
  if (typeof value === 'string') return { productVersion: value, buildNumber: 0 };
  return { productVersion: value.productVersion ?? value.version, buildNumber: Number(value.buildNumber ?? 0) };
}

export function compareReleaseVersions(a, b) {
  const left = releaseParts(a);
  const right = releaseParts(b);
  const semver = compareProductVersions(left.productVersion, right.productVersion);
  if (semver !== 0) return semver;
  return left.buildNumber === right.buildNumber ? 0 : left.buildNumber > right.buildNumber ? 1 : -1;
}

export function formatArtifactName({ productVersion, buildNumber, platform }) {
  const release = validateReleaseVersion({ productVersion, channel: channelForVersion(productVersion), buildNumber });
  const value = String(platform ?? '').toLowerCase();
  if (value === 'windows-x64') return `CetaMesh-Setup-${release.productVersion}-build${release.buildNumber}-x64.exe`;
  if (value === 'android') return `CetaMesh-Mobile-${release.productVersion}-build${release.buildNumber}.apk`;
  throw releaseError('PLATFORM_UNSUPPORTED', `artifact platform is not supported: ${value}`);
}

export function releaseArtifactDirectory({ rootDir = process.cwd(), channel, productVersion, buildNumber } = {}) {
  const requestedChannel = String(channel ?? '').trim();
  if (!['dev', 'rc', 'stable', 'beta'].includes(requestedChannel)) {
    throw releaseError('CHANNEL_INVALID', 'artifact channel is not supported');
  }
  const sourceChannel = channelForVersion(productVersion);
  const release = validateReleaseVersion({ channel: sourceChannel, productVersion, buildNumber });
  if (requestedChannel !== 'dev' && requestedChannel !== sourceChannel) {
    throw releaseError('CHANNEL_VERSION_MISMATCH', `artifact channel ${requestedChannel} does not match ${productVersion}`);
  }
  return path.join(rootDir, 'artifacts', requestedChannel, release.productVersion, `build-${release.buildNumber}`);
}

function versionPath({ rootDir = process.cwd(), file = null } = {}) {
  return file || path.join(rootDir, RELEASE_VERSION_FILE);
}

function syncVersionMirrors(rootDir, productVersion) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(rootDir, name);
    if (!fs.existsSync(file)) continue;
    const raw = readJsonFile(file, { maxBytes: 8 * 1024 * 1024 });
    raw.version = productVersion;
    if (name === 'package-lock.json' && raw.packages?.['']) raw.packages[''].version = productVersion;
    writeJsonAtomic(file, raw);
  }

  const cargoFile = path.join(rootDir, 'desktop-shell', 'Cargo.toml');
  if (fs.existsSync(cargoFile)) {
    const source = fs.readFileSync(cargoFile, 'utf8');
    const packageHeader = /^\[package\]\s*$/m.exec(source);
    if (!packageHeader) throw releaseError('VERSION_MIRROR_INVALID', 'Cargo.toml has no [package] section');
    const sectionStart = packageHeader.index + packageHeader[0].length;
    const nextSection = /^\[[^\]]+\]\s*$/gm;
    nextSection.lastIndex = sectionStart;
    const nextHeader = nextSection.exec(source);
    const sectionEnd = nextHeader?.index ?? source.length;
    const section = source.slice(sectionStart, sectionEnd);
    if (!/^\s*version\s*=\s*"[^"]+"/m.test(section)) throw releaseError('VERSION_MIRROR_INVALID', 'Cargo.toml [package] has no version field');
    const updated = source.slice(0, sectionStart)
      + section.replace(/^(\s*version\s*=\s*)"[^"]+"/m, `$1"${productVersion}"`)
      + source.slice(sectionEnd);
    writeTextAtomic(cargoFile, updated);
  }

  const cargoLock = path.join(rootDir, 'desktop-shell', 'Cargo.lock');
  if (fs.existsSync(cargoLock)) {
    const source = fs.readFileSync(cargoLock, 'utf8');
    const marker = /^(\[\[package\]\]\r?\nname = "whalebridge-desktop"\r?\nversion = ")[^"]+("\s*)$/m;
    if (!marker.test(source)) throw releaseError('VERSION_MIRROR_INVALID', 'Cargo.lock has no whalebridge-desktop package entry');
    writeTextAtomic(cargoLock, source.replace(marker, `$1${productVersion}$2`));
  }
}

function writeVersion(file, value) {
  const validated = validateReleaseVersion(value);
  const rootDir = path.dirname(path.dirname(path.resolve(file)));
  syncVersionMirrors(rootDir, validated.productVersion);
  writeJsonAtomic(file, validated);
  return validated;
}

export function bumpBuildNumber(options = {}) {
  const file = versionPath(options);
  const current = loadReleaseVersion({ file });
  return writeVersion(file, { ...current, buildNumber: current.buildNumber + 1 });
}

export function setProductVersion({ productVersion, ...options } = {}) {
  const file = versionPath(options);
  const current = loadReleaseVersion({ file });
  return writeVersion(file, { productVersion: String(productVersion ?? ''), channel: channelForVersion(productVersion), buildNumber: current.buildNumber });
}

export function bumpProductVersion({ kind = 'patch', ...options } = {}) {
  const file = versionPath(options);
  const current = loadReleaseVersion({ file });
  const parsed = parseSemVer(current.productVersion);
  const next = { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
  if (kind === 'major') { next.major += 1; next.minor = 0; next.patch = 0; }
  else if (kind === 'minor') { next.minor += 1; next.patch = 0; }
  else if (kind === 'patch') next.patch += 1;
  else throw releaseError('BUMP_KIND_INVALID', 'version bump must be major, minor, or patch');
  return writeVersion(file, { productVersion: `${next.major}.${next.minor}.${next.patch}`, channel: 'stable', buildNumber: current.buildNumber });
}

export function bumpPrerelease({ channel = 'rc', ...options } = {}) {
  if (!['rc', 'beta', 'dev'].includes(channel)) throw releaseError('CHANNEL_INVALID', 'prerelease must be rc, beta, or dev');
  const file = versionPath(options);
  const current = loadReleaseVersion({ file });
  const parsed = parseSemVer(current.productVersion);
  const order = { dev: 0, beta: 1, rc: 2 };
  let { major, minor, patch } = parsed;
  const sameChannel = parsed.prerelease[0] === channel;
  const nextId = sameChannel ? (Number(parsed.prerelease[1]) || 0) + 1 : 1;
  if (!sameChannel && (current.channel === 'stable' || order[channel] <= order[current.channel])) patch += 1;
  return writeVersion(file, { productVersion: `${major}.${minor}.${patch}-${channel}.${nextId}`, channel, buildNumber: current.buildNumber });
}
