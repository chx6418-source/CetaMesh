import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bumpBuildNumber,
  bumpProductVersion,
  compareReleaseVersions,
  formatArtifactName,
  loadReleaseVersion,
  releaseArtifactDirectory,
  setProductVersion,
  validateVersionMirrors
} from '../src/release/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name, callback) {
  try {
    callback();
    passed += 1;
    process.stdout.write(`✅ ${name}\n`);
  } catch (error) {
    process.stderr.write(`❌ ${name}: ${error.message}\n`);
    throw error;
  }
}

check('canonical release source is valid and agrees with package and Cargo mirrors', () => {
  const release = loadReleaseVersion({ rootDir: ROOT });
  assert.equal(release.productVersion, '1.0.0-rc.2');
  assert.equal(release.channel, 'rc');
  assert.ok(Number.isSafeInteger(release.buildNumber));
  const validation = validateVersionMirrors({ rootDir: ROOT });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
});

check('mirror validation rejects stale package and shell versions', () => {
  const validation = validateVersionMirrors({
    release: { productVersion: '1.0.0', channel: 'stable', buildNumber: 7 },
    packageVersion: '1.0.1',
    shellVersion: '1.0.0'
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some(issue => issue.code === 'PACKAGE_VERSION_MISMATCH'));
});

check('SemVer prerelease order and build number order are independent', () => {
  assert.equal(compareReleaseVersions(
    { productVersion: '1.0.0', buildNumber: 1 },
    { productVersion: '1.0.0-rc.10', buildNumber: 99 }
  ), 1);
  assert.equal(compareReleaseVersions(
    { productVersion: '1.0.0-rc.10', buildNumber: 2 },
    { productVersion: '1.0.0-rc.10', buildNumber: 3 }
  ), -1);
});

check('artifact names include product version, platform build, and architecture', () => {
  assert.equal(formatArtifactName({ productVersion: '1.0.0-rc.2', buildNumber: 1053, platform: 'windows-x64' }),
    'CetaMesh-Setup-1.0.0-rc.2-build1053-x64.exe');
});

check('CI uploads files from the canonical immutable release artifact directory', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const upload = workflow.match(/- name: Upload internal candidate[\s\S]*?path:\s*\|([\s\S]*?)\n\s*if-no-files-found:/);
  assert.ok(upload, 'CI artifact upload step and fail-closed missing-file policy are required');
  const paths = upload[1].split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.deepEqual(paths, [
    '${{ steps.candidate.outputs.directory }}/${{ steps.candidate.outputs.setup }}',
    '${{ steps.candidate.outputs.directory }}/release-manifest.json',
    '${{ steps.candidate.outputs.directory }}/candidate-provenance.json',
    '${{ steps.candidate.outputs.directory }}/SHA256SUMS.txt',
    '${{ steps.candidate.outputs.directory }}/sbom.json',
    '${{ steps.candidate.outputs.directory }}/licenses/**'
  ]);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.equal(paths.some(item => item.startsWith('dist/app/')), false);
  const canonical = releaseArtifactDirectory({
    rootDir: 'D:/fixture', channel: 'rc', productVersion: '1.0.0-rc.2', buildNumber: 1053
  });
  const manifest = path.relative('D:/fixture', path.join(canonical, 'release-manifest.json')).replaceAll('\\', '/');
  assert.equal(manifest, 'artifacts/rc/1.0.0-rc.2/build-1053/release-manifest.json');
  assert.ok(paths.some(pattern => pattern.endsWith('/release-manifest.json')),
    'the canonical release manifest must be included in the upload patterns');
});

check('release artifacts resolve to channel/version/build immutable directories', () => {
  assert.equal(releaseArtifactDirectory({ rootDir: 'D:/fixture', channel: 'rc', productVersion: '1.0.0-rc.2', buildNumber: 1053 }),
    path.join('D:/fixture', 'artifacts', 'rc', '1.0.0-rc.2', 'build-1053'));
  assert.throws(() => releaseArtifactDirectory({ rootDir: 'D:/fixture', channel: 'rc', productVersion: '../escape', buildNumber: 1 }));
});

check('build counter increments without changing product SemVer or channel', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-version-test-'));
  try {
    fs.mkdirSync(path.join(rootDir, 'release'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'release', 'version.json'), JSON.stringify({
      productVersion: '1.0.0-rc.2', channel: 'rc', buildNumber: 1052
    }));
    const bumped = bumpBuildNumber({ rootDir });
    assert.deepEqual(bumped, { productVersion: '1.0.0-rc.2', channel: 'rc', buildNumber: 1053 });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

check('product version change derives and validates the release channel', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-version-test-'));
  try {
    fs.mkdirSync(path.join(rootDir, 'release'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'release', 'version.json'), JSON.stringify({
      productVersion: '1.0.0-rc.2', channel: 'rc', buildNumber: 10
    }));
    assert.deepEqual(setProductVersion({ rootDir, productVersion: '1.0.1' }), {
      productVersion: '1.0.1', channel: 'stable', buildNumber: 10
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

check('product version bumps synchronize package, Cargo, and lock mirrors', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-version-mirrors-'));
  try {
    fs.mkdirSync(path.join(rootDir, 'release'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'desktop-shell'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'release', 'version.json'), JSON.stringify({
      productVersion: '1.0.0', channel: 'stable', buildNumber: 10
    }));
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    fs.writeFileSync(path.join(rootDir, 'package-lock.json'), JSON.stringify({
      version: '1.0.0', packages: { '': { version: '1.0.0' } }
    }));
    fs.writeFileSync(path.join(rootDir, 'desktop-shell', 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "1.0.0"\n');
    fs.writeFileSync(path.join(rootDir, 'desktop-shell', 'Cargo.lock'), '[[package]]\nname = "whalebridge-desktop"\nversion = "1.0.0"\n');
    assert.deepEqual(bumpProductVersion({ rootDir, kind: 'patch' }), {
      productVersion: '1.0.1', channel: 'stable', buildNumber: 10
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version, '1.0.1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')).packages[''].version, '1.0.1');
    assert.equal(fs.readFileSync(path.join(rootDir, 'desktop-shell', 'Cargo.toml'), 'utf8').includes('version = "1.0.1"'), true);
    assert.equal(fs.readFileSync(path.join(rootDir, 'desktop-shell', 'Cargo.lock'), 'utf8').includes('version = "1.0.1"'), true);
    assert.equal(validateVersionMirrors({ rootDir }).ok, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

process.stdout.write(`PASS ${passed} release version checks\n`);
