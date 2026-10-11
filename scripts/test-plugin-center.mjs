import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { normalizeCatalog } from '../src/plugin-center/catalog.js';
import { extractPluginPackage, verifyPluginPackage } from '../src/plugin-center/package.js';
import { createPluginCenterService } from '../src/plugin-center/service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function check(name, callback) {
  try {
    await callback();
    passed += 1;
    process.stdout.write(`✅ ${name}\n`);
  } catch (error) {
    process.stderr.write(`❌ ${name}: ${error.message}\n`);
    throw error;
  }
}

function manifest(version = '1.0.0') {
  return {
    manifestVersion: 1,
    id: 'cetamesh.hello-tool',
    name: 'Hello Tool',
    version,
    type: 'tool',
    entry: 'index.js',
    publisher: 'CetaMesh Example',
    description: 'A bounded example tool.',
    capabilities: [{
      id: 'hello', kind: 'tool', title: 'Hello', description: 'Say hello.', requires: [],
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    }],
    permissions: [],
    source: { kind: 'local' }
  };
}

function packageBytes(version = '1.0.0', overrides = {}) {
  return zipSync({
    'extension.json': new TextEncoder().encode(JSON.stringify({ ...manifest(version), ...overrides })),
    'index.js': new TextEncoder().encode('export async function invoke(input) { return { greeting: `Hello, ${input.name}` }; }\n'),
    'README.md': new TextEncoder().encode('# Hello Tool\n')
  });
}

function catalogPlugin(overrides = {}) {
  const bytes = packageBytes();
  return {
    id: 'cetamesh.hello-tool', name: 'Hello Tool', summary: 'A bounded example tool.',
    description: 'An example plugin for CetaMesh.', publisher: 'CetaMesh Example',
    publisherId: 'cetamesh.example', version: '1.0.0', category: 'Tools', icon: 'https://plugins.example.test/images/hello-icon.png',
    screenshots: [{ url: 'https://plugins.example.test/images/hello.png', alt: 'Hello Tool' }],
    homepage: 'https://plugins.example.test/hello-tool',
    documentation: 'https://plugins.example.test/docs/hello-tool',
    manifestUrl: 'https://plugins.example.test/packages/hello/extension.json',
    packageUrl: 'https://plugins.example.test/packages/hello/1.0.0.cetamesh-plugin',
    packageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    packageBytes: bytes.byteLength,
    minCetaMeshVersion: '1.0.0', maxCetaMeshVersion: null,
    permissions: [], capabilities: ['hello'], updatedAt: '2026-10-11T00:00:00.000Z',
    featured: true, verified: true, revoked: false,
    ...overrides
  };
}

const allowedHosts = ['plugins.example.test'];

await check('Catalog contract normalizes fields and rejects malformed or unsafe URLs', async () => {
  const normalized = normalizeCatalog({ schemaVersion: 1, generatedAt: '2026-10-11T00:00:00Z', plugins: [catalogPlugin()] }, {
    catalogUrl: 'https://plugins.example.test/api/catalog.json', allowedHosts
  });
  assert.equal(normalized.plugins[0].id, 'cetamesh.hello-tool');
  assert.equal(normalized.plugins[0].verified, true);
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, plugins: [catalogPlugin({
    packageUrl: 'file:///C:/secret.zip'
  })] }, { catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts }), { code: 'CATALOG_INVALID' });
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, plugins: [catalogPlugin({
    packageUrl: 'https://evil.example.test/pkg.zip'
  })] }, { catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts }), { code: 'CATALOG_URL_HOST_NOT_ALLOWED' });
});

await check('screenshot list enforces HTTPS official host and count/size limits', async () => {
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, plugins: [catalogPlugin({
    screenshots: [{ url: 'http://plugins.example.test/x.png' }]
  })] }, { catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts }), { code: 'CATALOG_INVALID' });
  assert.throws(() => normalizeCatalog({ schemaVersion: 1, plugins: [catalogPlugin({
    screenshots: Array.from({ length: 6 }, (_, index) => ({ url: `https://plugins.example.test/${index}.png`, bytes: 1 }))
  })] }, { catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts }), { code: 'CATALOG_INVALID' });
});

await check('package verifies SHA-256 and declared byte count before extraction', async () => {
  const bytes = packageBytes();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(verifyPluginPackage(bytes, { sha256, bytes: bytes.byteLength }).ok, true);
  assert.equal(verifyPluginPackage(bytes, { sha256: '0'.repeat(64), bytes: bytes.byteLength }).code, 'PACKAGE_SHA256_MISMATCH');
  assert.equal(verifyPluginPackage(bytes, { sha256, bytes: bytes.byteLength + 1 }).code, 'PACKAGE_SIZE_MISMATCH');
});

