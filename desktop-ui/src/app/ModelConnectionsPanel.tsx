import { useEffect, useRef, useState } from 'react';
import { modelConfigurationClient, type ModelConfigurationClient, type ModelConfigurationConnection, type ModelConfigurationDiscovery,
  type ModelConfigurationModel, type ModelConfigurationState, type ModelConnectionEditInput, type ModelManualCapabilities, type ModelReasoningEffort } from '../bridge/typed-client';
import { Button, Input } from '../components/primitives/inputs';
import { Badge, Surface } from '../components/primitives/surfaces';
import { ModelConnectionForm, modelConfigurationError } from './ModelConnectionForm';

export interface ModelConnectionsPanelProps {
  client?: ModelConfigurationClient; heading?: string;
  onConfigured?: (state: ModelConfigurationState) => void;
}
const efforts: { value: ModelReasoningEffort; label: string }[] = [
  { value: 'off', label: '关闭' }, { value: 'low', label: '较低' }, { value: 'high', label: '较高' }, { value: 'max', label: '最高' }
];
const booleanCapabilities = [{ key: 'tools', label: '工具调用' }, { key: 'vision', label: '图像理解' }, { key: 'reasoning', label: '思考' }, { key: 'streaming', label: '流式输出' }] as const;
const tokenCapabilities = [{ key: 'contextWindowTokens', label: '上下文 token 上限' }, { key: 'maxOutputTokens', label: '最大输出 token' }, { key: 'defaultOutputTokens', label: '默认输出 token' }] as const;
const sourceLabels = { manual: '手动声明（未验证）', 'protocol-declared': '服务协议声明（未验证）', 'rule-inferred': '适配规则推断（未验证）', unknown: '未知' };
const wrappingRow = { flexWrap: 'wrap' as const };

