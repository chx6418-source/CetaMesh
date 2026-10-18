// Source inventory for protocol review. It records the concrete handler location;
// inline DTOs are explicitly not treated as versioned JSON Schemas.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'AGENT_INTERFACE_METHOD_LEDGER.csv');
const columns = ['interface_id','method_or_event','caller_file_symbol','handler_file_symbol','transport','protocol_profile','version','schema_sha256','input_schema_ref','output_schema_ref','error_codes','auth_principal','grant_scope','identity_fields','side_effects','idempotency_key','cancellation','timeout_ms','max_bytes','pagination_cursor','event_subscription_replay','durability','feature_ids','pass1','pass2','pass3','pass4','evidence'];
const rows = [];
const uiFile = 'src/desktop/ui-service.js';
const uiText = fs.readFileSync(path.join(root, uiFile), 'utf8');
const bridgeFile = 'desktop-ui/src/bridge/typed-client.ts';
const bridgeText = fs.readFileSync(path.join(root, bridgeFile), 'utf8');
function lineAt(text, offset) { return text.slice(0, offset).split('\n').length; }
function csv(value) { const s = String(value ?? ''); return `"${s.replaceAll('"', '""')}"`; }
function push(row) { rows.push(Object.fromEntries(columns.map(key => [key, row[key] ?? 'UNVERIFIED']))); }
function family(method) {
  if (method.startsWith('ui.')) return 'Harbor-Rust-Core';
  if (method.startsWith('agent.')) return 'Core-AgentBroker';
  if (method.startsWith('mcp.') || method.startsWith('tools.') || method.startsWith('plugins.') || method.startsWith('integrations.')) return 'Core-MCP-Integration';
  if (method.startsWith('channel.')) return 'Core-QQ-Channel';
  if (method.startsWith('ext.')) return 'Core-Extension';
  return 'Core-OwnerIPC';
}
function effect(method) {
  return /(?:\.list|\.get|\.status|\.health|\.overview|\.describe|\.catalog|\.capabilities|\.tools|\.history|\.search|\.info|\.notes|\.settings$|\.proposals$|\.proposal$|\.events\.next$)/.test(method) ? 'read-or-subscribe' : 'potential-side-effect;inspect-handler';
}
function sourceRows(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const start = text.indexOf('const handlers = {');
  if (start < 0) return;
  const end = text.indexOf('\n  };', start);
  if (end < 0) throw new Error(`Missing handler map terminator: ${file}`);
  const segment = text.slice(start, end);
  const matches = [...segment.matchAll(/^    '([a-z][\w.-]+)':/gm)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const method = match[1];
    const offset = start + match.index;
    const handler = `${file}:${lineAt(text, offset)}`;
    const body = segment.slice(match.index, matches[i + 1]?.index ?? segment.length);
    const fields = [...new Set([...body.matchAll(/\b(?:p|params)(?:\?\.|\.)([A-Za-z]\w*)/g)].map(m => m[1]))].sort();
    const uiMatch = file !== uiFile ? uiText.indexOf(`'${method}'`) : -1;
    const bridgeAt = bridgeText.indexOf(`'${method}'`);
    const caller = file === uiFile
      ? bridgeAt >= 0 ? `${bridgeFile}:${lineAt(bridgeText, bridgeAt)}` : 'Harbor method caller UNVERIFIED'
      : uiMatch >= 0 ? `${uiFile}:${lineAt(uiText, uiMatch)}` : 'Owner IPC or in-process; exact caller UNVERIFIED';
    const errors = [...new Set([...body.matchAll(/(?:uiError|\w+Error)\('([A-Z][A-Z_]+)'/g)].map(m => m[1]))].sort();
    push({
      interface_id: family(method), method_or_event: method, caller_file_symbol: caller,
      handler_file_symbol: handler, transport: file === uiFile ? 'WebView2 bridge > Rust > Owner named pipe' : 'Owner named pipe or in-process',
      protocol_profile: file === uiFile ? 'desktop-ui-current' : 'core-service-current',
      version: 'unversioned-current-HEAD', schema_sha256: 'UNVERIFIED_NO_FORMAL_SCHEMA',
      input_schema_ref: `INLINE ${handler}; observed params: ${fields.join('|') || 'none-or-indirect'}`,
      output_schema_ref: `INLINE ${handler}; formal schema UNVERIFIED`,
      error_codes: `METHOD_NOT_FOUND${errors.length ? '|' + errors.join('|') : ''}; complete set UNVERIFIED`,
      auth_principal: file === uiFile ? 'Owner pipe token; actor bound in ipc-runtime' : 'Owner IPC or in-process principal;see-caller', grant_scope: /^(ui\.)?(task|workspace|ext|mcp|tools|plugins|integrations|channel|agent)\./.test(method) ? 'method-specific;see-handler' : 'Owner or service-specific',
      identity_fields: fields.filter(field => /(?:^id$|Id$|^provider$|^sessionId$|^requestId$|^turnId$|^runId$|^workspaceId$|^taskId$)/.test(field)).join('|') || 'UNVERIFIED_OR_NOT_APPLICABLE',
      side_effects: effect(method), idempotency_key: /requestId|clientMessageId/.test(body) ? 'requestId/clientMessageId;see-handler' : 'UNVERIFIED',
      cancellation: /signal|cancel|stop/.test(body) ? 'see-handler' : 'UNVERIFIED',
      timeout_ms: file === uiFile ? '32000 UI bridge; downstream varies' : 'UNVERIFIED',
      max_bytes: file === uiFile ? '921600 request;1048576 IPC frame' : '1048576 IPC frame',
      pagination_cursor: /cursor|beforeMessageId|afterMessageId|limit/.test(body) ? 'see-handler' : 'none-observed',
      event_subscription_replay: /events\.next|\.follow|\.subscribe/.test(method) ? 'cursor/retention;see-handler' : 'not-applicable-or-UNVERIFIED',
      durability: /^(ui\.)?(task|chat|workspace|ext|agent|mcp|plugins|integrations)\./.test(method) ? 'method-specific;see-handler' : 'UNVERIFIED',
      feature_ids: 'UNVERIFIED', pass1: 'SOURCE_ENUMERATED', pass2: 'FIELD_REVIEW_REQUIRED', pass3: 'NOT_RUN', pass4: 'NOT_RUN', evidence: handler
    });
  }
}
const files = [uiFile, 'src/agent/service.js','src/task/service.js','src/desktop/chat-service.js','src/continuity/service.js','src/workspace/service.js','src/integrations/service.js','src/channel/service.js','src/extension/service.js','src/workshop/service.js','src/memory/service.js','src/capability/service.js','src/plugin-center/service.js','src/settings/service.js','src/about/service.js','src/update/service.js','src/onboarding/service.js','src/model/service.js','src/router/service.js','src/mesh/service.js','src/product/service.js'];
for (const file of files) sourceRows(file);
const host = fs.readFileSync(path.join(root, 'desktop-shell/src/webview_ui.rs'), 'utf8');
for (const match of host.matchAll(/^        "(app\.[\w.]+)" =>/gm)) {
  const handler = `desktop-shell/src/webview_ui.rs:${lineAt(host, match.index)}`;
  push({ interface_id:'Harbor-Rust-Host', method_or_event:match[1], caller_file_symbol:bridgeFile, handler_file_symbol:handler, transport:'WebView2 host message', protocol_profile:'desktop-host-current', version:'unversioned-current-HEAD', schema_sha256:'UNVERIFIED_NO_FORMAL_SCHEMA', input_schema_ref:`HostMap ${bridgeFile}; ${handler}`, output_schema_ref:`HostMap ${bridgeFile}; ${handler}`, error_codes:'host error string; complete set UNVERIFIED', auth_principal:'local WebView2', grant_scope:'Rust host policy', identity_fields:'HostMap;see-typed-client', side_effects:effect(match[1]), idempotency_key:'UNVERIFIED', cancellation:'UNVERIFIED', timeout_ms:'32000 UI bridge', max_bytes:'921600 request', pagination_cursor:'none-observed', event_subscription_replay:'not-applicable', durability:'method-specific;see-handler', feature_ids:'UNVERIFIED', pass1:'SOURCE_ENUMERATED', pass2:'FIELD_REVIEW_REQUIRED', pass3:'NOT_RUN', pass4:'NOT_RUN', evidence:handler });
}
const native = [
  ['Core-Codex','--version','src/agent/codex-agent-provider.js','Codex CLI probe'],
  ['Core-Codex','login status','src/agent/codex-agent-provider.js','Codex CLI probe'],
  ['Core-Codex','exec --json','src/agent/codex-agent-provider.js','Codex exec JSONL stdio'],
  ['Core-Codex','exec resume --json','src/agent/codex-agent-provider.js','Codex exec JSONL stdio'],
  ['Core-DSH','session/create','src/agent/dsh-agent-provider.js','DSH HTTP RPC'],
  ['Core-DSH','session/prompt','src/agent/dsh-agent-provider.js','DSH HTTP RPC'],
  ['Core-DSH','session/cancel','src/agent/dsh-agent-provider.js','DSH HTTP RPC'],
  ['Core-DSH','session/list','src/agent/dsh-agent-provider.js','DSH HTTP RPC'],
  ['Core-DSH','session/follow','src/agent/dsh-agent-provider.js','DSH remote.mux stream'],
  ['Core-DSH','settings/describe','src/agent/dsh-agent-provider.js','DSH HTTP RPC'],
  ['Core-DSH','workspace/archiveSession','src/agent/dsh-agent-provider.js','DSH HTTP RPC'],
  ['Core-DSH','session/modelCatalog','src/bridge.js','DSH HTTP RPC'],
  ['Core-DSH','session/selectModel','src/dsh-integration.js','DSH HTTP RPC'],
  ['Core-DSH','workspace/create','src/bridge.js','DSH HTTP RPC'],
  ['Core-DSH','workspace/rename','src/bridge.js','DSH HTTP RPC'],
  ['Core-DSH','settings/mutate','src/bridge.js','DSH HTTP RPC'],
  ['Core-DSH','agentPresets/list','src/bridge.js','DSH HTTP RPC'],
  ['Core-DSH','$events','src/bridge.js','DSH remote.mux stream'],
  ['Core-DSH','$events/result','src/dsh-client.js','DSH HTTP RPC'],
  ['Core-MCP','initialize','src/integrations/mcp-runtime.js','MCP SDK negotiated transport'],
  ['Core-MCP','tools/list','src/integrations/mcp-runtime.js','MCP SDK negotiated transport'],
  ['Core-MCP','tools/call','src/integrations/mcp-runtime.js','MCP SDK negotiated transport'],
  ['Core-QQ-Channel','send_group_msg','src/bridge.js','OneBot gateway'],
  ['Core-QQ-Channel','send_private_msg','src/bridge.js','OneBot gateway'],
  ['Core-QQ-Channel','get_login_info','src/mcp-snowluma-safe.js','OneBot gateway'],
  ['Core-QQ-Channel','get_status','src/mcp-snowluma-safe.js','OneBot gateway'],
  ['Core-QQ-Channel','get_group_list','src/mcp-snowluma-safe.js','OneBot gateway'],
  ['Core-QQ-Channel','get_group_member_list','src/mcp-snowluma-safe.js','OneBot gateway'],
  ['Core-QQ-Channel','get_group_msg_history','src/mcp-snowluma-safe.js','OneBot gateway']
];
for (const [id, method, file, transport] of native) {
  const source = fs.readFileSync(path.join(root,file),'utf8');
  const token = method === 'exec --json' || method === 'exec resume --json' ? "args.push('exec'" : method === 'tools/list' ? 'client.listTools()' : method === 'tools/call' ? 'client.callTool(' : method === 'initialize' ? 'client.connect(' : `'${method}'`;
  const at = source.indexOf(token);
  const ref = `${file}:${at < 0 ? 'UNVERIFIED' : lineAt(source,at)}`;
  push({ interface_id:id, method_or_event:method, caller_file_symbol:ref, handler_file_symbol:'external native endpoint; installed schema UNVERIFIED', transport, protocol_profile:'native-profile-UNVERIFIED', version:'UNVERIFIED', schema_sha256:'UNVERIFIED', input_schema_ref:`INLINE ${ref}; external schema UNVERIFIED`, output_schema_ref:'external schema UNVERIFIED', error_codes:'external mapping;see-source', auth_principal:'native auth;UNVERIFIED', grant_scope:'Core mediated', identity_fields:'native identity mapping;UNVERIFIED', side_effects:effect(method), idempotency_key:'UNVERIFIED', cancellation:'native-specific;UNVERIFIED', timeout_ms:'see-source', max_bytes:'UNVERIFIED', pagination_cursor:'UNVERIFIED', event_subscription_replay:/follow|\$events/.test(method) ? 'native stream;replay UNVERIFIED' : 'not-applicable-or-UNVERIFIED', durability:'native-specific;UNVERIFIED', feature_ids:'UNVERIFIED', pass1:'SOURCE_ENUMERATED', pass2:'NATIVE_SCHEMA_UNVERIFIED', pass3:'NOT_RUN', pass4:'NOT_RUN', evidence:ref });
}
rows.sort((a,b) => a.interface_id.localeCompare(b.interface_id) || a.method_or_event.localeCompare(b.method_or_event));
fs.writeFileSync(output, [columns.join(','), ...rows.map(row => columns.map(key => csv(row[key])).join(','))].join('\n') + '\n');
console.log(`wrote ${rows.length} method rows to ${output}`);
