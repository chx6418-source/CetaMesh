import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Input } from '../components/primitives/inputs';
import './skill-picker.css';

export type SkillSourceKind = 'project' | 'user' | 'installed';
export interface SkillReference { skillId: string; sourceRevision: string; sourceKind?: SkillSourceKind }
export interface SkillEntry extends SkillReference {
  name: string; description: string; sourceKind: SkillSourceKind; sourceId: string;
  always?: boolean; packageVersion?: string; packageRevision?: string; sha256?: string;
}
export interface SkillOmission { skillId?: string; sourceKind?: SkillSourceKind; sourceId?: string; name?: string; reason: string }
export interface SkillIndex {
  indexRevision: string; entries: SkillEntry[]; shadowed: (SkillEntry & { reason?: string; shadowedBy?: string })[]; omissions: SkillOmission[];
  truncated?: boolean;
}
export interface SkillContentPage { content: string; sourceRevision: string; nextOffset: number | null; truncated: boolean; sha256?: string }
export interface SkillContentReview {
  id: string; name: string; version: string; contentProfile: 'skill-reference-v1'; entry: 'SKILL.md';
  permissions: string[]; codeExecution: false; packageRevision: string;
}
export interface SkillInstallStage {
  stageId: string; installable: boolean; contentReview?: SkillContentReview | null; summary: string[];
}
export interface SkillInstallerClient {
  catalog(): Promise<{ available: boolean; configured: boolean; offline: boolean; plugins: { id: string; name: string; summary: string; installed: boolean }[] }>;
  stage(id: string): Promise<SkillInstallStage>;
  install(stageId: string): Promise<{ installed: boolean }>;
  enable(id: string, expectedSkillPackage: { version: string; packageRevision: string }): Promise<unknown>;
}
export interface SkillPickerClient {
  listSkills(input: { chatId: string }): Promise<SkillIndex>;
  readSkill(input: { chatId: string; skillId: string; sourceRevision: string; offset?: number; maxBytes?: number }): Promise<SkillContentPage>;
  installer?: SkillInstallerClient;
}
export interface SkillPickerProps {
  client: SkillPickerClient; chatId: string; selectedRefs: SkillReference[];
  onChange(refs: SkillReference[]): void; onClose?(): void; entryPoint?: 'add' | 'slash';
}
export const MAX_SELECTED_SKILLS = 16;
const sourceLabel: Record<SkillSourceKind, string> = { project: '项目', user: '用户目录', installed: '已审安装' };
const sameRef = (a: SkillReference, b: SkillReference) => a.skillId === b.skillId && a.sourceRevision === b.sourceRevision;
const refFor = ({ skillId, sourceRevision, sourceKind }: SkillEntry): SkillReference => ({ skillId, sourceRevision, sourceKind });
const codeFor = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
function requestError(error: unknown): string {
  const code = codeFor(error);
  if (code === 'SKILL_SOURCE_STALE') return '来源已变化。刷新索引后明确重新选择当前版本。';
  if (code === 'SKILL_SOURCE_UNAVAILABLE' || code === 'SKILL_PERMISSION_DENIED') return '来源不可用。请核对当前来源启用状态和读取授权后刷新。';
  if (code === 'SETTINGS_CONFLICT') return '配置已变化。请刷新来源并核对后重新提交；填写中的目录保留。';
  if (code === 'SKILL_SOURCE_DIRECTORY_INVALID') return '请选择存在的本地目录；目录和父路径不能是链接。';
  if (code === 'SKILL_SOURCE_EXISTS') return '来源标识已登记。请核对现有来源或使用另一标识。';
  if (code === 'SKILL_SOURCE_CONFIG_INVALID') return '请检查来源标识、绝对目录和启用选项。最多登记 32 个目录。';
  return '请求未完成。请刷新当前内容，核对来源和授权后重试。';
}