function ModelRow({ row, connection, state, busy, onEdit, onDefault }: {
  row: ModelConfigurationModel; connection: ModelConfigurationConnection; state: ModelConfigurationState; busy: boolean;
  onEdit: (patch: ModelConnectionEditInput['patch']) => void; onDefault: (id: string) => void;
}) {
  const [manual, setManual] = useState<ModelManualCapabilities>({ ...row.manualCapabilities });
  const preference = state.modelPreferences.find(entry => entry.connectionId === connection.id && entry.modelId === row.id);
  const [effort, setEffort] = useState<ModelReasoningEffort | ''>(preference?.reasoningEffort ?? '');
  useEffect(() => { setEffort(preference?.reasoningEffort ?? ''); }, [preference?.reasoningEffort]);
  const reasoningLevels = row.reasoning?.status === 'declared' ? row.reasoning.levels : [];
  const canReason = reasoningLevels.length > 0;
  const preferredUnknown = !preference && state.preferencesNextOffset !== null;
  const defaultSelected = state.defaults.provider === connection.id && state.defaults.model === row.id;
  return <Surface className="stack" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <div className="row between" style={wrappingRow}>
      <strong style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{row.id}</strong>
      <div className="row" style={wrappingRow}>
        <Badge>{row.enabled ? '已启用' : '已停用'}</Badge>{defaultSelected && <Badge>全局默认</Badge>}
        <Button compact type="button" aria-label={`${row.enabled ? '停用' : '启用'}模型 ${row.id}`} disabled={busy} onClick={() => onEdit({ modelChanges: [{ id: row.id, enabled: !row.enabled }] })}>{row.enabled ? '停用' : '启用'}</Button>
        <Button compact type="button" aria-label={`设为默认模型 ${row.id}`} disabled={busy || !connection.enabled || !connection.configured || !row.enabled || defaultSelected} onClick={() => onDefault(row.id)}>设为默认</Button>
      </div>
    </div>
    <details data-model-id={row.id}>
      <summary>能力与思考设置</summary>
      <div className="stack" style={{ paddingTop: 12 }}>
        <p className="muted">自动信息与手动声明分别保留。手动声明不会成为已验证的能力；留空移除该手动覆盖。</p>
        {[...booleanCapabilities, ...tokenCapabilities].map(({ key, label }) => {
          const fact = row.capabilities[key];
          return <div key={key} style={{ minWidth: 0 }}>
            <p>{label}：{fact?.value === null || fact?.value === undefined ? '未知' : typeof fact.value === 'boolean' ? fact.value ? '支持' : '不支持' : fact.value.toLocaleString()} · {sourceLabels[fact?.source ?? 'unknown']}
              {fact?.ruleId && <small> · {fact.ruleId}</small>}{fact?.version && <small> · {fact.version}</small>}</p>
            {'tools vision reasoning streaming'.split(' ').includes(key)
              ? <label>手动{label}<select className="cm-input" aria-label={`${row.id} 手动${label}`} disabled={busy} value={manual[key] === undefined ? '' : String(manual[key])} onChange={event => {
                const edited = { ...manual }; if (event.target.value === '') delete edited[key]; else Object.assign(edited, { [key]: event.target.value === 'true' }); setManual(edited);
              }}><option value="">沿用自动信息</option><option value="true">声明支持（未验证）</option><option value="false">声明不支持</option></select></label>
              : <label>手动{label}<Input type="number" min={1} max={100000000} step={1} aria-label={`${row.id} 手动${label}`} disabled={busy} value={manual[key] === undefined ? '' : String(manual[key])} onChange={event => {
                const edited = { ...manual }; if (event.target.value === '') delete edited[key]; else Object.assign(edited, { [key]: Number(event.target.value) }); setManual(edited);
              }} /></label>}
          </div>;
        })}
        <Button compact type="button" aria-label={`保存能力 ${row.id}`} disabled={busy} onClick={() => onEdit({ modelChanges: [{ id: row.id, manualCapabilities: manual }] })}>保存手动能力</Button>
        <label>此模型的思考设置<select className="cm-input" aria-label={`${row.id} 模型思考设置`} value={effort} disabled={busy || !canReason} onChange={event => setEffort(event.target.value as ModelReasoningEffort)}>
          <option value="" disabled={!!preference}>{preferredUnknown ? '尚未载入偏好；选择后明确覆盖' : `未设置单独偏好时跟随全局（${efforts.find(entry => entry.value === state.defaults.reasoningEffort)?.label ?? '未知'}）`}</option>
          {efforts.filter(entry => reasoningLevels.includes(entry.value)).map(entry => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
        </select></label>
        {!canReason && <small>此连接当前未启用可发送的思考参数。兼容服务需要明确允许；可核对服务文档后，将本模型的“手动思考”设为支持并保存。协议声明本身不会打开参数开关。</small>}
        {canReason && <small>有效参数等级来自现有适配器：{row.reasoning.source ?? '来源未知'}。声明与实际推理验证分别保留。</small>}
        <Button compact type="button" aria-label={`保存思考设置 ${row.id}`} disabled={busy || !effort || !reasoningLevels.includes(effort)} onClick={() => { if (effort && reasoningLevels.includes(effort)) onEdit({ preferences: [{ modelId: row.id, reasoningEffort: effort }] }); }}>保存此模型思考设置</Button>
      </div>
    </details>
  </Surface>;
}

export function ModelConnectionsPanel({ client = modelConfigurationClient, onConfigured, heading = '模型连接' }: ModelConnectionsPanelProps) {
  const [state, setState] = useState<ModelConfigurationState | null>(null);
  const [selectedId, setSelectedId] = useState(''), [offset, setOffset] = useState(0);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [form, setForm] = useState<'new' | 'edit' | null>(null), [discovery, setDiscovery] = useState<ModelConfigurationDiscovery | null>(null);
  const [globalEffort, setGlobalEffort] = useState<ModelReasoningEffort>('off'), [manualId, setManualId] = useState('');
  const inFlight = useRef(false), generation = useRef(0);
  async function load(id = selectedId, pageOffset = offset) {
    const currentGeneration = ++generation.current;
    const summary = await client.get({ modelLimit: 1 });
    const chosen = summary.connections.find(row => row.id === id)?.id
      ?? summary.connections.find(row => row.configured)?.id ?? summary.connections[0]?.id ?? '';
    const detail = chosen ? await client.get({ connectionId: chosen, modelOffset: pageOffset, modelLimit: 50 }) : summary;
    if (detail.revision !== summary.revision) throw Object.assign(new Error('Changed while reading'), { code: 'SETTINGS_CONFLICT' });
    const projected = { ...detail, connections: summary.connections.map(row => row.id === chosen ? detail.connections[0] : row) };
    if (currentGeneration === generation.current) {
      setState(projected); setSelectedId(chosen); setOffset(pageOffset); setGlobalEffort(projected.defaults.reasoningEffort); setDiscovery(null);
    }
    return projected;
  }
  async function run<T,>(action: () => Promise<T>, refresh?: { id?: string; offset?: number }) {
    if (inFlight.current) throw Object.assign(new Error('Busy'), { code: 'MODEL_EDIT_BUSY' });
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try { const result = await action(); if (refresh) await load(refresh.id, refresh.offset); return result; }
    catch (reason) { setError(modelConfigurationError(reason)); throw reason; }
    finally { inFlight.current = false; setBusy(false); }
  }
  const invoke = (action: () => Promise<unknown>, refresh?: { id?: string; offset?: number }) => { void run(action, refresh).catch(() => {}); };
  useEffect(() => {
    // StrictMode replays mount effects. Initial reads may overlap, but only the
    // current generation can publish; the mutation lock must not suppress them.
    let cancelled = false;
    setBusy(true); setError('');
    void load('', 0).catch(reason => { if (!cancelled) setError(modelConfigurationError(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; generation.current++; };
  }, [client]);
  const connection = state?.connections.find(row => row.id === selectedId);
  const models = (connection?.models ?? []).filter(row => row.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'enabled') === row.enabled));
  function edit(patch: ModelConnectionEditInput['patch']) {
    if (state && connection) invoke(() => client.edit({ expectedRevision: state.revision, connectionId: connection.id, patch }), { id: connection.id, offset });
  }
  const definitelyAllDisabled = state && state.connections.every(row => !row.enabled || row.modelCount === row.models.length && row.models.every(model => !model.enabled));
  return <section className="stack" aria-label={heading} style={{ minWidth: 0, width: '100%', overflowWrap: 'anywhere' }}>
    <div className="row between" style={wrappingRow}><h2>{heading}</h2><div className="row" style={wrappingRow}>
      <Button compact type="button" disabled={busy} onClick={() => invoke(() => load(selectedId, offset))}>刷新模型配置</Button>
      <Button compact type="button" variant="primary" disabled={busy || !state} onClick={() => { setForm('new'); setError(''); }}>添加模型连接</Button>
    </div></div>
    <p className="muted">每个连接独立保存服务凭据和模型。模型目录与外部 Agent 的模型选择分别管理。</p>
    {error && <p className="message-error" role="alert">{error}</p>}
    {busy && <p role="status">正在读取或保存模型配置…</p>}{notice && <p role="status">{notice}</p>}
    {!state && !busy && !error && <p>还没有读取到模型配置。</p>}
    {state && <>
      {definitelyAllDisabled && <p role="status">尚无启用的模型。可在下方启用连接与模型，或添加连接继续配置。</p>}
      <div className="stack" aria-label="已保存的模型连接">
        {state.connections.map(row => <div key={row.id} className="row between" style={wrappingRow}>
          <div style={{ minWidth: 0 }}><strong>{row.label}</strong> <small>{row.id}</small><div className="row" style={wrappingRow}><Badge>{row.enabled ? '连接已启用' : '连接已停用'}</Badge><Badge>{row.configured ? '凭据已保存' : '尚未配置凭据'}</Badge><small>{row.modelCount} 个模型</small></div></div>
          <Button compact type="button" aria-label={`管理连接 ${row.id}`} aria-pressed={row.id === selectedId} disabled={busy} onClick={() => { setForm(null); setQuery(''); setFilter('all'); invoke(() => load(row.id, 0)); }}>管理模型</Button>
        </div>)}
      </div>
      {form && <Surface><ModelConnectionForm key={form === 'new' ? 'new' : selectedId} connection={form === 'edit' ? connection : null} expectedRevision={state.revision} busy={busy}
        onCancel={() => setForm(null)} onCommit={async input => {
          const saved = await run(() => client.commit(input), { id: input.connection.id, offset: 0 });
          setForm(null); setQuery(''); setNotice('连接已测试并保存；请审核后启用需要的模型。'); onConfigured?.(saved); return saved;
        }} /></Surface>}
      <Surface className="stack">
        <p>全局默认：{state.connections.find(row => row.id === state.defaults.provider)?.label ?? state.defaults.provider} · {state.defaults.model || '尚未选择模型'}</p>
        <small>在启用的模型旁点击“设为默认”。每个模型可单独保存思考偏好。</small>
        <label>全局思考强度<select className="cm-input" aria-label="全局思考强度" value={globalEffort} disabled={busy} onChange={event => setGlobalEffort(event.target.value as ModelReasoningEffort)}>{efforts.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
        <Button compact type="button" disabled={busy} onClick={() => invoke(() => client.update({ expectedRevision: state.revision, defaults: { reasoningEffort: globalEffort } }), { id: selectedId, offset })}>保存全局思考设置</Button>
      </Surface>
      {connection && <>
        <div className="row between" style={wrappingRow}><h3>{connection.label} 的模型</h3><div className="row" style={wrappingRow}>
          <Button compact type="button" aria-label={`${connection.enabled ? '停用' : '启用'}连接 ${connection.id}`} disabled={busy} onClick={() => edit({ enabled: !connection.enabled })}>{connection.enabled ? '停用连接' : '启用连接'}</Button>
          <Button compact type="button" disabled={busy} onClick={() => { setForm('edit'); setError(''); }}>编辑连接</Button>
          <Button compact type="button" disabled={busy || !connection.configured} onClick={() => invoke(async () => {
            const found = await client.discover({ connectionId: connection.id });
            if (found.configurationRevision !== state.revision) throw Object.assign(new Error('Changed'), { code: 'SETTINGS_CONFLICT' });
            setDiscovery(found);
          })}>发现模型</Button>
        </div></div>
        {discovery && <Surface className="stack"><p>发现 {discovery.models.length} 个模型{discovery.truncated ? '（目录已截断）' : ''}。新增模型默认停用，保存后可逐项审核。</p>
          <small>{discovery.models.slice(0, 10).map(row => row.id).join('、')}{discovery.models.length > 10 ? '…' : ''}</small>
          <Button compact type="button" disabled={busy} onClick={() => invoke(async () => {
            const saved = await client.commit({ expectedRevision: state.revision, connection: { id: connection.id, label: connection.label, protocolProfile: connection.protocolProfile, enabled: connection.enabled } });
            onConfigured?.(saved); return saved;
          }, { id: connection.id, offset })}>测试并保存发现结果</Button>
        </Surface>}
        <div className="row" style={wrappingRow}>
          <Input type="search" aria-label="搜索本页模型" placeholder="搜索本页模型 ID" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} style={{ flex: '1 1 180px', minWidth: 0 }} />
          <select className="cm-input" aria-label="模型启用筛选" value={filter} disabled={busy} style={{ flex: '1 1 130px', minWidth: 0 }} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select>
          <Button compact type="button" disabled={busy || !models.length} onClick={() => edit({ modelChanges: models.map(row => ({ id: row.id, enabled: true })) })}>启用本页筛选模型</Button>
        </div>
        <small>当前显示第 {connection.models.length ? offset + 1 : 0}–{offset + connection.models.length} 个，共 {connection.modelCount} 个模型；筛选只作用于当前页。</small>
        <div className="row" style={wrappingRow}>
          <Button compact type="button" disabled={busy || offset === 0} onClick={() => invoke(() => load(connection.id, Math.max(0, offset - 50)))}>上一页模型</Button>
          <Button compact type="button" disabled={busy || connection.modelsNextOffset === null} onClick={() => invoke(() => load(connection.id, connection.modelsNextOffset ?? offset))}>下一页模型</Button>
        </div>
        {!models.length && <p>{query || filter !== 'all' ? '本页没有匹配模型。可以清空筛选或查看其他页。' : '暂无模型。可发现模型或手动添加精确模型 ID。'}</p>}
        {models.map(row => <ModelRow key={`${connection.id}:${row.id}:${state.revision}`} row={row} connection={connection} state={state} busy={busy} onEdit={edit} onDefault={id => invoke(() => client.update({ expectedRevision: state.revision, defaults: { provider: connection.id, model: id } }), { id: connection.id, offset })} />)}
        <Surface className="stack"><h3>手动添加模型</h3><label>精确模型 ID<Input aria-label="手动模型 ID" value={manualId} maxLength={256} disabled={busy} placeholder="从服务文档复制完整模型 ID" onChange={event => setManualId(event.target.value)} /></label>
          <small>手动模型默认停用。添加后可在对应页编辑能力声明并启用。</small>
          <Button compact type="button" disabled={busy || !manualId.trim()} onClick={() => invoke(async () => {
            const id = manualId.trim();
            // An existing ID is an explicit row edit, never a catalog replacement.
            const saved = await client.edit({ expectedRevision: state.revision, connectionId: connection.id, patch: { modelChanges: [{ id }] } });
            setManualId(''); setNotice(`模型 ${id} 已保留；新模型默认停用。`); return saved;
          }, { id: connection.id, offset })}>添加手动模型</Button>
        </Surface>
      </>}
      {state.preferencesNextOffset !== null && <Button compact type="button" disabled={busy} onClick={() => invoke(async () => {
        const page = await client.get({ connectionId: selectedId, modelOffset: offset, modelLimit: 50, preferenceOffset: state.preferencesNextOffset ?? 0 });
        if (page.revision !== state.revision) throw Object.assign(new Error('Changed'), { code: 'SETTINGS_CONFLICT' });
        setState({ ...state, modelPreferences: [...state.modelPreferences, ...page.modelPreferences], preferencesNextOffset: page.preferencesNextOffset });
      })}>读取更多模型偏好</Button>}
      {(state.recoveryTotal ?? state.recovery.length) > 0 && <p className="muted">有 {state.recoveryTotal ?? state.recovery.length} 项凭据准备记录保留在 Core。请刷新配置，核对相应连接后明确重新测试；记录不会自动重放。</p>}
    </>}
  </section>;
}
