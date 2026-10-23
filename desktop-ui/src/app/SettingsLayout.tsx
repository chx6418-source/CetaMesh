import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons';
const sectionIcons: Record<string, IconName> = {
  general: 'settings', models: 'layers', agents: 'agents', extensions: 'plugins', memory: 'memory',
  workspace: 'folder', devices: 'device', appearance: 'sun', security: 'shield', updates: 'update', advanced: 'sliders'
};

export function SettingsLayout({ items, selected, onChange, children }: {
  items: { id: string; label: string }[]; selected: string; onChange(id: string): void; children: ReactNode;
}) {
  return <div className="settings-layout"><nav className="settings-category-nav" aria-label="设置类别">
    {items.map(item => <button type="button" key={item.id} aria-current={selected === item.id ? 'page' : undefined}
      onClick={() => onChange(item.id)}><Icon name={sectionIcons[item.id] ?? 'settings'} size={18} /><span>{item.label}</span></button>)}
  </nav><div className="settings-content"><header className="page-heading"><div><p className="eyebrow">PREFERENCES</p><h1>设置</h1><p className="page-description">管理界面偏好与本地工作方式</p></div></header>{children}</div></div>;
}
