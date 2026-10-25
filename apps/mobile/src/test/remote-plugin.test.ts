import {RemotePluginRuntime} from '../runtime/extension/RemotePluginRuntime';

const plugin = {
  id: 'plugin.remote-weather',
  name: 'Remote Weather',
  version: '1.0.0',
  type: 'remote-plugin' as const,
  publisher: 'publisher-1',
  platforms: ['android', 'ios'] as const,
  runtime: 'remote' as const,
  permissions: [],
  capabilities: [],
  networkAccess: {mode: 'remote-declared' as const},
  inputSchema: {type: 'object'},
  outputSchema: {type: 'object'},
  minimumProtocolVersion: 1,
};

test('remote plugin executes only through a bounded remote contract', async () => {
  const calls: unknown[] = [];
  const runtime = new RemotePluginRuntime({invoke: async request => {calls.push(request); return {temperature: 20};}});
  await expect(runtime.invoke(plugin, {city: 'Berlin'})).resolves.toEqual({temperature: 20});
  expect(calls[0]).toMatchObject({pluginId: 'plugin.remote-weather', input: {city: 'Berlin'}});
  expect(JSON.stringify(calls)).not.toContain('nativeModule');
});

test('remote plugin rejects a local executable runtime', async () => {
  const runtime = new RemotePluginRuntime({invoke: async () => ({})});
  await expect(runtime.invoke({...plugin, runtime: 'declarative' as never}, {})).rejects.toMatchObject({code: 'unsupported'});
});

test('remote plugin converts non-JSON input and output into standard errors', async () => {
  const inputRuntime = new RemotePluginRuntime({invoke: async () => ({})});
  await expect(inputRuntime.invoke(plugin, undefined)).rejects.toMatchObject({code: 'invalid_protocol'});

  const outputRuntime = new RemotePluginRuntime({invoke: async () => undefined});
  await expect(outputRuntime.invoke(plugin, {})).rejects.toMatchObject({code: 'provider_error'});
});
