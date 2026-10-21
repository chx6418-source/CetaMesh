// Legacy standalone HTML consoles are excluded. The bundled Harbor WebView2 UI is packaged separately.
const PRODUCT_HTML_BASENAMES = new Set([
  'console.html',
  'token-login.html',
  'dsh-monitor.html',
  'installer.html',
  'status.html'
]);

export function isNoWebUiHtmlArtifact(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const isPublicTree = normalized.startsWith('public/') || normalized.includes('/public/');
  return PRODUCT_HTML_BASENAMES.has(basename)
    || (isPublicTree && basename.endsWith('.html'));
}

export function findNoWebUiHtmlArtifacts(relativePaths) {
  return [...relativePaths].filter(isNoWebUiHtmlArtifact);
}

export function assertNoWebUiHtmlArtifacts(relativePaths, label = 'artifact') {
  const found = findNoWebUiHtmlArtifacts(relativePaths);
  if (found.length > 0) {
    throw new Error(`${label} contains product HTML UI assets: ${found.join(', ')}`);
  }
}

export function findNoWebUiBinaryMarkers(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const latin = bytes.toString('latin1').toLowerCase();
  return [...PRODUCT_HTML_BASENAMES].filter((name) => latin.includes(name));
}

export function assertNoWebUiBinaryMarkers(value, label = 'executable') {
  const found = findNoWebUiBinaryMarkers(value);
  if (found.length > 0) {
    throw new Error(`${label} embeds product HTML UI markers: ${found.join(', ')}`);
  }
}
