import { channelError } from '../delivery-journal.js';

// Only explicit, vendor-neutral configuration can grant transport authority.
// Legacy gateway metadata remains in the raw file for Owner-reviewed migration.
export function assertOneBotConfigured(config = {}) {
  const onebot = config.onebot;
  if (onebot?.enabled !== true) throw channelError('QQ_DISABLED', 'OneBot QQ channel requires explicit Owner activation');
  let endpoint;
  if (typeof onebot.wsUrl === 'string' && onebot.wsUrl.length <= 2000 && !/[\x00-\x20]/.test(onebot.wsUrl)) {
    try { endpoint = new URL(onebot.wsUrl); } catch { endpoint = null; }
  }
  if (!endpoint || !['ws:', 'wss:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw channelError('QQ_CONFIG_REQUIRED', 'An explicit ws:// or wss:// OneBot endpoint without URL credentials is required');
  }
  return onebot;
}

export function oneBotConfigured(config) {
  // A saved configuration is not an activation grant. Validation here only
  // projects completeness; start paths still require the real enabled flag.
  if(!config?.onebot)return false;
  try { assertOneBotHttpConfigured({onebot:{...config.onebot,enabled:true}}); return true; }
  catch { return false; }
}

export function assertOneBotHttpConfigured(config) {
  const onebot = assertOneBotConfigured(config);
  let endpoint;
  if (typeof onebot.httpUrl === 'string' && onebot.httpUrl.length <= 2000 && !/[\x00-\x20]/.test(onebot.httpUrl)) {
    try { endpoint = new URL(onebot.httpUrl); } catch { endpoint = null; }
  }
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw channelError('QQ_HTTP_CONFIG_REQUIRED', 'An explicit http:// or https:// OneBot endpoint without URL credentials is required for HTTP actions');
  }
  return endpoint.href.replace(/\/+$/, '');
}
