import { useEffect, useRef, useState } from 'react';
import { agentClient, openExternal, type Agent, type AgentRuntimeProvider, type AgentRuntimeConfiguration, type AgentRuntimeInput, type AgentAuthStatus, type AgentConnectionEvidence, type DshConfiguration, type DshSelection, type DshPresetCatalog } from '../bridge/typed-client';
import { Button, Input, Select } from '../components/primitives/inputs';
import { createAuthPanelController } from './AgentAuthController';
import { ErrorNotice, messageOf, dateLabel, dshSetupReasonLabel } from './PagePresentation';

export function mergeAgentHealth(previous: Agent, health: Agent): Agent {
  return { ...previous, ...health };
}

export function AgentSetupDiagnostic({ agent }: { agent: Agent }) {
  const reason = agent.reason || agent.preset?.reason;
  return <div className="agent-diagnostic">{reason && <small>{dshSetupReasonLabel(reason)}</small>}{agent.preset && <small>编程预设 {agent.preset.id || '未选择'} · {agent.preset.loadState === 'loaded' ? '原生已加载' : agent.preset.loadState === 'not-loaded' ? '原生未加载' : '加载状态未知'} · {agent.preset.compatible === true ? '本地 persona 已验证' : agent.preset.compatible === false ? '本地 persona 不兼容' : '本地 persona 未验证'}</small>}{agent.diagnostic && <details><summary>诊断详情</summary><small>阶段：{agent.diagnostic.stage || '未知'} · 错误码：{agent.diagnostic.code || '无'} · {agent.diagnostic.retryable ? '允许重新检查连接' : '请先处理配置'}{agent.diagnostic.checkedAt ? ` · ${dateLabel(agent.diagnostic.checkedAt)}` : ''}</small></details>}</div>;
}

export function DshSetupForm({ configuration, draft, presets, saving, conflicted = false, onDraftChange, onSave, onRefresh }: {
  configuration: DshConfiguration; draft: DshSelection; presets?: DshPresetCatalog; saving: boolean; conflicted?: boolean;
  onDraftChange(value: DshSelection): void; onSave(): void; onRefresh?(): void;
}) {
  const catalog = presets ?? { state: 'loading', truncated: false, presets: [] };
  const field = (key: keyof DshSelection, label: string, placeholder: string) => <label>{label}<Input aria-label={label} value={draft[key] ?? ''} placeholder={placeholder} disabled={saving} onChange={event => onDraftChange({ ...draft, [key]: event.target.value || null })} /></label>;
  const preset = (key: 'codingPreset' | 'socialPreset', label: string) => <div className="dsh-preset-field"><span>{label}</span><Select label={label} value={draft[key] ?? ''} disabled={saving || catalog.state === 'loading'} onChange={event => onDraftChange({ ...draft, [key]: event.target.value || null })}>
    <option value="">请选择预设</option>
    {draft[key] && !catalog.presets.some(row => row.id === draft[key]) && <option value={draft[key] ?? ''} disabled>{String(draft[key]) + '（未找到或尚未读取）'}</option>}
    {catalog.presets.map(row => <option key={row.id} value={row.id} disabled={!row.compatible}>{row.id + (row.compatible ? '' : '（不兼容）')}</option>)}
  </Select></div>;
  const listingMessage = catalog.state === 'loading' ? '正在读取本机预设…'
    : catalog.state === 'missing' ? '未找到预设目录，可在高级设置中检查 DSH 数据目录。'
    : catalog.state !== 'ready' ? '无法读取本机预设，请检查高级设置中的目录与访问权限。'
    : !catalog.presets.length ? '此目录下没有预设。请先在 DSH 中创建，再刷新列表。'
    : !catalog.presets.some(row => row.compatible) ? '未发现兼容预设；不会自动修改已有文件。请在 DSH 中核对后刷新。'
    : null;
  return <form className="dsh-setup-form" onSubmit={event => { event.preventDefault(); if (!saving && !conflicted) onSave(); }}>
    <h4>DSH 设置</h4><p>从本机预设中选择，无需手填名称或编辑文件。</p>
    {preset('codingPreset', '任务预设')}
    <small>选择后保存；实际可用状态以连接检查为准。</small>
    {listingMessage && <small role="status">{listingMessage}</small>}
    {catalog.presets.some(row => !row.compatible) && <small>部分预设不兼容，已禁用；原因见高级设置。</small>}
    {catalog.truncated && <small>预设数量较多，仅显示本次有界扫描结果。</small>}
    {configuration.restartRequired && <small role="status">配置已保存，重启 Core 后生效；当前连接保持原配置。</small>}
    {configuration.loadError && <p role="alert">连接配置读取失败（{configuration.loadError}），请检查并重新保存。</p>}
    <div className="row"><Button compact type="submit" disabled={saving || conflicted}>{saving ? '保存中…' : '保存配置'}</Button><Button compact type="button" variant="ghost" disabled={saving || catalog.state === 'loading'} onClick={onRefresh}>刷新预设</Button></div>
    <details><summary>高级设置</summary><div className="dsh-advanced-fields">
      {preset('socialPreset', '社交预设')}
      <small>仅用于 QQ 社交，与任务预设分别保存。</small>
      {field('homeDir', 'DSH 数据目录', '留空使用自动检测目录')}{field('baseUrl', 'DSH 服务地址', 'http://127.0.0.1:3080')}
      <details><summary>诊断信息</summary>{catalog.presets.filter(row => !row.compatible).map(row => <small key={row.id}>{row.id}：{row.reason === 'persona-prefix-required' ? '旧预设缺少 persona prefix' : '本地格式或文件校验未通过'}</small>)}
        <small>当前生效版本 {configuration.activeRevision} · 编程预设：{configuration.active.codingPreset || '未选择'} · 社交：{configuration.active.socialPreset || '未选择'}</small>
        {configuration.restartRequired && <small>待生效版本 {configuration.pendingRevision} · 编程：{configuration.pending?.codingPreset || '未选择'} · 社交：{configuration.pending?.socialPreset || '未选择'}。重启 Core 后生效。</small>}
        <small>配置来源：{configuration.source} · 目录来源：{configuration.homeSource}</small><small>配置文件：{configuration.configFile || '未知'}</small>{configuration.pendingConfigFile && <small>待生效配置文件：{configuration.pendingConfigFile}</small>}<small>数据根：{configuration.dataRoot || '未知'}</small>
      </details>
    </div></details>
  </form>;
}

