import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'motion/react';

type PopupProps = Omit<HTMLMotionProps<'div'>, 'children' | 'initial' | 'animate' | 'exit' | 'transition'> & {
  open: boolean; children: ReactNode;
};

// Keep closing popups mounted briefly, but remove them from keyboard and
// pointer interaction immediately. Reopening cancels the pending exit.
export function MotionPopup({ open, ...props }: PopupProps) {
  const parentPresent = useIsPresent();
  // A nested Select may portal outside its exiting parent. Propagate closure
  // through React presence so the portal cannot remain interactive meanwhile.
  return <AnimatePresence>{open && parentPresent && <PopupLayer key="popup" {...props} />}</AnimatePresence>;
}

function PopupLayer({ children, ...props }: Omit<PopupProps, 'open'>) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const ease = [.2, .75, .25, 1] as const;
  return <motion.div {...props} data-motion-popup="" inert={!present} aria-hidden={!present || undefined}
    style={{ ...props.style, pointerEvents: present ? props.style?.pointerEvents : 'none' }}
    initial={reduced ? false : { opacity: 0, y: -3, scale: .99 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: reduced ? 0 : -2, transition: { duration: reduced ? 0 : .1, ease } }}
    transition={{ duration: reduced ? 0 : .16, ease }}>{children}</motion.div>;
}
