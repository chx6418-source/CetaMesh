#!/usr/bin/env node
// Production contract for the Owner-selected Harbor WebView2 Desktop UI.
// Source-level checks are paired with the existing desktop/Core suites in `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); };

check('Rust WebView2 host and security policy are present', () => {
  assert.ok(exists('desktop-shell/src/webview_policy.rs'));
  assert.ok(exists('desktop-shell/src/webview_ui.rs'));
  const cargo = read('desktop-shell/Cargo.toml');
  assert.match(cargo, /\bwry\s*=/);
  assert.match(cargo, /\btao\s*=/);
});

check('production UI defaults to WebView2 and dev origin is opt-in', () => {
  const policy = read('desktop-shell/src/webview_policy.rs');
  const entry = read('desktop-shell/src/native_main.rs');
  assert.match(policy, /UiMode::V2/);
  assert.match(entry, /run_webview_ui/);
  assert.match(policy, /debug_build/);
  assert.match(policy, /127\.0\.0\.1:5173/);
});

check('Harbor shell is the sole design and contains no prototype records', () => {
  assert.ok(exists('desktop-ui/src/app/HarborApp.tsx'));
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const entry = read('desktop-ui/src/main.tsx');
  const sources = ['desktop-ui/src/app/HarborApp.tsx', 'desktop-ui/src/main.tsx']
    .filter(exists).map(read).join('\n');
  assert.match(app, /Chat/);
  assert.match(app, /Agents/);
  assert.match(app, /Plugins/);
  assert.match(app, /Settings/);
  assert.match(app, /About/);
  assert.match(entry, /HarborApp/);
  for (const page of ['ChatPage', 'WorkPage', 'AgentsPage', 'PluginsPage', 'SettingsPage', 'AboutPage', 'OnboardingPage']) assert.match(app, new RegExp(`function ${page}`));
  for (const action of ['sessions.rename', 'sessions.archive', 'sessions.remove', 'toggleIntegrationTool', 'pluginClient.toggleTool', 'manageServer']) {
    assert.match(app, new RegExp(action.replace('.', '\\.')), `Harbor is missing ${action}`);
  }
  assert.doesNotMatch(sources, /DirectionPicker|direction-picker|import .*data\/mock|演示数据|探索预览|不会运行命令/);
  assert.match(read('desktop-ui/src/theme/tokens.css'), /--background:\s*#f1f0ea/);
  assert.ok(exists('desktop-ui/src/app/harbor.css'));
});

check('renderer bridge is typed, Core-backed, bounded, and secret-safe', () => {
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  const policy = read('desktop-shell/src/webview_policy.rs');
  const host = read('desktop-shell/src/webview_ui.rs');
  for (const name of ['chatClient', 'taskClient', 'memoryClient', 'agentClient', 'pluginClient', 'settingsClient', 'updateClient', 'aboutClient']) {
    assert.match(client, new RegExp(`\\b${name}\\b`), `missing typed client ${name}`);
  }
  assert.doesNotMatch(client, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(/);
  assert.match(policy, /MAX_BRIDGE|65_536|65536/);
  assert.match(client, /MAX_BRIDGE_REQUEST_BYTES/);
  assert.match(host, /MAX_TOTAL_BYTES/);
  assert.match(policy, /allowlist|ALLOWLIST|is_allowed_method/);
  assert.match(host, /about\.info/);
  const projection = read('src/desktop/ui-service.js');
  assert.match(host, /method\s+if\s+method\.starts_with\("ui\."\)/);
  assert.match(projection, /function projectAbout\(/);
  assert.match(projection, /function projectSettings\(/);
  assert.match(projection, /function projectMcpServer\(/);
  assert.match(projection, /SECRET_KEY\.test\(key\)/);
  assert.match(projection, /SETTING_KEYS/);
  assert.match(host, /api\.request\("ui\.settings\.get"/);
  assert.doesNotMatch(host, /api\.request\("settings\.get"/);
  assert.match(policy, /ui\.plugins\.enable\.review/);
});

check('production WebView denies remote navigation, active content, and HTTP transport', () => {
  const policy = read('desktop-shell/src/webview_policy.rs');
  const host = read('desktop-shell/src/webview_ui.rs');
  assert.match(policy, /PRODUCTION_CSP/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /trusted_message_source/);
  assert.match(host, /with_navigation_handler/);
  assert.match(host, /NewWindowResponse::Deny/);
  assert.match(host, /with_custom_protocol/);
  assert.doesNotMatch(host, /localhost:3100|TcpListener|HttpServer/);
});

check('release bundles only the canonical local React assets', () => {
  const release = read('scripts/build-release.mjs');
  const policy = read('scripts/no-web-release-policy.mjs');
  assert.match(release, /'desktop-ui', 'dist'/);
  assert.match(release, /'resources', 'desktop-ui'/);
  assert.match(policy, /console\.html/);
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['build:ui'], /desktop-ui/);
  assert.match(release, /webview2-bundled/);
});

check('Harbor provides standalone Memory categories without changing primary navigation', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  assert.match(app, /type PageId = [^;]*'memory'/);
  assert.match(app, /function MemoryPage\(/);
  assert.match(app, /memoryClient\.overview/);
  assert.match(app, /偏好/);
  assert.match(app, /项目记忆/);
  assert.match(app, /已保存知识/);
  assert.match(app, /最近/);
  assert.match(app, /<ChatContextPanel[^>]*memories=\{memories\}/);
  assert.match(app, /function ChatContextPanel\(/);
  assert.doesNotMatch(app, /const NAV:[\s\S]{0,500}id:\s*['"]memory['"]/);
});

check('MCP detail exposes real restart and masked configuration actions', () => {
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const projection = read('src/desktop/ui-service.js');
  assert.match(client, /mcpConfig:\s*\(serverId: string\).*ui\.mcp\.config\.get/);
  assert.match(client, /updateMcpConfig:\s*\(serverId: string, config:.*ui\.mcp\.config\.update/);
  assert.match(app, /manageServer\(item: McpRow, action: 'start' \| 'stop' \| 'enable' \| 'disable' \| 'restart'\)/);
  assert.match(app, /selectedServer\.config\.hasEnvironment/);
  assert.match(app, /重启/);
  assert.match(app, /保存 MCP 设置/);
  assert.match(projection, /'ui\.mcp\.config\.get'/);
  assert.match(projection, /'ui\.mcp\.config\.update'/);
  assert.match(projection, /hasEnvironment:/);
  assert.doesNotMatch(projection, /return\s+\{\s*id:.*config\.env/);
});
check('Models settings connect through the provider catalog without retaining API keys in React state', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  assert.match(app, /function ModelConnectionSettings\(/);
  assert.match(app, /chatClient\.catalog\(\)/);
  assert.match(app, /onboardingClient\.testProvider\(provider, apiKey,/);
  assert.match(app, /ref=\{apiKeyRef\}/);
  assert.doesNotMatch(app, /const \[apiKey,\s*setApiKey\] = useState/);
  assert.match(client, /testProvider:.*ui\.onboarding\.testProvider/);
});
check('About renders real build metadata and cached release notes', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  assert.match(app, /aboutClient\.update\(\)/);
  assert.match(app, /info\.buildNumber/);
  assert.match(app, /info\.channel/);
  assert.match(app, /info\.developer \?\? '未配置'/);
  assert.doesNotMatch(app, /info\.developer \?\? 'CetaMesh Team'/);
  assert.match(app, /record\.announcement/);
  assert.match(app, /latestVersion/);
  assert.match(client, /ui\.about\.update/);
  assert.match(client, /ui\.update\.notes/);
});
check('Agent registry states stay distinct and reflect real provider health', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const projection = read('src/desktop/ui-service.js');
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  assert.match(projection, /not-installed/);
  assert.match(projection, /not-supported/);
  assert.match(projection, /not-checked/);
  assert.match(projection, /healthStatus/);
  assert.match(projection, /agent\('agent\.health'/);
  assert.match(client, /export type AgentStatus = 'ready' \| 'needs-setup' \| 'not-installed' \| 'unavailable' \| 'not-supported' \| 'not-checked'/);
  assert.match(app, /'not-installed': '未安装'/);
  assert.match(app, /'not-supported': '不支持'/);
  assert.match(app, /'not-checked': '未检查'/);
  assert.match(app, /StatusBadge value=\{agent\.status\} available=\{agent\.available\}/);
  assert.match(app, /agent\.status === 'needs-setup'/);
  assert.match(app, /\.\.\.item, available: health\.available, status: health\.status/);
  assert.match(app, /agent\.desktopApp\.installed/);
  assert.match(app, /agent\.desktopApp\.running/);
});
check('Chat context uses refreshed approval events and shows artifact empty/details states', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  assert.match(app, /<ChatContextPanel[^>]*approvals=\{approvals\}/);
  assert.match(app, /function ChatContextPanel\(\{ task, memories, approvals, onOpenMemory \}/);
  assert.doesNotMatch(app, /function ChatContextPanel\([\s\S]{0,260}useState<Approval\[\]>/);
  assert.match(app, /暂无交付物/);
  assert.match(app, /selectedArtifact/);
  assert.match(app, /setSelectedArtifact\(artifact\)/);
});
check('Plugin Center filters featured and updates and stages a real update review', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const projection = read('src/desktop/ui-service.js');
  assert.match(app, /id: 'recommended', label: '精选'/);
  assert.match(app, /id: 'update-available', label: '可更新'/);
  assert.match(projection, /status === 'Update Available' \? 'update'/);
  assert.match(app, /action: plugin\.status === 'update' \? 'update' : 'install'/);
  assert.match(app, /review\.action === 'update' \? '插件已更新。'/);
  assert.match(app, /plugin\.status === 'update'[\s\S]{0,260}查看更新并安装/);
});
check('Chat Core stream events reach Harbor through the composition root event bus', () => {
  const composition = read('src/app/service-container.js');
  const chat = read('src/desktop/chat-service.js');
  assert.match(composition, /const chatService = createChatService\([\s\S]{0,1800}onEvent:\s*event\s*=>\s*uiEventBus\.publish\(event\.event,\s*event\.data\)/);
  assert.match(chat, /onEvent\?\.\(\{ event: 'chat\.streaming'/);
  assert.match(chat, /onEvent\?\.\(\{ event: 'chat\.updated'/);
});
check('Workspace selection opens the chosen Core workspace and preserves the active ID', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  const projection = read('src/desktop/ui-service.js');
  const hostPolicy = read('desktop-shell/src/webview_policy.rs');
  assert.match(projection, /'ui\.workspace\.open'/);
  assert.match(projection, /activeId:\s*string\(result\.activeId/);
  assert.match(client, /open:\s*\(id: string\).*ui\.workspace\.open/);
  assert.match(client, /activeId: string \| null/);
  assert.match(hostPolicy, /"ui\.workspace\.open"/);
  assert.match(app, /activeWorkspaceId/);
  assert.match(app, /workspaceClient\.open\(/);
});
check('Native host applies Core start-minimized and confirm-on-exit settings', () => {
  const host = read('desktop-shell/src/webview_ui.rs');
  const policy = read('desktop-shell/src/webview_policy.rs');
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  assert.match(policy, /app\.setWindowBehavior/);
  assert.match(host, /ui\.settings\.get/);
  assert.match(host, /startMinimized/);
  assert.match(host, /confirmOnExit/);
  assert.match(host, /with_visible/);
  assert.match(app, /hostClient\.setWindowBehavior/);
  assert.match(client, /setWindowBehavior:.*app\.setWindowBehavior/);
});
check('Memory page edits saved records through the real update route', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const client = read('desktop-ui/src/bridge/typed-client.ts');
  assert.match(client, /update:\s*\(input:.*ui\.memory\.update/);
  const manager = app.slice(app.indexOf('function MemoryManager('), app.indexOf('function WorkPage('));
  assert.match(manager, /memoryClient\.update\(/);
  assert.match(manager, /编辑记忆/);
});
check('Plugin Center exposes pending Core approvals and one-time decisions', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  const page = app.slice(app.indexOf('function PluginsPage('), app.indexOf('const SETTING_SECTION_LABELS'));
  assert.match(page, /approvalClient\.list\(/);
  assert.match(page, /approvalClient\.decide\(/);
  assert.match(page, /待处理审批/);
});
check('Update check returns an honest current status', () => {
  const projection = read('src/desktop/ui-service.js');
  const route = projection.slice(projection.indexOf("'ui.update.check':"), projection.indexOf("'ui.update.notes':"));
  assert.match(route, /const status\s*=/);
  assert.match(route, /,\s*status\s*};/);
  assert.match(route, /updateAvailable\s*===\s*true\s*\?\s*'update_available'/);
});
check('Production host wording does not call the native app a browser preview', () => {
  const app = read('desktop-ui/src/app/HarborApp.tsx');
  assert.doesNotMatch(app, /浏览器预览/);
  assert.match(app, /桌面工作台已连接/);
});
check('Release SBOM and third-party report include renderer production dependencies', () => {
  const release = read('scripts/build-release.mjs');
  assert.match(release, /desktop-ui', 'package-lock\.json'/);
  assert.match(release, /rendererPackages/);
  assert.match(release, /desktop-ui.*node_modules/);
});
check('Missing WebView2 Runtime shows an actionable desktop startup message', () => {
  const host = read('desktop-shell/src/webview_ui.rs');
  const entry = read('desktop-shell/src/native_main.rs');
  assert.match(host, /缺少 Microsoft Edge WebView2 Runtime/);
  assert.match(entry, /MessageDialog/);
  assert.match(entry, /set_description\(&error\)/);
});
process.stdout.write(`PASS ${passed} production UI contracts\n`);
