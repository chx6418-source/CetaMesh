import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { NodeDatabase } from './helpers/NodeDatabase';
import { assembleServices } from '../app/bootstrap/assembleServices';
import { ChatHome } from '../features/chat/ChatHome';
import MobileApp from '../app/bootstrap/MobileApp';
import {CetaError} from '../shared/errors/CetaError';

async function services() {
  const db = new NodeDatabase();
  const secrets = new Map<string, string>();
  const app = await assembleServices(
    db,
    {
      get: async r => secrets.get(r) ?? null,
      set: async (r, s) => {
        secrets.set(r, s);
      },
      delete: async r => {
        secrets.delete(r);
      },
    },
    {
      json: async () => ({ data: [{ id: 'test-model' }] }),
      stream: async function* () {
        yield 'data: {"choices":[{"delta":{"content":"Reply from model"}}]}\n\ndata: [DONE]\n\n';
      },
    },
  );
  return { app, db, secrets };
}
test('fresh setup saves key securely, creates a session, sends, and restores history on remount', async () => {
  const { app, db, secrets } = await services();
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<ChatHome services={app} />);
  });
  expect(JSON.stringify(view.toJSON())).toContain('添加模型服务');
  const change = async (id: string, value: string) => {
    await act(async () =>
      view.root.findByProps({ testID: id }).props.onChangeText(value),
    );
  };
  const press = async (id: string) => {
    await act(async () =>
      view.root.findByProps({ testID: id }).props.onPress(),
    );
  };
  await press('tab-workspace');
  await press('settings');
  expect(JSON.stringify(view.toJSON())).toContain('模型服务');
  await press('provider-add');
  await change('provider-name', 'My Provider');
  await change('provider-url', 'https://example.com/v1');
  await change('provider-key', 'TOP_SECRET');
  await press('provider-save');
  expect(JSON.stringify(view.toJSON())).toContain('My Provider');
  expect(secrets.size).toBe(1);
  expect(JSON.stringify(view.toJSON())).not.toContain('TOP_SECRET');
  await press('back-workspace');
  await press('tab-chat');
  await press('session-options-open');
  await change('model-id', 'test-model');
  await press('session-options-sheet-close');
  await press('new-chat');
  await change('message-input', 'Hello independent Mobile');
  await press('send');
  expect(JSON.stringify(view.toJSON())).toContain('Reply from model');
  const rows = await db.executeAsync('SELECT * FROM model_providers');
  expect(JSON.stringify(rows)).not.toContain('TOP_SECRET');
  await act(async () => {
    view.unmount();
    view = Renderer.create(<ChatHome services={app} />);
  });
  const sessions = await app.sessions.list();
  await press('session-' + sessions[0].id);
  expect(JSON.stringify(view.toJSON())).toContain('Hello independent Mobile');
  await act(async () => view.unmount());
  await db.close();
});
test('bootstrap shows standardized database failure without raw exception', async () => {
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(
      <MobileApp
        load={async () => {
          throw new Error('SECRET exception');
        }}
      />,
    );
  });
  const json = JSON.stringify(view.toJSON());
  expect(json).toContain('storage_error');
  expect(json).not.toContain('SECRET exception');
  await act(async () => view.unmount());
});

test('Chat does not say no provider is configured when provider loading fails', async () => {
  const {app, db} = await services();
  app.settings.list = async () => {
    throw new CetaError('network_unavailable', 'Connection lost');
  };
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<ChatHome services={app} />);});

  expect(view.root.findAllByProps({testID: 'provider-empty-state'})).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain('网络不可用，请连接后重试。');
  await act(async () => view.unmount());
  await db.close();
});

test('a new-chat preference failure does not hide a successfully loaded provider empty state', async () => {
  const {app, db} = await services();
  app.preferences.getNewChatDefaults = async () => {
    throw new CetaError('storage_error', 'Preferences could not be read');
  };
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<ChatHome services={app} />);});

  expect(view.root.findAllByProps({testID: 'provider-empty-state'}).length).toBeGreaterThan(0);
  expect(JSON.stringify(view.toJSON())).toContain('storage_error');
  await act(async () => view.unmount());
  await db.close();
});

test('Chat does not show an empty session list when loading sessions fails', async () => {
  const {app, db} = await services();
  app.sessions.list = async () => {
    throw new CetaError('network_unavailable', 'Connection lost');
  };
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<ChatHome services={app} />);});

  expect(view.root.findAllByProps({testID: 'sessions-empty-state'})).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain('网络不可用，请连接后重试。');
  await act(async () => view.unmount());
  await db.close();
});

test('primary navigation opens Chat, Tasks, Memory, and Workspace destinations', async () => {
  const {app, db} = await services();
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {
    view = Renderer.create(<ChatHome services={app} />);
  });

  const press = async (testID: string) => {
    await act(async () => view.root.findByProps({testID}).props.onPress());
  };
  expect(view.root.findByProps({testID: 'tab-chat'}).props.accessibilityState).toMatchObject({selected: true});
  await press('tab-tasks');
  expect(JSON.stringify(view.toJSON())).toContain('还没有任务');
  await press('tab-memory');
  expect(JSON.stringify(view.toJSON())).toContain('记忆');
  await press('tab-workspace');
  const workspace = JSON.stringify(view.toJSON());
  expect(workspace).toContain('AI');
  expect(workspace).toContain('模型服务');
  expect(workspace).toContain('新对话默认设置');
  expect(workspace).toContain('设备');
  expect(workspace).toContain('插件与工具');
  expect(workspace).toContain('偏好设置');

  await act(async () => view.unmount());
  await db.close();
});

test('Workspace saves and restores new-conversation defaults on this device', async () => {
  const {app} = await services();
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<ChatHome services={app} />);});
  const press = async (testID: string) => act(async () => {await view.root.findByProps({testID}).props.onPress();});
  const change = async (testID: string, value: string) => act(async () => {view.root.findByProps({testID}).props.onChangeText(value);});

  await press('tab-workspace');
  await press('settings');
  await press('provider-add');
  await change('provider-name', 'Saved Defaults Provider');
  await change('provider-url', 'https://example.com/v1');
  await change('provider-key', 'TOP_SECRET');
  await press('provider-save');
  await press('back-workspace');
  await press('session-options-open');
  await change('model-id', 'persistent-model');
  await press('session-mode-smart');
  await press('session-reasoning-max');
  await press('save-session-settings');
  expect(JSON.stringify(view.toJSON())).toContain('已保存到本机');
  expect(view.root.findByProps({accessibilityLiveRegion: 'polite'})).toBeTruthy();
  expect(() => view.root.findByProps({accessibilityRole: 'status'})).toThrow();
  await expect(app.preferences.getNewChatDefaults()).resolves.toMatchObject({
    mode: 'smart',
    modelProviderId: expect.any(String),
    modelId: 'persistent-model',
    reasoning: 'max',
  });

  await act(async () => {
    view.unmount();
    view = Renderer.create(<ChatHome services={app} />);
  });
  await press('tab-workspace');
  const tree = JSON.stringify(view.toJSON());
  expect(tree).toContain('persistent-model');
  expect(tree).toContain('智能');
  expect(tree).toContain('推理强度 · 最高');
  await act(async () => {view.unmount();});
  await app.close();
});
