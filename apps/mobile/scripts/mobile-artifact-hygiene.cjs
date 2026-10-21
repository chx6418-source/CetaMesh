#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHANNEL_LIMIT = Object.freeze({ dev: 1, rc: 2, stable: 1, beta: 2 });
const SAFE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const DEV_ALLOWLIST = [
  'android/app/build/outputs/apk/debug',
  'android/app/build/outputs/bundle/debug'
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`manifest index already exists: ${file}`);
  const tempFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempFile, 'wx', 0o644);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.existsSync(file)) throw new Error(`manifest index appeared before publish: ${file}`);
    fs.renameSync(tempFile, file);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* closing a descriptor already closed by the OS is best effort */ }
    }
    try { fs.unlinkSync(tempFile); } catch { /* temp may already have moved or been removed */ }
    throw error;
  }
}

function normalizeRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('cleanup path is not allowlisted');
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('cleanup path traversal is not allowed');
  return normalized;
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoLinks(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error(`cleanup refuses symlink or junction: ${current}`);
  }
  return current;
}

function assertSafeDirectoryChain(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) return current;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`release output path contains a reparse point or non-directory: ${current}`);
    }
  }
  return current;
}

function ensureRealDirectoryChain(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat = lstatOrNull(current);
    if (!stat) {
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`release output path contains a reparse point or non-directory: ${current}`);
    }
  }
  return current;
}

function removeOwnedStage(root, stageDir) {
  const relative = path.relative(root, stageDir).split(path.sep).join('/');
  const checked = assertNoLinks(root, relative);
  if (!checked) return;
  assertNoLinksBelow(stageDir);
  fs.rmSync(stageDir, { recursive: true, force: false });
}

function assertNoLinksBelow(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cleanup target must be a real directory: ${directory}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const child = fs.lstatSync(target);
    if (child.isSymbolicLink()) throw new Error(`cleanup refuses nested symlink or junction: ${target}`);
    if (child.isDirectory()) assertNoLinksBelow(target);
  }
}

function directoryBytes(directory) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isFile()) total += stat.size;
    }
  }
  return total;
}

function artifactEntries(directory, manifest) {
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) return null;
  const entries = [];
  const artifactPaths = new Set();
  for (const item of manifest.artifacts) {
    const relative = normalizeRelative(item.path);
    const fullPath = path.resolve(directory, ...relative.split('/'));
    const pathKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    if (artifactPaths.has(pathKey)) return null;
    artifactPaths.add(pathKey);
    const fromPackage = path.relative(directory, fullPath);
    if (!fromPackage || fromPackage.startsWith(`..${path.sep}`) || path.isAbsolute(fromPackage)) return null;
    let stat;
    try { stat = fs.lstatSync(fullPath); } catch { return null; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(item.bytes)) return null;
    const actualHash = sha256(fullPath);
    if (actualHash !== String(item.sha256 ?? '').toLowerCase()) return null;
    entries.push({ path: relative, bytes: stat.size, sha256: actualHash });
  }
  return entries;
}

function readMobileVersion(rootDir) {
  const gradleFile = path.join(rootDir, 'android', 'app', 'build.gradle');
  const source = fs.readFileSync(gradleFile, 'utf8');
  const buildNumber = Number(/\bversionCode\s+(\d+)/.exec(source)?.[1]);
  const productVersion = /\bversionName\s+"([^"]+)"/.exec(source)?.[1];
  const packageVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) throw new Error('android versionCode must be a positive safe integer');
  if (!productVersion || productVersion !== packageVersion) throw new Error('android versionName must match package.json version');
  const match = SAFE_SEMVER.exec(productVersion);
  if (!match) throw new Error('android versionName must be safe SemVer and a single path component');
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((part) => !part || !/^[0-9A-Za-z-]+$/.test(part) || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) {
    throw new Error('android versionName has an invalid SemVer prerelease path component');
  }
  const channel = productVersion.includes('-rc') ? 'rc'
    : productVersion.includes('-beta') ? 'beta'
      : productVersion.includes('-alpha') || productVersion.includes('-dev') ? 'dev' : 'stable';
  return { productVersion, buildNumber, channel };
}

function sourceCommit(rootDir) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.status !== 0) throw new Error(`cannot read Git source commit: ${result.stderr || result.error?.message || 'git failed'}`);
  return result.stdout.trim();
}

function runGradle(rootDir, { appBuildDir }) {
  const androidDir = path.join(rootDir, 'android');
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const result = spawnSync(wrapper, [`-PcetameshAppBuildDir=${appBuildDir}`, 'assembleRelease', 'bundleRelease'], {
    cwd: androidDir,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32'
  });
  if (result.error || result.status !== 0) throw new Error(`Gradle release build failed: ${result.error?.message ?? `exit ${result.status}`}`);
}

