import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {assembleServices} from '../app/bootstrap/assembleServices';
import {ChatScreen} from '../features/chat/ChatScreen';
import {SqliteChatRepository} from '../data/repositories/SqliteChatRepository';
import {NodeDatabase} from './helpers/NodeDatabase';

async function renderConversation() {
  const db = new NodeDatabase();
  const app = await assembleServices(
    db,
    {get: async () => null, set: async () => undefined, delete: async () => undefined},
    {json: async () => ({}), stream: async function* () {yield ''; }},
  );
  const session = await app.sessions.create({
    mode: 'chat',
    modelProviderId: 'provider-a',
    modelId: 'model-a',
    reasoning: 'standard',
  });
  const messages = new SqliteChatRepository(db);
  const complete = await messages.beginTurn(session.id, 'A message to remember', []);
  await messages.finishTurn(complete.assistant.id, 'A helpful answer', 'completed');
  await messages.recordUsage(complete.assistant.id, {inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 90, cacheMissInputTokens: 10, providerReported: true}, 'provider-a', 'model-a');
  const failed = await messages.beginTurn(session.id, 'A request that failed', []);
  await messages.finishTurn(failed.assistant.id, '', 'failed', 'network_unavailable');

  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <ChatScreen
        id={session.id}
        services={app}
        providers={[
          {
            id: 'provider-a',
            name: 'Provider A',
            baseUrl: 'https://example.com/v1',
            credentialRef: 'provider:provider-a',
            supportsReasoning: true,
          },
        ]}
        onBack={() => undefined}
      />,
    );
  });
  await act(async () => undefined);
  return {app, view, complete, failed};
}

test('chat keeps messages separate from a fixed composer and offers retry on failed turns', async () => {
  const {app, view, complete, failed} = await renderConversation();
  const output = JSON.stringify(view.toJSON());

  expect(view.root.findByProps({testID: 'chat-message-list'})).toBeDefined();
  expect(view.root.findByProps({testID: 'chat-composer'})).toBeDefined();
  const composer = view.root.findByProps({testID: 'chat-composer'});
  expect(composer.findByProps({testID: 'composer-status-row'})).toBeDefined();
  expect(composer.findByProps({testID: 'session-options-open'})).toBeDefined();
  expect(composer.findByProps({testID: 'session-usage-open'})).toBeDefined();
  expect(view.root.findByProps({testID: 'message-input'}).props.placeholder).toBe('输入消息…');
  expect(view.root.findByProps({testID: `message-${complete.assistant.id}`})).toBeDefined();
  expect(view.root.findByProps({testID: `message-${failed.assistant.id}`})).toBeDefined();
  expect(output).toContain('A helpful answer');
  expect(output).toContain('网络连接中断');
  expect(view.root.findByProps({testID: 'retry'})).toBeDefined();
  expect(view.root.findByProps({testID: 'message-input'}).props.multiline).toBe(true);

  await act(async () => view.unmount());
  await app.close();
});

test('session usage shows provider counts and a detailed Chinese sheet', async () => {
  const {app, view} = await renderConversation();
  expect(view.root.findByProps({testID: 'session-usage-open'})).toBeDefined();
  await act(async () => view.root.findByProps({testID: 'session-usage-open'}).props.onPress());
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('会话用量');
  expect(output).toContain('缓存命中');
  expect(output).toContain('100');
  await act(async () => view.unmount());
  await app.close();
});

test('chat settings and session actions open focused sheets', async () => {
  const {app, view} = await renderConversation();
  const press = async (testID: string) => {
    await act(async () => view.root.findByProps({testID}).props.onPress());
  };

  await press('session-options-open');
  expect(view.root.findByProps({testID: 'session-options-sheet-modal'}).props.visible).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain('推理强度');
  await press('session-options-sheet-close');
  await press('chat-session-menu-open');
  expect(JSON.stringify(view.toJSON())).toContain('重命名会话');
  expect(JSON.stringify(view.toJSON())).toContain('归档会话');

  await act(async () => view.unmount());
  await app.close();
});

test('attachment action opens a sheet and explains when platform pickers are unavailable', async () => {
  const {app, view} = await renderConversation();
  await act(async () => view.root.findByProps({testID: 'attachments-open'}).props.onPress());

  expect(view.root.findByProps({testID: 'attachment-sheet-modal'}).props.visible).toBe(true);
  expect(view.root.findAllByProps({testID: 'attachment-sheet-close'})).toHaveLength(0);
  const backdrop = view.root.findByProps({testID: 'attachment-sheet-backdrop'});
  expect(backdrop.props.onPress).toBeDefined();
  expect(JSON.stringify(view.root.findByProps({testID: 'attachment-sheet-content'}).parent?.props.style)).toContain('transparent');
  expect(JSON.stringify(view.toJSON())).toContain('此设备暂不支持添加附件');
  await act(async () => view.unmount());
  await app.close();
});
