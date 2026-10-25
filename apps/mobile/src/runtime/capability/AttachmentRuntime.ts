import type { Attachment } from '../../domain/chat/ChatRepository';
import type {
  AttachmentCapability,
  AttachmentProvider,
} from '../../domain/capability/Attachment';
import { validateAttachment } from '../../domain/capability/Attachment';
import type { AttachmentPolicy } from '../../security/AttachmentPolicy';
import { CetaError } from '../../shared/errors/CetaError';
import type { CapabilityRequest, CapabilityRuntime } from './CapabilityRuntime';
export class AttachmentRuntime implements CapabilityRuntime {
  private picking = false;
  constructor(
    private readonly policy: AttachmentPolicy,
    private readonly provider: AttachmentProvider,
  ) {}
  async invoke(request: CapabilityRequest): Promise<Attachment> {
    if (request.input !== undefined && request.input !== null) {
      throw new CetaError(
        'permission_denied',
        'Arbitrary attachment paths are not accepted',
      );
    }
    const grant = await this.policy.authorize(request.name);
    if (this.picking) {
      throw new CetaError('sync_conflict', 'Another picker is already open');
    }
    this.policy.consume(grant, request.name);
    this.picking = true;
    try {
      return validateAttachment(await this.provider.pick(grant.name));
    } catch (e) {
      throw e instanceof CetaError
        ? e
        : new CetaError('provider_error', 'Attachment selection failed');
    } finally {
      this.picking = false;
    }
  }
  pick(name: AttachmentCapability): Promise<Attachment> {
    return this.invoke({ name, input: undefined });
  }
}
