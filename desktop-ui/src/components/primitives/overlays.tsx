import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './inputs';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { createPortal } from 'react-dom';
import {InteractionSuspensionContext} from './interaction-suspension';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const suspended=useContext(InteractionSuspensionContext),programmaticCloses=useRef(0);
  useEffect(() => { const element = ref.current; if (!element) return; if (open && !suspended && !element.open) element.showModal(); if ((!open || suspended) && element.open) {programmaticCloses.current++;element.close();} }, [open,suspended]);
  const content = <dialog ref={ref} className="cm-dialog" aria-label={title} inert={suspended} aria-hidden={suspended||undefined} onClose={()=>{if(programmaticCloses.current){programmaticCloses.current--;return;}if(open&&!suspended)onClose();}} onKeyDown={event=>{if(!suspended&&event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onClose();}}}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</dialog>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const reduced = useReducedMotion();
  return <AnimatePresence>{open && <SheetLayer key="sheet" title={title} onClose={onClose} reduced={Boolean(reduced)}>{children}</SheetLayer>}</AnimatePresence>;
}
function SheetLayer({ title, onClose, children, reduced }: { title: string; onClose(): void; children: ReactNode; reduced: boolean }) {
  const present = useIsPresent();
  const suspended=useContext(InteractionSuspensionContext);
  const panel = useRef<HTMLElement>(null);
  const launcherRef=useRef<HTMLElement|null>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!present || suspended) return;
    const element = panel.current;
    if (!element) return;
    launcherRef.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const launcher=launcherRef.current;
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
  }, [present,suspended]);
  return <motion.div className="cm-sheet-layer" inert={!present||suspended} aria-hidden={suspended||undefined} style={suspended?{visibility:'hidden',pointerEvents:'none'}:undefined} initial="closed" animate="open" exit="closed">
    <motion.button className="cm-sheet-backdrop" aria-label="关闭侧栏" onClick={onClose} variants={{ closed: { opacity: 0 }, open: { opacity: 1 } }} transition={{ duration: reduced ? 0 : .2 }} />
    <motion.aside ref={panel} role="dialog" aria-modal="true" tabIndex={-1} className="cm-sheet" aria-label={title} variants={{ closed: { opacity: 0, x: reduced ? 0 : 24 }, open: { opacity: 1, x: 0 } }} transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 38, mass: .9 }}><div className="row between"><h2>{title}</h2><IconButton label="关闭" icon="close" onClick={onClose} /></div>{children}</motion.aside>
  </motion.div>;
}
export function Popover({ summary, label, children, className = '', triggerClassName = '', width = 360, avoidOverlapWith }: { summary: ReactNode; label?: string; children: ReactNode | ((close: () => void) => ReactNode); className?: string; triggerClassName?: string; width?: number; avoidOverlapWith?:string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, left: 8, width, maxHeight: 420 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const suspended = useContext(InteractionSuspensionContext), id = useId();
  const close = useCallback((restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (!open || suspended) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const region = avoidOverlapWith ? trigger.current?.closest(avoidOverlapWith)?.getBoundingClientRect() : null;
      const anchorTop = Math.min(rect.top, region?.top ?? rect.top), anchorBottom = Math.max(rect.bottom, region?.bottom ?? rect.bottom);
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth, viewportHeight = viewport?.height ?? window.innerHeight;
      const panelWidth = Math.min(width, viewportWidth - 24);
      const above = anchorTop - y - 20, below = y + viewportHeight - anchorBottom - 20;
      const useAbove = above >= 180 || above >= below;
      const maxHeight = Math.max(80, Math.min(520, useAbove ? above : below));
      const height = Math.min(panel.current?.scrollHeight ?? maxHeight, maxHeight);
      setPosition({ width: panelWidth, maxHeight, left: Math.max(x + 12, Math.min(rect.right - panelWidth, x + viewportWidth - panelWidth - 12)), top: useAbove ? Math.max(y + 12, anchorTop - height - 8) : anchorBottom + 8 });
    };
    update();
    const observer = new ResizeObserver(update); if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); window.visualViewport?.removeEventListener('resize', update); };
  }, [open, suspended, width, avoidOverlapWith]);
  useEffect(() => {
    if (!open || suspended) return;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('input,button:not([disabled]),[tabindex="0"]') ?? panel.current)?.focus());
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    const focus = (event: FocusEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); document.addEventListener('focusin', focus);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); document.removeEventListener('focusin', focus); };
  }, [open, suspended, close]);
  return <span className={`cm-popover ${className}`}><button ref={trigger} type="button" className={`cm-button ${triggerClassName}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open && !suspended} aria-controls={open ? id : undefined} onClick={() => { if (!suspended) setOpen(value => !value); }}>{summary}</button>{open && !suspended && typeof document !== 'undefined' && createPortal(<div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1} className={`cm-popover-content cm-anchored-popover ${className}`} style={{ position: 'fixed', bottom: 'auto', ...position }}>{typeof children === 'function' ? children(() => close()) : children}</div>, document.body)}</span>;
}
export function Tooltip({ text, children }: { text: string; children: ReactNode }) { return <span className="cm-tooltip" data-tip={text}>{children}</span>; }
export function Toast({ children }: { children: ReactNode }) { return <div className="cm-toast" role="status">{children}</div>; }
