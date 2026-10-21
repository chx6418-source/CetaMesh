import React, { useState } from 'react';
import Renderer, { act } from 'react-test-renderer';
import { NodeDatabase } from './helpers/NodeDatabase';
import { assembleServices } from '../app/bootstrap/assembleServices';
import { SessionOptions } from '../features/chat/SessionOptions';
import { ChatHome } from '../features/chat/ChatHome';
import { ChatScreen } from '../features/chat/ChatScreen';
import { Action } from '../shared/ui/Controls';
import { SqliteChatRepository } from '../data/repositories/SqliteChatRepository';
import type { ChatSessionConfig } from '../domain/chat/ChatRepository';
import type { ModelInfo } from '../domain/model/ModelProvider';
async function setup() {
  const db = new NodeDatabase();
  const keys = new Map<string, string>();
  const app = await assembleServices(
    db,
    {
      get: async r => keys.get(r) ?? null,
      set: async (r, s) => {
        keys.set(r, s);
      },
      delete: async r => {
        keys.delete(r);
      },
    },
    {
      json: async () => ({}),
      stream: async function* () {
        yield 'data: [DONE]\n\n';
      },
    },
  );
  return { db, app };
}
const config: ChatSessionConfig = {
  mode: 'chat',
  modelProviderId: 'a',
  modelId: 'm',
  reasoning: 'standard',
};
test('late model discovery for A is not offered after selecting provider B', async () => {
  const { app, db } = await setup();
  let resolve!: (models: ModelInfo[]) => void;
  let pending!: Promise<void>;
  app.listModels = () =>
    new Promise(r => {
      resolve = r;
    });
  const providers = ['a', 'b'].map(id => ({
    id,
    name: id,
    baseUrl: 'https://example.com',
    credentialRef: 'provider:' + id,
    supportsReasoning: false,
  }));
  function Harness() {
    const [value, onChange] = useState(config);
    return (
      <SessionOptions
        value={value}
        onChange={onChange}
        providers={providers}
        services={app}
      />
    );
  }
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<Harness />);
  });
  await act(async () => view.root.findByProps({testID: 'session-options-open'}).props.onPress());
  await act(async () => {
    pending = view.root.findByProps({testID: 'session-load-models'}).props.onPress();
  });
  await act(async () => view.root.findByProps({testID: 'session-provider-b'}).props.onPress());
  await act(async () => {
    resolve([
      { id: 'A-only-model', name: 'A-only-model', supportsReasoning: false },
    ]);
    await pending;
  });
  expect(JSON.stringify(view.toJSON())).not.toContain('A-only-model');
  await act(async () => view.unmount());
  await db.close();
});
test('overlapping session pagination appends each page only once', async () => {
  const { app, db } = await setup();
  for (let n = 0; n < 61; n++) {
    await app.sessions.create({ ...config, modelId: 'm' + n });
  }
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<ChatHome services={app} />);
  });
  const load = view.root.findByProps({ testID: 'sessions-load-more' }).props.onPress;
  await act(async () => {
    await Promise.all([load(), load()]);
  });
  const rows = view.root.findAll(
    n => n.type === Action && String(n.props.testID).startsWith('session-'),
  );
  expect(rows).toHaveLength(60);
  expect(new Set(rows.map(r => r.props.testID)).size).toBe(60);
  await act(async () => view.unmount());
  await db.close();
});
test('overlapping message pagination is unique and retry preserves a prepared next draft', async () => {
  const { app, db } = await setup();
  await app.settings.save(
    {
      id: 'a',
      name: 'A',
      baseUrl: 'https://example.com',
      supportsReasoning: false,
    },
    'KEY',
  );
  await app.reloadProviders();
  const s = await app.sessions.create(config);
  for (let n = 0; n < 30; n++) {
    await app.chat.send(s.id, 'Message-' + n);
  }
  // Recovering a process-interrupted turn creates a retryable reply.
  const repo = new SqliteChatRepository(db);
  const turn = await repo.beginTurn(s.id, 'Failed question', []);
  await repo.finishTurn(turn.assistant.id, '', 'failed', 'network_unavailable');
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <ChatScreen
        id={s.id}
        services={app}
        providers={await app.settings.list()}
        onBack={() => {}}
      />,
    );
  });
  const load = view.root.findByProps({testID: 'load-earlier-messages'}).props.onPress;
  await act(async () => {
    await Promise.all([load(), load()]);
  });
  const text = JSON.stringify(view.toJSON());
  expect(text.split('Message-0').length - 1).toBe(1);
  await act(async () =>
    view.root
      .findByProps({ testID: 'message-input' })
      .props.onChangeText('My next question'),
  );
  await act(async () => {
    await view.root.findByProps({ testID: 'retry' }).props.onPress();
  });
  expect(view.root.findByProps({ testID: 'message-input' }).props.value).toBe(
    'My next question',
  );
  await act(async () => view.unmount());
  await db.close();
});
