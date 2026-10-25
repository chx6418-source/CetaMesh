import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { bridge, hostClient, openExternal, previewClient, type PreviewBounds, type PreviewMetadata, type PreviewSource } from '../bridge/typed-client';
import { Icon } from '../components/icons';
import { Button, IconButton } from '../components/primitives/inputs';
import { Markdown, VirtualList } from '../components/primitives/content';
import { ReferenceViewerContext } from './reference-viewer-context';
import { clampPreviewWidth, closeReferenceTab, openReferenceTab, PreviewLoadEpoch, PreviewWebHistory } from './reference-viewer-state';
import './reference-viewer.css';

type Tab = { id: string; source: PreviewSource; label: string; trigger: HTMLElement; metadata?: PreviewMetadata; history?: PreviewWebHistory; content?: string; error?: string; loading: boolean };
const StateContext = createContext<{
  tabs: Tab[]; activeId: string; setActiveId(id: string): void; close(id?: string): void; reload(tab: Tab): void; notice: string;
} | null>(null);
const errorText = (error: unknown) => error instanceof Error ? error.message : '此引用当前无法查看。';
let nextTabId = 0;

export function ReferenceViewerProvider({ children, page }: { children: ReactNode; page: string }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const [activeId, setActiveId] = useState('');
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const [notice, setNotice] = useState('');
  const epochs = useRef(new PreviewLoadEpoch());
  const reload = useCallback(async (tab: Tab) => {
    const epoch = epochs.current.begin(tab.id);
    const current = () => epochs.current.isCurrent(tab.id, epoch);
    const update = (patch: Partial<Tab>) => { if (current()) setTabs(items => items.map(item => item.id === tab.id ? { ...item, ...patch } : item)); };
    update({ loading: true, error: undefined });
    let handle: string | undefined;
    try {
      const metadata = await previewClient.open(tab.source);
      if ('handle' in metadata) handle = metadata.handle;
      if (!current()) return;
      if (metadata.kind === 'web' || metadata.kind === 'unsupported') { update({ metadata, history: metadata.kind === 'web' ? tab.history ?? new PreviewWebHistory(metadata.url) : undefined, loading: false, content: undefined }); return; }
      const chunks: Uint8Array[] = [];
      let offset: number | null = 0;
      let total = 0;
      while (offset !== null && current()) {
        const chunk = await previewClient.read(metadata.handle, offset);
        if (!current()) return;
        const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
        if (chunk.offset !== offset || bytes.length > 65536 || (chunk.nextOffset !== null && chunk.nextOffset !== offset + bytes.length)) throw new Error('预览数据不完整，请重试。');
        total += bytes.length;
        if (total > metadata.size || total > 10 * 1024 * 1024 || (chunk.nextOffset !== null && !bytes.length)) throw new Error('预览数据超过限制。');
        chunks.push(bytes); offset = chunk.nextOffset;
      }
      if (!current()) return;
      if (total !== metadata.size) throw new Error('预览数据不完整，请重试。');
      const bytes = new Uint8Array(total);
      let cursor = 0; for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
      let content: string;
      if (metadata.kind === 'image') {
        const blob = new Blob([bytes], { type: metadata.mimeType });
        content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片无法读取。')); reader.readAsDataURL(blob); });
      } else content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      update({ metadata, content, loading: false });
    } catch (error) { update({ loading: false, error: errorText(error) }); }
    finally { if (handle) void previewClient.close(handle).catch(() => { /* Core expires the bounded handle if disconnected. */ }); }
  }, []);
  const close = useCallback((id?: string) => {
    const closing = id ? tabsRef.current.filter(tab => tab.id === id) : tabsRef.current;
    for (const tab of closing) epochs.current.close(tab.id);
    const next = id ? closeReferenceTab(tabsRef.current, activeRef.current, id) : { tabs: [] as Tab[], activeId: '' };
    tabsRef.current = next.tabs; activeRef.current = next.activeId; setTabs(next.tabs); setActiveId(next.activeId); setNotice('');
    const trigger = closing.at(-1)?.trigger;
    if (trigger?.isConnected) trigger.focus();
  }, []);
  useEffect(() => { close(); }, [page, close]);
  useEffect(() => () => { for (const tab of tabsRef.current) epochs.current.close(tab.id); }, []);
  const context = useMemo(() => ({ open(source: PreviewSource, label: string, trigger: HTMLElement) {
    const tab: Tab = { id: `preview-${++nextTabId}`, source, label, trigger, loading: true };
    const next = openReferenceTab(tabsRef.current, tab);
    if (next.overflow) { setNotice('最多打开 8 个查看标签，请先关闭一个。'); return; }
    const added = next.tabs.length > tabsRef.current.length;
    tabsRef.current = next.tabs; activeRef.current = next.activeId;
    setTabs(next.tabs); setActiveId(next.activeId); setNotice('');
    if (added) void reload(tab);
  } }), [reload]);
  return <ReferenceViewerContext.Provider value={context}><StateContext.Provider value={{ tabs, activeId, setActiveId, close, reload, notice }}>{children}</StateContext.Provider></ReferenceViewerContext.Provider>;
}

