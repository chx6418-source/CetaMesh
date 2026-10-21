import { Children, forwardRef, isValidElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ComponentProps, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
type SelectOptionProps = { value?: string; disabled?: boolean; children?: ReactNode };
export function normalizeSelectOptionLabel(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    const label = String(candidate).trim();
    if (label) return label;
  }
  return '未命名选项';
}
export function Select({ label, children, value, disabled = false, className = '', id, onChange }: Omit<ComponentProps<'select'>, 'children' | 'onChange'> & { label: string; children: ReactNode; onChange?: ComponentProps<'select'>['onChange'] }) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listId = `${controlId}-options`;
  const options = useMemo(() => Children.toArray(children)
    .filter((item): item is ReactElement<SelectOptionProps> => isValidElement<SelectOptionProps>(item) && item.type === 'option')
    .map(item => ({
        value: String(item.props.value ?? (typeof item.props.children === 'string' || typeof item.props.children === 'number' ? item.props.children : '')),
      label: normalizeSelectOptionLabel(item.props.children, item.props.value),
      disabled: item.props.disabled === true
    })), [children]);
  const currentValue = String(value ?? '');
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === currentValue));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 220 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<HTMLButtonElement[]>([]);
  const typeahead = useRef('');
  const typeaheadTimer = useRef<number | null>(null);
  function updatePosition() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(rect.width, 180), Math.max(180, window.innerWidth - 16));
    const estimatedHeight = Math.min(options.length * 38 + 10, 320, window.innerHeight - 16);
    const below = rect.bottom + 4;
    const top = below + estimatedHeight <= window.innerHeight ? below : Math.max(8, rect.top - estimatedHeight - 4);
    setPosition({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width });
  }
  function openList() {
    updatePosition();
    const firstEnabled = options.findIndex(option => !option.disabled);
    setActiveIndex(options[selectedIndex]?.disabled ? Math.max(0, firstEnabled) : selectedIndex);
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open, activeIndex]);
  useEffect(() => () => { if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current); }, []);
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } } as ChangeEvent<HTMLSelectElement>);
    setOpen(false);
    triggerRef.current?.focus();
  }
  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { openList(); return; }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      for (let offset = 1; offset <= options.length; offset += 1) {
        const candidate = (activeIndex + direction * offset + options.length) % options.length;
        if (!options[candidate]?.disabled) { setActiveIndex(candidate); optionRefs.current[candidate]?.focus(); break; }
      }
    } else if (event.key === 'Home' && open) { event.preventDefault(); const index = options.findIndex(option => !option.disabled); if (index >= 0) { setActiveIndex(index); optionRefs.current[index]?.focus(); } }
    else if (event.key === 'End' && open) { event.preventDefault(); let index = options.length - 1; while (index >= 0 && options[index]?.disabled) index -= 1; if (index >= 0) { setActiveIndex(index); optionRefs.current[index]?.focus(); } }
    else if ((event.key === 'Enter' || event.key === ' ') && open) { event.preventDefault(); choose(activeIndex); }
    else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); openList(); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeahead.current += event.key.toLocaleLowerCase();
      if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current);
      typeaheadTimer.current = window.setTimeout(() => { typeahead.current = ''; typeaheadTimer.current = null; }, 700);
      const start = Math.max(-1, activeIndex);
      const ordered = [...options.slice(start + 1), ...options.slice(0, start + 1)];
      const found = ordered.find(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead.current));
      if (found) {
        const index = options.indexOf(found);
        if (!open) openList();
        setActiveIndex(index);
        if (open) optionRefs.current[index]?.focus();
        else window.setTimeout(() => optionRefs.current[index]?.focus(), 0);
      }
    }
  }
  const selected = options.find(option => option.value === currentValue);
  return <label className={`cm-select ${className}`}><span className="sr-only">{label}</span>
    <button ref={triggerRef} id={controlId} type="button" className="cm-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={() => open ? setOpen(false) : openList()} onKeyDown={handleKeyDown}>
      <span>{selected?.label ?? ''}</span><Icon name="down" size={14} />
    </button>
    {open && createPortal(<div ref={listRef} id={listId} role="listbox" aria-label={label} className="cm-select-options" style={{ position: 'fixed', top: position.top, left: position.left, width: position.width }}>
      {options.map((option, index) => <button key={`${option.value}-${index}`} ref={element => { if (element) optionRefs.current[index] = element; }} type="button" role="option" aria-selected={option.value === currentValue} className="cm-select-option" disabled={option.disabled} tabIndex={index === activeIndex ? 0 : -1} onKeyDown={handleKeyDown} onClick={() => choose(index)}>{option.label}{option.value === currentValue && <Icon name="check" size={14} />}</button>)}
    </div>, document.body)}
  </label>;
}
export function Dropdown({ label, children }: { label: string; children: ReactNode }) {
  return <details className="cm-dropdown"><summary className="cm-button">{label}<Icon name="down" size={14} /></summary><div className="cm-dropdown-menu">{children}</div></details>;
}
export function Tabs({ items, selected, onChange, label }: { items: { id: string; label: string }[]; selected: string; onChange(id: string): void; label: string }) {
  return <div className="cm-tabs" role="tablist" aria-label={label}>{items.map((item) => <button key={item.id} className="cm-tab" role="tab" aria-selected={selected === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}</div>;
}
