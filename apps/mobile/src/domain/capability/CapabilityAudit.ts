import type {CapabilityScope} from './Capability';

export type CapabilityAuditType =
  | 'requested'
  | 'denied'
  | 'approval_required'
  | 'started'
  | 'completed'
  | 'failed';

export type CapabilityAuditEvent = {
  readonly eventId: string;
  readonly type: CapabilityAuditType;
  readonly requestId: string;
  readonly capability: string;
  readonly caller?: string;
  readonly deviceId?: string;
  readonly taskId?: string;
  readonly scope?: CapabilityScope;
  readonly target?: string;
  readonly errorCode?: string;
};

export interface CapabilityAuditSink {
  record(event: CapabilityAuditEvent): void;
}

export class InMemoryCapabilityAuditLog implements CapabilityAuditSink {
  private readonly events: CapabilityAuditEvent[] = [];

  record(event: CapabilityAuditEvent): void {
    this.events.push({...event});
  }

  list(): readonly CapabilityAuditEvent[] {
    return this.events.map(event => ({...event}));
  }
}
