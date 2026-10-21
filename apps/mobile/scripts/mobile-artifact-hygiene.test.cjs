'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyCleanup,
  buildAndroidRelease,
  planArtifactRetention,
  planCleanup,
  readMobileVersion
} = require('./mobile-artifact-hygiene.cjs');

const roots = [];
function fixtureRoot() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-mobile-hygiene-'));
  roots.push(temp);
  const root = path.join(temp, 'repo');
  fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0-rc.2' }));
  fs.writeFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'defaultConfig {\n versionCode 2\n versionName "1.0.0-rc.2"\n}\n');
  return { temp, root };
}

function createPackage(root, buildNumber, { remoteBackedUp = true, bytes = 'duplicate package', createdAt = buildNumber } = {}) {
  const directory = path.join(root, 'artifacts', 'rc', '1.0.0-rc.2', `build-${buildNumber}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.apk'), bytes);
  const content = fs.readFileSync(path.join(directory, 'package.apk'));
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify({
    buildNumber,
    createdAt: new Date(Date.UTC(2026, 0, createdAt)).toISOString(),
    remoteBackedUp,
    artifacts: [{ path: 'package.apk', bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }]
  }));
  return directory;
}

test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('release build publishes immutable canonical APK/AAB package and verified manifest', () => {
  const { root } = fixtureRoot();
  const result = buildAndroidRelease({
    rootDir: root,
    commit: 'fixture-commit',
    now: new Date('2026-10-11T00:00:00.000Z'),
    runGradleCommand: (_root, { appBuildDir }) => {
      fs.mkdirSync(path.join(appBuildDir, 'outputs', 'apk', 'release'), { recursive: true });
      fs.mkdirSync(path.join(appBuildDir, 'outputs', 'bundle', 'release'), { recursive: true });
      fs.writeFileSync(path.join(appBuildDir, 'outputs', 'apk', 'release', 'app-release.apk'), 'apk-binary');
      fs.writeFileSync(path.join(appBuildDir, 'outputs', 'bundle', 'release', 'app-release.aab'), 'aab-binary');
    }
  });
  const expected = path.join(root, 'artifacts', 'rc', '1.0.0-rc.2', 'build-2');
  assert.equal(result.directory, expected);
  assert.equal(result.manifest.remoteBackedUp, false);
  assert.equal(result.manifest.buildNumber, 2);
  assert.equal(result.manifest.sourceCommit, 'fixture-commit');
  assert.equal(result.manifest.artifacts.length, 2);
  assert.equal(fs.existsSync(path.join(expected, 'CetaMesh-Mobile-1.0.0-rc.2-build2.apk')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'manifests', 'rc', '1.0.0-rc.2', 'build-2.json'), 'utf8')), result.manifest);
  assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts', '.staging')), []);
  assert.throws(() => buildAndroidRelease({ rootDir: root, runGradleCommand: () => assert.fail('existing build must fail before Gradle') }), /already exists/);
});

test('failed Gradle build removes only its unique staging output', () => {
  const { root } = fixtureRoot();
  const previous = createPackage(root, 1, { bytes: 'preexisting release' });
  const previousHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(previous, 'package.apk'))).digest('hex');
  assert.throws(() => buildAndroidRelease({
    rootDir: root,
    commit: 'fixture-commit',
    runGradleCommand: (_root, { appBuildDir }) => {
      fs.mkdirSync(appBuildDir, { recursive: true });
      fs.writeFileSync(path.join(appBuildDir, 'partial'), 'partial');
      throw new Error('fixture Gradle failure');
    }
  }), /fixture Gradle failure/);
  assert.equal(fs.existsSync(path.join(root, 'artifacts', 'rc', '1.0.0-rc.2', 'build-2')), false);
  assert.equal(fs.existsSync(path.join(root, 'artifacts', 'manifests', 'rc', '1.0.0-rc.2', 'build-2.json')), false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(previous, 'package.apk'))).digest('hex'), previousHash);
  assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts', '.staging')), []);
});

test('Dev cleanup is dry-run by default and deletes only exact allowlisted debug output', () => {
  const { root } = fixtureRoot();
  const target = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'app-debug.apk'), 'debug');
  const plan = planCleanup({ rootDir: root, mode: 'dev' });
  assert.equal(plan.candidates.length, 1);
  assert.equal(fs.existsSync(target), true);
  const result = applyCleanup({ rootDir: root, plan });
  assert.deepEqual(result.removed, ['android/app/build/outputs/apk/debug']);
  assert.equal(fs.existsSync(target), false);
});

test('cleanup refuses traversal and a junction escaping the Mobile repository', () => {
  const { temp, root } = fixtureRoot();
  assert.throws(() => planCleanup({ rootDir: root, mode: '../release' }), /unknown cleanup mode/);
  const outside = path.join(temp, 'outside');
  const outputParent = path.join(root, 'android', 'app', 'build', 'outputs');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(outputParent, { recursive: true });
  fs.symlinkSync(outside, path.join(outputParent, 'apk'), 'junction');
  assert.throws(() => planCleanup({ rootDir: root, mode: 'dev' }), /symlink|junction|reparse/i);
});

test('release cleanup retains the newest two, unbacked files, and unique binaries', () => {
  const { root } = fixtureRoot();
  const old1 = createPackage(root, 1, { createdAt: 1 });
  createPackage(root, 2, { createdAt: 2 });
  createPackage(root, 3, { createdAt: 3 });
  createPackage(root, 4, { createdAt: 4 });
  const unbacked = createPackage(root, 5, { remoteBackedUp: false, createdAt: 5 });
  const unique = createPackage(root, 6, { bytes: 'unique signed package', createdAt: 6 });
  const plan = planArtifactRetention(path.join(root, 'artifacts'));
  assert.equal(plan.keepByChannel.rc, 2);
  assert.ok(!plan.candidates.some((item) => item.path === unbacked));
  assert.ok(!plan.candidates.some((item) => item.path === unique));
  const applied = applyCleanup({ rootDir: root, plan });
  assert.ok(applied.removed.includes('artifacts/rc/1.0.0-rc.2/build-1'));
  assert.equal(fs.existsSync(old1), false);
  assert.equal(fs.existsSync(unbacked), true);
  assert.equal(fs.existsSync(unique), true);
});

test('release retention preserves duplicated manifest paths and counts distinct package owners', () => {
  const { root } = fixtureRoot();
  const uniqueDuplicate = createPackage(root, 101, { bytes: 'unique bytes duplicated in one manifest', createdAt: 1 });
  const sharedDuplicate = createPackage(root, 102, { bytes: 'shared bytes duplicated in one manifest', createdAt: 2 });
  const sharedPeer = createPackage(root, 103, { bytes: 'shared bytes duplicated in one manifest', createdAt: 3 });
  createPackage(root, 104, { bytes: 'newest stable package', createdAt: 4 });
  for (const directory of [uniqueDuplicate, sharedDuplicate]) {
    const manifestPath = path.join(directory, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.push({ ...manifest.artifacts[0] });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  const plan = planArtifactRetention(path.join(root, 'artifacts'));
  assert.ok(!plan.candidates.some((item) => item.path === uniqueDuplicate), 'duplicate entries cannot make a unique package appear shared');
  assert.ok(!plan.candidates.some((item) => item.path === sharedDuplicate), 'duplicate artifact paths make the package unverified');
  assert.ok(!plan.candidates.some((item) => item.path === sharedPeer), 'rejecting the duplicate manifest preserves the intact package containing the only verified copy');
});

test('Mobile version mirrors provide versionName and versionCode build number', () => {
  const { root } = fixtureRoot();
  assert.deepEqual(readMobileVersion(root), { productVersion: '1.0.0-rc.2', buildNumber: 2, channel: 'rc' });
});

test('Mobile release rejects a versionName that is not a safe SemVer path component', () => {
  const { root } = fixtureRoot();
  const unsafeVersion = '../../outside';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: unsafeVersion }));
  fs.writeFileSync(path.join(root, 'android', 'app', 'build.gradle'), `defaultConfig {\n versionCode 2\n versionName "${unsafeVersion}"\n}\n`);
  assert.throws(() => buildAndroidRelease({
    rootDir: root,
    runGradleCommand: () => assert.fail('unsafe version must fail before Gradle is started')
  }), /SemVer|version.*safe|path component/i);
  assert.equal(fs.existsSync(path.join(root, 'artifacts')), false, 'unsafe version must not create artifact paths');
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside')), false, 'unsafe version must not escape the repository');
});

test('Mobile release refuses an artifacts junction before Gradle is started', () => {
  const { temp, root } = fixtureRoot();
  const outside = path.join(temp, 'outside-artifacts');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'artifacts'), 'junction');
  assert.throws(() => buildAndroidRelease({
    rootDir: root,
    runGradleCommand: () => assert.fail('junction must fail before Gradle is started')
  }), /reparse|symlink|junction|artifact root/i);
  assert.deepEqual(fs.readdirSync(outside), [], 'rejected release leaves the junction target untouched');
});

test('Mobile release refuses a staging junction before Gradle is started', () => {
  const { temp, root } = fixtureRoot();
  const stageRoot = path.join(root, 'artifacts', '.staging');
  const outside = path.join(temp, 'outside-staging');
  fs.mkdirSync(path.dirname(stageRoot), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, stageRoot, 'junction');
  let gradleStarted = false;
  assert.throws(() => buildAndroidRelease({
    rootDir: root,
    runGradleCommand: () => { gradleStarted = true; throw new Error('fixture Gradle must not be started'); }
  }), /reparse|symlink|junction|staging/i);
  assert.equal(gradleStarted, false, 'staging junction is rejected before Gradle starts');
  assert.deepEqual(fs.readdirSync(outside), [], 'rejected release leaves staging junction target untouched');
});

test('Mobile release revalidates output directories after Gradle returns', () => {
  const { temp, root } = fixtureRoot();
  const outside = path.join(temp, 'outside-after-gradle');
  const stageRoot = path.join(root, 'artifacts', '.staging');
  let injectedJunction;
  fs.mkdirSync(outside, { recursive: true });
  assert.throws(() => buildAndroidRelease({
    rootDir: root,
    runGradleCommand: (_root, { appBuildDir }) => {
      injectedJunction = path.dirname(appBuildDir);
      fs.rmSync(injectedJunction, { recursive: true, force: false });
      fs.symlinkSync(outside, injectedJunction, 'junction');
    }
  }), /reparse|symlink|junction/i);
  assert.deepEqual(fs.readdirSync(outside), [], 'post-Gradle reparse point is rejected before publishing or cleanup');
  assert.ok(injectedJunction.startsWith(stageRoot), 'the fixture injects the junction inside the owned staging root');
  assert.equal(fs.lstatSync(injectedJunction).isSymbolicLink(), true, 'rejected path remains visible for fixture cleanup');
});
