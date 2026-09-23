#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertNoWebUiBinaryMarkers,
  assertNoWebUiHtmlArtifacts,
  findNoWebUiHtmlArtifacts,
  isNoWebUiHtmlArtifact
} from './no-web-release-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(isNoWebUiHtmlArtifact('public/console.html'), true);
assert.equal(isNoWebUiHtmlArtifact('PUBLIC/legacy-settings.HTML'), true);
assert.equal(isNoWebUiHtmlArtifact('resources/public/legacy-settings.HTML'), true);
assert.equal(isNoWebUiHtmlArtifact('ui/installer.html'), true);
assert.equal(isNoWebUiHtmlArtifact('roles/guide.md'), false);
assert.deepEqual(
  findNoWebUiHtmlArtifacts([
    'resources/public/console.html',
    'resources/public/token-login.html',
    'resources/public/dsh-monitor.html',
    'desktop-shell/ui/installer.html',
    'resources/public/product.json'
  ]),
  [
    'resources/public/console.html',
    'resources/public/token-login.html',
    'resources/public/dsh-monitor.html',
    'desktop-shell/ui/installer.html'
  ]
);
assert.throws(() => assertNoWebUiHtmlArtifacts(['resources/public/console.html']), /console\.html/);
assert.throws(() => assertNoWebUiBinaryMarkers(Buffer.from('embedded installer.html')), /installer\.html/);
assert.doesNotThrow(() => assertNoWebUiBinaryMarkers(Buffer.from('native shell without web UI')));

// Exercise the installer-side defense with a disposable payload on every OS. No real build
// output is touched; the invalid HTML fixture must be rejected before the platform tool check.
let tempRoot = null;
try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-no-web-'));
} catch (error) {
  if (error.code !== 'EPERM') throw error;
  process.stdout.write('↷ installer fixture integration skipped: temporary writes are blocked in this environment\n');
}
if (tempRoot) {
  try {
    const outDir = path.join(tempRoot, 'out');
    const payloadDir = path.join(tempRoot, 'payload');
    fs.mkdirSync(path.join(payloadDir, 'resources', 'public'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'WhaleBridge.exe'), Buffer.from([0x4d, 0x5a]));
    fs.writeFileSync(path.join(payloadDir, 'WhaleBridgeCore.exe'), Buffer.from('fixture core'));
    fs.writeFileSync(path.join(payloadDir, 'resources', 'public', 'console.html'), '<html/>');
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'package-installer.mjs'), outDir, payloadDir, '--no-web-ui'
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(result.status, 0, 'no-web installer must reject a payload containing console.html');
    assert.match(`${result.stdout ?? ''}${result.stderr ?? ''}`, /product HTML UI assets.*console\.html/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const buildCoreSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-core.mjs'), 'utf8');
const buildReleaseSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-release.mjs'), 'utf8');
assert.match(buildCoreSource, /noWebUi: true/);
assert.match(buildCoreSource, /isNoWebUiHtmlArtifact\(repoRelative\)/);
assert.match(buildCoreSource, /uiDistribution: options\.noWebUi \? 'native-no-web'/);
assert.match(buildReleaseSource, /noWebUi: true/);
assert.match(buildReleaseSource, /coreRuntimeManifest\.noWebUi !== true/);
assert.match(buildReleaseSource, /assertNoWebUiHtmlArtifacts\(payloadFiles/);

process.stdout.write('✓ native/no-web release filtering, artifact audits, and installer guard passed\n');
