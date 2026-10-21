import type {Approval, ApprovalDecision, ApprovalRepository, ApprovalRequest} from '../../domain/task';
import {CetaError} from '../../shared/errors/CetaError';
import {newId} from '../../shared/utils/id';

export class ApprovalRuntime {
  constructor(
    private readonly repository: ApprovalRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async request(input: ApprovalRequest): Promise<Approval> {
    const now = this.clock();
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires) || expires <= now || expires > now + 60 * 60 * 1000 || !input.reason.trim()) {
      throw new CetaError('invalid_protocol', 'Approval expiry or reason is invalid');
    }
    const nowIso = new Date(now).toISOString();
    return this.repository.create({
      ...input,
      approvalId: newId('approval'),
      status: 'pending',
      nonce: newId('approval-nonce'),
      revision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  get(approvalId: string): Promise<Approval> {
    return this.repository.get(approvalId);
  }

  async decide(approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    const current = await this.repository.get(approvalId);
    if (current.status !== 'pending') {
      return current;
    }
    if (Date.parse(current.expiresAt) <= this.clock()) {
      return this.repository.update(approvalId, 'expired', current.revision);
    }
    return this.repository.update(approvalId, decision === 'approve-once' ? 'approved' : 'denied', current.revision);
  }

  async expire(approvalId: string): Promise<Approval> {
    const current = await this.repository.get(approvalId);
    if (current.status !== 'pending' || Date.parse(current.expiresAt) > this.clock()) {
      return current;
    }
    return this.repository.update(approvalId, 'expired', current.revision);
  }

  async cancel(approvalId: string): Promise<Approval> {
    const current = await this.repository.get(approvalId);
    if (current.status !== 'pending') {
      return current;
    }
    return this.repository.update(approvalId, 'cancelled', current.revision);
  }

  async consume(approvalId: string, nonce: string): Promise<Approval> {
    const current = await this.repository.get(approvalId);
    if (current.nonce !== nonce) {
      throw new CetaError('permission_denied', 'Approval nonce is invalid');
    }
    if (current.status === 'consumed') {
      return current;
    }
    if (current.status !== 'approved' || Date.parse(current.expiresAt) <= this.clock()) {
      if (current.status === 'approved') {
        await this.repository.update(approvalId, 'expired', current.revision);
      }
      throw new CetaError('permission_denied', 'Approval is not executable');
    }
    return this.repository.update(approvalId, 'consumed', current.revision);
  }

  listPending(taskId?: string): Promise<Approval[]> {
    return this.repository.listPending(taskId);
  }
}
