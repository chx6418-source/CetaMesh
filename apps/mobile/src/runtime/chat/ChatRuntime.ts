import type {
  Attachment,
  ChatMessage,
  ChatRepository,
  MessagePage,
  Turn,
} from '../../domain/chat/ChatRepository';
import type {
  ChatRequest,
  MessageContent,
} from '../../domain/model/ModelProvider';
import { CetaError } from '../../shared/errors/CetaError';
import { newId } from '../../shared/utils/id';
import { validateAttachment } from '../../domain/capability/Attachment';
import type { ProviderRegistry } from './ProviderRegistry';
import type {SessionUsage, TokenUsage} from '../../domain/model/TokenUsage';
import {buildConversationPrompt, contextBudgetForModel, selectConversationHistory} from './PromptBuilder';
export type ChatEvent = {
  type: 'started' | 'delta' | 'settled';
  sessionId: string;
  traceId: string;
  eventId: string;
  messageId?: string;
  operation?: 'send' | 'retry' | 'continue';
  text?: string;
};
export class ChatRuntime {
  private readonly active = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  private readonly listeners = new Set<(event: ChatEvent) => void>();
  constructor(
    private readonly repository: ChatRepository,
    private readonly registry: ProviderRegistry,
  ) {}
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: Omit<ChatEvent, 'eventId'>): void {
    const value = { ...event, eventId: newId('event') };
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        /* UI listeners never interrupt durable chat state. */
      }
    }
  }
  isRunning(id: string): boolean {
    return this.active.has(id);
  }
  cancel(id: string): void {
    this.active.get(id)?.abort();
  }
  cancelAll(): void {
    for (const c of this.active.values()) {
      c.abort();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await Promise.all([...this.pending].map(p => p.catch(() => undefined)));
    this.listeners.clear();
  }
  private track(job: Promise<void>): Promise<void> {
    this.pending.add(job);
    job.then(
      () => this.pending.delete(job),
      () => this.pending.delete(job),
    );
    return job;
  }
  messages(id: string, page?: MessagePage): Promise<ChatMessage[]> {
    return this.repository.messages(id, page);
  }
  usage(id: string): Promise<SessionUsage | undefined> {return this.repository.sessionUsage(id);}
  turnUsage(messageId: string): Promise<TokenUsage | undefined> {return this.repository.turnUsage(messageId);}
  async send(
    id: string,
    text: string,
    attachments: Attachment[] = [],
    timeoutMs = 45000,
  ): Promise<void> {
    if (
      (!text.trim() && !attachments.length) ||
      text.length > 100000 ||
      attachments.length > 4
    ) {
      throw new CetaError(
        'invalid_protocol',
        'Enter a message within the size limit',
      );
    }
    return this.track(
      this.run(
        id,
        () =>
          this.repository.beginTurn(
            id,
            text,
            attachments.map(validateAttachment),
          ),
        timeoutMs,
        'send',
      ),
    );
  }
  retry(id: string): Promise<void> {
    return this.track(
      this.run(id, () => this.repository.retryTurn(id), 45000, 'retry'),
    );
  }
  continueReply(id: string): Promise<void> {
    return this.track(this.run(id, () => this.repository.resumeTurn(id), 45000, 'continue'));
  }
  private content(message: ChatMessage): MessageContent {
    if (!message.attachments.length) {
      return message.content;
    }
    const parts: Exclude<MessageContent, string>[number][] = [
      { type: 'text', text: message.content },
    ];
    for (const file of message.attachments) {
      if (file.kind === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: 'data:' + file.mime + ';base64,' + file.data },
        });
      } else {
        parts.push({
          type: 'text',
          text: 'Attached document (' + file.name + '):\n' + file.data,
        });
      }
    }
    return parts;
  }
  private async run(
    id: string,
    create: () => Promise<Turn>,
    timeoutMs: number,
    operation: 'send' | 'retry' | 'continue',
  ): Promise<void> {
    if (this.closed) {
      throw new CetaError('cancelled', 'Chat runtime is closed');
    }
    if (this.active.has(id)) {
      throw new CetaError('sync_conflict', 'A reply is already running');
    }
    const controller = new AbortController();
    this.active.set(id, controller);
    const traceId = newId('trace');
    let turn: Turn | undefined;
    let content = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {timedOut = true; controller.abort();};
    const resetIdle = (delay: number) => {
      if (timer) {clearTimeout(timer);}
      timer = setTimeout(expire, delay);
    };
    const idleTimeoutMs = timeoutMs === 45000 ? 75000 : timeoutMs;
    const aborted = () =>
      new CetaError(
        timedOut ? 'timeout' : 'cancelled',
        timedOut ? 'Provider request timed out' : 'Reply stopped',
        { context: { traceId, sessionId: id } },
      );
    try {
      const session = await this.repository.get(id);
      const provider = this.registry.get(session.config.modelProviderId);
      if (controller.signal.aborted) {
        throw aborted();
      }
      turn = await create();
      content = operation === 'continue' ? turn.assistant.content : '';
      this.emit({
        type: 'started',
        operation,
        sessionId: id,
        traceId,
        messageId: turn.assistant.id,
      });
      const inputBudgetTokens = contextBudgetForModel(session.config.modelId).inputBudgetTokens;
      let before = turn.assistant.sequence;
      let messages: Array<ChatRequest['messages'][number]> = [];
      while (true) {
        const page = await this.repository.messages(id, {limit: 200, before});
        if (!page.length) {
          break;
        }
        const completed = page
          .filter(m => m.status === 'completed')
          .map(m => ({role: m.role, content: this.content(m)} as ChatRequest['messages'][number]));
        const selection = selectConversationHistory([...completed, ...messages], inputBudgetTokens);
        messages = [...selection.history];
        if (selection.overBudget) {
          throw new CetaError(
            'unsupported',
            'The latest message is too large for the model context budget.',
          );
        }
        if (selection.truncated || page.length < 200) {
          break;
        }
        before = page[0].sequence;
      }
      if (operation === 'continue') {
        messages.push({role: 'assistant', content});
        messages.push({role: 'user', content: 'Continue the interrupted answer from its ending. Do not repeat previous text.'});
      }
      const finalSelection = selectConversationHistory(messages, inputBudgetTokens);
      if (finalSelection.overBudget) {
        throw new CetaError(
          'unsupported',
          'The latest message is too large for the model context budget.',
        );
      }
      messages = [...finalSelection.history];
      if (JSON.stringify(messages).length > 8 * 1024 * 1024) {
        throw new CetaError(
          'unsupported',
          'Conversation exceeds the request size limit',
        );
      }
      const iterator = provider
        .stream({
          modelId: session.config.modelId,
          reasoning: session.config.reasoning,
          messages: buildConversationPrompt(messages),
          signal: controller.signal,
          timeoutMs: idleTimeoutMs,
        })
        [Symbol.asyncIterator]();
      resetIdle(timeoutMs);
      hardTimer = setTimeout(expire, 10 * 60 * 1000);
      let completed = false;
      let usage: TokenUsage | undefined;
      let lastPersistedAt = Date.now();
      let lastPersistedLength = 0;
      try {
        while (!completed) {
          if (controller.signal.aborted) {
            throw aborted();
          }
          let onAbort: () => void = () => {};
          const cancellation = new Promise<never>((_, reject) => {
            onAbort = () => reject(aborted());
            controller.signal.addEventListener('abort', onAbort);
          });
          let next: Awaited<ReturnType<typeof iterator.next>>;
          try {
            next = await Promise.race([iterator.next(), cancellation]);
          } finally {
            controller.signal.removeEventListener('abort', onAbort);
          }
          if (next.done) {
            throw new CetaError(
              'network_unavailable',
              'Stream ended unexpectedly',
            );
          }
          if (next.value.type === 'done') {
            completed = true;
            break;
          }
          if (next.value.type === 'usage') {
            resetIdle(idleTimeoutMs);
            usage = next.value.usage;
            continue;
          }
          resetIdle(idleTimeoutMs);
          content += next.value.text;
          if (content.length > 4_000_000) {
            throw new CetaError(
              'unsupported',
              'Reply exceeds the size limit',
            );
          }
          if (Date.now() - lastPersistedAt >= 350 || content.length - lastPersistedLength >= 2048) {
            await this.repository.finishTurn(turn.assistant.id, content, 'streaming');
            lastPersistedAt = Date.now();
            lastPersistedLength = content.length;
          }
          this.emit({
            type: 'delta',
            sessionId: id,
            traceId,
            messageId: turn.assistant.id,
            text: content,
          });
        }
      } finally {
        iterator.return?.().catch(() => undefined);
      }
      if (controller.signal.aborted) {
        throw aborted();
      }
      await this.repository.finishTurn(turn.assistant.id, content, 'completed');
      if (usage) {
        await this.repository.recordUsage(turn.assistant.id, usage, provider.id, session.config.modelId);
      }
    } catch (error) {
      const failure = controller.signal.aborted
        ? aborted()
        : error instanceof CetaError
        ? error
        : new CetaError('provider_error', 'Chat request failed', {
            context: { traceId, sessionId: id },
          });
      if (turn) {
        await this.repository.finishTurn(
          turn.assistant.id,
          content,
          failure.code === 'cancelled' ? 'cancelled' : 'failed',
          failure.code,
        );
      }
      throw failure;
    } finally {
      if (timer) {clearTimeout(timer);}
      if (hardTimer) {clearTimeout(hardTimer);}
      this.active.delete(id);
      this.emit({
        type: 'settled',
        sessionId: id,
        traceId,
        messageId: turn?.assistant.id,
      });
    }
  }
}
