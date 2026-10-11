import { useRef } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { useVirtualizer } from '@tanstack/react-virtual';
import { openExternal } from '../../bridge/typed-client';

export function Markdown({ children }: { children: string }) {
  return <div className="cm-markdown"><ReactMarkdown components={{
    a: ({ href, children: label }) => <button className="text-link" onClick={() => { if (href) void openExternal(href); }}>{label}</button>,
    img: ({ alt }) => <span role="img" aria-label={alt || '图片'}>[图片：{alt || '未命名'}]</span>
  }}>{children}</ReactMarkdown></div>;
}
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return <figure className="code-figure"><figcaption>{language || '文本'}</figcaption><pre className="cm-code"><code>{code}</code></pre></figure>;
}
export function VirtualList<T>({ items, estimateSize, render, height }: { items: T[]; estimateSize: number; render(item: T, index: number): ReactNode; height: number }) {
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => parent.current, estimateSize: () => estimateSize, overscan: 4, useFlushSync: false });
  return <div ref={parent} className="virtual-scroll" style={{ height }}><div className="virtual-inner" style={{ height: virtualizer.getTotalSize() }}>
    {virtualizer.getVirtualItems().map((row) => <div key={row.key} className="virtual-row" style={{ transform: `translateY(${row.start}px)` }}>{render(items[row.index], row.index)}</div>)}
  </div></div>;
}
