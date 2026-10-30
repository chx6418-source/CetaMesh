import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient } from '../dsh-client.js';
import { inspectDshPreset } from '../agent/dsh-preset-policy.js';
import { readJsonFile } from '../storage/json-file.js';

const MAX_TOOL_LOG_BYTES = 2 * 1024 * 1024;
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(String(error?.code ?? '')) ? error.code : 'DSH_API_UNAVAILABLE';
const sessionRows = value => Array.isArray(value) ? value : value?.items ?? value?.sessions;

// Existing account-owned receipts are evidence; configuration or a tool call alone
// is not. A new process, changed session or failed result cannot reuse old proof.
function inspectMcpEvidence({ accountRoot, startedAt, sessions, config, now }) {
  const unverified = { state: 'needs-verification', verified: false, tool: null, checkedAt: null };
  if (!accountRoot || !startedAt || !Array.isArray(sessions)) return unverified;
  try {
    const mapping = readJsonFile(path.join(accountRoot, 'state', 'sessions.json'), { missing: { sessions: {} }, maxBytes: 2 * 1024 * 1024 });
    if (!mapping?.sessions || typeof mapping.sessions !== 'object' || Array.isArray(mapping.sessions)) return unverified;
    const live = new Set(sessions.map(row => row?.sessionId ?? row?.id).filter(id => typeof id === 'string'));
    const allowed = key => {
      const match = /^(group|private):(\d{1,20})$/.exec(key);
      return match && config.allow?.[match[1] === 'group' ? 'groups' : 'private']?.map(String).includes(match[2]);
    };
    const file = path.join(accountRoot, 'state', 'tool-calls.jsonl');
    const fd = fs.openSync(file, 'r');
    let source;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_TOOL_LOG_BYTES) return unverified;
      const bytes = Buffer.alloc(MAX_TOOL_LOG_BYTES + 1);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (size > MAX_TOOL_LOG_BYTES) return unverified;
      source = bytes.subarray(0, size).toString('utf8');
    } finally { fs.closeSync(fd); }
    const records = source.split(/\r?\n/).filter(Boolean).slice(-2000);
    for (const line of records.reverse()) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const time = Date.parse(row.time);
      if (row.type !== 'result' || !/^mcp__snowluma__qq_[a-z0-9_]{1,100}$/.test(row.tool ?? '') ||
          !Number.isFinite(time) || time < startedAt || time > now || !allowed(row.key) ||
          mapping.sessions[row.key] !== row.sessionId || !live.has(row.sessionId)) continue;
      // The latest observed QQ tool result wins, including a failed reconnect.
      return { state: row.ok === true ? 'verified' : 'failed', verified: row.ok === true,
        tool: row.tool, checkedAt: new Date(time).toISOString() };
    }
  } catch { return unverified; /* Missing/unreadable evidence remains unverified; original data is never repaired. */ }
  return unverified;
}

export function createBionicReadiness({ config = {}, api, inspectPreset = inspectDshPreset, now = () => Date.now() } = {}) {
  const dsh = config.dsh ?? {};
  const client = api ?? new NodeApiClient(dsh.baseUrl, { authCookie: () => dsh.authCookie,
    dshHome: () => dsh.homeDir || null, timeoutMs: 2500 });
  const presetId = config.socialV2?.agentPreset || config.agentPreset || 'whale-chat-v2';
  return async ({ accountRoot, startedAt } = {}) => {
    const checkedAt = new Date(now()).toISOString();
    const local = inspectPreset({ id: presetId, dshHome: dsh.homeDir });
    const results = await Promise.allSettled([
      client.callEndpoint('settings/describe', {}, AbortSignal.timeout(2500)),
      client.callEndpoint('session/list', { _request: {} }, AbortSignal.timeout(2500)),
      client.callEndpoint('agentPresets/list', {}, AbortSignal.timeout(2500))
    ]);
    const failure = results.find(result => result.status === 'rejected');
    const rows = results[1].status === 'fulfilled' ? sessionRows(results[1].value) : null;
    const listed = results[2].status === 'fulfilled' ? results[2].value?.presets : null;
    const found = Array.isArray(listed) ? listed.find(row => row?.id === presetId) : null;
    const discovered = Array.isArray(listed) ? Boolean(found && !found.broken) : null;
    const sessionApi = Array.isArray(rows);
    const dshReady = !failure && sessionApi;
    const presetReady = local.compatible === true && discovered === true;
    const mcp = inspectMcpEvidence({ accountRoot, startedAt, sessions: rows, config, now: now() });
    const code = failure ? safeCode(failure.reason) : !sessionApi ? 'DSH_SESSION_LIST_UNVERIFIED'
      : !local.compatible ? 'DSH_PRESET_INCOMPATIBLE' : discovered !== true ? 'DSH_PRESET_UNAVAILABLE'
      : !mcp.verified ? 'BIONIC_MCP_UNVERIFIED' : null;
    return { checkedAt, canStart: dshReady && presetReady, ready: dshReady && presetReady && mcp.verified,
      state: code === null ? 'ready' : code === 'BIONIC_MCP_UNVERIFIED' ? 'needs-verification' : 'needs-setup', code,
      dsh: { ready: dshReady, sessionApi, state: dshReady ? 'ready' : 'unavailable', code: failure ? safeCode(failure.reason) : !sessionApi ? 'DSH_SESSION_LIST_UNVERIFIED' : null },
      preset: { id: presetId, compatible: local.compatible === true, discovered, ready: presetReady,
        reason: local.reason ?? (discovered === false ? 'preset-not-loaded' : discovered === null ? 'preset-load-unknown' : null),
        verification: 'local-persona-and-native-discovery' }, mcp };
  };
}