function buildAndroidRelease({ rootDir, runGradleCommand = runGradle, now = new Date(), commit = null } = {}) {
  const root = fs.realpathSync(rootDir);
  const release = readMobileVersion(root);
  const artifactRootSegments = ['artifacts'];
  const stageRootSegments = ['artifacts', '.staging'];
  const releaseParentSegments = ['artifacts', release.channel, release.productVersion];
  const manifestParentSegments = ['artifacts', 'manifests', release.channel, release.productVersion];
  for (const segments of [artifactRootSegments, stageRootSegments, releaseParentSegments, manifestParentSegments]) {
    assertSafeDirectoryChain(root, segments);
  }
  const artifactRoot = path.join(root, ...artifactRootSegments);
  const buildDir = path.join(root, ...releaseParentSegments, `build-${release.buildNumber}`);
  const manifestIndex = path.join(root, ...manifestParentSegments, `build-${release.buildNumber}.json`);
  const stageRoot = path.join(root, ...stageRootSegments);
  const stageDir = path.join(stageRoot, `${process.pid}-${crypto.randomUUID()}`);
  const gradleBuildDir = path.join(stageDir, 'gradle-build');
  if (lstatOrNull(buildDir)) throw new Error(`canonical artifact already exists; refusing to overwrite: ${buildDir}`);
  if (lstatOrNull(manifestIndex)) throw new Error(`canonical manifest index already exists; refusing to overwrite: ${manifestIndex}`);
  ensureRealDirectoryChain(root, artifactRootSegments);
  ensureRealDirectoryChain(root, stageRootSegments);
  ensureRealDirectoryChain(root, releaseParentSegments);
  ensureRealDirectoryChain(root, manifestParentSegments);
  fs.mkdirSync(stageDir, { recursive: false });
  try {
    runGradleCommand(root, { appBuildDir: gradleBuildDir });
    const stageSegments = [...stageRootSegments, path.basename(stageDir)];
    const outputDirectories = [
      [...stageSegments, 'gradle-build'],
      [...stageSegments, 'gradle-build', 'outputs', 'apk', 'release'],
      [...stageSegments, 'gradle-build', 'outputs', 'bundle', 'release']
    ];
    for (const segments of [
      artifactRootSegments,
      stageRootSegments,
      stageSegments,
      releaseParentSegments,
      manifestParentSegments,
      ...outputDirectories
    ]) {
      assertSafeDirectoryChain(root, segments);
    }
    if (lstatOrNull(buildDir)) throw new Error('canonical artifact appeared during Gradle build');
    if (lstatOrNull(manifestIndex)) throw new Error('canonical manifest index appeared during Gradle build');
    const candidates = [
      ['apk', path.join(gradleBuildDir, 'outputs', 'apk', 'release', 'app-release.apk'), `CetaMesh-Mobile-${release.productVersion}-build${release.buildNumber}.apk`],
      ['aab', path.join(gradleBuildDir, 'outputs', 'bundle', 'release', 'app-release.aab'), `CetaMesh-Mobile-${release.productVersion}-build${release.buildNumber}.aab`]
    ].filter(([, source]) => fs.existsSync(source));
    if (!candidates.some(([kind]) => kind === 'apk')) throw new Error('Gradle completed without a release APK');
    const files = [];
    for (const [kind, source, name] of candidates) {
      const sourceSegments = path.relative(root, path.dirname(source)).split(path.sep);
      assertSafeDirectoryChain(root, sourceSegments);
      assertSafeDirectoryChain(root, stageSegments);
      const sourceStat = fs.lstatSync(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Gradle output must be a regular file: ${source}`);
      const target = path.join(stageDir, name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      files.push({ kind, path: name, bytes: fs.statSync(target).size, sha256: sha256(target) });
    }
    if (lstatOrNull(gradleBuildDir)) removeOwnedStage(root, gradleBuildDir);
    const manifest = {
      product: 'CetaMesh Mobile',
      productVersion: release.productVersion,
      version: release.productVersion,
      channel: release.channel,
      buildNumber: release.buildNumber,
      sourceCommit: commit ?? sourceCommit(root),
      createdAt: now.toISOString(),
      remoteBackedUp: false,
      signing: 'repository Gradle release signing configuration (unchanged)',
      entry: files.find((item) => item.kind === 'apk').path,
      artifacts: files.map(({ path: itemPath, bytes, sha256: hash }) => ({ path: itemPath, bytes, sha256: hash })),
      files: Object.fromEntries(files.map((item) => [item.path, item.sha256]))
    };
    fs.writeFileSync(path.join(stageDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    if (fs.existsSync(buildDir)) throw new Error(`canonical artifact appeared during build: ${buildDir}`);
    ensureRealDirectoryChain(root, releaseParentSegments);
    ensureRealDirectoryChain(root, manifestParentSegments);
    assertSafeDirectoryChain(root, stageSegments);
    if (lstatOrNull(manifestIndex)) throw new Error('canonical manifest index appeared before publish');
    fs.renameSync(stageDir, buildDir);
    ensureRealDirectoryChain(root, manifestParentSegments);
    if (lstatOrNull(manifestIndex)) throw new Error('canonical manifest index appeared before write');
    writeJsonAtomic(manifestIndex, manifest);
    return { directory: buildDir, manifest };
  } catch (error) {
    try {
      removeOwnedStage(root, stageDir);
    } catch (cleanupError) {
      error.cleanupError = cleanupError?.message ?? String(cleanupError);
    }
    throw error;
  }
}

function listPackages(artifactRoot) {
  const packages = [];
  if (!fs.existsSync(artifactRoot)) return packages;
  const rootStat = fs.lstatSync(artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('artifacts root must be a real directory');
  for (const channel of Object.keys(CHANNEL_LIMIT)) {
    const channelDir = path.join(artifactRoot, channel);
    const channelStat = lstatOrNull(channelDir);
    if (!channelStat) continue;
    if (!channelStat.isDirectory() || channelStat.isSymbolicLink()) throw new Error(`reparse point in release channel: ${channelDir}`);
    for (const version of fs.readdirSync(channelDir)) {
      if (!/^[0-9A-Za-z.+-]+$/.test(version)) continue;
      const versionDir = path.join(channelDir, version);
      const versionStat = lstatOrNull(versionDir);
      if (!versionStat) continue;
      if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) throw new Error(`reparse point in release version: ${versionDir}`);
      for (const build of fs.readdirSync(versionDir)) {
        if (!/^build-\d+$/.test(build)) continue;
        const directory = path.join(versionDir, build);
        const stat = lstatOrNull(directory);
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`reparse point in release package: ${directory}`);
        const manifestPath = path.join(directory, 'release-manifest.json');
        let manifest = null;
        let artifacts = null;
        try {
          if (fs.lstatSync(manifestPath).isFile()) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            artifacts = artifactEntries(directory, manifest);
          }
        } catch {
          // Incomplete or invalid artifacts are preserved and excluded from automatic retention.
        }
        const buildNumber = Number(manifest?.buildNumber ?? build.slice('build-'.length));
        const createdAt = Date.parse(manifest?.createdAt ?? '');
        packages.push({
          channel, directory,
          relativePath: path.relative(path.dirname(artifactRoot), directory).split(path.sep).join('/'),
          buildNumber,
          createdAt: Number.isFinite(createdAt) ? createdAt : 0,
          manifest,
          artifacts,
          verified: Boolean(artifacts),
          remoteBackedUp: manifest?.remoteBackedUp === true
        });
      }
    }
  }
  return packages;
}

function planArtifactRetention(artifactRoot) {
  const packages = listPackages(artifactRoot);
  const counts = new Map();
  for (const item of packages) {
    for (const artifact of item.artifacts ?? []) {
      let owners = counts.get(artifact.sha256);
      if (!owners) {
        owners = new Set();
        counts.set(artifact.sha256, owners);
      }
      owners.add(item.directory);
    }
  }
  const candidates = [];
  for (const channel of Object.keys(CHANNEL_LIMIT)) {
    const sorted = packages.filter((item) => item.channel === channel).sort((a, b) => b.createdAt - a.createdAt || b.buildNumber - a.buildNumber);
    for (const item of sorted.slice(CHANNEL_LIMIT[channel])) {
      if (!item.verified || !item.remoteBackedUp) continue;
      if (item.artifacts.some((artifact) => counts.get(artifact.sha256)?.size === 1)) continue;
      candidates.push({ relativePath: item.relativePath, path: item.directory, bytes: directoryBytes(item.directory) });
    }
  }
  return { mode: 'release', candidates, keepByChannel: { ...CHANNEL_LIMIT } };
}

function planCleanup({ rootDir, mode }) {
  const root = fs.realpathSync(rootDir);
  if (mode === 'dev') {
    const candidates = [];
    for (const relativePath of DEV_ALLOWLIST) {
      const target = assertNoLinks(root, relativePath);
      if (!target) continue;
      assertNoLinksBelow(target);
      candidates.push({ relativePath, path: target, bytes: directoryBytes(target) });
    }
    return { mode, rootDir: root, candidates };
  }
  if (mode === 'release') return { ...planArtifactRetention(path.join(root, 'artifacts')), rootDir: root };
  throw new Error(`unknown cleanup mode: ${mode}`);
}

function applyCleanup({ rootDir, plan }) {
  const root = fs.realpathSync(rootDir);
  const fresh = planCleanup({ rootDir: root, mode: plan?.mode });
  const requested = (plan?.candidates ?? []).map((item) => item.relativePath).sort();
  const current = fresh.candidates.map((item) => item.relativePath).sort();
  if (JSON.stringify(requested) !== JSON.stringify(current)) throw new Error('cleanup plan changed; preview it again');
  const removed = [];
  let reclaimedBytes = 0;
  for (const item of fresh.candidates) {
    const relative = normalizeRelative(item.relativePath);
    const isDev = DEV_ALLOWLIST.includes(relative);
    const isRelease = /^artifacts\/(dev|rc|stable|beta)\/[0-9A-Za-z.+-]+\/build-\d+$/.test(relative);
    if (!isDev && !isRelease) throw new Error(`cleanup target not allowlisted: ${relative}`);
    const target = assertNoLinks(root, relative);
    if (!target || target !== item.path) throw new Error(`cleanup path changed after preview: ${relative}`);
    assertNoLinksBelow(target);
    const bytes = directoryBytes(target);
    if (bytes !== item.bytes) throw new Error(`cleanup target changed after preview: ${relative}`);
    fs.rmSync(target, { recursive: true, force: false });
    removed.push(relative);
    reclaimedBytes += bytes;
  }
  return { removed, reclaimedBytes };
}

function inspectStorage({ rootDir }) {
  const root = fs.realpathSync(rootDir);
  const gitMarker = path.join(root, '.git');
  let gitObjects = null;
  try {
    const gitStat = fs.lstatSync(gitMarker);
    let gitDir = gitStat.isDirectory() ? gitMarker : null;
    if (!gitDir && gitStat.isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitMarker, 'utf8'));
      if (pointer) gitDir = path.resolve(root, pointer[1]);
    }
    if (gitDir) {
      const commonDirFile = path.join(gitDir, 'commondir');
      const commonDir = fs.existsSync(commonDirFile) ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim()) : gitDir;
      const candidate = path.join(commonDir, 'objects');
      if (fs.existsSync(candidate)) gitObjects = candidate;
    }
  } catch {
    // A missing or unreadable Git metadata pointer is reported as zero.
  }
  const gradleHome = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
  const paths = [
    'android/app/build', 'android/build', 'android/.gradle', 'artifacts', 'artifacts/manifests',
    '.git/objects (shared store)', 'Gradle user cache (report only)'
  ];
  const targets = [
    ...paths.slice(0, 5).map((relative) => path.join(root, ...relative.split('/'))),
    gitObjects,
    gradleHome
  ];
  return paths.map((relativePath, index) => {
    const target = targets[index];
    if (!target || !fs.existsSync(target)) return { relativePath, bytes: 0 };
    const stat = fs.lstatSync(target);
    return { relativePath, bytes: stat.isDirectory() ? directoryBytes(target) : stat.size };
  });
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes (${(bytes / 1_000_000_000).toFixed(3)} GB)`;
}

function main(argv = process.argv.slice(2)) {
  const rootDir = path.resolve(__dirname, '..');
  const [command, ...args] = argv;
  const apply = args.includes('--apply');
  if (command === 'build') {
    const result = buildAndroidRelease({ rootDir });
    process.stdout.write(`Published ${path.relative(rootDir, result.directory)}\n`);
    return;
  }
  if (command === 'status') {
    process.stdout.write('CetaMesh Mobile storage (metadata only)\n');
    for (const item of inspectStorage({ rootDir })) process.stdout.write(`- ${item.relativePath}: ${formatBytes(item.bytes)}\n`);
    process.stdout.write('Global Gradle cache is report-only.\n');
    return;
  }
  if (!['dev', 'release'].includes(command)) throw new Error('usage: mobile-artifact-hygiene.cjs <build|status|dev|release> [--apply]');
  const plan = planCleanup({ rootDir, mode: command });
  if (!plan.candidates.length) {
    process.stdout.write(`No ${command} cleanup candidates.\n`);
    return;
  }
  process.stdout.write(`${apply ? 'APPLY' : 'DRY RUN'} ${command} cleanup\n`);
  for (const item of plan.candidates) process.stdout.write(`- ${item.relativePath}: ${formatBytes(item.bytes)}\n`);
  if (!apply) process.stdout.write('Nothing deleted. Add --apply after reviewing the paths.\n');
  else {
    const result = applyCleanup({ rootDir, plan });
    process.stdout.write(`Removed ${result.removed.length} path(s); reclaimed ${formatBytes(result.reclaimedBytes)}.\n`);
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`[mobile-artifact-hygiene] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  applyCleanup,
  buildAndroidRelease,
  inspectStorage,
  planArtifactRetention,
  planCleanup,
  readMobileVersion,
  resolveGradleSourceCommit: sourceCommit
};
