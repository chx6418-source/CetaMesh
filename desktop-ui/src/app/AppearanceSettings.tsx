import { useEffect, useRef, useState } from 'react';
import { useUi, type ThemeMode } from '../stores/ui';
import { APPEARANCE_SCHEMES, DEFAULT_APPEARANCE, importBackgroundFile, type AppearancePreferences, type AppearanceScheme } from '../theme/appearance';
import { Button } from '../components/primitives/inputs';
import { Icon } from '../components/icons';
import './appearance-settings.css';

export function AppearanceSettings({ theme, onThemeChange }: { theme: ThemeMode; onThemeChange(theme: ThemeMode): Promise<void> }) {
  const appearance = useUi(state => state.appearance), setAppearance = useUi(state => state.setAppearance);
  const file = useRef<HTMLInputElement>(null), upload = useRef(0);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => () => { upload.current++; }, []);
  function save(value: Partial<AppearancePreferences>) {
    try { setAppearance(value); setError(''); return true; }
    catch { setError('外观设置未保存。本机存储空间可能不足，原设置已保留。'); return false; }
  }
  async function chooseScheme(scheme: AppearanceScheme) {
    if (!save({ scheme, accent: null })) return;
    if (scheme === 'white' || scheme === 'black') await onThemeChange(scheme === 'white' ? 'light' : 'dark');
  }
  async function chooseFile(selected?: File) {
    if (!selected) return;
    const token = ++upload.current; setLoading(true); setError('');
    try { const image = await importBackgroundFile(selected); if (token === upload.current) save({ image }); }
    catch (cause) { if (token === upload.current) setError(cause instanceof Error ? cause.message : '背景图片读取失败。'); }
    finally { if (token === upload.current) setLoading(false); }
  }
  return <div className="appearance-settings">
    <section><h3>明暗模式</h3><div className="theme-options">{(['system', 'light', 'dark'] as const).map(value => <button key={value} className={`theme-choice ${theme === value ? 'selected' : ''}`} aria-pressed={theme === value} onClick={() => void onThemeChange(value)}><span className={`theme-preview theme-${value}`}><i /><i /><i /></span><span>{value === 'system' ? '跟随系统' : value === 'light' ? '浅色' : '深色'}</span>{theme === value && <Icon name="check" size={16} />}</button>)}</div></section>
    <section><div className="row between"><h3>配色方案</h3><small className="muted">应用于整个窗口</small></div><div className="appearance-schemes">{APPEARANCE_SCHEMES.map(item => <button key={item.id} type="button" className={`appearance-scheme${appearance.scheme === item.id ? ' selected' : ''}`} aria-pressed={appearance.scheme === item.id} onClick={() => void chooseScheme(item.id)}><span style={{ backgroundColor: item.color }} /><strong>{item.label}</strong>{appearance.scheme === item.id && <Icon name="check" size={14} />}</button>)}</div><div className="appearance-accent"><label>自定义强调色<input type="color" aria-label="自定义强调色" value={appearance.accent || APPEARANCE_SCHEMES.find(item => item.id === appearance.scheme)!.color} onChange={event => save({ accent: event.target.value })} /></label>{appearance.accent && <Button compact variant="ghost" onClick={() => save({ accent: null })}>恢复方案配色</Button>}</div></section>
    <section><div className="row between"><div><h3>自定义背景</h3><p className="muted">仅保存在本机。支持 JPG、PNG、WebP，最大 10 MB。</p></div><Button compact disabled={loading} onClick={() => file.current?.click()}>{loading ? '正在读取…' : '选择背景图片'}</Button></div><input ref={file} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择自定义背景图片" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; void chooseFile(selected); }} />
      {appearance.image ? <><div className="appearance-background-preview" style={{ backgroundImage: `url("${appearance.image}")` }} aria-label="当前自定义背景预览" /><div className="appearance-background-controls"><label>显示强度 <small>{appearance.strength}%</small><input type="range" aria-label="背景显示强度" min="0" max="60" value={appearance.strength} onChange={event => save({ strength: Number(event.target.value) })} /></label><label>背景柔化 <small>{appearance.blur}</small><input type="range" aria-label="背景柔化" min="0" max="16" value={appearance.blur} onChange={event => save({ blur: Number(event.target.value) })} /></label><Button compact variant="ghost" onClick={() => { upload.current++; setLoading(false); save({ image: null }); }}>移除背景</Button></div></> : <div className="appearance-background-empty">选择一张喜欢的图片，作为整个窗口的背景。</div>}
    </section>
    {error && <p role="alert" className="appearance-error">{error}</p>}
    <div className="appearance-reset"><Button compact variant="ghost" onClick={() => { upload.current++; setLoading(false); if (save({ ...DEFAULT_APPEARANCE })) void onThemeChange('system'); }}>恢复默认外观</Button></div>
  </div>;
}
