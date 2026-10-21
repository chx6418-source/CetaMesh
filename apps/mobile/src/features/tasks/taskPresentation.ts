import type {TaskStatus} from '../../domain/task';
import {tr} from '../../shared/i18n';

export type TaskFilter = 'all' | 'active' | 'attention' | 'completed';

export function matchesFilter(status: TaskStatus, filter: TaskFilter): boolean {
  if (filter === 'all') {return true;}
  if (filter === 'active') {return status === 'queued' || status === 'running';}
  if (filter === 'attention') {return status === 'blocked' || status === 'paused' || status === 'failed';}
  return status === 'completed' || status === 'cancelled';
}

export function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    queued: tr('Queued'),
    running: tr('In progress'),
    blocked: tr('Needs attention'),
    paused: tr('Paused'),
    completed: tr('Completed'),
    failed: tr('Failed'),
    cancelled: tr('Cancelled'),
  };
  return labels[status];
}

export function clampProgress(value: number): number {
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100);
}
