import {ExtensionValidationRuntime, mapExtensionPermissions} from '../runtime/extension/ExtensionValidationRuntime';
import {CetaError} from '../shared/errors/CetaError';

const manifest = {
  id: 'tool.weather',
  name: 'Weather Tool',
  version: '1.0.0',
  type: 'declarative-tool',
  publisher: 'publisher-1',
  platforms: ['android', 'ios'],
  runtime: 'declarative',
  permissions: [{capability: 'location.current', scope: {kind: 'local'}}],
  capabilities: ['location.current'],
  networkAccess: {mode: 'none'},
  inputSchema: {type: 'object'},
  outputSchema: {type: 'object'},
  minimumProtocolVersion: 1,
};

test('validates a declarative manifest and maps permissions to known capabilities', () => {
  const runtime = new ExtensionValidationRuntime();
  const validated = runtime.validateManifest(manifest);
  expect(validated).toMatchObject({id: 'tool.weather', type: 'declarative-tool', runtime: 'declarative'});
  expect(mapExtensionPermissions(validated.permissions)).toEqual([{capability: 'location.current', scope: {kind: 'local'}}]);
});

test('rejects arbitrary code, unknown capabilities, and undeclared executable fields', () => {
  const runtime = new ExtensionValidationRuntime();
  expect(() => runtime.validateManifest({...manifest, type: 'arbitrary-code'})).toThrow(CetaError);
  expect(() => runtime.validateManifest({...manifest, runtime: 'javascript'})).toThrow(CetaError);
  expect(() => runtime.validateManifest({...manifest, permissions: [{capability: 'shell.exec', scope: {kind: 'local'}}]})).toThrow(CetaError);
  expect(() => runtime.validateManifest({...manifest, permissions: [null]})).toThrow(CetaError);
  expect(() => runtime.validateManifest({...manifest, script: 'run this'})).toThrow(CetaError);
  expect(() => runtime.validateManifest({...manifest, inputSchema: {type: 'object', properties: {x: 'x'.repeat(70_000)}}})).toThrow(CetaError);
});

test('workflow steps remain declarative and bounded', () => {
  const runtime = new ExtensionValidationRuntime();
  expect(runtime.validateWorkflow({id: 'workflow-1', version: '1.0.0', steps: [{kind: 'tool-call', toolId: 'tool.weather'}]})).toMatchObject({id: 'workflow-1'});
  expect(() => runtime.validateWorkflow({id: 'workflow-1', version: '1.0.0', steps: [{kind: 'script', code: 'x'}]})).toThrow(CetaError);
});
