import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './inputs';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; if (open && !element.open) element.showModal(); if (!open && element.open) element.close(); }, [open]);
  return <dialog ref={ref} className="cm-dialog" aria-label={title} onClose={onClose}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</dialog>;
}
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const reduced = useReducedMotion();
  return <AnimatePresence>{open && <SheetLayer key="sheet" title={title} onClose={onClose} reduced={Boolean(reduced)}>{children}</SheetLayer>}</AnimatePresence>;
}
function SheetLayer({ title, onClose, children, reduced }: { title: string; onClose(): void; children: ReactNode; reduced: boolean }) {
  const present = useIsPresent();
  return <motion.div className="cm-sheet-layer" inert={!present} initial="closed" animate="open" exit="closed">
    <motion.button className="cm-sheet-backdrop" aria-label="关闭侧栏" onClick={onClose} variants={{ closed: { opacity: 0 }, open: { opacity: 1 } }} transition={{ duration: reduced ? 0 : .2 }} />
    <motion.aside className="cm-sheet" aria-label={title} variants={{ closed: { opacity: 0, x: reduced ? 0 : 24 }, open: { opacity: 1, x: 0 } }} transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 38, mass: .9 }}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</motion.aside>
  </motion.div>;
}
export function Popover({ summary, children }: { summary: string; children: ReactNode }) { return <details className="cm-popover"><summary className="cm-button">{summary}</summary><div className="cm-popover-content">{children}</div></details>; }
export function Tooltip({ text, children }: { text: string; children: ReactNode }) { return <span className="cm-tooltip" data-tip={text}>{children}</span>; }
export function Toast({ children }: { children: ReactNode }) { return <div className="cm-toast" role="status">{children}</div>; }
