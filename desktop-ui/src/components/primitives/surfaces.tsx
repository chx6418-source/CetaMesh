import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '../icons';
import type { IconName } from '../icons';

export function Card({ className = '', ...props }: ComponentProps<'article'>) { return <article className={`cm-card ${className}`} {...props} />; }
export function Surface({ className = '', ...props }: ComponentProps<'section'>) { return <section className={`cm-surface ${className}`} {...props} />; }
export function Divider() { return <hr className="cm-divider" />; }
export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' }) { return <span className={`cm-badge ${tone}`}>{children}</span>; }
export function Banner({ children }: { children: ReactNode }) { return <div className="cm-banner" role="note">{children}</div>; }
export function EmptyState({ icon = 'sparkles', title, detail }: { icon?: IconName; title: string; detail: string }) { return <div className="cm-empty"><Icon name={icon} size={28} /><h3>{title}</h3><p>{detail}</p></div>; }
export function LoadingState({ label = '正在加载…' }: { label?: string }) { return <div role="status" className="cm-empty"><span className="loading-dot" />{label}</div>; }
export function ErrorState({ title = '暂时无法加载', detail }: { title?: string; detail: string }) { return <div role="alert" className="cm-empty"><Icon name="help" size={28} /><h3>{title}</h3><p>{detail}</p></div>; }
