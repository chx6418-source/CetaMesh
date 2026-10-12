type IdentifiedMessage = { id: string };

function indexMessages<T extends IdentifiedMessage>(messages: readonly T[]): { ids: string[]; byId: Map<string, T> } {
  const ids: string[] = [];
  const byId = new Map<string, T>();
  for (const message of messages) {
    if (!byId.has(message.id)) ids.push(message.id);
    byId.set(message.id, message);
  }
  return { ids, byId };
}

export function mergeLatestChatMessages<T extends IdentifiedMessage>(current: readonly T[], latest: readonly T[]): T[] {
  const currentIndex = indexMessages(current);
  const latestIndex = indexMessages(latest);
  const ids = [...currentIndex.ids, ...latestIndex.ids.filter(id => !currentIndex.byId.has(id))];
  return ids.map(id => latestIndex.byId.get(id) ?? currentIndex.byId.get(id)!);
}

export function prependOlderChatMessages<T extends IdentifiedMessage>(current: readonly T[], older: readonly T[]): T[] {
  const currentIndex = indexMessages(current);
  const olderIndex = indexMessages(older);
  const ids = [...olderIndex.ids.filter(id => !currentIndex.byId.has(id)), ...currentIndex.ids];
  return ids.map(id => currentIndex.byId.get(id) ?? olderIndex.byId.get(id)!);
}