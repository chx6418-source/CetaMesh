const MAX_PLUGINS = 500;
const MAX_SCREENSHOTS = 4;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export const PLUGIN_CATEGORIES = Object.freeze([
  'Tools', 'Integrations', 'Agent', 'Channel', 'Workflow', 'Memory Pack', 'Other'
]);

export function pluginCenterError(code, message) {
  return Object.assign(new Error(message), { code });
}

function text(value, label, max, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw pluginCenterError('CATALOG_INVALID', `${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw pluginCenterError('CATALOG_INVALID', `${label} must be text`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw pluginCenterError('CATALOG_INVALID', `${label} is missing or too long`);
  }
  return normalized;
}

function secureUrl(value, label, { allowedHosts = null, required = false } = {}) {
  const raw = text(value, label, 1200, { required });
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw pluginCenterError('CATALOG_INVALID', `${label} must be an HTTPS URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw pluginCenterError('CATALOG_INVALID', `${label} must be a safe HTTPS URL`);
  }
  if (allowedHosts && !allowedHosts.some(host => parsed.hostname.toLowerCase() === String(host).toLowerCase())) {
    throw pluginCenterError('CATALOG_URL_HOST_NOT_ALLOWED', `${label} host is outside the configured Plugin Service allowlist`);
  }
  return parsed.toString();
}

function stringList(value, label, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw pluginCenterError('CATALOG_INVALID', `${label} must be a bounded list`);
  const result = value.map((item, index) => text(String(item), `${label}[${index}]`, maxLength, { required: true }));
  if (new Set(result).size !== result.length) throw pluginCenterError('CATALOG_INVALID', `${label} contains duplicates`);
  return result;
}

function screenshotList(value, allowedHosts) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SCREENSHOTS) {
    throw pluginCenterError('CATALOG_INVALID', `screenshots may contain at most ${MAX_SCREENSHOTS} entries`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw pluginCenterError('CATALOG_INVALID', `screenshots[${index}] must be an object`);
    }
    const bytes = entry.bytes === undefined || entry.bytes === null ? null : Number(entry.bytes);
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_SCREENSHOT_BYTES)) {
      throw pluginCenterError('CATALOG_INVALID', `screenshots[${index}].bytes exceeds the image limit`);
    }
    return {
      url: secureUrl(entry.url, `screenshots[${index}].url`, { allowedHosts, required: true }),
      alt: text(entry.alt, `screenshots[${index}].alt`, 200) || 'Plugin screenshot',
      bytes
    };
  });
}

function normalizePlugin(raw, allowedHosts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw pluginCenterError('CATALOG_INVALID', 'plugin entry must be an object');
  const category = text(raw.category, 'category', 40, { required: true });
  if (!PLUGIN_CATEGORIES.includes(category)) throw pluginCenterError('CATALOG_INVALID', `unsupported plugin category: ${category}`);
  const version = text(raw.version, 'version', 40, { required: true });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw pluginCenterError('CATALOG_INVALID', 'version must be SemVer');
  const packageSha256 = text(raw.packageSha256, 'packageSha256', 64, { required: true }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(packageSha256)) throw pluginCenterError('CATALOG_INVALID', 'packageSha256 must be a SHA-256 digest');
  const packageBytes = Number(raw.packageBytes);
  if (!Number.isSafeInteger(packageBytes) || packageBytes < 1 || packageBytes > 5 * 1024 * 1024) {
    throw pluginCenterError('CATALOG_INVALID', 'packageBytes is outside the download limit');
  }
  const blockedVersions = stringList(raw.blockedVersions ?? (raw.blockedVersion ? [raw.blockedVersion] : []), 'blockedVersions', 100, 40);
  return {
    id: text(raw.id, 'id', 64, { required: true }).toLowerCase(),
    name: text(raw.name, 'name', 120, { required: true }),
    summary: text(raw.summary, 'summary', 300, { required: true }),
    description: text(raw.description, 'description', 4000),
    publisher: text(raw.publisher, 'publisher', 120, { required: true }),
    publisherId: text(raw.publisherId, 'publisherId', 120),
    version,
    category,
    icon: raw.icon ? secureUrl(raw.icon, 'icon', { allowedHosts }) : null,
    screenshots: screenshotList(raw.screenshots, allowedHosts),
    homepage: secureUrl(raw.homepage, 'homepage'),
    documentation: secureUrl(raw.documentation, 'documentation'),
    manifestUrl: secureUrl(raw.manifestUrl, 'manifestUrl', { allowedHosts, required: true }),
    packageUrl: secureUrl(raw.packageUrl, 'packageUrl', { allowedHosts, required: true }),
    packageSha256,
    packageBytes,
    minCetaMeshVersion: text(raw.minCetaMeshVersion, 'minCetaMeshVersion', 40) || null,
    maxCetaMeshVersion: text(raw.maxCetaMeshVersion, 'maxCetaMeshVersion', 40) || null,
    permissions: stringList(raw.permissions, 'permissions', 24, 80),
    capabilities: stringList(raw.capabilities, 'capabilities', 50, 80),
    updatedAt: text(raw.updatedAt, 'updatedAt', 40),
    featured: raw.featured === true,
    // Catalog claims are metadata; no publisher signature verifier exists yet.
    verified: false,
    catalogClaimedVerified: raw.catalogClaimedVerified === true || raw.verified === true,
    publisherSignature: 'not-implemented',
    revoked: raw.revoked === true,
    blockedVersions
  };
}

export function normalizeCatalog(raw, { catalogUrl, allowedHosts = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Number(raw.schemaVersion) !== 1) {
    throw pluginCenterError('CATALOG_INVALID', 'unsupported Plugin Catalog schema');
  }
  if (!Array.isArray(raw.plugins) || raw.plugins.length > MAX_PLUGINS) {
    throw pluginCenterError('CATALOG_INVALID', `plugins must contain at most ${MAX_PLUGINS} entries`);
  }
  const trustedHosts = [...new Set([...(allowedHosts || []).map(value => String(value).trim().toLowerCase()), ...(catalogUrl ? [new URL(catalogUrl).hostname.toLowerCase()] : [])])].filter(Boolean);
  const plugins = raw.plugins.map(plugin => normalizePlugin(plugin, trustedHosts));
  const ids = new Set();
  for (const plugin of plugins) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(plugin.id) || ids.has(plugin.id)) {
      throw pluginCenterError('CATALOG_INVALID', `invalid or duplicate plugin id: ${plugin.id}`);
    }
    ids.add(plugin.id);
  }
  return {
    schemaVersion: 1,
    generatedAt: text(raw.generatedAt, 'generatedAt', 40),
    plugins
  };
}

export const PLUGIN_CATALOG_LIMITS = Object.freeze({
  maxPlugins: MAX_PLUGINS,
  maxScreenshots: MAX_SCREENSHOTS,
  maxScreenshotBytes: MAX_SCREENSHOT_BYTES,
  maxCatalogBytes: 1024 * 1024,
  maxPackageBytes: 5 * 1024 * 1024
});
