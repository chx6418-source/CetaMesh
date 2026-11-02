import { useCallback, useEffect, useRef, useState } from 'react';
import { productToolsClient, approvalClient, bridge, extensionSettingsClient, hostClient, oneBotClient, pluginClient, taskClient, type Approval, type ApprovalDecisionResult, type DesktopEventData, type ExtensionSettingsDescription, type ExtensionSettingsSnapshot, type IntegrationSettings, type OneBotSettings, type OneBotMigrationPreview, type Plugin, type Task } from '../bridge/typed-client';
import { Icon, type IconName } from '../components/icons';
import { Button, Input, SearchInput, Select, Tabs } from '../components/primitives/inputs';
import { Sheet } from '../components/primitives/overlays';
import { Badge, Banner, Card, LoadingState, Surface } from '../components/primitives/surfaces';
import { ApprovalCard } from './ApprovalCard';
import { BionicReadiness } from './BionicReadiness';
import { ForgeTools } from './ForgeTools';
import { OneBotConnectionForm, type OneBotConnectionDraft } from './OneBotConnectionForm';
import { ErrorNotice, Heading, EmptyNotice, StatusBadge, availabilityReasonLabel, messageOf } from './PagePresentation';
import { ApprovalOperationSummary } from './StatusPresentation';

type PluginReview = { id: string; stageId: string; action: 'install' | 'update' | 'enable'; installable: boolean; requiresReview: boolean; permissions: string[]; summary: string[]; trust: string };
type ExtensionSettingsFormState = {
  description: ExtensionSettingsDescription;
  values: ExtensionSettingsSnapshot['values'];
  draft: Record<string, string | number | boolean | null>;
};
function extensionSettingsDraft(description: ExtensionSettingsDescription, values: ExtensionSettingsSnapshot['values']): Record<string, string | number | boolean | null> {
  return Object.fromEntries(description.fields.map(field => {
    const value = values[field.key];
    if (field.type === 'secretRef') return [field.key, ''];
    const safeValue = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
    if (safeValue !== undefined) return [field.key, safeValue];
    if (field.default !== undefined) return [field.key, field.default];
    if (field.type === 'boolean') return [field.key, false];
    if (field.type === 'number' || field.type === 'enum') return [field.key, null];
    return [field.key, ''];
  }));
}
type IntegrationRow = { kind?: string; id: string; name: string; status: string; enabled: boolean; available: boolean; eligible: boolean; configured: boolean; reason: string | null; lastError: string | null };
type McpRow = { id: string; name: string; status: string; enabled: boolean; running: boolean; available: boolean; toolCallable: boolean; eligible: boolean; configured: boolean; source: string; toolCount: number | null; discoveredToolCount: number; transport: string; reason: string | null; lastError: string | null };
const isMcpCallable = (server: McpRow) => server.enabled === true && server.running === true && server.toolCallable === true;
const mcpStatus = (server: McpRow) => isMcpCallable(server) ? 'ready' : !server.enabled ? 'disabled' : server.running ? 'needs-setup' : server.status === 'stopped' ? 'stopped' : 'not-checked';
const mcpRuntimeStatus = (server: McpRow) => server.running ? 'running' : server.status === 'stopped' ? 'stopped' : 'not-checked';

