import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreRoots = [
  'src/app',
  'src/model',
  'src/router',
  'src/agent',
  'src/task',
  'src/memory',
  'src/workspace',
  'src/capability',
  'src/continuity',
  'src/extension',
  'src/workshop'
];
const javascriptFiles = directory => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && target.endsWith('.js') ? [target] : [];
  });
};
const bridgeImport = /(?:from\s*|import\s*\(\s*|import\s+)['"][^'"]*bridge\.js['"]/;
for (const relativeRoot of coreRoots) {
  for (const file of javascriptFiles(path.join(root, relativeRoot))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(bridgeImport.test(source), false, path.relative(root, file) + ' must not import bridge.js');
  }
}

const bridge = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
for (const constructor of [
  'createModelRuntimeService',
  'createRouterService',
  'createTaskService',
  'createMemoryService',
  'createDefaultAgentService',
  'createWorkspaceService',
  'createCapabilityService',
  'createContinuityService',
  'createWorkshopService',
  'createExtensionService',
  'createMeshService',
  'createChannelService',
  'createSettingsService'
]) {
  assert.equal(
    new RegExp('\\b' + constructor + '\\s*\\(').test(bridge),
    false,
    'bridge.js must not construct modern Core service ' + constructor
  );
}
assert.equal(bridge.includes('startUiIpcServer('), false, 'bridge.js must not expose positional IPC construction');
assert.equal(bridge.includes('setInterval(checkDsh'), false, 'bridge.js must not own DSH polling');
assert.equal(bridge.includes("from '@snowluma/sdk'"), false, 'QQ SDK belongs behind the channel adapter');

const containerPath = path.join(root, 'src/app/service-container.js');
assert.ok(fs.existsSync(containerPath), 'Core service container must exist');
const container = fs.readFileSync(containerPath, 'utf8');
assert.equal(bridgeImport.test(container), false, 'service container must not import bridge.js');

// Walk actual import specifiers in the composition closure. Mentions in channel
// metadata or comments do not create runtime dependencies.
const queue = [containerPath];
const visited = new Set();
const importPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;
while (queue.length) {
  const file = queue.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = fs.readFileSync(file, 'utf8');
  const relativeFile = path.relative(root, file).replaceAll('\\', '/');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const target = specifier.startsWith('.')
      ? path.resolve(path.dirname(file), specifier)
      : specifier;
    assert.notEqual(target, '@snowluma/sdk', relativeFile + ' must not import SnowLuma SDK');
    assert.notEqual(target, path.join(root, 'src/channel/qq/runtime.js'), relativeFile + ' must not import QQ runtime');
    assert.equal(path.basename(target).includes('social-retention'), false, relativeFile + ' must not import Social runtime');
    if (!specifier.startsWith('.')) continue;
    if (target.endsWith('.js') && fs.existsSync(target)) queue.push(target);
  }
}

console.log('PASS Core composition boundaries');
