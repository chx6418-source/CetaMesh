import {useContext,type ReactNode} from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {InteractionSuspensionContext} from './interaction-suspension';

type PopupProps = Omit<HTMLMotionProps<'div'>, 'children' | 'initial' | 'animate' | 'exit' | 'transition'> & {
  open: boolean; children: ReactNode;
};

// Keep closing popups mounted briefly, but remove them from keyboard and
// pointer interaction immediately. Reopening cancels the pending exit.
export function MotionPopup({ open, ...props }: PopupProps) {
  const parentPresent = useIsPresent();
  const suspended=useContext(InteractionSuspensionContext);
  // A nested Select may portal outside its exiting parent. Propagate closure
  // through React presence so the portal cannot remain interactive meanwhile.
  return <AnimatePresence>{open && parentPresent && !suspended && <PopupLayer key="popup" {...props} />}</AnimatePresence>;
}

function PopupLayer({ children, ...props }: Omit<PopupProps, 'open'>) {
  const present = useIsPresent();
  const suspended=useContext(InteractionSuspensionContext);
  const reduced = useReducedMotion();
  const ease = [.2, .75, .25, 1] as const;
  return <motion.div {...props} data-motion-popup="" inert={!present||suspended} aria-hidden={!present || suspended || undefined}
    style={{ ...props.style, visibility:suspended?'hidden':props.style?.visibility, pointerEvents: present&&!suspended ? props.style?.pointerEvents : 'none' }}
    initial={reduced ? false : { opacity: 0, y: -3, scale: .99 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: reduced ? 0 : -2, transition: { duration: reduced ? 0 : .1, ease } }}
    transition={{ duration: reduced ? 0 : .16, ease }}>{children}</motion.div>;
}