export function PluginsPage() {
  const [tab, setTab] = useState('catalog');
  const [forgeTasks, setForgeTasks] = useState<Task[]>([]);
  const [forgeTasksError, setForgeTasksError] = useState('');
  const [view, setView] = useState('all');
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<{ available: boolean; configured: boolean; offline: boolean; reason: string | null; plugins: Plugin[] } | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [servers, setServers] = useState<McpRow[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [approvalOperations, setApprovalOperations] = useState<ApprovalDecisionResult[]>([]);
  const [channelEvents, setChannelEvents] = useState<(DesktopEventData & { kind: string })[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null);
  const extensionSettingsRequest = useRef(0);
  const [extensionSettings, setExtensionSettings] = useState<ExtensionSettingsFormState | null>(null);
  const [extensionSettingsLoading, setExtensionSettingsLoading] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationSettings | null>(null);
  const integrationRequest = useRef(0);
  const [oneBotSettings, setOneBotSettings] = useState<OneBotSettings | null>(null);
  const [oneBotMigration, setOneBotMigration] = useState<OneBotMigrationPreview | null>(null);
  const [oneBotDraft, setOneBotDraft] = useState<OneBotConnectionDraft>({ enabled: false, httpUrl: '', wsUrl: '', accessToken: '', httpAccessToken: '', clearAccessToken: false, clearHttpAccessToken: false });
  const [selectedServer, setSelectedServer] = useState<{ server: McpRow; tools: { id: string; name: string; description: string; enabled: boolean; discovered: boolean; callable: boolean }[]; toolSnapshotStale?: boolean; toolSnapshotObservation: number; config: { id: string; enabled: boolean; hasArgs: boolean; hasEnvironment: boolean; timeoutMs: number | null; note: string;url:string;credentialRef:string;allowedTools:string[] } } | null>(null);
  const [mcpToolQuery,setMcpToolQuery]=useState('');
  const [mcpToolPage,setMcpToolPage]=useState(0);
  const serverRequest=useRef(0);
  const [mcpConfigDraft, setMcpConfigDraft] = useState({ timeoutMs: '', note: '',url:'',credentialRef:'',allowedTools:'' });
  const [review, setReview] = useState<PluginReview | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const catalogRequest = useRef(0), connectionsRequest = useRef(0), approvalsRequest = useRef(0), lifetime = useRef(0), extensionSaveRequest = useRef(0);
  const latestMcpServers = useRef<McpRow[]>([]), mcpObservation = useRef(0);
  const activeTab = useRef(tab); activeTab.current = tab;
  useEffect(() => { ++lifetime.current; return () => { ++lifetime.current; ++catalogRequest.current; ++connectionsRequest.current; ++approvalsRequest.current; ++extensionSettingsRequest.current; ++integrationRequest.current; ++serverRequest.current; }; }, []);
  const applyMcpServers = useCallback((next: McpRow[], observation: number, forceStale = false) => {
    latestMcpServers.current = next; mcpObservation.current = observation;
    setServers(next);
    setSelectedServer(current => {
      if (!current) return current;
      const server = next.find(item => item.id === current.server.id) ?? { ...current.server, status: 'not-checked', running: false, available: false, toolCallable: false, eligible: false, reason: 'not-checked' };
      const changed = forceStale || observation !== current.toolSnapshotObservation || server.status !== current.server.status || server.enabled !== current.server.enabled || server.running !== current.server.running || server.toolCallable !== current.server.toolCallable;
      return { ...current, server, toolSnapshotStale: current.toolSnapshotStale || changed, tools: changed ? current.tools.map(tool => ({ ...tool, discovered: false, callable: false })) : current.tools };
    });
  }, []);

  const refreshCatalog = useCallback(async () => {
    const request = ++catalogRequest.current, connection = ++connectionsRequest.current, epoch = lifetime.current;
    setLoading(true);
    try {
      const [catalogResult, statusResult] = await Promise.all([
        pluginClient.catalog(query.trim(), category === 'all' ? '' : category, view), pluginClient.status()
      ]);
      if (epoch !== lifetime.current || request !== catalogRequest.current || activeTab.current !== 'catalog') return;
      setCatalog(catalogResult);
      setDeveloperMode(statusResult.developerMode);
      if (connection === connectionsRequest.current) { setIntegrations(statusResult.integrations); applyMcpServers(statusResult.mcp, connection); }
      setError('');
    } catch (cause) { if (epoch === lifetime.current && request === catalogRequest.current && activeTab.current === 'catalog') setError(messageOf(cause)); }
    finally { if (epoch === lifetime.current && request === catalogRequest.current) setLoading(false); }
  }, [applyMcpServers, category, query, view]);
  const refreshConnections = useCallback(async () => {
    const request = ++connectionsRequest.current, epoch = lifetime.current;
    try {
      const [integrationResult, mcpResult] = await Promise.all([pluginClient.integrations(), pluginClient.mcp()]);
      if (epoch !== lifetime.current || request !== connectionsRequest.current) return;
      setIntegrations(integrationResult.integrations);
      applyMcpServers(mcpResult.servers, request);
      setError('');
    } catch (cause) {
      if (epoch === lifetime.current && request === connectionsRequest.current) {
        setIntegrations(current => current.map(item => ({ ...item, available: false, eligible: false, reason: 'CHECK_FAILED' })));
        applyMcpServers(latestMcpServers.current.map(item => ({ ...item, status: 'not-checked', running: false, available: false, toolCallable: false, eligible: false, reason: 'CHECK_FAILED' })), request, true);
        setError(messageOf(cause));
      }
    }
  }, [applyMcpServers]);
  const refreshForgeTasks = useCallback(async () => {
    try { const result = await taskClient.overview(); setForgeTasks(result.tasks); setForgeTasksError(''); }
    catch (cause) { setForgeTasksError(messageOf(cause)); }
  }, []);
  const refreshApprovals = useCallback(async () => {
    const request = ++approvalsRequest.current, epoch = lifetime.current;
    try { const result = await approvalClient.list(); if (epoch !== lifetime.current || request !== approvalsRequest.current) return; setPendingApprovals(result.approvals.filter(item => item.status === 'pending')); setApprovalOperations(result.operations ?? []); }
    catch (cause) { if (epoch === lifetime.current && request === approvalsRequest.current) setError(messageOf(cause)); }
  }, []);
  useEffect(() => { if (tab === 'catalog') void refreshCatalog(); }, [tab, refreshCatalog]);
  useEffect(() => { if (tab !== 'catalog') void refreshConnections(); }, [tab, refreshConnections]);
  useEffect(() => { if (tab === 'connections') void refreshForgeTasks(); }, [tab, refreshForgeTasks]);
  useEffect(() => {
    void refreshApprovals();
    const offPending = bridge.subscribe('approval.pending', () => { void refreshApprovals(); });
    const offResolved = bridge.subscribe('approval.resolved', () => { void refreshApprovals(); });
    const offOperation = bridge.subscribe('approval.operation', () => { void refreshApprovals(); void refreshConnections(); });
    const timer = window.setInterval(() => { void refreshApprovals(); }, 4000);
    return () => { window.clearInterval(timer); offPending(); offResolved(); offOperation(); };
  }, [refreshApprovals]);
  useEffect(() => bridge.subscribe('plugin.updated', () => { if (tab === 'catalog') void refreshCatalog(); else void refreshConnections(); }), [refreshCatalog, refreshConnections, tab]);

  async function stage(plugin: Plugin) {
    setBusy(plugin.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.stage(plugin.id);
      setReview({ id: plugin.id, stageId: result.stageId, action: plugin.installed && plugin.status === 'update' ? 'update' : 'install', installable: result.installable, requiresReview: result.requiresReview, permissions: result.permissions, summary: result.summary, trust: result.trust });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function stageLocalPackage() {
    setError(''); setNotice('');
    try {
      const selected = await hostClient.pickExtensionPackage();
      if (!selected.path) return;
      setBusy('local-package');
      const result = await pluginClient.stageLocal(selected.path);
      setReview({ id: result.plugin.id, stageId: result.stageId, action: 'install', installable: result.installable, requiresReview: true, permissions: result.permissions, summary: result.summary, trust: 'local-unverified · Owner Review' });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function reviewEnable(plugin: Plugin) {
    setBusy(plugin.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.reviewEnable(plugin.id);
      setReview({ ...result, action: 'enable' });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function confirmReview() {
    if (!review || !review.installable) return;
    setBusy(review.id); setError('');
    try {
      if (review.action === 'install' || review.action === 'update') await pluginClient.install(review.stageId);
      else await pluginClient.enable(review.id, review.stageId);
      setNotice(review.action === 'update' ? '插件已更新。' : review.action === 'install' ? '插件已安装。' : '插件已启用。');
      setReview(null);
      await refreshCatalog();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function pluginAction(plugin: Plugin, action: 'disable' | 'uninstall') {
    const verb = action === 'disable' ? '停用' : '卸载';
    if (!window.confirm(`${verb}“${plugin.name}”？`)) return;
    setBusy(plugin.id); setError(''); setNotice('');
    try {
      await pluginClient[action](plugin.id);
      setSelectedPlugin(null);
      setNotice(`已${verb}插件。`);
      await refreshCatalog();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function toggleIntegration(item: IntegrationRow) {
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.manageIntegration(item.id, item.enabled ? 'disable' : 'enable');
      setNotice(result.pending === true || result.approvalId ? '此操作已提交，等待 Core 审批。' : '集成状态已更新。');
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function toggleIntegrationTool(integrationId: string, tool: IntegrationSettings['tools'][number]) {
    const key = `${integrationId}:${tool.id}`;
    const request = integrationRequest.current;
    setBusy(key); setError(''); setNotice('');
    try {
      const result = await pluginClient.toggleTool(integrationId, tool.id, !tool.enabled);
      const settings = await pluginClient.integrationSettings(integrationId);
      if (request !== integrationRequest.current) return;
      setNotice(result.pending === true || result.approvalId ? '工具权限变更已提交，等待 Core 审批。' : '工具状态已更新。');
      setSelectedIntegration(settings);
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { if (request === integrationRequest.current) setError(messageOf(cause)); }
    finally { if (request === integrationRequest.current) setBusy(''); }
  }
  useEffect(() => {
    setChannelEvents([]);
    const accountId = selectedIntegration?.id === 'cetamesh-onebot' ? oneBotSettings?.health.accountId : selectedIntegration?.localService?.accountId;
    const accept = (kind: string) => (data: DesktopEventData) => {
      if (!accountId || data.accountId !== accountId) return;
      setChannelEvents(rows => [...rows, { ...data, kind }].slice(-20));
    };
    const offMessage = bridge.subscribe('channel.message', accept('入站'));
    const offDelivery = bridge.subscribe('channel.delivery', accept('投递'));
    return () => { offMessage(); offDelivery(); };
  }, [selectedIntegration?.id, selectedIntegration?.localService?.accountId, oneBotSettings?.health.accountId]);
  useEffect(() => {
    if (selectedIntegration?.id !== 'cetamesh-onebot') return;
    let active = true;
    let generation = 0;
    const refreshHealth = async () => {
      const current = ++generation;
      try {
        const settings = await oneBotClient.get();
        if (!active || generation !== current) return;
        // Health refreshes never move the revision bound to an unsaved configuration draft.
        setOneBotSettings(previous => previous ? { ...previous, health: settings.health } : previous);
      } catch (cause) {
        if (!active || generation !== current) return;
        setOneBotSettings(previous => previous ? { ...previous, health: { ...previous.health, connected: null, authenticated: null, ready: false, canSend: false, state: 'unavailable', error: messageOf(cause) } } : previous);
      }
    };
    const offOperation = bridge.subscribe('approval.operation', () => { void refreshHealth(); });
    const offResolved = bridge.subscribe('approval.resolved', () => { void refreshHealth(); });
    const offPlugin = bridge.subscribe('plugin.updated', () => { void refreshHealth(); });
    const timer = window.setInterval(() => { void refreshHealth(); }, 4000);
    return () => { active = false; generation += 1; offOperation(); offResolved(); offPlugin(); window.clearInterval(timer); };
  }, [selectedIntegration?.id]);
  function acceptOneBotSettings(settings: OneBotSettings) {
    setOneBotSettings(settings);
    setOneBotDraft({ enabled: settings.configuration.enabled, httpUrl: settings.configuration.httpUrl || '', wsUrl: settings.configuration.wsUrl || '', accessToken: '', httpAccessToken: '', clearAccessToken: false, clearHttpAccessToken: false });
  }
  async function manageOneBot(action: 'health' | 'reconnect' | 'start' | 'stop') {
    const request = integrationRequest.current;
    setBusy(`onebot:${action}`); setError(''); setNotice('');
    try {
      const result = await pluginClient.integrationAction('onebot', action);
      const [settings, integration] = await Promise.all([oneBotClient.get(), pluginClient.integrationSettings('cetamesh-onebot')]);
      if (request !== integrationRequest.current) return;
      setNotice(result.pending === true || result.approvalId ? '连接操作已提交，等待 Core 审批。' : '通道状态已刷新，请按连接和认证证据核对。');
      setOneBotSettings(previous => previous ? { ...previous, health: settings.health } : previous);
      setSelectedIntegration(integration);
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { if (request === integrationRequest.current) setError(messageOf(cause)); }
    finally { if (request === integrationRequest.current) setBusy(''); }
  }
  async function saveOneBot() {
    if (!oneBotSettings) return;
    const request = integrationRequest.current;
    setBusy('onebot:configure'); setError(''); setNotice('');
    try {
      const settings = await oneBotClient.configure({
        enabled: oneBotDraft.enabled, httpUrl: oneBotDraft.httpUrl, wsUrl: oneBotDraft.wsUrl,
        expectedSourceHash: oneBotSettings.configuration.sourceHash,
        ...(oneBotDraft.accessToken ? { accessToken: oneBotDraft.accessToken } : {}),
        ...(oneBotDraft.httpAccessToken ? { httpAccessToken: oneBotDraft.httpAccessToken } : {}),
        ...(oneBotDraft.clearAccessToken ? { clearAccessToken: true } : {}),
        ...(oneBotDraft.clearHttpAccessToken ? { clearHttpAccessToken: true } : {})
      });
      if (request !== integrationRequest.current) return;
      acceptOneBotSettings(settings); setOneBotMigration(null);
      setNotice('OneBot 配置已保存，尚未发起连接。');
      await refreshConnections();
    } catch (cause) { if (request === integrationRequest.current) setError(messageOf(cause)); }
    finally { if (request === integrationRequest.current) setBusy(''); }
  }
  async function previewOneBotMigration() {
    const request = integrationRequest.current;
    setBusy('onebot:migration-preview'); setError('');
    try {
      const preview = await oneBotClient.previewMigration();
      if (request === integrationRequest.current) setOneBotMigration(preview);
    } catch (cause) { if (request === integrationRequest.current) setError(messageOf(cause)); }
    finally { if (request === integrationRequest.current) setBusy(''); }
  }
  async function applyOneBotMigration() {
    if (!oneBotMigration || !oneBotMigration.legacyPresent || oneBotMigration.hasCurrentConfig) return;
    const request = integrationRequest.current;
    setBusy('onebot:migration-apply'); setError(''); setNotice('');
    try {
      const settings = await oneBotClient.applyMigration(oneBotMigration.sourceHash);
      if (request !== integrationRequest.current) return;
      acceptOneBotSettings(settings); setOneBotMigration(null);
      setNotice('端点迁移已完成并保持关闭；旧配置备份已保留。请重新输入令牌，保存后再明确连接。');
      await refreshConnections();
    } catch (cause) { if (request === integrationRequest.current) setError(messageOf(cause)); }
    finally { if (request === integrationRequest.current) setBusy(''); }
  }
  async function manageServer(item: McpRow, action: 'start' | 'stop' | 'enable' | 'disable' | 'restart') {
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await pluginClient.manageMcp(item.id, action);
      setNotice(result.pending === true || result.approvalId ? '此操作已提交，等待 Core 审批。' : 'MCP 服务状态已更新。');
      await Promise.all([refreshConnections(), refreshApprovals()]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }
  async function openPlugin(plugin: Plugin) {
    const request = ++extensionSettingsRequest.current;
    setError(''); setNotice('');
    setSelectedPlugin(plugin);
    setExtensionSettings(null);
    setExtensionSettingsLoading(true);
    try {
      const result = await pluginClient.detail(plugin.id);
      const selected = result.plugin ?? plugin;
      if (request !== extensionSettingsRequest.current) return;
      setSelectedPlugin(selected);
      if (!selected.installed) return;
      const description = await extensionSettingsClient.describe(selected.id);
      if (request !== extensionSettingsRequest.current || !description.available || !description.fields.length) return;
      const snapshot = await extensionSettingsClient.get(selected.id);
      if (request !== extensionSettingsRequest.current) return;
      setExtensionSettings({ description, values: snapshot.values, draft: extensionSettingsDraft(description, snapshot.values) });
    } catch (cause) { if (request === extensionSettingsRequest.current) setError(messageOf(cause)); }
    finally { if (request === extensionSettingsRequest.current) setExtensionSettingsLoading(false); }
  }
  async function saveExtensionSettings() {
    if (!extensionSettings || !selectedPlugin) return;
    const request = extensionSettingsRequest.current, save = ++extensionSaveRequest.current;
    const submittedDraft = { ...extensionSettings.draft };
    const values: Record<string, string | number | boolean | null> = {};
    for (const field of extensionSettings.description.fields) {
      const value = extensionSettings.draft[field.key];
      if (field.type === 'secretRef') {
        if (value === null) values[field.key] = null;
        else if (typeof value === 'string' && value.length > 0) values[field.key] = value;
      } else if (value !== undefined) values[field.key] = value;
    }
    setBusy('extension-settings'); setError(''); setNotice('');
    try {
      const snapshot = await extensionSettingsClient.update(selectedPlugin.id, values);
      if (request !== extensionSettingsRequest.current) return;
      setExtensionSettings(current => {
        if (!current || current.description.id !== snapshot.id) return current;
        const draft = extensionSettingsDraft(current.description, snapshot.values);
        for (const field of current.description.fields) if (!Object.is(current.draft[field.key], submittedDraft[field.key])) draft[field.key] = current.draft[field.key];
        return { ...current, values: snapshot.values, draft };
      });
      setNotice('扩展设置已保存。');
    } catch (cause) { if (request === extensionSettingsRequest.current) setError(messageOf(cause)); }
    finally { if (save === extensionSaveRequest.current) setBusy(''); }
  }
  async function openIntegration(item: IntegrationRow) {
    const request = ++integrationRequest.current;
    setBusy('');
    try {
      const [settings, channel] = await Promise.all([pluginClient.integrationSettings(item.id), item.id === 'cetamesh-onebot' ? oneBotClient.get() : Promise.resolve(null)]);
      if (request !== integrationRequest.current) return;
      setSelectedIntegration(settings);
      setOneBotMigration(null);
      if (channel) acceptOneBotSettings(channel);
      else setOneBotSettings(null);
    }
    catch (cause) { if (request === integrationRequest.current) setError(messageOf(cause)); }
  }
  async function openServer(item: McpRow) {
    const epoch=++serverRequest.current, connectionAtOpen=connectionsRequest.current, observationAtOpen=mcpObservation.current;setError('');
    try {
      const [result, config] = await Promise.all([pluginClient.mcpTools(item.id), pluginClient.mcpConfig(item.id)]);
      if(epoch!==serverRequest.current)return;
      const changed = connectionAtOpen !== connectionsRequest.current || observationAtOpen !== mcpObservation.current || mcpObservation.current !== connectionsRequest.current;
      const latest = latestMcpServers.current.find(server => server.id === item.id);
      const server = !changed ? item : latest && mcpObservation.current === connectionsRequest.current ? latest : { ...(latest ?? item), status: 'not-checked', running: false, available: false, toolCallable: false, eligible: false, reason: 'not-checked' };
      setMcpToolQuery('');setMcpToolPage(0);
      setSelectedServer({ server, tools: changed ? result.tools.map(tool => ({ ...tool, discovered: false, callable: false })) : result.tools, toolSnapshotStale: changed, toolSnapshotObservation: mcpObservation.current, config });
      setMcpConfigDraft({ timeoutMs: config.timeoutMs === null ? '' : String(config.timeoutMs), note: config.note,url:config.url||'',credentialRef:config.credentialRef||'',allowedTools:(config.allowedTools||[]).join(', ') });
    } catch (cause) { if(epoch===serverRequest.current)setError(messageOf(cause)); }
  }

  async function decidePendingApproval(id: string, approve: boolean) {
    setBusy(`approval:${id}`); setError(''); setNotice('');
    try {
      const result = await approvalClient.decide(id, approve);
      if (result.resumeError) setError(`审批已记录，但回合继续失败（${result.resumeError}）。`);
      else if (approve && result.resumePending) setNotice('已批准一次，后续敏感操作仍需审批。');
      else if (approve) setNotice(result.turnResumed ? '已批准一次，聊天回合已继续。' : '已批准一次，Core 正在继续操作。');
      else setNotice(result.turnResumed ? '已拒绝，聊天回合已收到结果并继续。' : '已拒绝此操作。');
      await refreshApprovals();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(''); }
  }

  async function saveMcpConfig() {
    if (!selectedServer) return;
    const epoch=serverRequest.current,targetServer=selectedServer.server.id;
    const timeoutText = mcpConfigDraft.timeoutMs.trim();
    const timeoutMs = timeoutText ? Number(timeoutText) : null;
    if (timeoutText && (timeoutMs === null || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)) {
      setError('MCP 超时必须是 100 到 300000 毫秒之间的整数。');
      return;
    }
    setBusy('mcp-config'); setError(''); setNotice('');
    try {
      await pluginClient.updateMcpConfig(targetServer, {
        ...(timeoutMs === null ? {} : { timeoutMs }),
        note: mcpConfigDraft.note.trim(),
        ...(selectedServer.server.transport==='streamable-http'?{url:mcpConfigDraft.url.trim(),credentialRef:mcpConfigDraft.credentialRef.trim(),allowedTools:mcpConfigDraft.allowedTools.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean)}:{})
      });
      const config = await pluginClient.mcpConfig(targetServer);
      if(epoch!==serverRequest.current)return;
      setSelectedServer(current => current?.server.id===targetServer ? { ...current, config } : current);
      setMcpConfigDraft({ timeoutMs: config.timeoutMs === null ? '' : String(config.timeoutMs), note: config.note,url:config.url||'',credentialRef:config.credentialRef||'',allowedTools:(config.allowedTools||[]).join(', ') });
      setNotice('MCP 设置已保存。');
    } catch (cause) { if(epoch===serverRequest.current)setError(messageOf(cause)); }
    finally { if(epoch===serverRequest.current)setBusy(''); }
  }
  const plugins = catalog?.plugins ?? [];
  const connectionRows = integrations.filter(item => tab === 'tools' ? item.kind === 'tool-pack' : item.kind !== 'tool-pack').filter(item => `${item.name} ${item.reason ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const categories = ['all', ...new Set(plugins.map(plugin => plugin.category).filter(Boolean))];
  return <div className="content-page plugins-page">
    <Heading eyebrow="EXTENSIONS & CONNECTORS" title="插件中心" description="管理插件、服务连接和开发工具，查看真实可用状态。" action={<Button icon="add" variant="primary" onClick={() => { setTab('catalog'); setView('all'); }}>添加插件</Button>} />
    <Banner><span className="banner-icon"><Icon name="approval" size={20} /></span><span className="grow"><strong>安装前先查看权限</strong><small>插件详情与权限清单会在安装前显示；高风险操作仍由 Core 审批。</small></span><span className="banner-link">仅安装可信来源</span></Banner>
    <div className="plugins-controls row between"><SearchInput label="搜索插件" placeholder="搜索插件、集成或开发者" value={query} onChange={event => { ++catalogRequest.current; setQuery(event.target.value); }} /><Tabs label="插件视图" selected={tab} onChange={value => { ++catalogRequest.current; setTab(value); }} items={[{ id: 'catalog', label: '插件' }, { id: 'connections', label: '连接' }, { id: 'tools', label: '开发工具' }, { id: 'mcp', label: `MCP ${servers.length || ''}` }]} /></div>
    {error && <ErrorNotice error={error} onRetry={() => tab === 'catalog' ? void refreshCatalog() : void refreshConnections()} />}{notice && <p className="inline-success" role="status">{notice}</p>}
    <ApprovalOperationSummary operations={approvalOperations} onCancel={id => { void approvalClient.cancel(id).then(() => refreshApprovals()).catch(cause => setError(messageOf(cause))); }} />
    {pendingApprovals.length > 0 && <section className="plugin-approval-inbox"><div className="section-heading"><h2>待处理审批</h2><Badge tone="warning">{pendingApprovals.length}</Badge></div>{pendingApprovals.map(approval => <ApprovalCard key={approval.id} approval={approval} onDecide={(id, approve) => { void decidePendingApproval(id, approve); }} />)}</section>}
    {tab === 'catalog' && <>
    <div className="catalog-filters"><Tabs label="插件分类" selected={category} onChange={value => { ++catalogRequest.current; setCategory(value); }} items={categories.map(value => ({ id: value, label: value === 'all' ? '全部' : value }))} /><Tabs label="安装状态" selected={view} onChange={value => { ++catalogRequest.current; setView(value); }} items={[{ id: 'all', label: '全部' }, { id: 'recommended', label: '精选' }, { id: 'installed', label: '已安装' }, { id: 'update-available', label: '可更新' }]} />{developerMode && <Button compact onClick={() => void stageLocalPackage()} disabled={busy === 'local-package'}>{busy === 'local-package' ? '读取本地包…' : '导入本地扩展'}</Button>}<Button compact icon="update" onClick={() => void refreshCatalog()} disabled={loading}>刷新目录</Button></div>
      {catalog?.offline && <Banner>当前目录离线，显示 Core 缓存的插件信息。{catalog.reason ? ` ${catalog.reason}` : ''}</Banner>}
      {loading && !plugins.length ? <LoadingState label="正在读取插件目录…" /> : plugins.length ? <div className="plugin-grid">{plugins.map(plugin => <Card className="plugin-card" key={plugin.id}><button className="plugin-card-main" onClick={() => void openPlugin(plugin)}><span className={`plugin-icon plugin-icon-${plugin.icon}`}><Icon name={(plugin.icon as IconName) || 'layers'} size={20} /></span><span className="plugin-card-copy"><strong>{plugin.name}</strong><span>{plugin.summary}</span><small>{plugin.developer} · v{plugin.version || '—'} · {plugin.category || plugin.kind}</small></span><StatusBadge value={!plugin.installed ? plugin.status === 'invalid' ? 'invalid' : 'not-installed' : plugin.status === 'update' ? 'update' : plugin.enabled ? 'enabled' : 'installed'} /></button><div className="plugin-card-actions"><Button compact variant="ghost" onClick={() => void openPlugin(plugin)}>查看详情 <Icon name="right" size={13} /></Button>{plugin.installed && plugin.status === 'update' ? <Button compact variant="primary" disabled={busy === plugin.id} onClick={() => void stage(plugin)}>查看更新并安装</Button> : !plugin.installed ? <Button compact variant="primary" disabled={busy === plugin.id} onClick={() => void stage(plugin)}>安装</Button> : plugin.enabled ? <Button compact disabled={busy === plugin.id} onClick={() => void pluginAction(plugin, 'disable')}>停用</Button> : <Button compact variant="primary" disabled={busy === plugin.id} onClick={() => void reviewEnable(plugin)}>启用</Button>}</div></Card>)}</div> : !loading && !error && <EmptyNotice icon="plugins" title="没有匹配的插件" detail={catalog?.reason || '调整搜索条件，或刷新插件目录。'} />}
    </>}
    {(tab === 'connections' || tab === 'tools') && <><div className="plugin-section-heading"><h2>{tab === 'tools' ? '开发工具' : '服务连接'}</h2><p className="muted">{tab === 'tools' ? '查看工具的启用状态与调用条件，进入详情管理权限。' : '先连接账号或本地服务，再查看可用能力。'}</p></div>{tab === 'connections' && <section className="forge-connections-section" aria-label="开发平台连接">{forgeTasksError && <ErrorNotice error={'任务列表读取失败：' + forgeTasksError} onRetry={() => void refreshForgeTasks()} />}<ForgeTools call={productToolsClient.call} tasks={forgeTasks}/></section>}<div className="connection-list">{connectionRows.length ? connectionRows.map(item => <Surface className="connection-row" key={item.id}><span className="connection-icon"><Icon name="plug" size={20} /></span><span className="grow"><strong>{item.name}</strong><small>{item.id} · {availabilityReasonLabel(item.reason) || item.lastError || (item.available ? item.status : '当前不可用')}</small></span><StatusBadge value={!item.enabled ? 'disabled' : item.available ? item.status : (item.reason === 'needs-setup' ? 'needs-setup' : item.reason === 'not-installed' ? 'not-installed' : 'unavailable')} available={item.enabled && item.eligible} /><Button compact onClick={() => void openIntegration(item)}>详情与设置</Button><Button compact variant={item.enabled ? 'default' : 'primary'} disabled={busy === item.id} onClick={() => void toggleIntegration(item)}>{item.enabled ? '停用' : '启用'}</Button></Surface>) : !error && <EmptyNotice icon="plug" title="没有已注册的集成" detail="Integration 状态由本机 Core 提供。安装扩展请前往插件中心。" />}</div></>}
    {tab === 'mcp' && <div className="connection-list">{servers.length ? servers.map(item => <Surface className="connection-row" key={item.id}><span className="connection-icon mcp-icon"><Icon name="layers" size={20} /></span><span className="grow"><strong>{item.name}</strong><small>{item.source === 'builtin' ? '内置服务 · 默认启动入口' : item.transport || '本机连接'} · {item.discoveredToolCount}/{item.toolCount ?? '?'} 个工具已发现{item.reason ? ` · ${availabilityReasonLabel(item.reason) || item.reason}` : ''}</small></span><StatusBadge value={mcpStatus(item)} available={isMcpCallable(item)} /><Button compact onClick={() => void openServer(item)}>查看工具</Button><Button compact variant={item.enabled ? 'default' : 'primary'} disabled={busy === item.id} onClick={() => void manageServer(item, item.enabled ? 'disable' : 'enable')}>{item.enabled ? '禁用' : '启用'}</Button><Button compact disabled={busy === item.id || !item.enabled || item.status === 'unsupported'} onClick={() => void manageServer(item, item.running ? 'stop' : 'start')}>{item.running ? '停止' : '启动'}</Button></Surface>) : !error && <EmptyNotice icon="layers" title="没有配置 MCP 服务" detail="MCP 服务与凭据由本机 Core 配置和管理。" />}</div>}
    <Sheet open={Boolean(selectedPlugin)} title={selectedPlugin?.name ?? '插件详情'} onClose={() => { extensionSettingsRequest.current += 1; extensionSaveRequest.current += 1; setSelectedPlugin(null); setExtensionSettings(null); setExtensionSettingsLoading(false); setBusy(current => current === 'extension-settings' ? '' : current); }}>{selectedPlugin && <div className="plugin-detail">{error && <ErrorNotice error={error} />}<p className="eyebrow">{selectedPlugin.developer} · {selectedPlugin.kind}</p><h3>{selectedPlugin.summary}</h3><p>{selectedPlugin.description || '暂无详细说明。'}</p><section aria-label="插件运行状态"><h3>安装与运行状态</h3><p>安装：{selectedPlugin.installed ? '已安装' : '未安装'} · 启用：{!selectedPlugin.installed && selectedPlugin.enabled ? '状态不一致，请刷新' : selectedPlugin.enabled ? '已启用' : '未启用'}</p><p>运行状态未验证。授权：声明权限不等于已授权；可调用：尚未验证，由 Core 在具体操作时判断。</p></section><div className="detail-facts"><span>版本 <strong>{selectedPlugin.version || '—'}</strong></span><span>分类 <strong>{selectedPlugin.category || '未分类'}</strong></span><span>最低版本 <strong>{selectedPlugin.compatibility.minimum || '未说明'}</strong></span></div><section><h3>权限</h3>{selectedPlugin.permissions.length ? <ul>{selectedPlugin.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul> : <p className="muted">该插件没有声明权限。</p>}</section>{selectedPlugin.warning && <Banner>{selectedPlugin.warning}</Banner>}
      {selectedPlugin.installed && extensionSettingsLoading && <p className="muted">正在读取扩展设置…</p>}
      {selectedPlugin.installed && extensionSettings && extensionSettings.description.fields.length > 0 && <section className="extension-settings">
        <div><h3>扩展设置</h3><p className="muted">设置由本机 Core 保存；敏感值只显示是否已配置。</p></div>
        {extensionSettings.description.fields.map(field => {
          const draft = extensionSettings.draft[field.key];
          const stored = extensionSettings.values[field.key];
          const configured = field.type === 'secretRef' && typeof stored === 'object' && stored !== null && stored.configured;
          const updateDraft = (value: string | number | boolean | null) => setExtensionSettings(current => current
            ? { ...current, draft: { ...current.draft, [field.key]: value } } : current);
          return <div className="extension-setting" key={field.key}>
            <div className="extension-setting-copy"><strong>{field.label}</strong>{field.required && <small>必填</small>}</div>
            {field.type === 'boolean'
              ? <label className="extension-setting-toggle"><span className="sr-only">{field.label}</span><Input type="checkbox" checked={draft === true} onChange={event => updateDraft(event.target.checked)} /></label>
              : field.type === 'enum'
                ? <Select label={field.label} value={typeof draft === 'string' ? draft : ''} onChange={event => updateDraft(event.target.value || null)}><option value="">未设置</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</Select>
                : field.type === 'number'
                  ? <Input type="number" aria-label={field.label} min={field.min ?? undefined} max={field.max ?? undefined} step="any" value={typeof draft === 'number' ? draft : typeof draft === 'string' ? draft : ''} onChange={event => updateDraft(event.target.value === '' ? null : Number(event.target.value))} />
                  : field.type === 'secretRef'
                    ? <div className="extension-secret-control"><Input type="password" aria-label={field.label} autoComplete="new-password" maxLength={field.maxLength ?? undefined} value={typeof draft === 'string' ? draft : ''} placeholder={configured ? '已配置，留空保持不变' : '输入敏感值'} onChange={event => updateDraft(event.target.value)} /><span className="muted">{configured ? '已配置' : '未配置'}</span>{configured && draft !== null && <Button compact variant="ghost" onClick={() => updateDraft(null)}>清除</Button>}</div>
                    : <Input aria-label={field.label} maxLength={field.maxLength ?? undefined} value={typeof draft === 'string' ? draft : ''} onChange={event => updateDraft(event.target.value)} />}
          </div>;
        })}
        <div className="row detail-actions"><Button compact variant="primary" disabled={busy === 'extension-settings'} onClick={() => void saveExtensionSettings()}>{busy === 'extension-settings' ? '正在保存…' : '保存扩展设置'}</Button></div>
      </section>}
      <section><h3>更新说明</h3>{selectedPlugin.changelog.length ? <ul>{selectedPlugin.changelog.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul> : <p className="muted">没有更新说明。</p>}</section><div className="row detail-actions">{selectedPlugin.installed && selectedPlugin.status === 'update' ? <Button variant="primary" disabled={busy === selectedPlugin.id} onClick={() => void stage(selectedPlugin)}>查看更新并安装</Button> : !selectedPlugin.installed ? <Button variant="primary" disabled={busy === selectedPlugin.id} onClick={() => void stage(selectedPlugin)}>查看权限并安装</Button> : selectedPlugin.enabled ? <Button disabled={busy === selectedPlugin.id} onClick={() => void pluginAction(selectedPlugin, 'disable')}>停用</Button> : <Button variant="primary" disabled={busy === selectedPlugin.id} onClick={() => void reviewEnable(selectedPlugin)}>查看权限并启用</Button>}{selectedPlugin.installed && <Button variant="danger" disabled={busy === selectedPlugin.id} onClick={() => void pluginAction(selectedPlugin, 'uninstall')}>卸载</Button>}</div></div>}</Sheet>
    <Sheet open={Boolean(review)} title="安装与权限审查" onClose={() => setReview(null)}>{review && <div className="review-detail"><Badge tone={review.trust === 'publisher-signature-verified' ? 'success' : 'warning'}>{review.trust || '来源待核验'}</Badge><h3>{review.action === 'update' ? '更新前查看权限' : review.action === 'install' ? '安装前查看权限' : '启用前查看权限'}</h3><p>仅继续本次明确选择的操作。运行时能力仍需 Core 按策略审批。</p>{review.summary.length ? <section><h4>操作说明</h4><ul>{review.summary.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul></section> : null}<section><h4>请求的权限</h4>{review.permissions.length ? <ul>{review.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul> : <p>没有声明额外权限。</p>}</section>{!review.installable && <ErrorNotice error="Core 尚未允许该插件安装或启用。请先处理完整性或兼容性问题。" />}<div className="row detail-actions"><Button onClick={() => setReview(null)}>取消</Button><Button variant="primary" disabled={!review.installable || busy === review.id} onClick={() => void confirmReview()}>{busy === review.id ? '正在处理…' : review.action === 'update' ? '确认更新' : review.action === 'install' ? '确认安装' : '确认启用'}</Button></div></div>}</Sheet>
    <Sheet open={Boolean(selectedIntegration)} title={selectedIntegration?.name ?? '集成设置'} onClose={() => { integrationRequest.current += 1; setSelectedIntegration(null); setOneBotSettings(null); setOneBotMigration(null); setOneBotDraft({ enabled: false, httpUrl: '', wsUrl: '', accessToken: '', httpAccessToken: '', clearAccessToken: false, clearHttpAccessToken: false }); setBusy(''); }}>
      {selectedIntegration && <div className="plugin-detail">
        <StatusBadge value={selectedIntegration.enabled ? 'enabled' : 'disabled'} available={selectedIntegration.enabled && selectedIntegration.available} />
        {selectedIntegration.id === 'cetamesh-onebot' && oneBotSettings && <section>
          {channelEvents.length > 0 && <div role="status"><h4>当前账号通道活动</h4>{channelEvents.map((event,index) => <p key={index}>{event.kind} · {event.status || '已持久接收'}{event.code ? ' · '+event.code : ''}</p>)}</div>}
          <OneBotConnectionForm settings={oneBotSettings} draft={oneBotDraft} busy={busy.startsWith('onebot:')} migrationPreview={oneBotMigration} onDraftChange={setOneBotDraft} onSave={() => void saveOneBot()} onAction={action => void manageOneBot(action)} onPreviewMigration={() => void previewOneBotMigration()} onApplyMigration={() => void applyOneBotMigration()} onCancelMigration={() => setOneBotMigration(null)} />
        </section>}
        {selectedIntegration.id === 'cetamesh-bionic-chat' && selectedIntegration.localService && <section><h3>Bionic 社交运行时</h3><BionicReadiness readiness={selectedIntegration.localService.readiness} activity={selectedIntegration.localService.activity}/><p>{selectedIntegration.localService.running ? '运行中' : '已停止'} · QQ 基础传输具有独立生命周期。</p><div className="row detail-actions">{(['health','start','stop','reconnect'] as const).map(action => <Button compact key={action} onClick={() => void pluginClient.integrationAction('bionic', action).then(async result => { setNotice(result.pending ? '操作等待审批' : '状态已更新'); setSelectedIntegration(await pluginClient.integrationSettings('cetamesh-bionic-chat')); await refreshApprovals(); }).catch(cause => setError(messageOf(cause)))}>{action === 'health' ? '健康检查' : action === 'start' ? '启动' : action==='reconnect'?'安全重连':'停止'}</Button>)}</div></section>}
        {selectedIntegration.inventory && <Surface className="bionic-inventory">
          <div className="section-heading"><h3>仿生聊天工具清单</h3><small>按当前 Integration Registry 状态统计</small></div>
          <div className="bionic-inventory-counts">
            <Surface><strong>{selectedIntegration.inventory.restored}</strong><small>已恢复</small></Surface>
            <Surface><strong>{selectedIntegration.inventory.partial}</strong><small>部分恢复</small></Surface>
            <Surface><strong>{selectedIntegration.inventory.legacyUnsupported}</strong><small>不可恢复</small></Surface>
          </div>
        </Surface>}
        <h3>能力与工具</h3>
        {selectedIntegration.tools.length ? selectedIntegration.tools.map(tool => {
          const restoreLabel = tool.restore === 'restored' ? '已恢复' : tool.restore === 'partial' ? '部分恢复'
            : tool.restore === 'deprecated' ? '已弃用' : tool.restore === 'legacy-unsupported' ? '不可恢复' : '状态未识别';
          return <div className="tool-setting-row" key={tool.id}>
            <span className="grow"><strong>{tool.name}</strong><small>{tool.permission || '权限由 Core 控制'} · {restoreLabel}</small>{tool.reason && <small>{tool.reason}</small>}</span>
            <div className="row"><StatusBadge value={tool.enabled ? 'enabled' : 'disabled'} />{tool.enabled && !tool.available && <StatusBadge value="unavailable" />}</div>
            <Button compact disabled={!tool.restorable || busy === `${selectedIntegration.id}:${tool.id}`} title={!tool.restorable ? tool.reason : undefined} onClick={() => void toggleIntegrationTool(selectedIntegration.id, tool)}>{tool.enabled ? '关闭工具' : '开启工具'}</Button>
          </div>;
        }) : <p className="muted">没有公开的工具配置。</p>}
        {selectedIntegration.legacyRetired.length > 0 && <details className="bionic-retired-tools">
          <summary>已退役工具 <span>{selectedIntegration.legacyRetired.length}</span></summary>
          {selectedIntegration.legacyRetired.map(tool => <div className="tool-setting-row" key={tool.id}>
            <span className="grow"><strong>{tool.name}</strong><small>{tool.feature}</small><small>{tool.reason}</small>{tool.replacement && <small>已注册替代项：{tool.replacement.label}</small>}</span>
            <Badge tone={tool.restore === 'deprecated' ? 'default' : 'danger'}>{tool.restore === 'deprecated' ? 'Deprecated' : 'Legacy Unsupported'}</Badge>
          </div>)}
        </details>}
        {selectedIntegration.id !== 'cetamesh-onebot' && <><h3>安全设置</h3>
        {Object.entries(selectedIntegration.settings).length ? Object.entries(selectedIntegration.settings).map(([key, value]) => <div className="tool-setting-row" key={key}><strong>{key}</strong><span>{typeof value === 'boolean' ? value ? '启用' : '停用' : String(value ?? '—')}</span></div>) : <p className="muted">没有可展示的非敏感设置。</p>}</>}
      </div>}
    </Sheet>
    <Sheet open={Boolean(selectedServer)} title={selectedServer?.server.name ?? 'MCP 工具'} onClose={() => {serverRequest.current++;setSelectedServer(null);setBusy(current=>current==='mcp-config'?'':current);}}>{selectedServer && <div className="plugin-detail">{error&&<ErrorNotice error={error}/>} {notice&&<p role="status">{notice}</p>}
      <div className="row between"><p>工具可调用状态来自运行时发现与 Core 权限策略。调用仍由 Capability Broker 审核。</p><Button compact onClick={() => void manageServer(selectedServer.server, 'restart')}>重启</Button></div>
      <Surface className="mcp-settings-card"><div className="row between"><strong>服务器状态</strong><StatusBadge value={mcpRuntimeStatus(selectedServer.server)} /></div><p>传输方式：{selectedServer.server.transport || '未检查'} · {selectedServer.server.source === 'builtin' ? '内置启动配置' : '外部启动配置'}</p><p>{selectedServer.server.source === 'builtin' ? `启动参数覆盖：${selectedServer.config.hasArgs ? '已设置' : '未设置，使用内置入口'} · 环境变量覆盖：${selectedServer.config.hasEnvironment ? '已设置' : '未设置'}` : `启动参数：${selectedServer.config.hasArgs ? '已配置' : '未配置'} · 环境变量：${selectedServer.config.hasEnvironment ? '已配置' : '未配置'}`}</p><p className="muted">凭据和原始环境值不会传入界面。</p><details className="plugin-advanced-settings"><summary>高级连接设置</summary><div className="plugin-advanced-fields"><>{selectedServer.server.transport==='streamable-http'&&<><label>服务地址（HTTPS）<Input disabled={busy==='mcp-config'} value={mcpConfigDraft.url} onChange={e=>setMcpConfigDraft(d=>({...d,url:e.target.value}))}/></label><label>凭据引用（可选）<Input disabled={busy==='mcp-config'} value={mcpConfigDraft.credentialRef} onChange={e=>setMcpConfigDraft(d=>({...d,credentialRef:e.target.value}))}/></label><label>允许的工具名称（逗号分隔）<Input disabled={busy==='mcp-config'} value={mcpConfigDraft.allowedTools} onChange={e=>setMcpConfigDraft(d=>({...d,allowedTools:e.target.value}))}/></label></>}</><label>启动超时（毫秒，留空保持现有值）<Input disabled={busy==='mcp-config'} type="number" min={100} max={300000} value={mcpConfigDraft.timeoutMs} onChange={event => setMcpConfigDraft(current => ({ ...current, timeoutMs: event.target.value }))} /></label><label>备注<Input disabled={busy==='mcp-config'} value={mcpConfigDraft.note} onChange={event => setMcpConfigDraft(current => ({ ...current, note: event.target.value }))} maxLength={500} /></label><Button compact disabled={busy === 'mcp-config'} onClick={() => void saveMcpConfig()}>保存 MCP 设置</Button></div></details></Surface>
      {selectedServer.toolSnapshotStale && <p role="status">服务状态已变化；工具状态需重新读取，请关闭后重新打开详情。</p>}
      <SearchInput label="搜索 MCP 工具" placeholder="搜索工具名称或说明" value={mcpToolQuery} onChange={event=>{setMcpToolQuery(event.target.value);setMcpToolPage(0);}}/>
      <nav className="row between" aria-label="MCP 工具分页"><Button compact disabled={!mcpToolPage} onClick={()=>setMcpToolPage(value=>Math.max(0,value-1))}>上一页</Button><small>第 {mcpToolPage+1} 页 · {selectedServer.tools.filter(tool=>(tool.name+' '+tool.description).toLocaleLowerCase().includes(mcpToolQuery.toLocaleLowerCase())).length} 个工具 · 每页 50</small><Button compact disabled={(mcpToolPage+1)*50>=selectedServer.tools.filter(tool=>(tool.name+' '+tool.description).toLocaleLowerCase().includes(mcpToolQuery.toLocaleLowerCase())).length} onClick={()=>setMcpToolPage(value=>value+1)}>下一页</Button></nav>
      {selectedServer.tools.length ? selectedServer.tools.filter(tool=>(tool.name+' '+tool.description).toLocaleLowerCase().includes(mcpToolQuery.toLocaleLowerCase())).slice(mcpToolPage*50,mcpToolPage*50+50).map(tool => <article className="mcp-tool-row" key={tool.id}><div className="row between"><strong>{tool.name}</strong><StatusBadge value={tool.callable && isMcpCallable(selectedServer.server) ? 'ready' : tool.enabled && tool.discovered ? 'unavailable' : tool.enabled ? 'not-checked' : 'disabled'} /></div><p>{tool.description || '没有描述。'}</p></article>) : <EmptyNotice icon="layers" title="没有发现工具" detail="服务可能尚未启动，或当前没有注册工具。" />}
    </div>}</Sheet>
  </div>;
}
