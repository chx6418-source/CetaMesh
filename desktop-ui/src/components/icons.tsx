import type { ComponentProps } from 'react';
import { Bot, Brain, BriefcaseBusiness, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Code2, Command, Download, FileCode2, FileText, Globe2, Image, Layers3, LayoutGrid, Menu, MessageCircle, Mic, Moon, MoreHorizontal, Music2, Paperclip, Pause, Play, PlugZap, Plus, Search, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Square, Sun, TerminalSquare, Wrench, X } from 'lucide-react';

const icons = {
  chat: MessageCircle, work: BriefcaseBusiness, memory: Brain, agents: Bot, plugins: LayoutGrid,
  settings: Settings2, search: Search, add: Plus, send: Send, attach: Paperclip, tools: Wrench,
  approval: ShieldCheck, device: Globe2, update: Download, sparkles: Sparkles, plug: PlugZap,
  music: Music2, code: Code2, globe: Globe2, image: Image, bot: Bot, layers: Layers3,
  check: Check, down: ChevronDown, left: ChevronLeft, right: ChevronRight, help: CircleHelp, shield: ShieldCheck,
  clock: Clock3, file: FileText, fileCode: FileCode2, command: Command, menu: Menu, mic: Mic,
  moon: Moon, more: MoreHorizontal, pause: Pause, play: Play, sliders: SlidersHorizontal,
  square: Square, sun: Sun, terminal: TerminalSquare, close: X
} as const;

export type IconName = keyof typeof icons;
export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & Omit<ComponentProps<'svg'>, 'ref'>) {
  const Component = icons[name];
  return <Component aria-hidden="true" size={size} strokeWidth={1.85} {...props} />;
}