export function ReferenceViewerLayout({ children }: { children: ReactNode }) {
  const state = useContext(StateContext)!;
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(1000);
  const [preferred, setPreferred] = useState<number | null>(null);
  const [narrowViewer, setNarrowViewer] = useState(true);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => { if (container.current) setAvailable(container.current.clientWidth); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const active = state.tabs.find(tab => tab.id === state.activeId);
  const width = clampPreviewWidth(preferred ?? available * .42, available);
  const narrow = Boolean(active) && available < 640;
  return <div ref={container} className={`reference-layout ${active ? 'has-viewer' : ''} ${narrow ? 'narrow' : ''} ${narrowViewer ? 'show-viewer' : 'show-chat'}`} style={{ '--viewer-width': `${width}px` } as CSSProperties}>
    <div className="reference-chat">{children}</div>
    {active && <>
      {narrow && !narrowViewer && <button type="button" className="reference-narrow-switch" onClick={() => setNarrowViewer(true)}>查看引用</button>}
      <div className="reference-divider" role="separator" aria-label="调整查看面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={Math.max(320, Math.floor(available * .6))} aria-valuenow={Math.round(width)} tabIndex={0}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPreferred(width + (event.key === 'ArrowLeft' ? 24 : -24)); } }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && container.current) setPreferred(container.current.getBoundingClientRect().right - event.clientX); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}><span /></div>
      <aside className="reference-viewer" aria-label="引用查看" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); active.trigger?.focus(); } }}>
        {narrow && <div className="reference-toolbar"><Button compact variant="ghost" onClick={() => setNarrowViewer(false)}>返回聊天</Button></div>}
        <div className="reference-tabs" role="tablist" aria-label="已打开的引用">{state.tabs.map(tab => <div key={tab.id} className={`reference-tab ${tab.id === active.id ? 'active' : ''}`}>
          <button type="button" role="tab" id={`${tab.id}-tab`} aria-controls={`${tab.id}-panel`} aria-selected={tab.id === active.id} tabIndex={tab.id === active.id ? 0 : -1} title={tab.metadata?.name ?? tab.label} onClick={() => state.setActiveId(tab.id)}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const index = state.tabs.indexOf(tab); const next = state.tabs[(index + (event.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) % state.tabs.length]; state.setActiveId(next.id); document.getElementById(`${next.id}-tab`)?.focus(); } }}><Icon name={tab.metadata?.kind === 'web' ? 'globe' : tab.metadata?.kind === 'image' ? 'image' : 'fileCode'} size={16} /><span>{tab.label}</span></button>
          <button type="button" aria-label={`关闭引用：${tab.label}`} onClick={() => state.close(tab.id)}><Icon name="close" size={13} /></button></div>)}</div>
        {state.notice && <p role="status" className="reference-notice">{state.notice}</p>}
        <div className="reference-panel" role="tabpanel" id={`${active.id}-panel`} aria-labelledby={`${active.id}-tab`}>
          {active.metadata?.kind === 'web' ? <WebReference key={active.id} tab={active} onClose={() => state.close()} /> : <>
            <div className="reference-toolbar"><span className="reference-location" title={active.metadata?.name ?? active.label}>{active.metadata?.name ?? active.label}</span><IconButton label="刷新预览" icon="refresh" onClick={() => state.reload(active)} />{active.source.kind === 'artifact' && <IconButton label="在系统中打开" icon="external" onClick={() => { const source = active.source; if (source.kind === 'artifact') void hostClient.openArtifact(source.taskId, source.artifactId).catch(error => window.alert(errorText(error))); }} />}<IconButton label="关闭查看面板" icon="close" onClick={() => state.close()} /></div>
            {active.loading ? <p className="reference-state" role="status">正在读取引用…</p> : active.error ? <div className="reference-state" role="alert"><p>{active.error}</p><Button compact onClick={() => state.reload(active)}>重试</Button></div> : active.metadata?.kind === 'unsupported' ? <p className="reference-state">{active.metadata.message}</p> : <FileReference key={active.id} tab={active} />}
          </>}
        </div>
      </aside>
    </>}
  </div>;
}

