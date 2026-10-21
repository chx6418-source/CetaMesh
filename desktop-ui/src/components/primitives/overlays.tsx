import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './inputs';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; if (open && !element.open) element.showModal(); if (!open && element.open) element.close(); }, [open]);
  return <dialog ref={ref} className="cm-dialog" aria-label={title} onClose={onClose}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</dialog>;
}
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  if (!open) return null;
  return <><button className="cm-sheet-backdrop" aria-label="关闭侧栏" onClick={onClose} /><aside className="cm-sheet" aria-label={title}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</aside></>;
}
export function Popover({ summary, children }: { summary: string; children: ReactNode }) { return <details className="cm-popover"><summary className="cm-button">{summary}</summary><div className="cm-popover-content">{children}</div></details>; }
export function Tooltip({ text, children }: { text: string; children: ReactNode }) { return <span className="cm-tooltip" data-tip={text}>{children}</span>; }
export function Toast({ children }: { children: ReactNode }) { return <div className="cm-toast" role="status">{children}</div>; }