/** Add and slash mount this same component with the same Core-derived index. */
export function SkillPicker({ client, chatId, selectedRefs, onChange, onClose, entryPoint = 'add' }: SkillPickerProps) {
  const [index, setIndex] = useState<SkillIndex | null>(null), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{ entry: SkillEntry; content: string; nextOffset: number | null; truncated: boolean } | null>(null);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState('');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<SkillInstallerClient['catalog']>> | null>(null);
  const [installReview, setInstallReview] = useState<SkillInstallStage | null>(null);
  const [installBusy, setInstallBusy] = useState(false), [installError, setInstallError] = useState(''), [installStatus, setInstallStatus] = useState('');
  const installGeneration = useRef(0), selection = useRef({ selectedRefs, onChange });
  useLayoutEffect(() => { selection.current = { selectedRefs, onChange }; });
  // Commit-time fences close the window before passive effects run. A late
  // continuation must not use another Chat's freshly rendered onChange callback.
  useLayoutEffect(() => {
    installGeneration.current += 1; setCatalog(null); setInstallReview(null); setInstallBusy(false); setInstallError(''); setInstallStatus('');
    return () => { installGeneration.current += 1; };
  }, [client, chatId]);
  const readGeneration = useRef(0);
  useEffect(() => {
    let current = true;
    readGeneration.current += 1; setPreview(null); setReadError(''); setReading(false); setLoading(true); setError(''); setIndex(null);
    client.listSkills({ chatId }).then(result => { if (current) setIndex(result); }, failure => { if (current) setError(requestError(failure)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; readGeneration.current += 1; };
  }, [client, chatId, refresh]);
  const entries = index?.entries ?? [], normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = entries.filter(row => [row.name, row.description, sourceLabel[row.sourceKind], row.sourceId].some(value => value.toLocaleLowerCase().includes(normalizedQuery)));
  function choose(entry: SkillEntry) {
    const ref = refFor(entry);
    if (selectedRefs.some(row => sameRef(row, ref))) onChange(selectedRefs.filter(row => !sameRef(row, ref)));
    else if (selectedRefs.some(row => row.skillId === ref.skillId)) onChange(selectedRefs.map(row => row.skillId === ref.skillId ? ref : row));
    else if (selectedRefs.length < MAX_SELECTED_SKILLS) onChange([...selectedRefs, ref]);
  }
  async function browse() {
    if (!client.installer) return;
    const generation = installGeneration.current;
    setInstallBusy(true); setInstallError(''); setInstallReview(null); setInstallStatus('');
    try {
      const result = await client.installer.catalog();
      if (generation === installGeneration.current) setCatalog(result);
    } catch { if (generation === installGeneration.current) setInstallError('插件目录不可用。可继续选择已有本地参考，或在插件中心检查服务配置后重试。'); }
    finally { if (generation === installGeneration.current) setInstallBusy(false); }
  }
  async function stage(id: string) {
    if (!client.installer) return;
    const generation = installGeneration.current;
    setInstallBusy(true); setInstallError(''); setInstallReview(null); setInstallStatus('');
    try {
      const result = await client.installer.stage(id);
      if (generation !== installGeneration.current) return;
      const content = result.contentReview;
      if (!result.installable || !content || content.id !== id || content.contentProfile !== 'skill-reference-v1' || content.entry !== 'SKILL.md'
        || content.codeExecution !== false || content.permissions.length !== 1 || content.permissions[0] !== 'skill.read' || !/^[a-f0-9]{64}$/.test(content.packageRevision)) {
        setInstallError('实际包不是可安装的严格 Skill 内容包。本入口不安装可执行扩展；请到插件中心审查对应类型。'); return;
      }
      setInstallReview(result);
    } catch { if (generation === installGeneration.current) setInstallError('包下载或审查未完成。已有引用保留；请重新查看目录并审查当前包。'); }
    finally { if (generation === installGeneration.current) setInstallBusy(false); }
  }
  async function installAndSelect() {
    if (!client.installer || !installReview?.contentReview) return;
    const generation = installGeneration.current, review = installReview, content = review.contentReview!;
    setInstallBusy(true); setInstallError(''); setInstallStatus('正在安装已审内容包…');
    try {
      const result = await client.installer.install(review.stageId);
      if (generation !== installGeneration.current) return;
      if (!result.installed) throw Error('Installation not observed');
      setInstallReview(null); setInstallStatus('已安装 · 正在启用内容来源…');
      await client.installer.enable(content.id, { version: content.version, packageRevision: content.packageRevision });
      if (generation !== installGeneration.current) return;
      setInstallStatus('已安装 · 已启用 · 正在读取实际参考索引…');
      const currentIndex = await client.listSkills({ chatId });
      if (generation !== installGeneration.current) return;
      setIndex(currentIndex);
      const entry = currentIndex.entries.find(row => row.sourceKind === 'installed' && row.sourceId === 'extension:' + content.id
        && row.packageVersion === content.version && row.packageRevision === content.packageRevision);
      if (!entry) { setInstallStatus('已安装 · 已启用；当前索引没有此受审版本的可读来源。请检查来源与预算说明后刷新。'); return; }
      const page = await client.readSkill({ chatId, skillId: entry.skillId, sourceRevision: entry.sourceRevision, maxBytes: 1 });
      if (generation !== installGeneration.current) return;
      if (page.sourceRevision !== entry.sourceRevision) throw Error('Source changed');
      const { selectedRefs: current, onChange: change } = selection.current;
      if (!current.some(row => sameRef(row, entry))) {
        if (!current.some(row => row.skillId === entry.skillId) && current.length >= MAX_SELECTED_SKILLS) {
          setInstallStatus('已安装 · 已启用 · 来源已就绪；引用已满，请移除一个引用后选择。'); return;
        }
        change(current.some(row => row.skillId === entry.skillId) ? current.map(row => row.skillId === entry.skillId ? refFor(entry) : row) : [...current, refFor(entry)]);
      }
      setInstallStatus('已安装 · 已启用 · 来源已就绪 · 已选择受审版本');
      setCatalog(previous => previous ? { ...previous, plugins: previous.plugins.filter(row => row.id !== content.id) } : previous);
    } catch {
      if (generation === installGeneration.current) { setInstallReview(null); setInstallError('安装、启用或来源核验未完成。已有引用保留；请到插件中心核对实际安装状态，再刷新 Skill。'); }
    } finally { if (generation === installGeneration.current) setInstallBusy(false); }
  }
  async function read(entry: SkillEntry, offset = 0) {
    const generation = ++readGeneration.current;
    setReading(true); setReadError('');
    if (offset === 0) setPreview(null);
    try {
      const result = await client.readSkill({ chatId, skillId: entry.skillId, sourceRevision: entry.sourceRevision, offset, maxBytes: 8192 });
      if (generation !== readGeneration.current) return;
      if (result.sourceRevision !== entry.sourceRevision) { setPreview(null); setReadError('来源已变化。刷新索引后明确重新选择当前版本。'); return; }
      setPreview(previous => ({ entry, content: ((offset > 0 && previous && sameRef(previous.entry, entry) ? previous.content : '') + result.content).slice(0, 65536),
        nextOffset: result.nextOffset, truncated: result.truncated }));
    } catch (failure) { if (generation === readGeneration.current) { setPreview(null); setReadError(requestError(failure)); } }
    finally { if (generation === readGeneration.current) setReading(false); }
  }
  function close() { installGeneration.current += 1; readGeneration.current += 1; onClose?.(); }
  return <section className="skill-picker" data-skill-picker={entryPoint} aria-label="Skill 参考选择" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <div className="skill-picker-header"><h3>选择 Skill 参考</h3><Button compact onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新 Skill</Button>{onClose && <Button compact variant="ghost" onClick={close}>关闭 Skill</Button>}</div>
    <p className="skill-reference-disclosure">Skill 是低信任参考文本，不授予工具或审批权限。正文和资源读取会再次核对来源版本与当前授权。</p>
    {client.installer && <div className="skill-install"><Button compact disabled={installBusy} onClick={() => void browse()}>浏览可安装参考</Button>
      <p className="skill-reference-disclosure">目录条目仅为候选；点击查看时才下载并审查实际包。安装仅支持严格内容包。</p>
      {catalog && (!catalog.available || catalog.offline) && <p role="status">插件目录{catalog.offline ? '离线' : catalog.configured ? '不可用' : '未配置'}。可继续选择已有本地参考，或到插件中心检查服务后重试。</p>}
      {catalog?.available && !catalog.offline && <ul className="skill-install-candidates" aria-label="可安装参考候选">{catalog.plugins.filter(row => !row.installed).map(row => <li key={row.id}><strong>{row.name}</strong><p>{row.summary}</p><Button compact disabled={installBusy} onClick={() => void stage(row.id)}>查看实际包 {row.name}</Button></li>)}</ul>}
      {installReview?.contentReview && <div className="skill-install-review" aria-label="Skill 安装审查"><h4>{installReview.contentReview.name} · v{installReview.contentReview.version}</h4>
        <p>实际清单：{installReview.contentReview.id} · {installReview.contentReview.contentProfile} · {installReview.contentReview.entry}</p>
        <p>权限：skill.read · 仅受审内容读取 · 不执行代码，不授予工具、网络、通用文件或账号权限。</p>
        <p>受审包指纹 <code>{installReview.contentReview.packageRevision}</code></p><ul>{installReview.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
        <Button compact disabled={installBusy} onClick={() => void installAndSelect()}>同意安装、启用并选择此版本</Button><Button compact variant="ghost" disabled={installBusy} onClick={() => setInstallReview(null)}>取消安装参考</Button>
      </div>}
      {installBusy && <p role="status">正在核对内容包…</p>}{installStatus && <p role="status">{installStatus}</p>}{installError && <p role="alert">{installError}</p>}
    </div>}
    <Input aria-label="搜索 Skill" placeholder="搜索名称、说明或来源" value={query} onChange={event => setQuery(event.target.value)} />
    <p className="skill-picker-status" role="status">已选 {selectedRefs.length}/{MAX_SELECTED_SKILLS}{loading ? ' · 正在读取来源' : ` · ${entries.length} 个可用参考`}{index && ` · 索引 ${index.indexRevision.slice(0, 12)}`}</p>
    {error && <p role="alert">{error}</p>}
    {selectedRefs.length > 0 && <ul className="skill-selected" aria-label="已选 Skill 版本">{selectedRefs.map(ref => {
      const exact = entries.find(row => sameRef(row, ref)), current = entries.find(row => row.skillId === ref.skillId);
      return <li key={ref.skillId + ':' + ref.sourceRevision} data-skill-selection={exact ? 'current' : current ? 'stale' : 'unavailable'}>
        <span>{exact?.name ?? current?.name ?? ref.skillId.slice(0, 18)} · {ref.sourceRevision.slice(0, 12)}{!loading && !error && !exact && <strong> · {current ? '来源已变化' : '来源不可用'}</strong>}</span>
        {!loading && current && !exact && <Button compact onClick={() => choose(current)}>重新选择 {current.name}</Button>}
        <Button compact variant="ghost" aria-label={'移除 Skill ' + (exact?.name ?? current?.name ?? ref.skillId)} onClick={() => onChange(selectedRefs.filter(row => !sameRef(row, ref)))}>移除引用</Button>
      </li>;
    })}</ul>}
    <ul className="skill-entry-list" aria-label="可用 Skill">{visible.map(entry => {
      const selected = selectedRefs.some(ref => sameRef(ref, entry));
      const atLimit = !selected && !selectedRefs.some(ref => ref.skillId === entry.skillId) && selectedRefs.length >= MAX_SELECTED_SKILLS;
      return <li key={entry.skillId + ':' + entry.sourceRevision} data-skill-entry={entry.skillId}>
        <label><input type="checkbox" aria-label={'选择 Skill ' + entry.name} checked={selected} disabled={atLimit} onChange={() => choose(entry)} /><span><strong>{entry.name}</strong><span className="skill-entry-description">{entry.description}</span></span></label>
        <div className="skill-entry-meta">{sourceLabel[entry.sourceKind]} · {entry.sourceId}{entry.packageVersion && ` · v${entry.packageVersion}`} · 版本 {entry.sourceRevision.slice(0, 12)}{entry.always && ' · 自动参考（受预算限制）'}</div>
        <Button compact variant="ghost" disabled={reading} onClick={() => void read(entry)}>预览 {entry.name}</Button>
      </li>;
    })}</ul>
    {!loading && !error && visible.length === 0 && <p>没有匹配的可读 Skill。可检查项目 .cetamesh/skills、登记的用户目录或已启用的受审内容包。</p>}
    {(index?.truncated || index?.omissions.length || index?.shadowed.length) ? <details className="skill-omissions"><summary>来源与预算说明 · 遗漏 {index?.omissions.length ?? 0} · 遮蔽 {index?.shadowed.length ?? 0}</summary>
      {index?.truncated && <p>索引已截断；当前预算只包含显示的条目。</p>}
      <ul>{index?.omissions.map((row, i) => <li key={'omitted:' + i}>{row.name || row.sourceId || row.skillId?.slice(0, 18) || sourceLabel[row.sourceKind ?? 'project']} · {row.reason}</li>)}
        {index?.shadowed.map(row => <li key={'shadowed:' + row.skillId}>{row.name} · {sourceLabel[row.sourceKind]} · {row.reason || 'source-priority'} · 同名高优先级来源已采用</li>)}</ul>
    </details> : null}
    {readError && <p role="alert">{readError}</p>}
    {reading && <p role="status">正在读取已选来源版本…</p>}
    {preview && <div className="skill-content-preview" aria-label="Skill 正文预览"><h4>{preview.entry.name} · 低信任参考</h4><p>来源版本 {preview.entry.sourceRevision.slice(0, 12)}{preview.truncated && ' · 已截断，可读取下一页'}</p><pre>{preview.content}</pre>
      {preview.nextOffset !== null && preview.content.length < 65536 && <Button compact disabled={reading} onClick={() => void read(preview.entry, preview.nextOffset ?? 0)}>读取下一页 Skill</Button>}</div>}
    {selectedRefs.length >= MAX_SELECTED_SKILLS && <p role="status">每条聊天消息最多引用 {MAX_SELECTED_SKILLS} 个 Skill；请先移除一个引用。</p>}
  </section>;
}

export interface SkillSourceConfiguration { sourceId: string; root: string; revision: number; enabled: boolean }
export interface SkillSourcesState { sources: SkillSourceConfiguration[]; revision: number }
export interface SkillSourceSettingsClient {
  listSkillSources(): Promise<SkillSourcesState>;
  registerSkillSource(input: { sourceId: string; root: string; enabled: boolean; expectedRev: number }): Promise<SkillSourcesState>;
  setSkillSourceEnabled(input: { sourceId: string; enabled: boolean; expectedRev: number }): Promise<SkillSourcesState>;
  removeSkillSource(input: { sourceId: string; expectedRev: number }): Promise<SkillSourcesState>;
}
/** Existing Settings commands own storage; the form keeps only unsaved UI drafts. */
export function SkillSourceSettings({ client }: { client: SkillSourceSettingsClient }) {
  const [state, setState] = useState<SkillSourcesState | null>(null), [sourceId, setSourceId] = useState(''), [root, setRoot] = useState('');
  const [enabled, setEnabled] = useState(false), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current; setLoading(true); setError('');
    client.listSkillSources().then(result => { if (current === generation.current) setState(result); }, failure => { if (current === generation.current) setError(requestError(failure)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [client, refresh]);
  async function commit(run: () => Promise<SkillSourcesState>, clearForm = false) {
    const current = generation.current; setSaving(true); setError('');
    try { const result = await run(); if (current === generation.current) { setState(result); if (clearForm) { setSourceId(''); setRoot(''); setEnabled(false); } } }
    catch (failure) { if (current === generation.current) setError(requestError(failure)); }
    finally { if (current === generation.current) setSaving(false); }
  }
  const busy = saving || loading, revision = state?.revision ?? -1;
  return <section className="skill-source-settings" aria-label="Skill 参考来源设置">
    <div className="skill-picker-header"><h3>Skill 参考目录</h3><Button compact disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新参考来源</Button></div>
    <p className="skill-reference-disclosure">登记的目录可向聊天提供低信任参考文本，不授予工具或审批权限。只读取显式登记的目录，不会复制或删除其中的文件；取消登记会撤销这些引用来源。</p>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">正在读取来源设置…</p>}
    <ul className="skill-source-list">{state?.sources.map(source => <li key={source.sourceId}><strong>{source.sourceId}</strong><code>{source.root}</code><span>{source.enabled ? '已启用参考' : '未启用参考'} · 配置版本 {source.revision}</span>
      <div className="skill-source-actions"><Button compact disabled={busy} aria-label={(source.enabled ? '停用参考 ' : '启用参考 ') + source.sourceId} onClick={() => void commit(() => client.setSkillSourceEnabled({ sourceId: source.sourceId, enabled: !source.enabled, expectedRev: revision }))}>{source.enabled ? '停用参考' : '启用参考'}</Button>
        <Button compact variant="ghost" disabled={busy} aria-label={'取消登记 ' + source.sourceId} onClick={() => void commit(() => client.removeSkillSource({ sourceId: source.sourceId, expectedRev: revision }))}>取消登记（保留文件）</Button></div></li>)}</ul>
    <form className="skill-source-form" onSubmit={event => { event.preventDefault(); if (!busy && state && sourceId.trim() && root.trim()) void commit(() => client.registerSkillSource({ sourceId: sourceId.trim(), root: root.trim(), enabled, expectedRev: revision }), true); }}>
      <label>来源标识<Input aria-label="Skill 来源标识" maxLength={80} placeholder="my-reference-library" value={sourceId} disabled={saving} onChange={event => setSourceId(event.target.value)} /></label>
      <label>本地绝对目录<Input aria-label="Skill 来源目录" maxLength={2048} value={root} disabled={saving} onChange={event => setRoot(event.target.value)} /></label>
      <label className="skill-source-consent"><input type="checkbox" checked={enabled} disabled={saving} onChange={event => setEnabled(event.target.checked)} />登记后启用为聊天参考文本</label>
      <Button type="submit" disabled={busy || !state || !sourceId.trim() || !root.trim() || state.sources.length >= 32}>登记参考目录</Button>
    </form>
    {state && <p className="skill-picker-status">已登记 {state.sources.length}/32 · Settings 修订 {state.revision}</p>}
  </section>;
}
