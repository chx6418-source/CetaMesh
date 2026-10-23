import type { PreviewSource } from '../bridge/typed-client';

export const MAX_PREVIEW_TABS = 8;
export class PreviewWebHistory {
  private entries: string[];
  private position = 0;
  private attached: string[] = [];
  private anchor = 0;
  constructor(url: string) { this.entries = [url]; }
  get current() { return this.entries[this.position]; }
  get canBack() { return this.position > 0; }
  get canForward() { return this.position < this.entries.length - 1; }
  attach() { this.attached = [...this.entries]; this.anchor = this.position; }
  snapshot(urls: string[], index: number) {
    if (!urls.length || !Number.isInteger(index) || index < 0 || index >= urls.length) return;
    const base = this.attached.length ? this.attached : this.entries;
    this.entries = urls.length === 1 ? base.map((url, i) => i === this.anchor ? urls[0] : url) : [...base.slice(0, this.anchor), ...urls];
    this.position = this.anchor + index;
    const trim = Math.max(0, this.position - 49);
    this.entries = this.entries.slice(trim, trim + 50); this.position -= trim;
  }
  record(url: string) {
    if (this.current === url) return;
    this.entries = [...this.entries.slice(0, this.position + 1), url].slice(-50);
    this.position = this.entries.length - 1;
  }
  move(delta: number) {
    const next = this.position + delta;
    if (next < 0 || next >= this.entries.length) return null;
    this.position = next;
    return this.current;
  }
}
export class PreviewLoadEpoch {
  private versions = new Map<string, number>();
  private revision = 0;
  begin(id: string) { const value = ++this.revision; this.versions.set(id, value); return value; }
  isCurrent(id: string, value: number) { return this.versions.get(id) === value; }
  close(id: string) { this.versions.delete(id); }
}
export function referenceKey(source: PreviewSource): string {
  return source.kind === 'message' ? JSON.stringify([source.kind, source.sessionId, source.messageId, source.href]) : JSON.stringify([source.kind, source.taskId, source.artifactId]);
}
export function openReferenceTab<T extends { id: string; source: PreviewSource }>(tabs: T[], tab: T): { tabs: T[]; activeId: string; overflow: boolean } {
  const existing = tabs.find(item => referenceKey(item.source) === referenceKey(tab.source));
  if (existing) return { tabs, activeId: existing.id, overflow: false };
  if (tabs.length >= MAX_PREVIEW_TABS) return { tabs, activeId: tabs.at(-1)?.id ?? '', overflow: true };
  return { tabs: [...tabs, tab], activeId: tab.id, overflow: false };
}
export function closeReferenceTab<T extends { id: string }>(tabs: T[], activeId: string, id: string) {
  const index = tabs.findIndex(tab => tab.id === id);
  const next = tabs.filter(tab => tab.id !== id);
  return { tabs: next, activeId: activeId === id ? next[Math.max(0, index - 1)]?.id ?? '' : activeId };
}
export function clampPreviewWidth(preferred: number, available: number) {
  return Math.max(0, Math.min(Math.max(320, preferred), Math.max(0, available - 320), available * .6));
}
