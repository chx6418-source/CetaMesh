import type {InboxInput, InboxItem, InboxRepository} from '../../domain/inbox';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier} from '../../protocol/PairingProtocol';

function validate(input: InboxInput): void {
  if (!input || !['share', 'quick-memory', 'voice', 'task-note'].includes(input.kind)) { throw new CetaError('invalid_protocol', 'Invalid Inbox kind'); }
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || !['url', 'text', 'image', 'file', 'voice'].includes(payload.type)) { throw new CetaError('invalid_protocol', 'Invalid Inbox payload'); }
  if (payload.type === 'text') {
    const value = payload.value ?? payload.text ?? '';
    if (!value.trim() || value.length > 16_000) { throw new CetaError('unsupported', 'Inbox text is empty or too large'); }
  }
  if (payload.type === 'url' && (payload.value.length > 4096 || !/^https?:\/\/[A-Za-z0-9.-]+(?:[/:?#][^\s]*)?$/.test(payload.value))) { throw new CetaError('permission_denied', 'Inbox URL is unsafe'); }
  if ((payload.type === 'file' || payload.type === 'image') && (!payload.name.trim() || payload.name.length > 120 || payload.uri.length > 4096 || !/^(file:\/\/\/|content:\/\/[^/]+\/)/.test(payload.uri) || payload.uri.includes('..'))) { throw new CetaError('permission_denied', 'Inbox reference is unsafe'); }
  if (payload.type === 'voice' && (payload.data.length > 12 * 1024 * 1024 || payload.size <= 0 || payload.size > 8 * 1024 * 1024 || payload.durationMs <= 0 || payload.durationMs > 60_000)) { throw new CetaError('unsupported', 'Voice Inbox artifact is too large'); }
}

export class OfflineInboxRuntime {
  constructor(private readonly repository: InboxRepository) {}

  accept(input: InboxInput): Promise<InboxItem> { validate(input); return this.repository.create(input); }
  list(): Promise<InboxItem[]> { return this.repository.list(); }
  get(inboxId: string): Promise<InboxItem> { identifier(inboxId); return this.repository.get(inboxId); }
  retry(inboxId: string): Promise<InboxItem> { identifier(inboxId); return this.repository.updateStatus(inboxId, 'pending'); }
  fail(inboxId: string, error: string): Promise<InboxItem> { identifier(inboxId); return this.repository.updateStatus(inboxId, 'failed', error); }
  process(inboxId: string): Promise<InboxItem> { identifier(inboxId); return this.repository.updateStatus(inboxId, 'processing'); }

  async recoverInterrupted(): Promise<number> {
    const items = await this.repository.list();
    let recovered = 0;
    for (const item of items) {
      if (item.status === 'processing') {
        await this.repository.updateStatus(item.inboxId, 'pending', 'interrupted');
        recovered += 1;
      }
    }
    return recovered;
  }
}
