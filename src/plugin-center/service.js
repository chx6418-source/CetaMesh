import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { compareProductVersions } from '../release/version.js';
import { validateManifest } from '../extension/manifest.js';
import { normalizeCatalog, PLUGIN_CATALOG_LIMITS, pluginCenterError } from './catalog.js';
import { cleanupPluginStage, extractPluginPackage, verifyPluginPackage } from './package.js';
import { validatePluginDirectory } from './validator.js';

const CATALOG_CACHE_NAME = 'plugin-catalog-cache.json';
const TRUST_STATE_NAME = 'plugin-trust.json';
const CATALOG_TIMEOUT_MS = 12_000;
const IMAGE_CACHE_ITEMS = 16;

function string(value) { return String(value ?? '').trim(); }

function compatible(version, minVersion, maxVersion) {
  if (minVersion && compareProductVersions(version, minVersion) < 0) return false;
  if (maxVersion && compareProductVersions(version, maxVersion) > 0) return false;
  return true;
}

function developerModeFromStore(settingsStore) {
  if (!settingsStore || typeof settingsStore.get !== 'function') return false;
  const snapshot = settingsStore.get();
  return snapshot?.settings?.extensions?.developerMode === true;
}

async function readBoundedBody(response, maxBytes, code) {
  const contentLength = response?.headers?.get?.('content-length');
  const declared = contentLength === null || contentLength === undefined ? null : Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) throw pluginCenterError(code, `response exceeds ${maxBytes} bytes`);
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {
            // The size-limit failure remains authoritative if a peer has already closed the stream.
          });
          throw pluginCenterError(code, `response exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    if (Number.isFinite(declared) && declared !== total) throw pluginCenterError('PACKAGE_SIZE_MISMATCH', 'content-length does not match the downloaded response');
    return Buffer.concat(chunks, total);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw pluginCenterError(code, `response exceeds ${maxBytes} bytes`);
  if (Number.isFinite(declared) && declared !== data.byteLength) throw pluginCenterError('PACKAGE_SIZE_MISMATCH', 'content-length does not match the downloaded response');
  return data;
}

function parseArchiveManifest(directory, plugin, currentVersion) {
  const manifestFile = ['extension.json', 'manifest.json'].find(name => fs.existsSync(path.join(directory, name)));
  if (!manifestFile) throw pluginCenterError('MANIFEST_MISSING', 'package has no extension manifest');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(directory, manifestFile), 'utf8')); }
  catch (error) { throw pluginCenterError('MANIFEST_INVALID', `package manifest is invalid: ${error.message}`); }
  const checked = validateManifest(raw);
  if (!checked.ok) throw pluginCenterError(checked.issues[0]?.code ?? 'MANIFEST_INVALID', checked.issues[0]?.message ?? 'invalid manifest');
  const manifest = checked.manifest;
  if (manifest.id !== plugin.id || manifest.version !== plugin.version || manifest.name !== plugin.name) {
    throw pluginCenterError('PACKAGE_MANIFEST_MISMATCH', 'package id, name, or version does not match the catalog');
  }
  if (plugin.publisher && manifest.publisher !== plugin.publisher) {
    throw pluginCenterError('PACKAGE_MANIFEST_MISMATCH', 'package publisher does not match the catalog');
  }
  const permissions = [...manifest.permissions].sort();
  if (JSON.stringify(permissions) !== JSON.stringify([...plugin.permissions].sort())) {
    throw pluginCenterError('PACKAGE_MANIFEST_MISMATCH', 'package permissions do not match the catalog');
  }
  const capabilities = manifest.capabilities.map(item => item.id).sort();
  if (JSON.stringify(capabilities) !== JSON.stringify([...plugin.capabilities].sort())) {
    throw pluginCenterError('PACKAGE_MANIFEST_MISMATCH', 'package capabilities do not match the catalog');
  }
  if (!compatible(currentVersion, plugin.minCetaMeshVersion || raw.minCetaMeshVersion, plugin.maxCetaMeshVersion || raw.maxCetaMeshVersion)) {
    throw pluginCenterError('PLUGIN_INCOMPATIBLE', `plugin ${plugin.id} is incompatible with CetaMesh ${currentVersion}`);
  }
  return { manifest, raw };
}

function pluginState(plugin, installedEntry, runtimeDetail, currentVersion) {
  const blocked = plugin.revoked || plugin.blockedVersions.includes(plugin.version);
  const appCompatible = compatible(currentVersion, plugin.minCetaMeshVersion, plugin.maxCetaMeshVersion);
  if (blocked) return { status: 'Revoked', warning: 'This plugin is revoked. Installed files and user data were left in place.' };
  if (!appCompatible) return { status: 'Incompatible', warning: 'This plugin does not support the current CetaMesh version.' };
  if (!installedEntry) return { status: 'Available', warning: null };
  if (installedEntry.status === 'disabled_due_to_crash' || runtimeDetail?.runtimeState === 'crashed') return { status: 'Crashed', warning: 'The Extension Runtime disabled this plugin after a crash.' };
  if (installedEntry.version !== plugin.version && compareProductVersions(plugin.version, installedEntry.version) > 0) {
    return { status: 'Update Available', warning: null };
  }
  if (installedEntry.status === 'disabled') return { status: 'Disabled', warning: null };
  if (runtimeDetail?.pendingReview) return { status: 'Needs Review', warning: null };
  return { status: 'Installed', warning: null };
}

export function createPluginCenterService({
  stateDir,
  catalogUrl = null,
  allowedHosts = [],
  currentVersion = '1.0.0',
  fetchImpl = null,
  extensionRuntime = null,
  settingsStore = null,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createPluginCenterService requires stateDir');
  const stateRoot = path.join(stateDir, 'plugin-center');
  const cacheFile = path.join(stateRoot, CATALOG_CACHE_NAME);
  const trustFile = path.join(stateRoot, TRUST_STATE_NAME);
  const doFetch = fetchImpl || globalThis.fetch;
  const staged = new Map();
  const rollbackReviews = new Map();
  const enableReviews = new Map();
  const imageCache = new Map();
  const localUnverified = new Map();
  let trustMetadataInvalid = false;
  let lastCatalogState = { configured: Boolean(catalogUrl), reachable: false, checkedAt: null, lastError: null };

  try {
    const saved = readJsonFile(trustFile, { missing: { schemaVersion: 1, localUnverified: [] }, maxBytes: 64 * 1024 });
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.localUnverified)) throw new Error('unsupported plugin trust state');
    for (const item of saved.localUnverified) {
      if (!item || typeof item.id !== 'string' || typeof item.version !== 'string') throw new Error('malformed local plugin trust entry');
      localUnverified.set(item.id, { version: item.version, firstEnableReviewed: item.firstEnableReviewed === true });
    }
  } catch (error) {
    trustMetadataInvalid = true;
    log('Plugin trust state could not be read; enabling extensions is blocked until repaired: ' + String(error?.message ?? error));
  }

  function persistTrustState() {
    writeJsonAtomic(trustFile, {
      schemaVersion: 1,
      localUnverified: [...localUnverified.entries()].map(([id, value]) => ({
        id, version: value.version, firstEnableReviewed: value.firstEnableReviewed === true
      }))
    });
    trustMetadataInvalid = false;
  }

  function requireDeveloperMode() {
    if (!developerModeFromStore(settingsStore)) throw pluginCenterError('DEVELOPER_MODE_REQUIRED', 'enable Developer Mode to use plugin reload and logs');
  }

  function cacheRead() {
    try {
      const saved = readJsonFile(cacheFile, { missing: null, maxBytes: 2 * PLUGIN_CATALOG_LIMITS.maxCatalogBytes });
      if (!saved?.catalog || !Array.isArray(saved.catalog.plugins)) return null;
      return saved;
    } catch (error) {
      log('Plugin Catalog cache could not be read: ' + String(error?.message ?? error));
      return null;
    }
  }

  async function requestBytes(url, { maxBytes, accept = '*/*', code = 'CATALOG_TOO_LARGE' } = {}) {
    if (typeof doFetch !== 'function') throw pluginCenterError('PLUGIN_NETWORK_UNAVAILABLE', 'fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: { accept },
        redirect: 'error',
        signal: controller.signal
      });
      if (!response || response.status < 200 || response.status >= 300) {
        throw pluginCenterError('PLUGIN_HTTP_ERROR', `Plugin Service returned ${response?.status ?? 'no response'}`);
      }
      const body = await readBoundedBody(response, maxBytes, code);
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchCatalog() {
    if (!catalogUrl) {
      lastCatalogState = { configured: false, reachable: false, checkedAt: null, lastError: 'service_not_configured' };
      return { catalog: null, offline: false, configured: false, error: 'service_not_configured' };
    }
    let parsedUrl;
    try { parsedUrl = new URL(catalogUrl); }
    catch { return { catalog: null, offline: true, configured: true, error: 'CATALOG_URL_INVALID' }; }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      return { catalog: null, offline: true, configured: true, error: 'CATALOG_URL_INVALID' };
    }
    try {
      const { body } = await requestBytes(parsedUrl.toString(), {
        maxBytes: PLUGIN_CATALOG_LIMITS.maxCatalogBytes,
        accept: 'application/json', code: 'CATALOG_TOO_LARGE'
      });
      let raw;
      try { raw = JSON.parse(body.toString('utf8')); }
      catch { throw pluginCenterError('CATALOG_INVALID', 'Plugin Catalog response is not valid JSON'); }
      const catalog = normalizeCatalog(raw, { catalogUrl: parsedUrl.toString(), allowedHosts });
      const cachedAt = new Date(now()).toISOString();
      try {
        fs.mkdirSync(stateRoot, { recursive: true });
        writeJsonAtomic(cacheFile, { cachedAt, catalog });
      } catch (error) {
        log('Plugin Catalog cache could not be saved: ' + String(error?.message ?? error));
      }
      lastCatalogState = { configured: true, reachable: true, checkedAt: cachedAt, lastError: null };
      return { catalog, offline: false, configured: true, cachedAt };
    } catch (error) {
      const message = String(error?.code ?? error?.message ?? error);
      lastCatalogState = { configured: true, reachable: false, checkedAt: new Date(now()).toISOString(), lastError: message };
      const cached = cacheRead();
      return cached
        ? { catalog: cached.catalog, offline: true, configured: true, cachedAt: cached.cachedAt, error: message }
        : { catalog: null, offline: true, configured: true, error: message };
    }
  }

  async function currentCatalog({ requireOnline = false } = {}) {
    const loaded = await fetchCatalog();
    if (!loaded.catalog) {
      if (!loaded.configured) throw pluginCenterError('PLUGIN_SERVICE_NOT_CONFIGURED', 'Plugin Service has not been configured');
      throw pluginCenterError(loaded.error || 'PLUGIN_CATALOG_UNAVAILABLE', 'Plugin Catalog is unavailable');
    }
    if (requireOnline && loaded.offline) throw pluginCenterError('PLUGIN_OFFLINE', 'Plugin installation and updates require an online Plugin Service');
    return loaded;
  }

  async function installedEntries() {
    if (!extensionRuntime || typeof extensionRuntime.list !== 'function') return [];
    return await extensionRuntime.list();
  }

  async function buildCatalogRows(loaded) {
    const installed = new Map((await installedEntries()).map(entry => [entry.id, entry]));
    const rows = [];
    for (const plugin of loaded.catalog.plugins) {
      const entry = installed.get(plugin.id) || null;
      let detail = null;
      if (entry && extensionRuntime?.get) {
        try { detail = await extensionRuntime.get({ id: plugin.id }); }
        catch {
          // A stale catalog card must stay visible when an installed entry disappears during refresh.
          detail = null;
        }
      }
      const state = pluginState(plugin, entry, detail, currentVersion);
      const trust = localUnverified.get(plugin.id);
      rows.push({
        ...plugin, ...state, installedVersion: entry?.version ?? null, installedEntry: entry,
        trust: trust ? 'local-unverified' : 'catalog-sha256',
        firstEnableReviewed: trust?.firstEnableReviewed === true
      });
    }
    return rows;
  }

  async function localInstalledRows(excludedIds = new Set()) {
    const rows = [];
    for (const entry of await installedEntries()) {
      const trust = localUnverified.get(entry.id);
      if (!trust || excludedIds.has(entry.id)) continue;
      const status = entry.status === 'enabled' ? 'Installed'
        : entry.status === 'disabled_due_to_crash' ? 'Crashed' : 'Disabled';
      rows.push({
        id: entry.id, name: entry.name, summary: entry.manifest?.description ?? 'Locally loaded plugin',
        description: entry.manifest?.description ?? '', publisher: 'Local', publisherId: '',
        version: entry.version, category: 'Other', permissions: entry.permissions ?? [],
        capabilities: (entry.manifest?.capabilities ?? []).map(item => item.id), screenshots: [],
        featured: false, verified: false, status, warning: null, installedVersion: entry.version,
        installedEntry: entry, trust: 'local-unverified', firstEnableReviewed: trust.firstEnableReviewed === true
      });
    }
    return rows;
  }

  async function listCatalog(params = {}) {
    const loaded = await fetchCatalog();
    if (!loaded.catalog) {
      const view = string(params.view || 'all').toLowerCase().replaceAll('_', '-');
      return {
        available: false, configured: loaded.configured, offline: loaded.offline, reason: loaded.error,
        plugins: view === 'installed' ? await localInstalledRows() : []
      };
    }
    const query = string(params.query).toLocaleLowerCase();
    const view = string(params.view || 'all').toLowerCase().replaceAll('_', '-');
    const category = string(params.category);
    let plugins = await buildCatalogRows(loaded);
    if (view === 'installed') {
      const catalogIds = new Set(plugins.map(plugin => plugin.id));
      plugins.push(...await localInstalledRows(catalogIds));
    }
    plugins = plugins.filter(plugin => {
      if (view === 'recommended' && !plugin.featured) return false;
      if (view === 'installed' && !plugin.installedEntry) return false;
      if (view === 'update-available' && plugin.status !== 'Update Available') return false;
      if (category && plugin.category !== category) return false;
      if (query && ![plugin.name, plugin.summary, plugin.description, plugin.publisher, plugin.category].join(' ').toLocaleLowerCase().includes(query)) return false;
      return true;
    });
    return {
      available: true,
      configured: true,
      offline: loaded.offline,
      cachedAt: loaded.cachedAt ?? null,
      generatedAt: loaded.catalog.generatedAt,
      plugins
    };
  }

  function lookupPlugin(catalog, id) {
    const plugin = catalog.plugins.find(item => item.id === string(id));
    if (!plugin) throw pluginCenterError('PLUGIN_NOT_FOUND', `plugin is not in the Catalog: ${id}`);
    if (plugin.revoked || plugin.blockedVersions.includes(plugin.version)) {
      throw pluginCenterError('PLUGIN_REVOKED', `plugin ${plugin.id}@${plugin.version} is revoked or blocked`);
    }
    if (!compatible(currentVersion, plugin.minCetaMeshVersion, plugin.maxCetaMeshVersion)) {
      throw pluginCenterError('PLUGIN_INCOMPATIBLE', `plugin ${plugin.id} is incompatible with CetaMesh ${currentVersion}`);
    }
    return plugin;
  }

  async function stageCatalogPackage(params = {}) {
    const loaded = await currentCatalog({ requireOnline: true });
    const plugin = lookupPlugin(loaded.catalog, params.id);
    const { body } = await requestBytes(plugin.packageUrl, {
      maxBytes: Math.min(plugin.packageBytes, PLUGIN_CATALOG_LIMITS.maxPackageBytes),
      accept: 'application/zip,application/octet-stream', code: 'PACKAGE_TOO_LARGE'
    });
    const verified = verifyPluginPackage(body, { sha256: plugin.packageSha256, bytes: plugin.packageBytes });
    if (!verified.ok) throw pluginCenterError(verified.code, `download verification failed (${verified.code})`);
    const unpacked = extractPluginPackage(body, { stagingRoot: path.join(stateRoot, 'staging') });
    try {
      const { manifest } = parseArchiveManifest(unpacked.directory, plugin, currentVersion);
      if (plugin.blockedVersions.includes(manifest.version)) throw pluginCenterError('PLUGIN_REVOKED', `plugin version ${manifest.version} is blocked`);
      if (!extensionRuntime || typeof extensionRuntime.review !== 'function') {
        throw pluginCenterError('EXTENSION_RUNTIME_UNAVAILABLE', 'Extension Runtime is unavailable');
      }
      const reviewed = await extensionRuntime.review({ sourceDir: unpacked.directory });
      const stageId = crypto.randomUUID();
      const permissionDelta = reviewed.permissionDelta ?? { added: [], removed: [] };
      const review = {
        manifest,
        review: reviewed.review,
        scan: reviewed.scan,
        permissionDelta,
        summary: reviewed.summary ?? []
      };
      staged.set(stageId, {
        stageId, directory: unpacked.directory, plugin, manifest,
        review: reviewed, permissionDelta, trust: 'catalog-sha256', kind: 'catalog'
      });
      return {
        stageId,
        entry: plugin,
        review,
        trust: { level: 'catalog-sha256', publisherSignature: 'not-implemented', verifiedPublisher: plugin.verified },
        requiresReview: true,
        enableAfterInstall: false
      };
    } catch (error) {
      cleanupPluginStage(unpacked.directory);
      throw error;
    }
  }

  async function installStaged(params = {}) {
    const item = staged.get(string(params.stageId));
    if (!item) throw pluginCenterError('PLUGIN_STAGE_NOT_FOUND', 'staged plugin package is no longer available');
    if (params.reviewed !== true) throw pluginCenterError('PERMISSION_REVIEW_REQUIRED', 'review plugin permissions before installing');
    if (!item.review?.review?.installable) throw pluginCenterError(item.review?.review?.blockers?.[0]?.code ?? 'PERMISSION_REVIEW_BLOCKED', `Extension Runtime permission review blocked this plugin (${String(item.review?.review?.installable)})`);
    if (item.kind === 'catalog') {
      const latest = await currentCatalog({ requireOnline: true });
      const trusted = latest.catalog.plugins.find(plugin => plugin.id === item.plugin.id);
      if (!trusted || trusted.revoked || trusted.blockedVersions.includes(item.manifest.version)
        || trusted.version !== item.manifest.version || trusted.packageSha256 !== item.plugin.packageSha256) {
        throw pluginCenterError('PLUGIN_CATALOG_CHANGED', 'Catalog trust changed after staging; stage and review the package again');
      }
    }
    const current = (await installedEntries()).find(entry => entry.id === item.manifest.id) ?? null;
    const approval = { approved: true, token: item.review.review.token };
    const previousTrust = localUnverified.get(item.manifest.id) ?? null;
    if (item.kind === 'local') {
      localUnverified.set(item.manifest.id, { version: item.manifest.version, firstEnableReviewed: false });
      try {
        persistTrustState();
      } catch (error) {
        if (previousTrust) localUnverified.set(item.manifest.id, previousTrust);
        else localUnverified.delete(item.manifest.id);
        throw pluginCenterError('PLUGIN_TRUST_STATE_WRITE_FAILED', `plugin trust state could not be saved: ${error.message}`);
      }
    }
    let result;
    try {
      result = current
        ? await extensionRuntime.update({ sourceDir: item.directory, approval })
        : await extensionRuntime.install({ sourceDir: item.directory, approval });
    } catch (error) {
      if (previousTrust) localUnverified.set(item.manifest.id, previousTrust);
      else localUnverified.delete(item.manifest.id);
      try { persistTrustState(); }
      catch (restoreError) {
        trustMetadataInvalid = true;
        log('Plugin trust state could not be restored after install failure: ' + String(restoreError?.message ?? restoreError));
      }
      throw error;
    } finally {
      staged.delete(item.stageId);
      if (item.kind === 'catalog') cleanupPluginStage(item.directory);
    }
    if (item.kind === 'catalog' && previousTrust) {
      localUnverified.delete(item.manifest.id);
      try { persistTrustState(); }
      catch (error) {
        localUnverified.set(item.manifest.id, previousTrust);
        log('Verified Catalog update completed but local trust marker could not be cleared: ' + String(error?.message ?? error));
      }
    }
    return {
      ...result,
      status: result?.entry?.status === 'disabled' ? 'Disabled' : 'Installed',
      trust: item.trust === 'catalog-sha256'
        ? { level: 'catalog-sha256', publisherSignature: 'not-implemented' }
        : { level: 'local-unverified', publisherSignature: 'none' },
      enabled: false,
      permissionDelta: item.permissionDelta
    };
  }

  async function stageLocal(params = {}) {
    if (!developerModeFromStore(settingsStore)) throw pluginCenterError('DEVELOPER_MODE_REQUIRED', 'enable Developer Mode before loading a local plugin');
    const directory = path.resolve(string(params.directory));
    const validation = validatePluginDirectory(directory, { currentVersion });
    if (!validation.ok) throw pluginCenterError(validation.issues[0].code, validation.issues[0].message);
    const reviewed = await extensionRuntime?.review?.({ sourceDir: directory });
    if (!reviewed) throw pluginCenterError('EXTENSION_RUNTIME_UNAVAILABLE', 'Extension Runtime is unavailable');
    const stageId = crypto.randomUUID();
    staged.set(stageId, {
      stageId, directory, plugin: null, manifest: validation.manifest,
      review: reviewed, permissionDelta: reviewed.permissionDelta ?? { added: [], removed: [] },
      trust: 'local-unverified', kind: 'local'
    });
    return {
      stageId,
      entry: validation.manifest,
      review: { manifest: validation.manifest, review: reviewed.review, scan: reviewed.scan, permissionDelta: reviewed.permissionDelta },
      trust: { level: 'local-unverified', publisherSignature: 'none' },
      requiresReview: true,
      enableAfterInstall: false
    };
  }

  async function rollbackReview(params = {}) {
    if (!extensionRuntime?.reviewRollback) throw pluginCenterError('EXTENSION_RUNTIME_UNAVAILABLE', 'Extension Runtime rollback is unavailable');
    const id = string(params.id);
    const result = await extensionRuntime.reviewRollback({ id });
    rollbackReviews.set(id, result);
    return {
      action: 'rollback-review', id,
      review: {
        manifest: { id, name: result.review?.name ?? id, version: result.review?.version ?? '' },
        review: result.review,
        scan: result.scan,
        permissionDelta: result.permissionDelta ?? { added: [], removed: [] },
        summary: result.summary ?? []
      }
    };
  }

  async function doRollback(params = {}) {
    const review = rollbackReviews.get(string(params.id));
    if (params.reviewed !== true || !review) throw pluginCenterError('PERMISSION_REVIEW_REQUIRED', 'review the rollback package before switching versions');
    rollbackReviews.delete(string(params.id));
    return extensionRuntime.rollback({ id: params.id, approval: { approved: true, token: review.review.token } });
  }

  async function reviewLocalEnable(params = {}) {
    if (trustMetadataInvalid) throw pluginCenterError('PLUGIN_TRUST_STATE_INVALID', 'Plugin trust state is invalid; extension enable is blocked');
    const id = string(params.id);
    const trust = localUnverified.get(id);
    if (!trust) throw pluginCenterError('PLUGIN_NOT_LOCAL_UNVERIFIED', `plugin ${id} does not require local trust review`);
    if (trust.firstEnableReviewed) return { required: false, id, trust: 'local-unverified' };
    if (!extensionRuntime?.get || !extensionRuntime?.review) throw pluginCenterError('EXTENSION_RUNTIME_UNAVAILABLE', 'Extension Runtime review is unavailable');
    const detail = await extensionRuntime.get({ id });
    const entry = detail?.extension ?? detail?.entry ?? null;
    if (!entry?.sourceRoot || entry.version !== trust.version) throw pluginCenterError('PLUGIN_TRUST_STATE_STALE', 'installed local plugin changed; review it again');
    const reviewed = await extensionRuntime.review({ sourceDir: entry.sourceRoot });
    const stageId = crypto.randomUUID();
    enableReviews.set(stageId, { id, version: entry.version, token: reviewed.review?.token });
    return {
      action: 'enable-review', stageId, id,
      review: {
        manifest: entry.manifest ?? entry,
        review: reviewed.review,
        scan: reviewed.scan,
        permissionDelta: reviewed.permissionDelta ?? { added: [], removed: [] },
        summary: reviewed.summary ?? []
      },
      trust: 'local-unverified', requiresReview: true
    };
  }

  async function enablePlugin(params = {}) {
    if (trustMetadataInvalid) throw pluginCenterError('PLUGIN_TRUST_STATE_INVALID', 'Plugin trust state is invalid; extension enable is blocked');
    const id = string(params.id);
    const trust = localUnverified.get(id);
    const catalog = await fetchCatalog();
    const catalogEntry = catalog.catalog?.plugins.find(plugin => plugin.id === id);
    const installedDetail = extensionRuntime?.get ? await extensionRuntime.get({ id }) : null;
    const installed = installedDetail?.extension ?? installedDetail?.entry ?? null;
    if (catalogEntry && (catalogEntry.revoked || catalogEntry.blockedVersions.includes(installed?.version ?? catalogEntry.version))) {
      throw pluginCenterError('PLUGIN_REVOKED', 'revoked plugin versions cannot be enabled');
    }
    if (trust && !trust.firstEnableReviewed) {
      const stageId = string(params.stageId);
      const reviewed = enableReviews.get(stageId);
      if (params.reviewed !== true || !reviewed || reviewed.id !== id || reviewed.version !== trust.version) {
        throw pluginCenterError('PERMISSION_REVIEW_REQUIRED', 'review this Unverified / Local plugin before its first enable');
      }
      if (string(params.reviewToken) !== reviewed.token) throw pluginCenterError('REVIEW_MISMATCH', 'Owner Review token does not match the installed plugin');
      const entry = installed;
      if (!entry || entry.version !== reviewed.version) throw pluginCenterError('PLUGIN_TRUST_STATE_STALE', 'installed plugin changed after review');
      const latest = await extensionRuntime.review({ sourceDir: entry.sourceRoot });
      if (latest.review?.token !== reviewed.token) throw pluginCenterError('REVIEW_MISMATCH', 'plugin changed after Owner Review; review it again');
      const result = await extensionRuntime.enable({ id });
      enableReviews.delete(stageId);
      trust.firstEnableReviewed = true;
      persistTrustState();
      return result;
    }
    return extensionRuntime.enable({ id });
  }

  async function icon(params = {}) {
    const loaded = await currentCatalog();
    const plugin = loaded.catalog.plugins.find(item => item.id === string(params.id));
    if (!plugin) throw pluginCenterError('PLUGIN_NOT_FOUND', `plugin is not in the Catalog: ${params.id}`);
    if (!plugin.icon) throw pluginCenterError('PLUGIN_ICON_NOT_FOUND', 'plugin has no Catalog icon');
    const key = plugin.icon;
    if (imageCache.has(key)) return { ...imageCache.get(key), id: plugin.id, cached: true };
    const { response, body } = await requestBytes(key, {
      maxBytes: PLUGIN_CATALOG_LIMITS.maxScreenshotBytes,
      accept: 'image/png,image/jpeg,image/webp', code: 'ICON_TOO_LARGE'
    });
    const mimeType = string(response.headers?.get?.('content-type')).split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw pluginCenterError('ICON_TYPE_INVALID', 'Catalog icon is not PNG, JPEG, or WebP');
    const result = { id: plugin.id, mimeType, bytes: body.byteLength, data: body.toString('base64'), alt: plugin.name, cached: false };
    imageCache.set(key, result);
    while (imageCache.size > IMAGE_CACHE_ITEMS) imageCache.delete(imageCache.keys().next().value);
    return result;
  }

  async function screenshot(params = {}) {
    const loaded = await currentCatalog();
    const plugin = loaded.catalog.plugins.find(item => item.id === string(params.id));
    if (!plugin) throw pluginCenterError('PLUGIN_NOT_FOUND', `plugin is not in the Catalog: ${params.id}`);
    const index = Number(params.index ?? 0);
    const shot = plugin.screenshots[index];
    if (!shot) throw pluginCenterError('SCREENSHOT_NOT_FOUND', 'screenshot is not in the Catalog entry');
    const key = shot.url;
    if (imageCache.has(key)) return { ...imageCache.get(key), cached: true };
    const { response, body } = await requestBytes(key, {
      maxBytes: PLUGIN_CATALOG_LIMITS.maxScreenshotBytes,
      accept: 'image/png,image/jpeg,image/webp', code: 'SCREENSHOT_TOO_LARGE'
    });
    const mimeType = string(response.headers?.get?.('content-type')).split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw pluginCenterError('SCREENSHOT_TYPE_INVALID', 'Catalog screenshot is not PNG, JPEG, or WebP');
    const result = { mimeType, bytes: body.byteLength, data: body.toString('base64'), alt: shot.alt, cached: false };
    imageCache.set(key, result);
    while (imageCache.size > IMAGE_CACHE_ITEMS) imageCache.delete(imageCache.keys().next().value);
    return result;
  }

  const handlers = {
    'plugin-center.catalog.list': listCatalog,
    'plugin-center.catalog.refresh': async () => {
      const loaded = await fetchCatalog();
      return { available: Boolean(loaded.catalog), configured: loaded.configured, offline: loaded.offline, cachedAt: loaded.cachedAt ?? null, generatedAt: loaded.catalog?.generatedAt ?? null, error: loaded.error ?? null };
    },
    'plugin-center.catalog.detail': async params => {
      const result = await listCatalog({ view: 'all' });
      return { plugin: result.plugins.find(item => item.id === string(params.id)) ?? null, available: result.available, offline: result.offline, reason: result.reason ?? null };
    },
    'plugin-center.icon.get': icon,
    'plugin-center.screenshot.get': screenshot,
    'plugin-center.status': async () => {
      const installed = (await installedEntries()).map(entry => ({
        id: entry.id, name: entry.name, version: entry.version, extensionStatus: entry.status,
        status: entry.status === 'disabled_due_to_crash' ? 'Crashed' : entry.status === 'disabled' ? 'Disabled' : entry.status === 'enabled' ? 'Installed' : 'Needs Review',
        trust: localUnverified.has(entry.id) ? 'local-unverified' : 'catalog-sha256',
        firstEnableReviewed: localUnverified.get(entry.id)?.firstEnableReviewed === true
      }));
      const loaded = await fetchCatalog();
      const rows = loaded.catalog ? await buildCatalogRows(loaded) : [];
      return { installed, catalogAvailable: Boolean(loaded.catalog), configured: loaded.configured, offline: loaded.offline, plugins: rows };
    },
    'plugin-center.health': async () => ({ ...lastCatalogState, extensionRuntimeAvailable: Boolean(extensionRuntime) }),
    'plugin-center.configure': async params => {
      if (params.developerMode === undefined) {
        return { catalogConfigured: Boolean(catalogUrl), catalogUrl: catalogUrl ? String(catalogUrl) : null, developerMode: developerModeFromStore(settingsStore) };
      }
      if (typeof params.developerMode !== 'boolean') throw pluginCenterError('CONFIG_INVALID', 'developerMode must be a boolean');
      if (!settingsStore || typeof settingsStore.update !== 'function') throw pluginCenterError('CONFIG_UNAVAILABLE', 'settings store is unavailable');
      const updated = settingsStore.update('extensions', { developerMode: params.developerMode });
      return { developerMode: updated?.settings?.extensions?.developerMode ?? params.developerMode };
    },
    'plugin-center.package.stage': stageCatalogPackage,
    'plugin-center.package.install': installStaged,
    'plugin-center.package.rollback.review': rollbackReview,
    'plugin-center.package.rollback': doRollback,
    'plugin-center.developer.stageLocal': stageLocal,
    'plugin-center.developer.installLocal': installStaged,
    'plugin-center.developer.reload': params => { requireDeveloperMode(); return extensionRuntime.restart({ id: params.id }); },
    'plugin-center.plugin.enable.review': reviewLocalEnable,
    'plugin-center.plugin.enable': enablePlugin,
    'plugin-center.plugin.disable': params => extensionRuntime.disable({ id: params.id }),
    'plugin-center.plugin.uninstall': params => extensionRuntime.uninstall({ id: params.id, keepFiles: params.keepFiles === true }),
    'plugin-center.plugin.logs': params => { requireDeveloperMode(); return extensionRuntime.logs({ id: params.id }); }
  };

  return {
    stateDir,
    cacheFile,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(pluginCenterError('METHOD_NOT_FOUND', `unknown Plugin Center method: ${String(method)}`));
      return Promise.resolve().then(() => handler(params || {}));
    },
    close() {
      for (const item of staged.values()) {
        if (item.kind === 'catalog') cleanupPluginStage(item.directory);
      }
      staged.clear();
      rollbackReviews.clear();
      enableReviews.clear();
      imageCache.clear();
    }
  };
}
