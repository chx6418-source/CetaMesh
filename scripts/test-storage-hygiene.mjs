import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyCleanup,
  planArtifactRetention,
  planCleanup,
  resolveAllowlistedTarget
} from '../src/storage/hygiene.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { cleanupStagingDirectory, publishStagedArtifact } from '../src/release/artifacts.js';
import * as releaseArtifacts from '../src/release/artifacts.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-storage-hygiene-'));
const rootDir = path.join(tempRoot, 'repo');
const desktopRoot = path.resolve(import.meta.dirname, '..');
const artifactRoot = path.join(rootDir, 'artifacts');
fs.mkdirSync(rootDir, { recursive: true });

function writeArtifact(channel, build, { remoteBackedUp = true, bytes = 'shared installer bytes', builtAt = build } = {}) {
  const dir = path.join(artifactRoot, channel, '1.0.0-rc.1', `build-${build}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'installer.bin');
  fs.writeFileSync(file, bytes);
  const content = fs.readFileSync(file);
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), `${JSON.stringify({
    productVersion: '1.0.0-rc.1',
    buildNumber: build,
    sourceCommit: `commit-${build}`,
    createdAt: new Date(Date.UTC(2026, 0, builtAt)).toISOString(),
    remoteBackedUp,
    artifacts: [{ path: 'installer.bin', bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }]
  }, null, 2)}\n`);
  return dir;
}

try {
  const incremental = path.join(rootDir, 'desktop-shell', 'target', 'debug', 'incremental');
  fs.mkdirSync(incremental, { recursive: true });
  fs.writeFileSync(path.join(incremental, 'cache'), 'generated');

  const gitInit = spawnSync('git', ['init', '--quiet'], { cwd: rootDir, encoding: 'utf8', windowsHide: true });
  assert.equal(gitInit.status, 0, `tracked-file cleanup fixture initializes Git: ${gitInit.stderr}`);
  const dryRun = planCleanup({ rootDir, mode: 'dev' });
  assert.equal(dryRun.mode, 'dev');
  assert.equal(dryRun.candidates.length, 1);
  assert.equal(fs.existsSync(incremental), true, 'planning must not delete files');
  assert.throws(() => resolveAllowlistedTarget(rootDir, '../outside'), /allowlist|path/i);

  const markerlessRoot = path.join(tempRoot, 'source-archive');
  fs.mkdirSync(path.join(markerlessRoot, 'desktop-shell', 'target', 'debug', 'incremental'), { recursive: true });
  fs.writeFileSync(path.join(markerlessRoot, 'desktop-shell', 'target', 'debug', 'incremental', 'cache'), 'generated');
  assert.throws(
    () => planCleanup({ rootDir: markerlessRoot, mode: 'dev' }),
    /Git metadata missing|cannot verify Git-tracked/i,
    'Dev cleanup fails closed when it cannot verify tracked files'
  );

  const trackedCache = path.join(incremental, 'tracked-cache');
  fs.writeFileSync(trackedCache, 'tracked source');
  const gitAdd = spawnSync('git', ['add', '--', 'desktop-shell/target/debug/incremental/tracked-cache'], { cwd: rootDir, encoding: 'utf8', windowsHide: true });
  assert.equal(gitAdd.status, 0, `tracked-file cleanup fixture stages its source: ${gitAdd.stderr}`);
  assert.throws(() => planCleanup({ rootDir, mode: 'dev' }), /tracked/i, 'Dev cleanup rejects any Git-tracked cache file');
  const gitRemove = spawnSync('git', ['rm', '--cached', '--quiet', '--', 'desktop-shell/target/debug/incremental/tracked-cache'], { cwd: rootDir, encoding: 'utf8', windowsHide: true });
  assert.equal(gitRemove.status, 0, `tracked-file cleanup fixture removes its temporary index entry: ${gitRemove.stderr}`);
  fs.rmSync(trackedCache);

  writeArtifact('rc', 1, { builtAt: 1 });
  const second = writeArtifact('rc', 2, { builtAt: 2 });
  const third = writeArtifact('rc', 3, { builtAt: 3 });
  const fourth = writeArtifact('rc', 4, { builtAt: 4 });
  const unbacked = writeArtifact('rc', 5, { remoteBackedUp: false, builtAt: 5 });
  const unique = writeArtifact('rc', 6, { bytes: 'unique signed installer', builtAt: 6 });

  const retention = planArtifactRetention({ artifactRoot });
  assert.equal(retention.keepByChannel.rc, 2);
  assert.ok(retention.candidates.some((candidate) => candidate.path === path.join(artifactRoot, 'rc', '1.0.0-rc.1', 'build-1')));
  assert.ok(!retention.candidates.some((candidate) => candidate.path === unbacked), 'unbacked package must be preserved');
  assert.ok(!retention.candidates.some((candidate) => candidate.path === unique), 'unique installer must be preserved');
  const releasePlan = { mode: 'release', candidates: retention.candidates };
  const releaseResult = applyCleanup({ rootDir, plan: releasePlan });
  assert.ok(releaseResult.removed.includes('artifacts/rc/1.0.0-rc.1/build-1'));
  assert.ok(!fs.existsSync(second));
  assert.ok(!fs.existsSync(third));
  assert.ok(!fs.existsSync(fourth));
  assert.ok(fs.existsSync(unbacked));
  assert.ok(fs.existsSync(unique));

  const duplicateUnique = writeArtifact('stable', 7, { bytes: 'unique duplicated manifest artifact', builtAt: 7 });
  const duplicateShared = writeArtifact('stable', 8, { bytes: 'shared duplicated manifest artifact', builtAt: 8 });
  const sharedPeer = writeArtifact('stable', 9, { bytes: 'shared duplicated manifest artifact', builtAt: 9 });
  writeArtifact('stable', 10, { bytes: 'newest stable installer', builtAt: 10 });
  for (const directory of [duplicateUnique, duplicateShared]) {
    const manifestPath = path.join(directory, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.push({ ...manifest.artifacts[0] });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  const duplicateRetention = planArtifactRetention({ artifactRoot });
  assert.ok(!duplicateRetention.candidates.some((candidate) => candidate.path === duplicateUnique), 'a unique hash repeated within one package must not make that package deletable');
  assert.ok(!duplicateRetention.candidates.some((candidate) => candidate.path === duplicateShared), 'duplicate manifest paths invalidate package verification even when another package shares the hash');
  assert.ok(!duplicateRetention.candidates.some((candidate) => candidate.path === sharedPeer), 'the intact peer remains the only verified copy when the duplicate manifest is rejected');

  const outside = path.join(tempRoot, 'outside');
  const debug = path.join(rootDir, 'desktop-shell', 'target', 'debug');
  fs.rmSync(path.dirname(debug), { recursive: true, force: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.dirname(debug), { recursive: true });
  fs.symlinkSync(outside, debug, 'junction');
  assert.throws(() => planCleanup({ rootDir, mode: 'dev' }), /link|reparse|symlink|escape/i);

  const sandboxRoot = path.join(tempRoot, 'test-sandboxes');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  // The aggregator exports its sandbox as TMPDIR. Leave room for a nested
  // fixture directory and socket basename within Unix sockaddr_un limits.
  const compact = createSuiteSandbox({ suiteId: 'test-comm-lifecycle-with-a-long-descriptive-suite-name', tempRoot: sandboxRoot });
  assert.ok(Buffer.byteLength(path.basename(compact.root)) <= 44, 'suite sandbox name must leave room for nested Unix socket paths');
  assert.equal(JSON.parse(fs.readFileSync(compact.markerPath, 'utf8')).suiteId, compact.suiteId);
  finalizeSuiteSandbox({ sandbox: compact, failed: false });
  const successful = createSuiteSandbox({ suiteId: 'successful', tempRoot: sandboxRoot });
  fs.writeFileSync(path.join(successful.root, 'output.txt'), 'successful diagnostic');
  assert.deepEqual(finalizeSuiteSandbox({ sandbox: successful, failed: false, keepFailed: true }), { retained: false, removed: true });
  assert.equal(fs.existsSync(successful.root), false, 'successful suite sandbox is removed');

  const oldFailure = createSuiteSandbox({ suiteId: 'parallel-suite', tempRoot: sandboxRoot });
  fs.writeFileSync(path.join(oldFailure.root, 'failure.txt'), 'old failure');
  finalizeSuiteSandbox({ sandbox: oldFailure, failed: true, keepFailed: true });
  assert.equal(fs.existsSync(oldFailure.root), true, 'explicitly retained failure stays available');
  const concurrent = createSuiteSandbox({ suiteId: 'parallel-suite', tempRoot: sandboxRoot });
  const latestFailure = createSuiteSandbox({ suiteId: 'parallel-suite', tempRoot: sandboxRoot });
  fs.writeFileSync(path.join(latestFailure.root, 'failure.txt'), 'latest failure');
  finalizeSuiteSandbox({ sandbox: latestFailure, failed: true, keepFailed: true });
  assert.equal(fs.existsSync(oldFailure.root), false, 'only the newest completed failure is retained');
  assert.equal(fs.existsSync(concurrent.root), true, 'concurrently running sandbox is preserved');
  finalizeSuiteSandbox({ sandbox: concurrent, failed: false, keepFailed: false });

  const unretainedFailure = createSuiteSandbox({ suiteId: 'unretained', tempRoot: sandboxRoot });
  finalizeSuiteSandbox({ sandbox: unretainedFailure, failed: true, keepFailed: false });
  assert.equal(fs.existsSync(unretainedFailure.root), false, 'failed sandbox is removed without KEEP_TEST_ARTIFACTS=1');

  const protectedTarget = path.join(tempRoot, 'outside-test-target');
  fs.mkdirSync(protectedTarget, { recursive: true });
  fs.writeFileSync(path.join(protectedTarget, 'keep.txt'), 'outside target');
  const linkedSandbox = createSuiteSandbox({ suiteId: 'sandbox-link-cleanup', tempRoot: sandboxRoot });
  fs.symlinkSync(protectedTarget, path.join(linkedSandbox.root, 'outside-link'), 'junction');
  finalizeSuiteSandbox({ sandbox: linkedSandbox, failed: false, keepFailed: false });
  assert.equal(fs.existsSync(linkedSandbox.root), false, 'suite cleanup removes its own junction entry');
  assert.equal(fs.readFileSync(path.join(protectedTarget, 'keep.txt'), 'utf8'), 'outside target', 'suite cleanup never follows a junction target');

  const markerlessSandbox = createSuiteSandbox({ suiteId: 'markerless-suite', tempRoot: sandboxRoot });
  fs.unlinkSync(markerlessSandbox.markerPath);
  finalizeSuiteSandbox({ sandbox: markerlessSandbox, failed: false, keepFailed: false });
  assert.equal(fs.existsSync(markerlessSandbox.root), false, 'suite owner can clean its own run directory if a test removed the marker');

  const retrySandbox = createSuiteSandbox({ suiteId: 'retry-cleanup', tempRoot: sandboxRoot });
  const transientOutput = path.join(retrySandbox.root, 'transient-output.bin');
  fs.writeFileSync(transientOutput, 'closed after a short Windows file lock');
  const originalUnlinkSync = fs.unlinkSync;
  let transientFailures = 0;
  fs.unlinkSync = function unlinkWithTransientFailure(target, ...args) {
    if (path.resolve(target) === path.resolve(transientOutput) && transientFailures < 2) {
      transientFailures += 1;
      const error = new Error('fixture lock');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlinkSync.call(fs, target, ...args);
  };
  try {
    finalizeSuiteSandbox({ sandbox: retrySandbox, failed: false, keepFailed: false });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(transientFailures, 2, 'transient Windows file locks are retried');
  assert.equal(fs.existsSync(retrySandbox.root), false, 'retry cleanup leaves no markerless partial sandbox');

  const stagingRoot = path.join(rootDir, 'artifacts', '.staging');
  const outsideStaging = path.join(tempRoot, 'outside-staging');
  fs.mkdirSync(outsideStaging, { recursive: true });
  fs.symlinkSync(outsideStaging, stagingRoot, 'junction');
  assert.throws(
    () => releaseArtifacts.assertSafeStagingDirectory({ rootDir, stagingDirectory: path.join(stagingRoot, 'release-fixture') }),
    /link|reparse|symlink|junction/i,
    'release build staging ancestry is rejected before writes'
  );
  assert.deepEqual(fs.readdirSync(outsideStaging), [], 'rejected staging junction target is untouched');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  const failedStage = path.join(stagingRoot, '12345-failed-fixture');
  const unrelatedStage = path.join(stagingRoot, '12345-running-fixture');
  fs.mkdirSync(failedStage, { recursive: true });
  fs.mkdirSync(unrelatedStage, { recursive: true });
  fs.writeFileSync(path.join(failedStage, 'partial'), 'partial package');
  assert.deepEqual(cleanupStagingDirectory({ rootDir, stagingDirectory: failedStage }), { removed: true });
  assert.equal(fs.existsSync(unrelatedStage), true, 'failed-build cleanup removes only its own stage');

  const readyStage = path.join(stagingRoot, '12345-ready-fixture');
  const canonical = path.join(rootDir, 'artifacts', 'dev', '1.0.0-rc.1', 'build-7');
  fs.mkdirSync(readyStage, { recursive: true });
  fs.writeFileSync(path.join(readyStage, 'package.bin'), 'complete package');
  publishStagedArtifact({ rootDir, stagingDirectory: readyStage, finalDirectory: canonical });
  assert.equal(fs.readFileSync(path.join(canonical, 'package.bin'), 'utf8'), 'complete package');

  const blockedStage = path.join(stagingRoot, '12345-blocked-fixture');
  fs.mkdirSync(blockedStage, { recursive: true });
  fs.writeFileSync(path.join(blockedStage, 'package.bin'), 'new attempt');
  assert.throws(() => publishStagedArtifact({ rootDir, stagingDirectory: blockedStage, finalDirectory: canonical }), /already exists/);
  assert.equal(fs.readFileSync(path.join(canonical, 'package.bin'), 'utf8'), 'complete package', 'failed publish preserves pre-existing artifact');
  cleanupStagingDirectory({ rootDir, stagingDirectory: blockedStage });

  const releaseBuildSource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'build-release.mjs'), 'utf8');
  assert.match(releaseBuildSource, /releaseArtifactDirectory\(/, 'Desktop release uses the canonical artifact layout');
  assert.match(releaseBuildSource, /remoteBackedUp:\s*false/, 'new packages start unbacked');
  assert.match(releaseBuildSource, /publishStagedArtifact\(/, 'release publishing is atomic and immutable');
  assert.match(releaseBuildSource, /assertSafeStagingDirectory/, 'release builder validates staging ancestry before writing');
  assert.doesNotMatch(releaseBuildSource, /app-previous-/, 'release builds no longer accumulate dist/app backups');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write('✅ Storage hygiene dry-run, retention, allowlist, and link-escape fixtures passed\n');