export function dshSetupErrorMessage(cause: unknown): string {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  const message = ({
    DSH_AUTH_SCOPE_CHANGE_REQUIRES_REVIEW: '服务地址或目录变更涉及已有认证范围，请先核对 DSH 凭据归属，再单独处理连接范围。',
    DSH_PRESET_INCOMPATIBLE: '预设校验未通过，请检查编程与社交预设的文件、格式和 persona 内容后保存。',
    CONFIGURATION_UNSUPPORTED: '当前 Core 无法保存 DSH 配置，请检查本机数据目录。',
    INVALID_PARAMS: '配置字段无效，请检查预设名称、绝对目录路径与服务地址。',
    WRITE_FAILED: '无法写入连接配置，请检查数据目录的写入权限。'
  } as Record<string, string>)[code];
  return message ? `${message}${code ? `（${code}）` : ''}` : messageOf(cause);
}

export function DshSetupPanel({ agent, onConfigured }: { agent: Agent; onConfigured(configuration: DshConfiguration): void }) {
  const configuration = agent.configuration;
  const [draft, setDraft] = useState<DshSelection>(() => configuration?.pending ?? configuration?.active ?? { codingPreset: null, socialPreset: null, homeDir: null, baseUrl: null });
  const [presets, setPresets] = useState<DshPresetCatalog>({state:'loading',truncated:false,presets:[]});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setPresets({state:'loading',truncated:false,presets:[]});
    const timer=window.setTimeout(() => {
      void agentClient.presets(draft.homeDir).then(value => { if(active) setPresets(value); })
        .catch(() => { if(active) setPresets({state:'error',truncated:false,presets:[]}); });
    },250);
    return () => { active=false; window.clearTimeout(timer); };
  },[draft.homeDir,refresh]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const dirty = useRef(false), mounted = useRef(0), savingRef = useRef(false);
  const currentConfiguration = useRef(configuration); currentConfiguration.current = configuration;
  useEffect(() => { ++mounted.current; return () => { ++mounted.current; }; }, [agent.id]);
  useEffect(() => { if (configuration) { if (dirty.current) setConflicted(true); else setDraft(configuration.pending ?? configuration.active); } }, [configuration?.revision, configuration?.activeRevision]);
  async function save() {
    if (savingRef.current || conflicted) return;
    savingRef.current = true; const epoch = mounted.current, revision = configuration?.revision, activeRevision = configuration?.activeRevision;
    setSaving(true); setError('');
    try {
      const result = await agentClient.configure(draft);
      if (epoch === mounted.current) {
        const current = currentConfiguration.current;
        if (current && (current.revision !== revision || current.activeRevision !== activeRevision)) {
          setConflicted(true); setError('保存期间配置已变化，请核对最新配置。');
          onConfigured(current.revision > result.configuration.revision ? current : result.configuration);
        } else { dirty.current = false; setConflicted(false); onConfigured(result.configuration); }
      }
    }
    catch (cause) { if (epoch === mounted.current) setError(dshSetupErrorMessage(cause)); }
    finally { if (epoch === mounted.current) { savingRef.current = false; setSaving(false); } }
  }
  return configuration ? <><DshSetupForm configuration={configuration} draft={draft} presets={presets} onRefresh={() => setRefresh(value => value + 1)} saving={saving} conflicted={conflicted} onDraftChange={value => { dirty.current = true; setDraft(value); }} onSave={() => void save()} />{conflicted && <div role="status">配置已变化，当前草稿仍保留；重新载入将替换当前草稿。 <Button compact type="button" disabled={saving} onClick={() => { dirty.current = false; setDraft(configuration.pending ?? configuration.active); setConflicted(false); setError(''); }}>放弃草稿并载入配置</Button></div>}{error && <ErrorNotice error={error} />}</> : <small>尚未取得连接配置，请检查连接。</small>;
}

