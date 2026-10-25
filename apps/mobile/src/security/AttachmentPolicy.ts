import type { AttachmentCapability } from '../domain/capability/Attachment';
import { CetaError } from '../shared/errors/CetaError';
type Grant = { name: AttachmentCapability; expiresAt: number };
export class AttachmentPolicy {
  private readonly grants = new WeakSet<Grant>();
  constructor(
    private readonly confirm: (name: AttachmentCapability) => Promise<boolean>,
    private readonly clock: () => number = Date.now,
  ) {}
  async authorize(name: string): Promise<Grant> {
    if (name !== 'file.pick' && name !== 'photos.select') {
      throw new CetaError('permission_denied', 'Unknown capability denied');
    }
    if (!(await this.confirm(name))) {
      throw new CetaError(
        'permission_denied',
        'Attachment access was not approved',
      );
    }
    const grant: Grant = { name, expiresAt: this.clock() + 60000 };
    this.grants.add(grant);
    return grant;
  }
  consume(grant: Grant, name: string): void {
    const known = this.grants.delete(grant);
    if (!known || grant.name !== name || grant.expiresAt <= this.clock()) {
      throw new CetaError(
        'permission_denied',
        'Invalid or expired one-time permission',
      );
    }
  }
}