function FileReference({ tab }: { tab: Tab }) {
  const [imageError, setImageError] = useState(false);
  const requested = tab.metadata && 'line' in tab.metadata ? tab.metadata.line ?? 1 : 1;
  const lines = useMemo(() => {
    const all = (tab.content ?? '').split('\n');
    const start = Math.min(Math.max(0, requested - 40), Math.max(0, all.length - 20000));
    return { total: all.length, start, rows: all.slice(start, start + 20000).map((text, index) => ({ text, number: start + index + 1 })) };
  }, [tab.content, requested]);
  const key = useCallback((line: { number: number; text: string }) => `line-${line.number}`, []);
  useEffect(() => setImageError(false), [tab.content]);
  if (tab.metadata?.kind === 'image') return <div className="reference-file">{imageError ? <p role="alert">图片无法解码或文件已损坏。</p> : <img src={tab.content} alt={tab.metadata.name} onError={() => setImageError(true)} />}</div>;
  if (tab.metadata?.kind === 'markdown' && (tab.content?.length ?? 0) <= 200000 && lines.total <= 5000) return <div className="reference-file"><Markdown>{tab.content ?? ''}</Markdown></div>;
  return <div className="reference-file reference-code-list">{(lines.total > 20000 || tab.metadata?.kind === 'markdown') && <p className="reference-notice">只读文本 · 共 {lines.total} 行{lines.total > 20000 ? `，当前预览 ${lines.start + 1}–${lines.start + lines.rows.length} 行` : ''}</p>}<VirtualList items={lines.rows} estimateSize={22} height="100%" initialIndex={Math.min(lines.rows.length - 1, Math.max(0, requested - lines.start - 3))} getItemKey={key} render={line => <div className={`reference-code-row ${line.number === requested ? 'located' : ''}`}><small aria-hidden="true">{line.number}</small><code>{line.text || ' '}</code></div>} /></div>;
}

