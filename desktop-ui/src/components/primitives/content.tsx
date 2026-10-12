import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
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
export interface VirtualListAnchor { key: string; offset: number }
export interface VirtualListRowBounds { key: string; index: number; top: number; bottom: number }
export function findVisibleVirtualAnchor(
  rows: readonly VirtualListRowBounds[],
  viewportTop: number,
  viewportBottom: number,
  isAnchorable?: (index: number) => boolean
): VirtualListAnchor | null {
  const row = rows.find(item =>
    Number.isInteger(item.index) && item.key.length > 0 &&
    (!isAnchorable || isAnchorable(item.index)) &&
    item.bottom > viewportTop && item.top < viewportBottom
  );
  return row ? { key: row.key, offset: row.top - viewportTop } : null;
}
export function scrollTopForAnchor(scrollTop: number, rowTop: number, viewportTop: number, anchorOffset: number): number {
  return scrollTop + rowTop - (viewportTop + anchorOffset);
}
export function isVirtualScrollAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 48): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
export interface VirtualListController {
  captureAnchor(): VirtualListAnchor | null;
  preserveAnchorOnNextChange(anchor: VirtualListAnchor): void;
  isAtBottom(): boolean;
  scrollToBottom(): void;
}
export function VirtualList<T>({ items, estimateSize, render, height, getItemKey, isAnchorable, controllerRef, onScrollStateChange, overlay }: {
  items: T[];
  estimateSize: number;
  render(item: T, index: number): ReactNode;
  height: number | '100%';
  getItemKey(item: T, index: number): string;
  isAnchorable?(item: T, index: number): boolean;
  controllerRef?: MutableRefObject<VirtualListController | null>;
  onScrollStateChange?(atBottom: boolean): void;
  overlay?: ReactNode;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<VirtualListAnchor | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    initialRect: { width: 1280, height: typeof height === 'number' ? height : 640 },
    estimateSize: () => estimateSize,
    getItemKey: index => getItemKey(items[index], index),
    measureElement: element => element.getBoundingClientRect().height,
    overscan: 4,
    useFlushSync: false
  });
  const controller = useMemo<VirtualListController>(() => ({
    captureAnchor: () => {
      const container = parent.current;
      if (!container) return null;
      const viewportTop = container.getBoundingClientRect().top + container.clientTop;
      const viewportBottom = viewportTop + container.clientHeight;
      const rows = [...container.querySelectorAll<HTMLElement>('[data-virtual-key]')].map(element => ({
        key: element.dataset.virtualKey ?? '',
        index: Number(element.dataset.index),
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom
      }));
      return findVisibleVirtualAnchor(
        rows,
        viewportTop,
        viewportBottom,
        index => index >= 0 && index < items.length && (!isAnchorable || isAnchorable(items[index], index))
      );
    },
    preserveAnchorOnNextChange: anchor => { pendingAnchor.current = anchor; },
    isAtBottom: () => {
      const container = parent.current;
      return !container || isVirtualScrollAtBottom(container.scrollHeight, container.scrollTop, container.clientHeight);
    },
    scrollToBottom: () => {
      const container = parent.current;
      if (!container || !items.length) return;
      virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
      window.requestAnimationFrame(() => {
        if (parent.current) parent.current.scrollTop = parent.current.scrollHeight;
      });
    }
  }), [items, isAnchorable, virtualizer]);
  useLayoutEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = controller;
    return () => { if (controllerRef.current === controller) controllerRef.current = null; };
  }, [controller, controllerRef]);
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    const index = items.findIndex((item, itemIndex) => getItemKey(item, itemIndex) === anchor.key);
    if (index < 0) { pendingAnchor.current = null; return; }
    virtualizer.scrollToIndex(index, { align: 'start' });
    const firstFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const container = parent.current;
        const row = container && [...container.querySelectorAll<HTMLElement>('[data-virtual-key]')]
          .find(element => element.dataset.virtualKey === anchor.key);
        if (container && row) {
          const viewportTop = container.getBoundingClientRect().top + container.clientTop;
          container.scrollTop = scrollTopForAnchor(container.scrollTop, row.getBoundingClientRect().top, viewportTop, anchor.offset);
        }
        pendingAnchor.current = null;
      });
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [items, getItemKey, virtualizer]);
  return <div className="virtual-list-frame" style={{ height }}>
    <div
      ref={parent}
      className="virtual-scroll message-stream"
      style={{ height: '100%' }}
      aria-live="polite"
      onScroll={event => onScrollStateChange?.(
        isVirtualScrollAtBottom(event.currentTarget.scrollHeight, event.currentTarget.scrollTop, event.currentTarget.clientHeight)
      )}
    >
      <div className="virtual-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(row => <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          data-virtual-key={getItemKey(items[row.index], row.index)}
          className="virtual-row"
          style={{ transform: `translateY(${row.start}px)` }}
        >{render(items[row.index], row.index)}</div>)}
      </div>
    </div>
    {overlay ? <div className="virtual-list-overlay">{overlay}</div> : null}
  </div>;
}
