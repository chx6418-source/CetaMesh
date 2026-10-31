import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './inputs';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { createPortal } from 'react-dom';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; if (open && !element.open) element.showModal(); if (!open && element.open) element.close(); }, [open]);
  const content = <dialog ref={ref} className="cm-dialog" aria-label={title} onClose={onClose} onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onClose();}}}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</dialog>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const reduced = useReducedMotion();
  return <AnimatePresence>{open && <SheetLayer key="sheet" title={title} onClose={onClose} reduced={Boolean(reduced)}>{children}</SheetLayer>}</AnimatePresence>;
}
function SheetLayer({ title, onClose, children, reduced }: { title: string; onClose(): void; children: ReactNode; reduced: boolean }) {
  const present = useIsPresent();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!present) return;
    const element = panel.current;
    if (!element) return;
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isTop = () => !document.querySelector('dialog[open]') && [...document.querySelectorAll('.cm-sheet-layer:not([inert])')].at(-1) === element.parentElement;
    const controls = () => [...element.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter(item => item.getClientRects().length && !item.closest('[inert]'));
    const frame = requestAnimationFrame(() => { if (isTop()) (controls()[0] ?? element).focus(); });
    const key = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      else if (event.key === 'Tab') {
        const items = controls(), first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (isTop() && !element.contains(event.target as Node)) (controls()[0] ?? element).focus(); };
    document.addEventListener('keydown', key); document.addEventListener('focusin', focus);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', key); document.removeEventListener('focusin', focus); if (launcher?.isConnected && !launcher.closest('[inert]')) launcher.focus(); };
  }, [present]);
  return <motion.div className="cm-sheet-layer" inert={!present} initial="closed" animate="open" exit="closed">
    <motion.button className="cm-sheet-backdrop" aria-label="关闭侧栏" onClick={onClose} variants={{ closed: { opacity: 0 }, open: { opacity: 1 } }} transition={{ duration: reduced ? 0 : .2 }} />
    <motion.aside ref={panel} role="dialog" aria-modal="true" tabIndex={-1} className="cm-sheet" aria-label={title} variants={{ closed: { opacity: 0, x: reduced ? 0 : 24 }, open: { opacity: 1, x: 0 } }} transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 38, mass: .9 }}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</motion.aside>
  </motion.div>;
}
export function Popover({ summary, children }: { summary: string; children: ReactNode }) { return <details className="cm-popover"><summary className="cm-button">{summary}</summary><div className="cm-popover-content">{children}</div></details>; }
export function Tooltip({ text, children }: { text: string; children: ReactNode }) { return <span className="cm-tooltip" data-tip={text}>{children}</span>; }
export function Toast({ children }: { children: ReactNode }) { return <div className="cm-toast" role="status">{children}</div>; }