function WebReference({ tab, onClose }: { tab: Tab; onClose(): void }) {
  const slot = useRef<HTMLDivElement>(null);
  const history = tab.history!;
  const [status, setStatus] = useState({ url: history.current, title: tab.label, loading: true, error: '', canBack: false, canForward: false });
  const errorRef = useRef(''); errorRef.current = status.error;
  useEffect(() => {
    const initialUrl = history.current;
    if (!initialUrl || !slot.current) return;
    history.attach();
    let disposed = false, opened = false, frame = 0, lastLayout = '', revision = -1, generation = -1;
    const bounds = (): PreviewBounds => { const rect = slot.current!.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: window.devicePixelRatio }; };
    const off = bridge.subscribe('preview.browser', data => {
      if (data.targetId !== tab.id || disposed) return;
      if (data.focusRequested) { tab.trigger?.focus(); return; }
      if (data.generation !== undefined && data.generation !== generation) { generation = data.generation; revision = -1; }
      if ((data.revision ?? 0) < revision) return;
      revision = data.revision ?? 0;
      if (data.historyUrls && data.historyIndex !== undefined) history.snapshot(data.historyUrls, data.historyIndex);
      setStatus(previous => ({ url: data.url ?? previous.url, title: data.title ?? previous.title, loading: data.loading ?? previous.loading, error: data.error ?? previous.error, canBack: data.canBack ?? previous.canBack, canForward: data.canForward ?? previous.canForward }));
    });
    const layout = () => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        if (disposed || !slot.current || !opened) return;
        const rect = bounds();
        const covered = Boolean(document.querySelector('.cm-sheet-layer, dialog[open], .cm-select-options, .session-menu-items, details[open] .workspace-menu, .composer-context-options'));
        const visible = !document.hidden && !errorRef.current && !covered && rect.width > 0 && rect.height > 0;
        const signature = JSON.stringify([rect, visible]);
        if (signature !== lastLayout) { lastLayout = signature; void previewClient.browserLayout(tab.id, rect, visible).catch(error => { if (!disposed) setStatus(current => ({ ...current, error: errorText(error), loading: false })); }); }
      });
    };
    const observer = new ResizeObserver(layout); observer.observe(slot.current);
    const mutations = new MutationObserver(layout); mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class', 'style'] });
    window.addEventListener('resize', layout); document.addEventListener('visibilitychange', layout);
    void previewClient.browserOpen(tab.id, initialUrl, bounds()).then(() => { opened = true; layout(); }).catch(error => { if (!disposed) setStatus(current => ({ ...current, error: errorText(error), loading: false })); });
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); off(); window.removeEventListener('resize', layout); document.removeEventListener('visibilitychange', layout); void previewClient.browserCommand(tab.id, 'close').catch(() => { /* Host shutdown also owns and destroys this view. */ }); };
  }, [tab.id, tab.metadata, history]);
  const command = (action: 'back' | 'forward' | 'reload') => {
    setStatus(current => ({ ...current, error: '', loading: true }));
    const nativeHistory = action === 'back' ? status.canBack : status.canForward;
    const url = action === 'reload' ? null : history.move(action === 'back' ? -1 : 1);
    let operation: Promise<unknown>;
    if (action !== 'reload' && !nativeHistory && url && slot.current) {
      history.attach();
      const rect = slot.current.getBoundingClientRect(); const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: window.devicePixelRatio };
      operation = previewClient.browserOpen(tab.id, url, bounds).then(() => previewClient.browserLayout(tab.id, bounds, true));
    } else operation = previewClient.browserCommand(tab.id, action);
    void operation.catch(error => setStatus(current => ({ ...current, error: errorText(error), loading: false })));
  };
  return <><div className="reference-toolbar"><IconButton label="后退" icon="left" disabled={!status.canBack && !history.canBack} onClick={() => command('back')} /><IconButton label="前进" icon="right" disabled={!status.canForward && !history.canForward} onClick={() => command('forward')} /><IconButton label="刷新网页" icon="refresh" onClick={() => command('reload')} /><span className="reference-location" title={status.url}>{status.url.replace(/^https:\/\//, '')}</span><IconButton label="在浏览器打开" icon="external" onClick={() => void openExternal(status.url).catch(error => setStatus(current => ({ ...current, error: errorText(error) })))} /><IconButton label="关闭查看面板" icon="close" onClick={onClose} /></div>
    <div className="reference-web-slot" ref={slot} aria-label={status.title}>{(status.loading || status.error) && <div className="reference-state" role={status.error ? 'alert' : 'status'}>{status.error || '正在加载网页…'}</div>}</div></>;
}
