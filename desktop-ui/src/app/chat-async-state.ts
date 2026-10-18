export type ChatRequestKind = 'load' | 'context' | 'older';
export type ChatRequestToken = { kind: ChatRequestKind; sessionId: string | null; generation: number };

/** Prevents a server status snapshot from replacing deltas received after that read began. */
export class ChatStreamRevision {
  private revision = 0;

  beginSnapshot() { return this.revision; }

  noteEvent() { this.revision += 1; }

  canApply(snapshotRevision: number) { return snapshotRevision === this.revision; }

  shouldApply(snapshotRevision: number, current: { state: string; displayText: string; requestId: string | null },
    next: { state: string; displayText: string; requestId: string | null }) {
    return shouldApplyChatStatusSnapshot(snapshotRevision, this.revision, current, next);
  }
}

export function shouldApplyChatStatusSnapshot(snapshotRevision: number, currentRevision: number, current: {
  state: string; displayText: string; requestId: string | null;
}, next: { state: string; displayText: string; requestId: string | null }): boolean {
  if (snapshotRevision !== currentRevision) return false;
  const currentStreaming = ['starting', 'streaming', 'recovering', 'cancelling'].includes(current.state);
  return !(currentStreaming && current.displayText && current.requestId === next.requestId
    && next.displayText.length < current.displayText.length);
}

/** Invalidates late Chat reads when the selected session changes or a newer read starts. */
export class ChatRequestEpoch {
  private activeSessionId: string | null = null;
  private generations: Record<ChatRequestKind, number> = { load: 0, context: 0, older: 0 };

  activate(sessionId: string | null) {
    if (this.activeSessionId === sessionId) return;
    this.activeSessionId = sessionId;
    for (const kind of Object.keys(this.generations) as ChatRequestKind[]) this.generations[kind] += 1;
  }

  begin(kind: ChatRequestKind, sessionId: string | null): ChatRequestToken {
    this.activate(sessionId);
    const generation = ++this.generations[kind];
    return { kind, sessionId, generation };
  }

  invalidate(kind: ChatRequestKind) {
    this.generations[kind] += 1;
  }

  isCurrent(token: ChatRequestToken, sessionId = this.activeSessionId) {
    return token.sessionId === sessionId && token.sessionId === this.activeSessionId
      && token.generation === this.generations[token.kind];
  }
}

export type ChatStreamUpdate = {
  sessionId?: string;
  requestId?: string;
  status?: string;
  retryCount?: number;
  message?: string;
  delta?: string;
  replaceText?: string;
  reset?: boolean;
  toolActivity?: unknown;
  agentActivity?: unknown;
};

/** Keep the last streamed answer until the matching durable message reaches history. */
export function pendingReplyVisible(reply: { requestId: string | null; text: string } | null,
  messages: readonly { role: string; requestId?: string | null }[]): boolean {
  return Boolean(reply?.text && reply.requestId && !messages.some(message =>
    message.role === 'assistant' && message.requestId === reply.requestId));
}

/** Apply a frame's events in order, keeping every delta and discarding stale identities. */
export function applyChatStreamUpdates<T extends {
  displayText: string;
  requestId: string | null;
  state: string;
  retryCount: number;
  statusMessage: string | null;
  toolActivity: unknown;
  agentActivity: unknown;
}>(current: T, updates: ChatStreamUpdate[], sessionId: string, activeRequestId: string | null): T {
  let next = current;
  let acceptedRequestId = activeRequestId ?? current.requestId;
  for (const update of updates) {
    if (update.sessionId !== sessionId) continue;
    const requestId = typeof update.requestId === 'string' ? update.requestId : null;
    // A reset is the explicit start boundary for a new request. It may replace
    // the prior request identity; subsequent stale events are filtered against it.
    if (!(update.reset && requestId) && requestId && acceptedRequestId && requestId !== acceptedRequestId) continue;
    if (!next || next === current) next = { ...current };
    if (update.reset) {
      next.displayText = '';
      if (requestId) {
        acceptedRequestId = requestId;
        next.requestId = requestId;
      }
    }
    if (typeof update.replaceText === 'string') next.displayText = update.replaceText;
    if (typeof update.delta === 'string' && update.delta) next.displayText += update.delta;
    next.state = update.status ?? next.state;
    next.requestId = requestId ?? next.requestId;
    next.retryCount = update.retryCount ?? next.retryCount;
    next.statusMessage = update.message ?? next.statusMessage;
    next.toolActivity = update.toolActivity ?? next.toolActivity;
    next.agentActivity = update.agentActivity === undefined ? next.agentActivity : update.agentActivity;
  }
  return next;
}
