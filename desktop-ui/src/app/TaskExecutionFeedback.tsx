import type { Task } from '../bridge/typed-client';
import { Button } from '../components/primitives/inputs';

export function activeTaskChildren(task: Pick<Task, 'parentTaskId' | 'children'>) {
  if (task.parentTaskId) return [];
  return (task.children ?? []).filter(child => !['completed', 'failed', 'cancelled'].includes(child.status));
}

export function taskOperationErrorMessage(cause: unknown) {
  const code = (cause as { code?: string } | null)?.code;
  if (code === 'TASK_CHILD_ACTIVE') return '该任务还有未结束的子任务。请先查看并处理子任务，再启动或继续父任务。';
  return cause instanceof Error ? cause.message : String(cause);
}

export async function validateTaskExecution(task: Task, getTask: (id: string) => Promise<{ task: Task }>) {
  const current = (await getTask(task.id)).task;
  if (!Number.isSafeInteger(task.rev) || current.rev !== task.rev) {
    throw Object.assign(new Error('任务状态已变化，请核对最新状态后再操作。'), { code: 'TASK_CONFLICT' });
  }
  if (activeTaskChildren(current).length) {
    throw Object.assign(new Error(taskOperationErrorMessage({ code: 'TASK_CHILD_ACTIVE' })), { code: 'TASK_CHILD_ACTIVE' });
  }
  return current;
}

export function TaskDependencyNotice({ task, onOpenChild }: { task: Task; onOpenChild?(id: string): void }) {
  const children = activeTaskChildren(task);
  if (!children.length) return null;
  const status = (value: string) => ({ queued: '待启动', running: '运行中', paused: '已暂停', blocked: '待核对', waiting: '等待中' } as Record<string, string>)[value] ?? '待处理';
  return <section className="task-dependency-notice" role="status"><strong>先处理子任务</strong>
    <p>还有 {children.length} 个子任务未结束，父任务暂不能启动或继续。请先处理下列子任务；如果执行结果未知，应先核对结果。</p>
    <ul>{children.map(child => <li key={child.id}>
      {onOpenChild ? <Button compact variant="ghost" onClick={() => onOpenChild(child.id)}>查看子任务：{child.title}</Button> : <span>{child.title}</span>}
      <small>{status(child.status)}</small>
    </li>)}</ul>
  </section>;
}
