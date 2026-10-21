import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {assembleServices} from '../app/bootstrap/assembleServices';
import {TaskScreen} from '../features/tasks/TaskScreen';
import {TasksScreen} from '../features/tasks/TasksScreen';
import {ActionCenterScreen} from '../features/approvals/ActionCenterScreen';
import {CetaError} from '../shared/errors/CetaError';
import {NodeDatabase} from './helpers/NodeDatabase';

async function services() {
  const db = new NodeDatabase();
  const app = await assembleServices(
    db,
    {get: async () => null, set: async () => undefined, delete: async () => undefined},
    {json: async () => ({}), stream: async function* () {yield ''; }},
  );
  return {db, app};
}

test('Task screen renders Task-first execution context and attention summary', async () => {
  const {db, app} = await services();
  const task = await app.tasks.create({taskId: 'task-ui', goal: 'Review a document', source: 'mobile', phase: 'executing'});
  await app.tasks.update(task.taskId, {
    status: 'running',
    progress: 0.5,
    providerExecutionRef: {providerId: 'desktop-provider', executionId: 'exec-1', sessionId: 'session-1', state: 'running', contextUsage: {usedTokens: 10, limitTokens: 100}},
  });
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<TaskScreen services={app} taskId={task.taskId} onBack={() => undefined} />);
  });
  await act(async () => undefined);
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('进度');
  expect(output).toContain('desktop-provider');
  expect(output).toContain('session-1');
  expect(output).toContain('上下文');
  expect(output).toContain('当前阶段');
  const progress = view.root.findByProps({accessibilityLabel: '任务进度'});
  expect(progress.props.accessibilityRole).toBe('progressbar');
  expect(progress.props.accessibilityValue).toEqual({min: 0, max: 100, now: 50});
  await db.close();
});

test('操作中心 aggregates approvals and questions without exposing raw payloads', async () => {
  const {db, app} = await services();
  const task = await app.tasks.create({taskId: 'task-action', goal: 'Handle an approval', source: 'mobile', phase: 'waiting'});
  await app.tasks.appendEvent({eventId: 'approval-attention', taskId: task.taskId, type: 'approval.required', revision: 1, payload: {title: 'Allow once?', summary: 'Camera'}, createdAt: '2026-09-30T00:00:00.000Z'});
  const approval = await app.approvals.request({
    taskId: task.taskId,
    requestedBy: 'task-runtime',
    capability: 'camera.capture',
    scope: {kind: 'task', id: task.taskId},
    target: 'https://private.example/endpoint',
    risk: 'high',
    reason: 'Capture one image after approval',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<ActionCenterScreen services={app} onBack={() => undefined} />);
  });
  await act(async () => undefined);
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('操作中心');
  expect(output).toContain('Allow once?');
  expect(output).toContain('Capture one image after approval');
  expect(output).not.toContain('private.example');
  expect(output).not.toContain('Private payload');
  await act(async () => {
    await view.root.findByProps({testID: `reject-${approval.approvalId}`}).props.onPress();
  });
  expect(await app.approvals.listPending()).toHaveLength(0);
  await db.close();
});

test('Tasks workspace summarizes status, filters task cards, and opens task and action details', async () => {
  const {db, app} = await services();
  const running = await app.tasks.create({taskId: 'task-running-ui', goal: 'Prepare a report', source: 'mobile', phase: 'drafting'});
  await app.tasks.update(running.taskId, {status: 'running', progress: 0.35});
  const blocked = await app.tasks.create({taskId: 'task-blocked-ui', goal: 'Choose a direction', source: 'desktop-node', phase: 'waiting'});
  await app.tasks.update(blocked.taskId, {status: 'blocked', progress: 0.6});
  await app.tasks.appendEvent({eventId: 'question-blocked-ui', taskId: blocked.taskId, type: 'question.required', revision: 3, payload: {title: 'Which direction?', summary: 'Two options'}, createdAt: '2026-10-01T00:00:00.000Z'});
  const completed = await app.tasks.create({taskId: 'task-done-ui', goal: 'Send summary', source: 'mobile', phase: 'done'});
  await app.tasks.update(completed.taskId, {status: 'completed', progress: 1});

  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<TasksScreen services={app} />);
  });
  await act(async () => undefined);
  let output = JSON.stringify(view.toJSON());
  expect(output).toContain('Prepare a report');
  expect(output).toContain('Choose a direction');
  expect(output).toContain('Send summary');
  expect(output).toContain('操作中心');

  await act(async () => view.root.findByProps({testID: 'tasks-filter-attention'}).props.onPress());
  output = JSON.stringify(view.toJSON());
  expect(output).toContain('Choose a direction');
  expect(output).not.toContain('Prepare a report');
  expect(output).not.toContain('Send summary');

  await act(async () => view.root.findByProps({testID: `task-${blocked.taskId}`}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('任务详情');
  await act(async () => view.root.findByProps({testID: 'back-tasks'}).props.onPress());
  await act(async () => view.root.findByProps({testID: 'tasks-action-center'}).props.onPress());
  expect(JSON.stringify(view.toJSON())).toContain('操作中心');

  await act(async () => view.unmount());
  await db.close();
});

test('Tasks workspace does not show an empty state when loading fails', async () => {
  const {db, app} = await services();
  app.tasks.list = async () => {
    throw new CetaError('network_unavailable', 'Connection lost');
  };

  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<TasksScreen services={app} />);
  });

  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('网络不可用，请连接后重试。');
  expect(output).toContain('无法加载任务统计');
  expect(output).not.toContain('还没有任务');
  expect(output).not.toContain('任务进展');
  expect(output).not.toContain('Work keeps its progress');

  await act(async () => view.unmount());
  await db.close();
});

test('操作中心 does not say the user is caught up when loading fails', async () => {
  const {db, app} = await services();
  app.actionCenter.list = async () => {
    throw new CetaError('network_unavailable', 'Connection lost');
  };

  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<ActionCenterScreen services={app} onBack={() => undefined} />);
  });

  expect(view.root.findAllByProps({testID: 'action-center-empty'})).toHaveLength(0);
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('网络不可用，请连接后重试。');
  expect(output).toContain('无法加载待处理状态');
  expect(output).not.toContain('You’re all caught up');
  await act(async () => view.unmount());
  await db.close();
});
