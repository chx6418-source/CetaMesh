import { useCallback, useEffect, useState } from 'react';
import { aboutClient, feedbackClient, openExternal, updateClient } from '../bridge/typed-client';
import { Icon } from '../components/icons';
import { Button } from '../components/primitives/inputs';
import { Badge, LoadingState, Surface } from '../components/primitives/surfaces';
import { DiagnosticsEntry, FeedbackDeveloperButton } from './StartupDiagnostics';
import { FeedbackLinkRow } from './StatusPresentation';
import { ErrorNotice, Heading, messageOf } from './PagePresentation';

const updateStatusLabel = (status: string) => ({ update_available: '有可用更新', up_to_date: '已是最新版本', checked: '已完成检查', not_configured: '软件内更新暂不可用', error: '检查失败', unknown: '尚未检查' }[status] ?? status);

export function AboutPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof aboutClient.info>> | null>(null);
  const [feedback, setFeedback] = useState<Awaited<ReturnType<typeof feedbackClient.links>> | null>(null);
  const [update, setUpdate] = useState<Record<string, unknown> | null>(null);
  const [notes, setNotes] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setInfo(await aboutClient.info()); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); void aboutClient.update().then(setUpdate).catch(() => setUpdate(null)); void updateClient.notes().then(setNotes).catch(() => setNotes(null)); void feedbackClient.links().then(setFeedback).catch(() => setFeedback(null)); }, [refresh]);
  async function checkUpdate() {
    setChecking(true); setError('');
    try {
      setUpdate(await updateClient.check());
      setNotes(await updateClient.notes());
      setCheckedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
    }
    catch (cause) { setError(messageOf(cause)); }
    finally { setChecking(false); }
  }
  async function visit(url: string | null) { if (url?.startsWith('https://')) { try { await openExternal(url); } catch (cause) { setError(messageOf(cause)); } } }
  const linkRows = info ? [{ id: 'website', label: '官方网站', url: info.website }, { id: 'gitcode', label: 'GitCode', url: info.gitcode }, { id: 'github', label: 'GitHub', url: info.github }] : [];
  const latestVersionValue = update?.latestVersion ?? update?.latest;
  const latestVersion = typeof latestVersionValue === 'string' ? latestVersionValue : latestVersionValue && typeof latestVersionValue === 'object' ? String((latestVersionValue as { version?: unknown }).version ?? '') : '';
  const updateStatus = updateStatusLabel(String(update?.status ?? 'unknown'));
  const updateUnavailable = update?.status === 'not_configured';
  const updateFailure = String(update?.failureMessage ?? update?.message ?? '');
  const releasePage = info?.github?.startsWith('https://') ? `${info.github.replace(/\/+$/, '')}/releases` : null;
  const previousCheck = typeof update?.checkedAt === 'string' ? new Date(update.checkedAt) : null;
  const lastCheckedAt = checkedAt || (previousCheck && Number.isFinite(previousCheck.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(previousCheck) : '');
  const record = notes?.record as { announcement?: { title?: string; notes?: string[]; publishedAt?: string | null } } | undefined;
  const releaseNotes = Array.isArray(record?.announcement?.notes) ? record.announcement.notes : [];  return <div className="content-page about-page"><Heading eyebrow="ABOUT CETAMESH" title="关于 CetaMesh" description="一个连接本地工具、Agent 与工作流的桌面空间。" />{error && <ErrorNotice error={error} onRetry={() => void refresh()} />}{loading ? <LoadingState label="正在读取版本信息…" /> : info && <>
    <Surface className="about-hero"><span className="about-brand-mark"><Icon name="sparkles" size={34} /></span><span className="grow"><strong>CetaMesh Desktop</strong><small>让本地 Agent 协作保持透明、可控。</small></span><Badge tone="success">UX v2 · Harbor</Badge></Surface>
    <div className="about-facts">
      <Surface><small>版本</small><strong>{info.version ?? '未知'}</strong><span>构建号 {info.buildNumber ?? '未知'} · {info.channel ?? '未指定'}</span><small>构建标识 {info.buildId ?? '本地构建'}</small></Surface>
      <Surface><small>开发者</small><strong>{info.developer ?? '未配置'}</strong><span>{info.platform ?? 'Windows 桌面应用'}</span></Surface>
      <Surface className="update-card">
        <div className="row between"><strong>软件更新</strong><Icon name="update" size={18} /></div>
        <span>当前版本 {info.version ?? '未知'}</span>
        <span>最新版本 {latestVersion || (updateUnavailable ? '暂未获取' : '尚未检查')}</span>
        <small>更新状态：{updateStatus}</small>
        {updateFailure && <small role="status">{updateFailure}</small>}
        <small>{lastCheckedAt ? `最近检查 ${lastCheckedAt}` : '尚未检查更新'}</small>
        <div className="row">
          <Button compact disabled={checking || updateUnavailable} onClick={() => void checkUpdate()}>{checking ? '正在检查…' : '检查更新'}</Button>
          {releasePage && <Button compact onClick={() => void visit(releasePage)}>查看发布版本</Button>}
        </div>
      </Surface>
    </div>
    <section className="about-links"><h2>项目链接</h2><Surface>{linkRows.map(row => <button className="about-link-row" key={row.id} onClick={() => void visit(row.url ?? null)} disabled={!row.url?.startsWith('https://')}><Icon name="globe" size={18} /><span>{row.label}</span><span className="grow" /><small>{row.url ? row.url.replace(/^https:\/\//, '') : '未配置'}</small><Icon name="right" size={15} /></button>)}</Surface></section>
    <section className="about-links"><h2>反馈与安全</h2><Surface>{feedback?.entries.map(entry => <FeedbackLinkRow key={entry.id} entry={entry} message={feedback.message} onVisit={url => { void visit(url); }} />)}{feedback?.securityNotice && <p className="security-notice">{feedback.securityNotice}</p>}{!feedback && <p className="muted">反馈入口由本机产品配置提供。</p>}<div className="diagnostics-settings-entry"><DiagnosticsEntry/><FeedbackDeveloperButton/></div></Surface></section>
    {releaseNotes.length > 0 && <section className="about-links"><h2>更新说明</h2><Surface>{releaseNotes.map((line, index) => <div className="release-note-row" key={index}><p>{line}</p></div>)}</Surface></section>}
    <p className="about-footnote">桌面使用 WebView2 展示界面，Core 服务和命名管道保持本地运行。</p>
  </>}</div>;
}
