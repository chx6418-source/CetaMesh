import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {assembleServices} from '../app/bootstrap/assembleServices';
import {ChatHome} from '../features/chat/ChatHome';
import {NodeDatabase} from './helpers/NodeDatabase';
import type {ExtensionManifest} from '../domain/extension/ExtensionManifest';
import type {ExtensionPackagePicker} from '../domain/extension/ExtensionPackagePicker';
import {CetaError} from '../shared/errors/CetaError';

const manifest: ExtensionManifest = {
  id: 'tool.mobile',
  name: 'Mobile Helper',
  version: '1.0.0',
  type: 'declarative-tool',
  publisher: 'CetaMesh',
  platforms: ['android', 'ios'],
  runtime: 'declarative',
  permissions: [{capability: 'camera.capture', scope: {kind: 'local'}}],
  capabilities: ['camera.capture'],
  networkAccess: {mode: 'none'},
  inputSchema: {type: 'object'},
  outputSchema: {type: 'object'},
  minimumProtocolVersion: 1,
};

test('Workspace reviews extension permissions before import and exposes lifecycle controls', async () => {
  const db = new NodeDatabase();
  const picker: ExtensionPackagePicker = {pick: async () => ({name: 'mobile-helper.json', text: JSON.stringify(manifest)})};
  const app = await assembleServices(
    db,
    {get: async () => null, set: async () => undefined, delete: async () => undefined},
    {json: async () => ({data: []}), stream: async function* () {}},
    undefined,
    undefined,
    undefined,
    picker,
  );
  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<ChatHome services={app} />);});
  const press = async (testID: string) => act(async () => {await view.root.findByProps({testID}).props.onPress();});

  await press('tab-workspace');
  await press('open-extensions');
  await press('extension-import');
  expect(JSON.stringify(view.toJSON())).toContain('相机');
  expect(JSON.stringify(view.toJSON())).toContain('需要额外确认');
  expect(JSON.stringify(view.toJSON())).not.toContain('mobile-helper.json');
  await press('extension-import-details');
  expect(JSON.stringify(view.toJSON())).toContain('camera.capture');
  await press('extension-import-details');
  await press('extension-import-confirm');
  expect(JSON.stringify(view.toJSON())).toContain('Mobile Helper');
  expect(JSON.stringify(view.toJSON())).toContain('已停用');

  await press('extension-details-tool.mobile-import');
  await press('extension-enable-tool.mobile-import');
  expect(JSON.stringify(view.toJSON())).toContain('已启用');
  await press('extension-details-tool.mobile-import');
  expect(JSON.stringify(view.toJSON())).toContain('权限详情');
  expect(JSON.stringify(view.toJSON())).toContain('camera.capture');

  await act(async () => {view.unmount();});
  await app.close();
});

test('Extensions does not show an empty inventory when loading fails', async () => {
  const db = new NodeDatabase();
  const app = await assembleServices(
    db,
    {get: async () => null, set: async () => undefined, delete: async () => undefined},
    {json: async () => ({data: []}), stream: async function* () {}},
  );
  jest.spyOn(app.extensionLifecycle!, 'list').mockRejectedValue(
    new CetaError('network_unavailable', 'Connection lost'),
  );

  let view!: Renderer.ReactTestRenderer;
  await act(async () => {view = Renderer.create(<ChatHome services={app} />);});
  const press = async (testID: string) => act(async () => {await view.root.findByProps({testID}).props.onPress();});
  await press('tab-workspace');
  await press('open-extensions');

  expect(view.root.findAllByProps({testID: 'extensions-empty'})).toHaveLength(0);
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain('网络不可用，请连接后重试。');
  expect(output).toContain('无法加载插件列表');
  await act(async () => {view.unmount();});
  await app.close();
});
