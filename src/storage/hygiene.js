import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEV_ALLOWLIST = ['desktop-shell/target/debug/incremental'];
const CHANNEL_RETENTION = Object.freeze({ dev: 1, rc: 2, stable: 1 });
const RELEASE_RELATIVE_PATH = /^artifacts\/(dev|rc|stable)\/[^/]+\/build-\d+$/;

function normalizeRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('cleanup path is outside the allowlist');
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error('cleanup path traversal is not allowed');
  }
  return normalized;
}

function existsNoFollow(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoReparseComponents(rootRealPath, relativePath) {
  let current = rootRealPath;
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    const stat = existsNoFollow(current);
    if (!stat) return { exists: false, targetPath: current };
    if (stat.isSymbolicLink()) throw new Error(`cleanup refuses symlink or junction path: ${current}`);
  }
  return { exists: true, targetPath: current };
}

function assertNoReparseTree(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cleanup target must be a real directory: ${directory}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const childStat = fs.lstatSync(fullPath);
    if (childStat.isSymbolicLink()) throw new Error(`cleanup refuses nested symlink or junction: ${fullPath}`);
    if (childStat.isDirectory()) assertNoReparseTree(fullPath);
  }
}

function directoryBytes(directory) {
  let bytes = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(fullPath);
      else if (stat.isFile()) bytes += stat.size;
    }
  }
  return bytes;
}

function safeManifestArtifacts(directory, manifest) {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) return null;
  const files = [];
  const artifactPaths = new Set();
  for (const artifact of manifest.artifacts) {
    const relative = normalizeRelative(String(artifact.path ?? '')).replaceAll('\\', '/');
    const fullPath = path.resolve(directory, ...relative.split('/'));
    const pathKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    if (artifactPaths.has(pathKey)) return null;
    artifactPaths.add(pathKey);
    const relFromPackage = path.relative(directory, fullPath);
    if (!relFromPackage || relFromPackage.startsWith(`..${path.sep}`) || path.isAbsolute(relFromPackage)) return null;
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (Number(artifact.bytes) !== stat.size) return null;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
    if (typeof artifact.sha256 !== 'string' || artifact.sha256.toLowerCase() !== sha256) return null;
    files.push({ path: relative, bytes: stat.size, sha256 });
  }
  return files;
}

