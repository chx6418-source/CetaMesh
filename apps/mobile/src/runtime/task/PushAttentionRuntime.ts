import type {Approval, PushAttentionPayload} from '../../domain/task';
import type {ApprovalRuntime} from './ApprovalRuntime';
import type {Task} from '../../domain/task';
import {PUSH_EVENT_KINDS} from '../../domain/task';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier} from '../../protocol/PairingProtocol';
import type {TaskRuntime} from './TaskRuntime';

const allowedKeys = new Set(['kind', 'taskId', 'attentionId', 'eventId']);

export function validatePushPayload(value: unknown): PushAttentionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CetaError('invalid_protocol', 'Invalid push payload');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowedKeys.has(key)) || !PUSH_EVENT_KINDS.includes(record.kind as PushAttentionPayload['kind'])) {
    throw new CetaError('invalid_protocol', 'Push payload contains unsupported fields');
  }
  for (const key of ['taskId', 'attentionId', 'eventId']) {
    if (record[key] !== undefined) {
      identifier(record[key]);
    }
  }
  return {
    kind: record.kind as PushAttentionPayload['kind'],
    ...(record.taskId ? {taskId: String(record.taskId)} : {}),
    ...(record.attentionId ? {attentionId: String(record.attentionId)} : {}),
    ...(record.eventId ? {eventId: String(record.eventId)} : {}),
  };
}

export type PushOpenResult = {
  readonly payload: PushAttentionPayload;
  readonly task?: Task;
  readonly approvals: readonly Approval[];
  readonly attention: Awaited<ReturnType<TaskRuntime['listNeedsAttention']>>;
};

export class PushAttentionRuntime {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly approvals: ApprovalRuntime,
  ) {}

  async open(raw: unknown): Promise<PushOpenResult> {
    const payload = validatePushPayload(raw);
    const task = payload.taskId ? await this.tasks.get(payload.taskId) : undefined;
    const [attention, approvals] = await Promise.all([
      this.tasks.listNeedsAttention(payload.taskId),
      this.approvals.listPending(payload.taskId),
    ]);
    return {payload, task, approvals, attention};
  }
}
