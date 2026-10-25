import type {CapabilityRisk, CapabilityScope} from '../capability/Capability';
import type {ExecutionRef} from './ExecutionRef';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'consumed';
export type ApprovalDecision = 'deny' | 'approve-once';

export type Approval = {
  readonly approvalId: string;
  readonly taskId: string;
  readonly executionRef?: ExecutionRef;
  readonly requestedBy: string;
  readonly capability: string;
  readonly scope: CapabilityScope;
  readonly target?: string;
  readonly risk: CapabilityRisk;
  readonly reason: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly nonce: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ApprovalRequest = Omit<Approval, 'approvalId' | 'status' | 'nonce' | 'revision' | 'createdAt' | 'updatedAt'>;

export interface ApprovalRepository {
  create(approval: Approval): Promise<Approval>;
  get(approvalId: string): Promise<Approval>;
  update(approvalId: string, status: ApprovalStatus, expectedRevision: number): Promise<Approval>;
  listPending(taskId?: string): Promise<Approval[]>;
}
