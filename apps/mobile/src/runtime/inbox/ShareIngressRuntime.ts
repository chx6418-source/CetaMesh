import type {ShareInput} from '../../domain/inbox';
import type {InboxItem} from '../../domain/inbox';
import type {OfflineInboxRuntime} from './OfflineInboxRuntime';
import {CetaError} from '../../shared/errors/CetaError';

export class ShareIngressRuntime {
  constructor(private readonly inbox: Pick<OfflineInboxRuntime, 'accept'>) {}

  receive(input: ShareInput): Promise<InboxItem> {
    if (!input || !['url', 'text', 'image', 'file'].includes(input.type)) { return Promise.reject(new CetaError('invalid_protocol', 'Invalid share input')); }
    if (input.type === 'url' && (!/^https?:\/\//.test(input.value) || input.value.length > 4096)) { return Promise.reject(new CetaError('permission_denied', 'Unsafe shared URL')); }
    if (input.type === 'text' && (!input.value.trim() || input.value.length > 16_000)) { return Promise.reject(new CetaError('unsupported', 'Shared text is empty or too large')); }
    if ((input.type === 'image' || input.type === 'file') && (!input.name.trim() || input.name.length > 120 || input.uri.length > 4096 || !/^(file:\/\/\/|content:\/\/[^/]+\/)/.test(input.uri) || input.uri.includes('..'))) { return Promise.reject(new CetaError('permission_denied', 'Unsafe shared reference')); }
    return this.inbox.accept({kind: 'share', payload: input});
  }
}