await check('package extraction rejects path traversal, forbidden credential files, and oversized archives', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-package-'));
  try {
    assert.throws(() => extractPluginPackage(zipSync({ '../escape.js': new Uint8Array([1]) }), { stagingRoot: root }), { code: 'PACKAGE_PATH_INVALID' });
    assert.throws(() => extractPluginPackage(zipSync({ '.env': new Uint8Array([1]) }), { stagingRoot: root }), { code: 'PACKAGE_FORBIDDEN_FILE' });
    const huge = zipSync({ 'large.bin': new Uint8Array(1024 * 1024 + 1) });
    assert.throws(() => extractPluginPackage(huge, { stagingRoot: root, maxUncompressedBytes: 1024 * 1024 }), { code: 'PACKAGE_TOO_LARGE' });
    const compressedBomb = zipSync({ 'repeat.bin': [new Uint8Array(4 * 1024 * 1024).fill(0x5a), { level: 9 }] });
    assert.ok(compressedBomb.byteLength < 64 * 1024, 'fixture must be highly compressed');
    assert.throws(() => extractPluginPackage(compressedBomb, { stagingRoot: root, maxUncompressedBytes: 1024 * 1024 }), { code: 'PACKAGE_TOO_LARGE' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check('catalog views support search, category, installed, update, and revoked states', async () => {
  const bytes = packageBytes();
  const fetchImpl = async url => url.endsWith('catalog.json')
    ? new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-11T00:00:00Z', plugins: [catalogPlugin(), catalogPlugin({
      id: 'cetamesh.revoked', name: 'Revoked', packageUrl: 'https://plugins.example.test/revoked.zip', revoked: true
    })] }), { status: 200 })
    : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  const service = createPluginCenterService({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-center-')),
    catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts,
    currentVersion: '1.0.0', fetchImpl
  });
  try {
    const all = await service.execute({ method: 'plugin-center.catalog.list', params: { view: 'all' } });
    assert.equal(all.plugins.length, 2, JSON.stringify(all));
    assert.equal(all.plugins.find(plugin => plugin.id === 'cetamesh.revoked').status, 'Revoked');
    const search = await service.execute({ method: 'plugin-center.catalog.list', params: { query: 'hello', category: 'Tools' } });
    assert.equal(search.plugins.length, 1);
    assert.equal(search.plugins[0].id, 'cetamesh.hello-tool');
  } finally {
    await service.close();
    fs.rmSync(service.stateDir, { recursive: true, force: true });
  }
});

