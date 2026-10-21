type IdentifiedMessage = { id: string };

export async function recoverForwardHistory<T extends { messages: IdentifiedMessage[]; hasMoreAfter?: boolean; nextAfterMessageId?: string | null }>(
  initialCursor: string | null,
  fetchPage: (cursor: string | null) => Promise<T>,
  isCurrent: () => boolean,
  applyPage: (page: T, first: boolean) => void
): Promise<void> {
  let cursor = initialCursor;
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
    if (!isCurrent()) return;
    const page = await fetchPage(cursor);
    if (!isCurrent()) return;
    applyPage(page, pageIndex === 0);
    if (!page.hasMoreAfter) return;
    const next = page.nextAfterMessageId;
    if (!next || next === cursor || seen.has(next)) throw new Error('消息恢复游标未前进，请重新加载会话。');
    seen.add(next);
    cursor = next;
  }
  throw new Error('消息恢复分页达到安全上限，请继续刷新会话。');
}

function indexMessages<T extends IdentifiedMessage>(messages: readonly T[]): { ids: string[]; byId: Map<string, T> } {
  const ids: string[] = [];
  const byId = new Map<string, T>();
  for (const message of messages) {
    if (!byId.has(message.id)) ids.push(message.id);
    byId.set(message.id, message);
  }
  return { ids, byId };
}

export function mergeLatestChatMessages<T extends IdentifiedMessage>(
  current: readonly T[], latest: readonly T[], preserveCurrentIds: ReadonlySet<string> = new Set()
): T[] {
  const currentIndex = indexMessages(current);
  const latestIndex = indexMessages(latest);
  const ids = [...currentIndex.ids, ...latestIndex.ids.filter(id => !currentIndex.byId.has(id))];
  return ids.map(id => preserveCurrentIds.has(id)
    ? currentIndex.byId.get(id)!
    : latestIndex.byId.get(id) ?? currentIndex.byId.get(id)!);
}

export function mergeChatHistorySnapshot<T extends IdentifiedMessage>(
  current: readonly T[], latest: readonly T[], sameSession: boolean, preserveCurrentIds: ReadonlySet<string> = new Set()
): T[] {
  return mergeLatestChatMessages(sameSession ? current : [], latest, preserveCurrentIds);
}

export function prependOlderChatMessages<T extends IdentifiedMessage>(current: readonly T[], older: readonly T[]): T[] {
  const currentIndex = indexMessages(current);
  const olderIndex = indexMessages(older);
  const ids = [...olderIndex.ids.filter(id => !currentIndex.byId.has(id)), ...currentIndex.ids];
  return ids.map(id => currentIndex.byId.get(id) ?? olderIndex.byId.get(id)!);
}
