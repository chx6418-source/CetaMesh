import { forwardRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '../icons';
import type { IconName } from '../icons';

type ButtonProps = ComponentProps<'button'> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; compact?: boolean; icon?: IconName };
export function Button({ variant = 'default', compact = false, icon, className = '', children, ...props }: ButtonProps) {
  return <button className={`cm-button ${variant} ${compact ? 'compact' : ''} ${className}`} {...props}>{icon && <Icon name={icon} size={compact ? 14 : 16} />}{children}</button>;
}
export function IconButton({ label, icon, ...props }: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: IconName }) {
  return <Button className="cm-icon-button" variant="ghost" aria-label={label} title={label} {...props}><Icon name={icon} size={18} /></Button>;
}
export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function Input({ className = '', ...props }, ref) {
  return <input ref={ref} className={`cm-input ${className}`} {...props} />;
});
export function Textarea(props: ComponentProps<'textarea'>) { return <textarea className={`cm-textarea ${props.className ?? ''}`} {...props} />; }
export function SearchInput({ label, ...props }: ComponentProps<'input'> & { label: string }) {
  return <label className="cm-search"><span className="sr-only">{label}</span><Icon name="search" size={16} /><Input type="search" aria-label={label} {...props} /></label>;
}
export function Select({ label, children, ...props }: ComponentProps<'select'> & { label: string; children: ReactNode }) {
  return <label><span className="sr-only">{label}</span><select className="cm-select" aria-label={label} {...props}>{children}</select></label>;
}
export function Dropdown({ label, children }: { label: string; children: ReactNode }) {
  return <details className="cm-dropdown"><summary className="cm-button">{label}<Icon name="down" size={14} /></summary><div className="cm-dropdown-menu">{children}</div></details>;
}
export function Tabs({ items, selected, onChange, label }: { items: { id: string; label: string }[]; selected: string; onChange(id: string): void; label: string }) {
  return <div className="cm-tabs" role="tablist" aria-label={label}>{items.map((item) => <button key={item.id} className="cm-tab" role="tab" aria-selected={selected === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}</div>;
}