type AgentRuntimeDraft = Required<Pick<AgentRuntimeInput, 'enabled' | 'runtimePath' | 'nodePath' | 'model' | 'baseUrl' | 'apiKey'>> & Pick<AgentRuntimeInput, 'authMode' | 'servicePreset' | 'providerId' | 'methodId'>;
export function isRuntimeProvider(provider: string): provider is AgentRuntimeProvider { return ['gemini', 'opencode', 'qwen', 'claude'].includes(provider); }
export function agentNeedsSetup(agent: Pick<Agent, 'id' | 'status' | 'reason' | 'eligible' | 'taskEligible' | 'runtimeConfiguration'>): boolean {
  if (isAgentReady(agent) || agent.runtimeConfiguration?.enabled === false || ['disabled', 'provider_disabled', 'runtime_disabled'].includes(agent.reason?.trim().toLowerCase() ?? '')) return false;
  return agent.status === 'needs-setup' || agent.status === 'connection-pending' || isRuntimeProvider(agent.id);
}
export function AgentRuntimeAuthenticationNotice({ agent }: { agent: Agent }) {
  if (!isRuntimeProvider(agent.id) || agent.runtimeConfiguration?.authMode === 'provider-login' || agent.runtimeConfiguration?.credentialConfigured !== true || (agent.authVerified !== false && agent.authentication !== 'configured-unverified')) return null;
  return <small role="status">运行时就绪后，API 认证将在实际任务中验证。</small>;
}
export function AgentRuntimeSetupGuide({ provider, onOpen }: { provider: AgentRuntimeProvider; onOpen(url: string): void }) {
  const documentation = {
    gemini: { name: 'Gemini CLI', url: 'https://geminicli.com/docs/get-started/installation/' },
    qwen: { name: 'Qwen Code', url: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/' },
    claude: { name: 'Claude Code', url: 'https://code.claude.com/docs/en/setup' }
  };
  if (provider === 'opencode') return <small>优先自动发现 OpenCode 安装包中的编码运行时；已包含时无需另装 CLI。</small>;
  const doc = documentation[provider];
  return <div className="dsh-setup-form"><small>本连接使用 {doc.name} 编码运行时；桌面客户端已安装不代表编码 CLI 已就绪。</small><Button compact type="button" variant="ghost" title={doc.url} onClick={() => onOpen(doc.url)}>{doc.name} 官方安装文档</Button></div>;
}
function runtimeDraft(configuration: AgentRuntimeConfiguration): AgentRuntimeDraft {
  return { enabled: configuration.enabled, runtimePath: configuration.runtimePath, nodePath: configuration.nodePath, model: configuration.model, baseUrl: configuration.baseUrl, apiKey: '', authMode: configuration.authMode ?? 'api-key', servicePreset: configuration.servicePreset ?? 'custom', providerId: configuration.providerId ?? null, methodId: configuration.methodId ?? null };
}
export function AgentConnectionSteps({ agent }: { agent: Agent }) {
  if (!isRuntimeProvider(agent.id)) return null;
  const evidence = agent.connection;
  return <dl className="agent-connection-steps">
    <div><dt>安装</dt><dd>{agent.cliInstalled === true || evidence?.runtime.installed === true ? '编码 CLI 已发现' : agent.cliInstalled === false || evidence?.runtime.installed === false ? '未发现编码 CLI' : '编码 CLI 尚未检查'}</dd></div>
    <div><dt>协议</dt><dd>{evidence?.runtime.protocolVerified ? '协议已验证' : '尚未验证'}</dd></div>
    <div><dt>认证</dt><dd>{evidence?.authentication.state === 'session-present' ? '已有专用登录会话（未验证模型访问）' : evidence?.authentication.state === 'configured-unverified' ? 'API 凭据已保存，未验证' : '尚未配置 / 未验证'}</dd></div>
    <div><dt>任务执行</dt><dd>{evidence?.execution.eligible && agent.taskEligible === true && isAgentReady(agent) ? '需工作区授权及逐次工具审批' : '策略或连接条件尚未满足'}</dd></div>
  </dl>;
}
export function AgentRuntimeSetupForm({ provider, configuration, draft, saving, conflicted = false, connection, auth, onDraftChange, onSave, onRefresh, onLogin, onCancel }: {
  provider: AgentRuntimeProvider; configuration: AgentRuntimeConfiguration; draft: AgentRuntimeDraft; saving: boolean; conflicted?: boolean;
  connection?: AgentConnectionEvidence | null; auth?: AgentAuthStatus | null;
  onDraftChange(value: AgentRuntimeDraft): void; onSave(): void; onRefresh(): void; onLogin?(methodId: string): void; onCancel?(): void;
}) {
  const account = draft.authMode === 'provider-login';
  const modelRequired = provider !== 'claude' || connection?.modelRequired !== false;
  const active = auth && ['starting', 'awaiting-user', 'exit-unconfirmed'].includes(auth.state);
  const locked = saving || Boolean(active);
  const field = (key: 'runtimePath' | 'nodePath' | 'model' | 'baseUrl', label: string, placeholder: string, maxLength: number) => <label>{label}<Input aria-label={label} value={draft[key]} placeholder={placeholder} maxLength={maxLength} required={key === 'model' && modelRequired && draft.enabled} disabled={locked} onChange={event => onDraftChange({ ...draft, [key]: event.target.value, ...(key === 'baseUrl' ? { servicePreset: 'custom', apiKey: '' } : {}) })} /></label>;
  const supported = connection?.methods.find(method => method.id !== 'api-key' && method.supported && (provider !== 'opencode' || method.id === draft.methodId));
  return <form className="dsh-setup-form" onSubmit={event => { event.preventDefault(); if (!locked && !conflicted) onSave(); }}>
    <label><Input type="checkbox" checked={draft.enabled} disabled={locked} onChange={event => onDraftChange({ ...draft, enabled: event.target.checked })} /> 启用此连接</label>
    {provider === 'qwen' ? <small>Qwen Code 仅支持 API；旧账号 OAuth 已停用。</small> : <label>认证方式<Select label="认证方式" value={draft.authMode ?? 'api-key'} disabled={locked} onChange={event => onDraftChange({ ...draft, authMode: event.target.value as 'api-key' | 'provider-login', apiKey: '', providerId: null, methodId: null })}><option value="api-key">API Key</option><option value="provider-login">服务商官方账号（待原生验证）</option></Select></label>}
    {!account && Boolean(connection?.servicePresets?.length) && <label>API 服务<Select label="API 服务" value={draft.servicePreset ?? 'custom'} disabled={locked} onChange={event => { const preset = connection?.servicePresets?.find(item => item.id === event.target.value); if (preset) onDraftChange({ ...draft, servicePreset: preset.id, baseUrl: preset.baseUrl ?? draft.baseUrl, apiKey: '' }); }}>{connection?.servicePresets?.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</Select></label>}
    {account && provider === 'opencode' && <label>模型服务的官方登录<Select label="模型服务的官方登录" disabled={locked} value={draft.methodId ?? ''} onChange={event => { const item = connection?.providerSelections?.find(item => item.methodId === event.target.value); onDraftChange({ ...draft, providerId: item?.providerId ?? null, methodId: item?.methodId ?? null }); }}><option value="">选择服务及方式（均待验证）</option>{connection?.providerSelections?.map(item => <option key={item.methodId} value={item.methodId}>{item.label}</option>)}</Select></label>}
    {(!account || provider === 'opencode') && field('model', modelRequired ? '模型（必填）' : '模型（可选）', modelRequired ? '填写服务支持的准确模型 ID' : '留空使用已验证的 Claude 默认模型', 256)}
    {!account && <><label>API Key<Input aria-label="API Key" type="password" value={draft.apiKey} autoComplete="new-password" maxLength={512} placeholder={configuration.credentialConfigured ? '留空保留已保存凭据' : '输入此 Agent 使用的 API Key'} disabled={locked} onChange={event => onDraftChange({ ...draft, apiKey: event.target.value })} /></label><small>{configuration.credentialConfigured ? '凭据已保存；留空保留已保存凭据。' : '尚未保存此 Agent 的凭据。'} 更换服务或端点须重新输入 Key；保存后清空输入框。</small></>}
    {account && <><small>在 CetaMesh 专用配置中使用服务商官方登录，不复制现有账号目录。服务商可能打开系统默认浏览器；这不是独立浏览器账号。不会自动调用付费模型。</small>{supported ? <Button type="button" disabled={locked || configuration.authMode !== 'provider-login' || draft.methodId !== configuration.methodId} onClick={() => onLogin?.(draft.methodId ?? supported.id)}>开始官方登录</Button> : <small role="status">官方登录暂未启用：需要 Windows 原生进程、私有存储与审批策略验证。可切回 API 配置。</small>}{provider === 'gemini' && <small>Gemini 0.65.0 没有可用于被动检查的账号状态接口，且缺少完整工具输入证明；登录也不会开放任务执行。</small>}{provider === 'claude' && <small>仅计划支持 Claude 订阅登录，不支持 Console 无 Key 登录；SDK 第三方使用资格文档存在差异，需发行前复核。</small>}</>}
    {active && <div role="status">{auth.state === 'exit-unconfirmed' ? '进程退出尚未确认；连接仍被占用。' : '等待服务商完成登录。'}<Button type="button" variant="ghost" onClick={onCancel}>取消登录</Button></div>}
    {auth && !active && <small role="status">{{'no-session':'尚无专用登录会话',unsupported:'此账号方式不受支持',starting:'正在启动', 'awaiting-user':'等待用户', 'session-present':'专用会话已保存；不代表模型访问已验证',cancelled:'登录已取消',failed:'登录失败；可重试',expired:'登录已超时；可重试','exit-unconfirmed':'退出未确认'}[auth.state]}</small>}
    <details><summary>高级设置</summary>{field('runtimePath', '运行时路径', '留空自动发现；填写官方编码运行时的绝对路径', 4096)}{field('nodePath', '独立 Node 路径', 'npm 运行时可填写独立 node.exe 的绝对路径', 4096)}{!account && field('baseUrl', 'API 端点', 'https://…', 2048)}</details>
    <small>使用原生权限模式；工作区授权与逐次审批另行确认。保存配置不等于连接成功。</small>
    <div className="row"><Button compact type="submit" disabled={locked || conflicted}>{saving ? '保存中…' : '保存配置'}</Button><Button compact type="button" variant="ghost" disabled={saving} onClick={onRefresh}>刷新连接</Button></div>
  </form>;
}
function AgentRuntimeSetupPanel({ agent, onConfigured, onRefresh }: { agent: Agent; onConfigured(configuration: AgentRuntimeConfiguration): void; onRefresh(): void }) {
  const configuration = agent.runtimeConfiguration;
  const [draft, setDraft] = useState<AgentRuntimeDraft>(() => configuration ? runtimeDraft(configuration) : { enabled: true, runtimePath: '', nodePath: '', model: '', baseUrl: '', apiKey: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [auth, setAuth] = useState<AgentAuthStatus | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const authController = useRef<ReturnType<typeof createAuthPanelController> | null>(null);
  const mountedRevision = useRef(0), savingRef = useRef(false), dirty = useRef(false);
  const currentConfiguration = useRef(configuration); currentConfiguration.current = configuration;
  useEffect(() => { ++mountedRevision.current; return () => { ++mountedRevision.current; }; }, [agent.id]);
  useEffect(() => {
    if (!isRuntimeProvider(agent.id) || !configuration) return;
    let updates = 0, active = true;
    setAuth(null);
    const controller = createAuthPanelController({ provider: agent.id, revision: configuration.revision, client: agentClient, onUpdate: value => { updates++; setAuth(value); } });
    authController.current = controller;
    void agentClient.authDescribe(agent.id).then(value => { if (active && updates === 0) controller.adopt(value); }).catch(() => {});
    return () => { active = false; controller.dispose(); authController.current = null; };
  }, [agent.id, configuration?.revision]);
  useEffect(() => {
    if (!auth || !['starting', 'awaiting-user', 'exit-unconfirmed'].includes(auth.state)) return;
    const timer = window.setInterval(() => { void authController.current?.status().catch(() => {}); }, 1500);
    return () => window.clearInterval(timer);
  }, [auth]);
  useEffect(() => { if (configuration) { if (dirty.current) setConflicted(true); else setDraft(runtimeDraft(configuration)); } }, [configuration?.provider, configuration?.revision]);
  async function save() {
    if (!isRuntimeProvider(agent.id) || savingRef.current || conflicted) return;
    savingRef.current = true; const epoch = mountedRevision.current, revision = configuration?.revision;
    setSaving(true); setError(''); setNotice('');
    let clearCredential = false;
    try {
      const result = await agentClient.configureRuntime(agent.id, { ...draft, executionMode: 'native-permissions' });
      if (epoch === mountedRevision.current) {
        clearCredential = true;
        const current = currentConfiguration.current;
        if (current && current.revision !== revision) {
          setConflicted(true); setError('保存期间配置已变化，请核对最新配置。');
          onConfigured(current.revision > result.revision ? current : result);
        } else {
          dirty.current = false; setConflicted(false); onConfigured(result); setNotice('配置已保存，请刷新连接查看验证结果。');
        }
      }
    }
    catch (cause) { if (epoch === mountedRevision.current) { clearCredential = (cause as { code?: string })?.code === 'AGENT_RUNTIME_CREDENTIAL_SCOPE_MISMATCH'; setError(clearCredential ? '服务或端点已更改，请核对后重新输入对应 API Key。' : messageOf(cause)); } }
    finally { if (epoch === mountedRevision.current) { savingRef.current = false; if (clearCredential) setDraft(current => ({ ...current, apiKey: '' })); setSaving(false); } }
  }
  return isRuntimeProvider(agent.id) ? <><AgentRuntimeSetupGuide provider={agent.id} onOpen={url => { setError(''); void openExternal(url).catch(cause => setError(messageOf(cause))); }} />{configuration ? <AgentRuntimeSetupForm provider={agent.id} configuration={configuration} draft={draft} saving={saving} conflicted={conflicted} connection={agent.connection} auth={auth} onLogin={method => { void authController.current?.start(method).catch(cause => setError(messageOf(cause))); }} onCancel={() => { void authController.current?.cancel().catch(cause => setError(messageOf(cause))); }} onDraftChange={value => { dirty.current = true; setDraft(value); }} onSave={() => void save()} onRefresh={onRefresh} /> : <small>尚未取得运行时配置，请刷新连接。</small>}{conflicted && configuration && <div role="status">配置已变化，当前草稿仍保留；重新载入将替换当前草稿。 <Button compact type="button" disabled={saving} onClick={() => { dirty.current = false; setDraft(runtimeDraft(configuration)); setConflicted(false); setNotice(''); setError(''); }}>放弃草稿并载入配置</Button></div>}{notice && <small role="status">{notice}</small>}{error && <ErrorNotice error={error} />}</> : null;
}

export function AgentRuntimeSetupDisclosure(props: { agent: Agent; onConfigured(configuration: AgentRuntimeConfiguration): void; onRefresh(): void }) {
  const [open, setOpen] = useState(false);
  return <details className="agent-setup-disclosure" onToggle={event => setOpen(event.currentTarget.open)}><summary>连接设置</summary>{open && <AgentRuntimeSetupPanel {...props} />}</details>;
}

export function isAgentReady(agent: Pick<Agent, 'eligible' | 'taskEligible'> & Partial<Pick<Agent, 'status' | 'reason' | 'probeCode' | 'diagnostic'>>) {
  const failedCheck = [agent.reason, agent.probeCode, agent.diagnostic?.code].some(value => value?.trim().toUpperCase() === 'CHECK_FAILED');
  return !failedCheck && (!agent.status || agent.status === 'ready') && (agent.eligible === true || agent.taskEligible === true);
}

export function CodexSetupDiagnostic({ agent }: { agent: Agent }) {
  const code = agent.probeCode;
  const action = code === 'NODE_RUNTIME_UNAVAILABLE' ? 'npm CLI 需要独立 Node；可改用原生 Codex CLI。'
    : code === 'UNSUPPORTED_WINDOWS_SHIM' ? '无法安全解析此启动脚本；请使用原生 CLI 或受支持的 npm 安装。'
    : code === 'CODEX_CLI_PATH_INVALID' ? '请检查明确配置的 CODEX_CLI_PATH：需要存在且可运行的绝对 exe 路径。'
    : agent.installed === false ? '未找到可调用的 Codex CLI；Desktop App / IDE 插件安装状态不代表 CLI 已安装。'
    : agent.installed == null ? 'Codex CLI 安装状态尚未验证，请检查连接。'
    : agent.compatible === false ? '已检测到 CLI，但版本或 exec 协议不兼容；请检查 CLI 版本。'
    : agent.authenticated === false ? 'Codex CLI 已安装，请在 CLI 完成登录后检查连接。'
    : agent.sandboxCapable === false ? 'Windows Sandbox 无法执行所需隔离；任务已阻止，不会无沙箱运行。'
    : agent.taskEligible && isAgentReady(agent) ? 'Codex CLI 已就绪 · 仅工作区任务。' : '请检查 CLI 的连接与任务条件。';
  return <div className="agent-setup-diagnostic"><strong>Codex CLI</strong><p>{action}</p><small>安装：{agent.installed === true ? '已检测' : agent.installed === false ? '未检测' : '未知'} · 协议：{agent.compatible ? '兼容' : '未验证或不兼容'} · 登录：{agent.authenticated ? '已认证' : '未验证或未登录'} · Sandbox：{agent.sandboxCapable === true ? '已验证' : agent.sandboxCapable === false ? '不可用' : '待首次明确选择的任务验证'}</small>{code && <small role="status">{agent.probePhase} · {code}</small>}</div>;
}

export function AgentInstallationDiagnostic({ agent }: { agent: Agent }) {
  if (!agent.desktopApp) return null;
  if (agent.id === 'dsh') return <div className="agent-desktop-state"><strong>DeepSeek Harness Desktop</strong><span>桌面应用：{agent.desktopApp.installed === true ? '已安装' : agent.desktopApp.installed === false ? '未检测到' : '安装状态未知'} · {agent.desktopApp.running === true ? '运行中' : agent.desktopApp.running === false ? '未运行' : '运行状态未知'}</span><span>DSH Agent Provider：{agent.available === true && agent.reason !== 'CHECK_FAILED' ? '已连接' : agent.available === false ? '未连接' : '连接状态未知'}</span></div>;
  const installed = agent.desktopApp.installed;
  return <div className="agent-desktop-state"><strong>{agent.desktopApp.displayName || agent.name} 桌面客户端</strong><span>桌面客户端：{installed === true ? '已安装' : installed === false ? '未检测到' : '检测结果未知'}{agent.desktopApp.version ? ' · ' + agent.desktopApp.version : ''}</span><span>CLI：{agent.cliInstalled === true ? '已检测到' : agent.cliInstalled === false ? '未检测到' : '检测结果未知'} · Agent 连接：{isAgentReady(agent) ? '已就绪' : '待验证'}</span></div>;
}
