import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, TextInput } from 'react-native';
import { NodeDatabase } from './helpers/NodeDatabase';
import { assembleServices } from '../app/bootstrap/assembleServices';
import { ChatHome } from '../features/chat/ChatHome';
import { ChatScreen } from '../features/chat/ChatScreen';
import { SqliteChatRepository } from '../data/repositories/SqliteChatRepository';
import { CetaError } from '../shared/errors/CetaError';
async function setup() {
  const app = await assembleServices(
    new NodeDatabase(),
    { get: async () => null, set: async () => {}, delete: async () => {} },
    {
      json: async () => {
        throw new Error('No network');
      },
      stream: async function* () {
        throw new Error('No network');
      },
    },
  );
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<ChatHome services={app} />);
  });
  const press = async (id: string) => {
    await act(async () => {
      await view.root.findByProps({ testID: id }).props.onPress();
    });
  };
  const change = async (id: string, value: string) => {
    await act(async () => {
      view.root.findByProps({ testID: id }).props.onChangeText(value);
    });
  };
  return { app, view, press, change };
}
test('Memory works without Provider, supports create/search/edit/pin and confirmed deletion', async () => {
  const { app, view, press, change } = await setup();
  await press('tab-memory');
  await press('memory-new');
  await change('memory-content', '我喜欢乌龙茶');
  await press('memory-kind-user');
  await press('memory-save');
  const [saved] = await app.memory.search();
  expect(saved.kind).toBe('user');
  expect(saved.scope).toBe('local-only');
  await press('memory-list');
  await change('memory-search', '不存在');
  expect(JSON.stringify(view.toJSON())).not.toContain('我喜欢乌龙茶');
  await change('memory-search', '乌龙茶');
  await press('memory-' + saved.id);
  const detail = JSON.stringify(view.toJSON());
  expect(detail).toContain('记忆详情');
  expect(detail).toContain('Local only');
  expect(detail).toContain('手动保存');
  expect(detail).toContain('更新时间');
  await press('memory-pin');
  expect((await app.memory.get(saved.id)).pinned).toBe(true);
  await press('memory-edit');
  await change('memory-content', '我喜欢清淡的茶');
  await press('memory-save');
  expect(JSON.stringify(view.toJSON())).toContain('记忆详情');
  await press('memory-list');
  await change('memory-search', '');
  await press('memory-' + saved.id);
  expect((await app.memory.get(saved.id)).content).toBe('我喜欢清淡的茶');
  let confirm: (() => void) | undefined;
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _text, buttons) => {
      confirm = buttons?.find(b => b.style === 'destructive')
        ?.onPress as () => void;
    });
  await press('memory-delete');
  expect(await app.memory.search()).toHaveLength(1);
  await act(async () => {
    await confirm!();
  });
  expect(await app.memory.search()).toEqual([]);
  alert.mockRestore();
  await act(async () => view.unmount());
  await app.close();
});

test('Memory does not show an empty library when the search fails', async () => {
  const {app, view, press} = await setup();
  app.memory.search = async () => {
    throw new CetaError('network_unavailable', 'Connection lost');
  };

  await press('tab-memory');

  expect(view.root.findAllByProps({testID: 'memory-empty-state'})).toHaveLength(0);
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('网络不可用，请连接后重试。');
  expect(output).toContain('无法加载记忆列表');
  await act(async () => view.unmount());
  await app.close();
});