function listReleasePackages(artifactRoot) {
  const packages = [];
  if (!fs.existsSync(artifactRoot)) return packages;
  const rootStat = fs.lstatSync(artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('artifacts root must be a real directory');
  for (const channel of Object.keys(CHANNEL_RETENTION)) {
    const channelDir = path.join(artifactRoot, channel);
    const channelStat = existsNoFollow(channelDir);
    if (!channelStat) continue;
    if (!channelStat.isDirectory() || channelStat.isSymbolicLink()) throw new Error(`refusing reparse point at ${channelDir}`);
    for (const versionName of fs.readdirSync(channelDir)) {
      if (!/^[0-9A-Za-z.+-]+$/.test(versionName)) continue;
      const versionDir = path.join(channelDir, versionName);
      const versionStat = existsNoFollow(versionDir);
      if (!versionStat) continue;
      if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) throw new Error(`refusing reparse point at ${versionDir}`);
      for (const buildName of fs.readdirSync(versionDir)) {
        if (!/^build-\d+$/.test(buildName)) continue;
        const directory = path.join(versionDir, buildName);
        const stat = existsNoFollow(directory);
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing reparse point at ${directory}`);
        const relativePath = path.relative(path.dirname(artifactRoot), directory).split(path.sep).join('/');
        const manifestPath = path.join(directory, 'release-manifest.json');
        let manifest;
        let artifacts = null;
        try {
          if (fs.lstatSync(manifestPath).isFile()) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            artifacts = safeManifestArtifacts(directory, manifest);
          }
        } catch (error) {
          if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
          manifest = null;
          artifacts = null;
        }
        const match = /^build-(\d+)$/.exec(buildName);
        const buildNumber = Number(manifest?.buildNumber ?? match?.[1]);
        const createdAt = Date.parse(manifest?.createdAt ?? manifest?.buildTime ?? '');
        packages.push({
          channel,
          version: versionName,
          buildNumber,
          createdAt: Number.isFinite(createdAt) ? createdAt : 0,
          directory,
          relativePath,
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

export function resolveAllowlistedTarget(rootDir, relativePath) {
  const relative = normalizeRelative(relativePath);
  const rootRealPath = fs.realpathSync(rootDir);
  const isDevAllowlisted = DEV_ALLOWLIST.includes(relative);
  const isReleaseAllowlisted = RELEASE_RELATIVE_PATH.test(relative);
  if (!isDevAllowlisted && !isReleaseAllowlisted) throw new Error(`cleanup path is not allowlisted: ${relative}`);
  const resolved = path.resolve(rootRealPath, ...relative.split('/'));
  const fromRoot = path.relative(rootRealPath, resolved);
  if (!fromRoot || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('cleanup path escapes the repository root');
  }
  const inspected = assertNoReparseComponents(rootRealPath, relative);
  if (!inspected.exists) return null;
  if (path.resolve(inspected.targetPath) !== resolved) throw new Error('cleanup target path did not resolve canonically');
  return resolved;
}

function trackedFilesUnder(rootDir, relativePath) {
  const gitMarker = existsNoFollow(path.join(rootDir, '.git'));
  if (!gitMarker) throw new Error('cleanup cannot verify Git-tracked Dev-cache files: Git metadata missing');
  if (gitMarker.isSymbolicLink()) throw new Error('cleanup cannot verify tracked files through a linked .git directory');
  const result = spawnSync('git', ['-C', rootDir, 'ls-files', '--cached', '-z', '--', relativePath], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`cleanup could not verify Git-tracked Dev-cache files: ${result.error?.message ?? result.stderr ?? 'git ls-files failed'}`);
  }
  return String(result.stdout ?? '').split('\0').filter(Boolean);
}

export function inspectStorage({ rootDir }) {
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
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') throw error;
  }
  const cachePath = process.env.npm_config_cache
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache') : path.join(os.homedir(), '.npm'));
  const paths = [
    ['desktop-shell/target', path.join(root, 'desktop-shell', 'target')],
    ['dist', path.join(root, 'dist')],
    ['output', path.join(root, 'output')],
    ['node_modules', path.join(root, 'node_modules')],
    ['artifacts/manifests', path.join(root, 'artifacts', 'manifests')],
    ['.git/objects', gitObjects],
    ['npm-cache (report only)', cachePath]
  ];
  return paths.map(([name, target]) => {
    if (!target || !fs.existsSync(target)) return { name, bytes: 0 };
    const stat = fs.lstatSync(target);
    return { name, bytes: stat.isDirectory() ? directoryBytes(target) : stat.size };
  });
}

export function planArtifactRetention({ artifactRoot, now = Date.now() }) {
  void now;
  const packages = listReleasePackages(path.resolve(artifactRoot));
  const hashOwners = new Map();
  for (const item of packages) {
    for (const artifact of item.artifacts ?? []) {
      let owners = hashOwners.get(artifact.sha256);
      if (!owners) {
        owners = new Set();
        hashOwners.set(artifact.sha256, owners);
      }
      owners.add(item.directory);
    }
  }
  const candidates = [];
  for (const channel of Object.keys(CHANNEL_RETENTION)) {
    const channelPackages = packages
      .filter((item) => item.channel === channel)
      .sort((a, b) => b.createdAt - a.createdAt || b.buildNumber - a.buildNumber);
    for (const item of channelPackages.slice(CHANNEL_RETENTION[channel])) {
      if (!item.verified || !item.remoteBackedUp) continue;
      if (item.artifacts.some((artifact) => hashOwners.get(artifact.sha256)?.size === 1)) continue;
      candidates.push({ relativePath: item.relativePath, path: item.directory, bytes: directoryBytes(item.directory), channel, buildNumber: item.buildNumber });
    }
  }
  return { mode: 'release', keepByChannel: { ...CHANNEL_RETENTION }, candidates };
}

export function planCleanup({ rootDir, mode, now = Date.now() }) {
  if (mode === 'release') {
    const root = fs.realpathSync(rootDir);
    return { ...planArtifactRetention({ artifactRoot: path.join(root, 'artifacts'), now }), rootDir: root };
  }
  if (mode !== 'dev') throw new Error(`unknown cleanup mode: ${mode}`);
  const root = fs.realpathSync(rootDir);
  const candidates = [];
  for (const relativePath of DEV_ALLOWLIST) {
    const tracked = trackedFilesUnder(root, relativePath);
    if (tracked.length) throw new Error(`cleanup refuses Git-tracked Dev-cache files: ${tracked.slice(0, 5).join(', ')}`);
    const target = resolveAllowlistedTarget(root, relativePath);
    if (!target) continue;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cleanup target must be a real directory: ${target}`);
    assertNoReparseTree(target);
    candidates.push({ relativePath, path: target, bytes: directoryBytes(target) });
  }
  return { mode: 'dev', rootDir: root, candidates };
}

export function applyCleanup({ rootDir, plan }) {
  if (!plan || !['dev', 'release'].includes(plan.mode)) throw new Error('invalid cleanup plan');
  const root = fs.realpathSync(rootDir);
  const fresh = planCleanup({ rootDir: root, mode: plan.mode });
  const requested = (plan.candidates ?? []).map((item) => item.relativePath).sort();
  const current = fresh.candidates.map((item) => item.relativePath).sort();
  if (JSON.stringify(requested) !== JSON.stringify(current)) throw new Error('cleanup plan is stale or was modified; generate a new dry-run plan');
  const removed = [];
  let reclaimedBytes = 0;
  for (const candidate of fresh.candidates) {
    const target = resolveAllowlistedTarget(root, candidate.relativePath);
    if (!target || target !== candidate.path) throw new Error(`cleanup target changed after planning: ${candidate.relativePath}`);
    assertNoReparseTree(target);
    const currentBytes = directoryBytes(target);
    if (currentBytes !== candidate.bytes) throw new Error(`cleanup target changed after planning: ${candidate.relativePath}`);
    fs.rmSync(target, { recursive: true, force: false });
    removed.push(candidate.relativePath);
    reclaimedBytes += currentBytes;
  }
  return { removed, reclaimedBytes };
}