await check('detail and screenshot preview fetch is bounded and cached', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-image-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  let imageRequests = 0;
  const service = createPluginCenterService({
    stateDir: root, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts, currentVersion: '1.0.0',
    fetchImpl: async url => {
      if (url.endsWith('catalog.json')) return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-11T00:00:00Z', plugins: [catalogPlugin()] }), { status: 200 });
      imageRequests += 1;
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) } });
    }
  });
  try {
    const detail = await service.execute({ method: 'plugin-center.catalog.detail', params: { id: 'cetamesh.hello-tool' } });
    assert.equal(detail.plugin.id, 'cetamesh.hello-tool');
    const iconFirst = await service.execute({ method: 'plugin-center.icon.get', params: { id: 'cetamesh.hello-tool' } });
    const iconSecond = await service.execute({ method: 'plugin-center.icon.get', params: { id: 'cetamesh.hello-tool' } });
    assert.equal(iconFirst.id, 'cetamesh.hello-tool');
    assert.equal(iconFirst.mimeType, 'image/png');
    assert.equal(iconFirst.cached, false);
    assert.equal(iconSecond.cached, true);
    const first = await service.execute({ method: 'plugin-center.screenshot.get', params: { id: 'cetamesh.hello-tool', index: 0 } });
    const second = await service.execute({ method: 'plugin-center.screenshot.get', params: { id: 'cetamesh.hello-tool', index: 0 } });
    assert.equal(first.mimeType, 'image/png');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(imageRequests, 2);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check('oversized package responses and embedded manifest mismatches are rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-reject-'));
  const bytes = packageBytes('1.0.0', { name: 'Tampered Name' });
  const badPlugin = catalogPlugin({ packageBytes: bytes.byteLength, packageSha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  const service = createPluginCenterService({
    stateDir: root, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts, currentVersion: '1.0.0',
    fetchImpl: async url => url.endsWith('catalog.json')
      ? new Response(JSON.stringify({ schemaVersion: 1, plugins: [badPlugin] }), { status: 200 })
      : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
  });
  try {
    await assert.rejects(service.execute({ method: 'plugin-center.package.stage', params: { id: badPlugin.id } }), { code: 'PACKAGE_MANIFEST_MISMATCH' });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const oversizedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-oversized-'));
  const valid = packageBytes();
  const plugin = catalogPlugin();
  const oversized = Buffer.alloc(valid.byteLength + 1);
  const oversizedService = createPluginCenterService({
    stateDir: oversizedRoot, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts, currentVersion: '1.0.0',
    fetchImpl: async url => url.endsWith('catalog.json')
      ? new Response(JSON.stringify({ schemaVersion: 1, plugins: [plugin] }), { status: 200 })
      : new Response(oversized, { status: 200, headers: { 'content-length': String(oversized.byteLength) } })
  });
  try {
    await assert.rejects(oversizedService.execute({ method: 'plugin-center.package.stage', params: { id: plugin.id } }), { code: 'PACKAGE_TOO_LARGE' });
  } finally {
    oversizedService.close();
    fs.rmSync(oversizedRoot, { recursive: true, force: true });
  }
});

await check('offline cache is explicit and cannot stage installs without network', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-offline-'));
  const bytes = packageBytes();
  let unavailable = false;
  const service = createPluginCenterService({
    stateDir: root, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts,
    currentVersion: '1.0.0', fetchImpl: async url => {
      if (unavailable) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
      return url.endsWith('catalog.json')
        ? new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-11T00:00:00Z', plugins: [catalogPlugin()] }), { status: 200 })
        : new Response(bytes, { status: 200 });
    }
  });
  try {
    const online = await service.execute({ method: 'plugin-center.catalog.refresh' });
    assert.equal(online.offline, false);
    unavailable = true;
    const offline = await service.execute({ method: 'plugin-center.catalog.list', params: { view: 'all' } });
    assert.equal(offline.offline, true);
    await assert.rejects(service.execute({ method: 'plugin-center.package.stage', params: { id: 'cetamesh.hello-tool' } }), { code: 'PLUGIN_OFFLINE' });
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check('installation delegates review/install to Extension Runtime and remains disabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-install-'));
  const bytes = packageBytes();
  const calls = [];
  const extensionRuntime = {
    async review({ sourceDir }) {
      const found = JSON.parse(fs.readFileSync(path.join(sourceDir, 'extension.json'), 'utf8'));
      return { manifest: found, review: { id: found.id, token: 'review-token', requiresExplicitApproval: true, installable: true, blockers: [] }, scan: { ok: true, findings: [] } };
    },
    async install(request) { calls.push(['install', request]); return { entry: { status: 'installed', ...manifest() } }; },
    async update(request) { calls.push(['update', request]); return { entry: { status: 'disabled', ...manifest() } }; },
    async list() { return []; },
    async get({ id }) { return { extension: { id, status: 'disabled' } }; },
    async enable({ id }) { calls.push(['enable', id]); return { extension: { id, status: 'enabled' } }; },
    async disable({ id }) { return { extension: { id, status: 'disabled' } }; },
    async rollback({ id }) { return { extension: { id, status: 'disabled' } }; },
    async uninstall({ id }) { return { id, removed: true }; },
    async restart({ id }) { return { id, runtimeState: 'running' }; },
    async logs({ id }) { return { logs: [{ level: 'info', message: id }] }; }
  };
  const service = createPluginCenterService({
    stateDir: root, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts, currentVersion: '1.0.0',
    extensionRuntime,
    settingsStore: { get: () => ({ settings: { extensions: { developerMode: false } } }) },
    fetchImpl: async url => url.endsWith('catalog.json')
      ? new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-11T00:00:00Z', plugins: [catalogPlugin()] }), { status: 200 })
      : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
  });
  try {
    const staged = await service.execute({ method: 'plugin-center.package.stage', params: { id: 'cetamesh.hello-tool' } });
    assert.equal(staged.review.manifest.id, 'cetamesh.hello-tool');
    await assert.rejects(service.execute({ method: 'plugin-center.package.install', params: { stageId: staged.stageId } }), { code: 'PERMISSION_REVIEW_REQUIRED' });
    const installed = await service.execute({ method: 'plugin-center.package.install', params: { stageId: staged.stageId, reviewed: true } });
    assert.equal(installed.entry.status, 'installed');
    assert.equal(calls[0][0], 'install');
    assert.equal(calls[0][1].approval.approved, true);
    assert.equal(calls.some(call => call[0] === 'enable'), false);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check('update permission expansion is reviewed and Runtime rollback is reused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-update-'));
  const expandedManifest = {
    permissions: ['network'],
    network: { hosts: ['api.example.test'] }
  };
  const bytes = packageBytes('1.1.0', expandedManifest);
  const plugin = catalogPlugin({
    version: '1.1.0', permissions: ['network'],
    packageSha256: crypto.createHash('sha256').update(bytes).digest('hex'), packageBytes: bytes.byteLength
  });
  const calls = [];
  const extensionRuntime = {
    list() { return [{ id: plugin.id, version: '1.0.0', status: 'disabled', permissions: [] }]; },
    async review() { return {
      review: { token: 'update-token', installable: true, blockers: [], permissions: [{ name: 'network', risk: 'high', summary: 'declared host access' }] },
      scan: { ok: true, findings: [] }, permissionDelta: { added: ['network'], removed: [] }
    }; },
    async update(request) { calls.push(['update', request]); return { entry: { id: plugin.id, version: '1.1.0', status: 'disabled' } }; },
    async reviewRollback() { return { review: { token: 'rollback-token', installable: true, blockers: [] } }; },
    async rollback(request) { calls.push(['rollback', request]); return { entry: { id: plugin.id, version: '1.0.0', status: 'disabled' } }; }
  };
  const service = createPluginCenterService({
    stateDir: root, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts, currentVersion: '1.0.0', extensionRuntime,
    fetchImpl: async url => url.endsWith('catalog.json')
      ? new Response(JSON.stringify({ schemaVersion: 1, plugins: [plugin] }), { status: 200 })
      : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
  });
  try {
    const stage = await service.execute({ method: 'plugin-center.package.stage', params: { id: plugin.id } });
    assert.deepEqual(stage.review.permissionDelta.added, ['network']);
    await assert.rejects(service.execute({ method: 'plugin-center.package.install', params: { stageId: stage.stageId } }), { code: 'PERMISSION_REVIEW_REQUIRED' });
    const updated = await service.execute({ method: 'plugin-center.package.install', params: { stageId: stage.stageId, reviewed: true } });
    assert.equal(updated.entry.version, '1.1.0');
    assert.equal(calls[0][0], 'update');
    assert.equal(calls[0][1].approval.token, 'update-token');
    const rollbackReview = await service.execute({ method: 'plugin-center.package.rollback.review', params: { id: plugin.id } });
    assert.equal(rollbackReview.action, 'rollback-review');
    assert.equal(rollbackReview.review.manifest.id, plugin.id);
    await service.execute({ method: 'plugin-center.package.rollback', params: { id: plugin.id, reviewed: true } });
    assert.equal(calls[1][0], 'rollback');
    assert.equal(calls[1][1].approval.token, 'rollback-token');
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check('Developer Mode gates local plugins and never deletes the source directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-local-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-local-source-'));
  fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify(manifest()), 'utf8');
  fs.writeFileSync(path.join(source, 'index.js'), 'export async function invoke(input) { return { greeting: input.name }; }\n', 'utf8');
  let developerMode = false;
  const calls = [];
  const settingsStore = {
    get() { return { settings: { extensions: { developerMode } } }; },
    update(_section, values) { developerMode = values.developerMode; return { settings: { extensions: { developerMode } } }; }
  };
  const extensionRuntime = {
    async review({ sourceDir }) {
      const raw = JSON.parse(fs.readFileSync(path.join(sourceDir, 'extension.json'), 'utf8'));
      return { manifest: raw, review: { token: 'local-token', installable: true, blockers: [], permissions: [] }, scan: { ok: true, findings: [] } };
    },
    list() { return []; },
    async install(request) { calls.push(request); return { entry: { id: 'cetamesh.hello-tool', status: 'disabled' } }; }
  };
  const service = createPluginCenterService({ stateDir: root, extensionRuntime, settingsStore, currentVersion: '1.0.0' });
  try {
    await assert.rejects(service.execute({ method: 'plugin-center.developer.stageLocal', params: { directory: source } }), { code: 'DEVELOPER_MODE_REQUIRED' });
    const configured = await service.execute({ method: 'plugin-center.configure', params: { developerMode: true } });
    assert.equal(configured.developerMode, true);
    const stage = await service.execute({ method: 'plugin-center.developer.stageLocal', params: { directory: source } });
    assert.equal(stage.trust.level, 'local-unverified');
    const installed = await service.execute({ method: 'plugin-center.developer.installLocal', params: { stageId: stage.stageId, reviewed: true } });
    assert.equal(installed.enabled, false);
    assert.equal(calls[0].approval.token, 'local-token');
    assert.equal(fs.existsSync(path.join(source, 'extension.json')), true);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

await check('Unverified local plugins require first-enable review and Developer Mode gates reload/logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-local-review-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-local-review-source-'));
  fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify(manifest()), 'utf8');
  fs.writeFileSync(path.join(source, 'index.js'), 'export async function invoke(input) { return { greeting: input.name }; }\n', 'utf8');
  let developerMode = true;
  let installed = false;
  const entry = { ...manifest(), sourceRoot: source, status: 'disabled' };
  const calls = [];
  const extensionRuntime = {
    async review() { return { review: { token: 'first-enable-token', installable: true, blockers: [], permissions: [] }, scan: { ok: true, findings: [] }, permissionDelta: { added: [], removed: [] } }; },
    async install() { calls.push('install'); installed = true; return { entry }; },
    list() { return installed ? [entry] : []; },
    async get() { return { extension: entry }; },
    async enable() { calls.push('enable'); entry.status = 'enabled'; return { extension: entry }; },
    async restart() { calls.push('reload'); return { runtimeState: 'running' }; },
    async logs() { calls.push('logs'); return { logs: [] }; }
  };
  const settingsStore = {
    get() { return { settings: { extensions: { developerMode } } }; },
    update(_section, values) { developerMode = values.developerMode; return { settings: { extensions: { developerMode } } }; }
  };
  const service = createPluginCenterService({ stateDir: root, extensionRuntime, settingsStore, currentVersion: '1.0.0' });
  try {
    const stage = await service.execute({ method: 'plugin-center.developer.stageLocal', params: { directory: source } });
    await service.execute({ method: 'plugin-center.developer.installLocal', params: { stageId: stage.stageId, reviewed: true } });
    const installedView = await service.execute({ method: 'plugin-center.catalog.list', params: { view: 'installed' } });
    assert.equal(installedView.available, false);
    assert.equal(installedView.plugins[0].trust, 'local-unverified');
    await assert.rejects(service.execute({ method: 'plugin-center.plugin.enable', params: { id: entry.id } }), { code: 'PERMISSION_REVIEW_REQUIRED' });
    const review = await service.execute({ method: 'plugin-center.plugin.enable.review', params: { id: entry.id } });
    assert.equal(review.action, 'enable-review');
    assert.equal(review.review.manifest.id, entry.id);
    await assert.rejects(service.execute({ method: 'plugin-center.plugin.enable', params: { id: entry.id, stageId: review.stageId, reviewed: true, reviewToken: 'wrong' } }), { code: 'REVIEW_MISMATCH' });
    await service.execute({ method: 'plugin-center.plugin.enable', params: { id: entry.id, stageId: review.stageId, reviewed: true, reviewToken: 'first-enable-token' } });
    assert.deepEqual(calls, ['install', 'enable']);
    const status = await service.execute({ method: 'plugin-center.status' });
    assert.equal(status.installed[0].trust, 'local-unverified');
    assert.equal(status.installed[0].firstEnableReviewed, true);

    await service.execute({ method: 'plugin-center.configure', params: { developerMode: false } });
    await assert.rejects(service.execute({ method: 'plugin-center.developer.reload', params: { id: entry.id } }), { code: 'DEVELOPER_MODE_REQUIRED' });
    await assert.rejects(service.execute({ method: 'plugin-center.plugin.logs', params: { id: entry.id } }), { code: 'DEVELOPER_MODE_REQUIRED' });
    await service.execute({ method: 'plugin-center.configure', params: { developerMode: true } });
    await service.execute({ method: 'plugin-center.developer.reload', params: { id: entry.id } });
    await service.execute({ method: 'plugin-center.plugin.logs', params: { id: entry.id } });
    assert.deepEqual(calls.slice(-2), ['reload', 'logs']);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

await check('compatibility and revoked-version policy fail closed before download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-plugin-compat-'));
  const bytes = packageBytes();
  let packageRequests = 0;
  const service = createPluginCenterService({
    stateDir: root, catalogUrl: 'https://plugins.example.test/catalog.json', allowedHosts, currentVersion: '1.0.0',
    fetchImpl: async url => {
      if (!url.endsWith('catalog.json')) packageRequests += 1;
      return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-11T00:00:00Z', plugins: [
        catalogPlugin({ minCetaMeshVersion: '1.1.0' }),
        catalogPlugin({ id: 'cetamesh.hello-tool-revoked', version: '1.0.0', revoked: true })
      ] }), { status: 200 });
    }
  });
  try {
    await assert.rejects(service.execute({ method: 'plugin-center.package.stage', params: { id: 'cetamesh.hello-tool' } }), { code: 'PLUGIN_INCOMPATIBLE' });
    assert.equal(packageRequests, 0);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write(`PASS ${passed} Plugin Center checks\n`);