test('Use in Chat opens an editable memory draft without sending it', async () => {
  const {app, view, press, change} = await setup();
  const session = await app.sessions.create({
    mode: 'chat',
    modelProviderId: 'p',
    modelId: 'm',
    reasoning: 'standard',
  });
  const saved = await app.memory.save({kind: 'user', content: 'I prefer concise answers'});

  await press('tab-memory');
  await press('memory-' + saved.id);
  await press('memory-use-in-chat');
  await press('memory-use-session-' + session.id);

  expect(view.root.findByProps({testID: 'message-input'}).props.value).toBe(
    'I prefer concise answers',
  );
  expect(JSON.stringify(view.toJSON())).toContain('发送前请检查这条记忆');
  expect(await app.chat.messages(session.id)).toEqual([]);

  await change('message-input', 'Please apply this preference: I prefer concise answers');
  await press('tab-memory');
  await press('tab-chat');
  expect(view.root.findByProps({testID: 'message-input'}).props.value).toBe(
    'Please apply this preference: I prefer concise answers',
  );
  expect(await app.chat.messages(session.id)).toEqual([]);

  await act(async () => view.unmount());
  await app.close();
});
test('chat preview saves only the confirmed edited candidate and retains next message draft', async () => {
  const db = new NodeDatabase();
  const app = await assembleServices(
    db,
    { get: async () => null, set: async () => {}, delete: async () => {} },
    {
      json: async () => ({}),
      stream: async function* () {
        throw new Error('No extraction network');
      },
    },
  );
  const session = await app.sessions.create({
    mode: 'chat',
    modelProviderId: 'p',
    modelId: 'm',
    reasoning: 'standard',
  });
  const repo = new SqliteChatRepository(db);
  for (const text of ['记住：我喜欢茶', '记住：我喜欢蓝色']) {
    const t = await repo.beginTurn(session.id, text, []);
    await repo.finishTurn(t.assistant.id, 'Okay', 'completed');
  }
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <ChatScreen
        id={session.id}
        services={app}
        providers={[]}
        onBack={() => {}}
      />,
    );
  });
  await act(async () =>
    view.root
      .findByProps({ testID: 'message-input' })
      .props.onChangeText('Next draft'),
  );
  await act(async () => {
    view.root.findByProps({testID: 'chat-session-menu-open'}).props.onPress();
  });
  await act(async () => {
    await view.root.findByProps({testID: 'review-memory'}).props.onPress();
  });
  expect(await app.memory.search()).toEqual([]);
  const candidateInput = view.root.findAll(
    n =>
      n.props.testID?.startsWith('candidate-content-') && n.type === TextInput,
  )[0];
  const id = candidateInput.props.testID.replace('candidate-content-', '');
  await act(async () => candidateInput.props.onChangeText('我喜欢绿茶'));
  await act(async () => {
    await view.root
      .findByProps({ testID: 'candidate-confirm-' + id })
      .props.onPress();
  });
  const reject = view.root.findAll(n =>
    n.props.testID?.startsWith('candidate-reject-'),
  )[0];
  await act(async () => reject.props.onPress());
  expect((await app.memory.search()).map(m => m.content)).toEqual([
    '我喜欢绿茶',
  ]);
  expect(JSON.stringify(view.toJSON())).toContain(session.id);
  await act(async () =>
    view.root.findByProps({ testID: 'memory-review-back' }).props.onPress(),
  );
  expect(view.root.findByProps({ testID: 'message-input' }).props.value).toBe(
    'Next draft',
  );
  await act(async () => view.unmount());
  await app.close();
});
test('reselecting the active filter cannot invalidate an in-flight search', async () => {
  const { app, view, press, change } = await setup();
  const a = await app.memory.save({ kind: 'user', content: 'Tea result' });
  const search = app.memory.search.bind(app.memory);
  let release!: () => void;
  const wait = new Promise<void>(r => {
    release = r;
  });
  app.memory.search = async q => {
    if (q?.query === 'Tea') {
      await wait;
    }
    return search(q);
  };
  await press('tab-memory');
  await change('memory-search', 'Tea');
  await press('memory-filter-recent');
  await act(async () => release());
  expect(JSON.stringify(view.toJSON())).toContain(a.content);
  expect(view.root.findAllByProps({testID: 'memory-loading'})).toHaveLength(0);
  await act(async () => view.unmount());
  await app.close();
});
test('filter switches discard obsolete results and page loads remain unique', async () => {
  const { app, view, press, change } = await setup();
  for (let n = 0; n < 61; n++) {
    await app.memory.save({
      kind: n === 0 ? 'user' : 'local',
      content: 'Note ' + n,
    });
  }
  await press('tab-memory');
  const load = view.root.findByProps({ testID: 'memory-more' }).props.onPress;
  await act(async () => {
    await Promise.all([load(), load()]);
  });
  const rowIds = new Set(
    view.root
      .findAll(n => n.props.testID?.startsWith('memory-memory') && n.props.accessibilityRole === 'button')
      .map(row => row.props.testID),
  );
  expect(rowIds.size).toBe(60);
  const search = app.memory.search.bind(app.memory);
  let release!: () => void;
  const wait = new Promise<void>(r => {
    release = r;
  });
  app.memory.search = async q => {
    if (q?.query === 'Note 0') {
      await wait;
    }
    return search(q);
  };
  await change('memory-search', 'Note 0');
  await change('memory-search', 'Note 1');
  await act(async () => release());
  expect(JSON.stringify(view.toJSON())).not.toContain('Note 0');
  await press('memory-filter-user');
  expect(
    new Set(
      view.root
        .findAll(n => n.props.testID?.startsWith('memory-memory') && n.props.accessibilityRole === 'button')
        .map(row => row.props.testID),
    ).size,
  ).toBe(0);
  await act(async () => view.unmount());
  await app.close();
});
