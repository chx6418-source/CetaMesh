import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCoreDependencies, dependencyCycles, dependencyViolations } from './lib/core-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-dependencies-'));
try {
  const fixture = path.join(temporary, 'src');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'a.js'), `
    // import './comment.js';
    const text = "import './string.js'";
    export { value } from './b.js';
    export const lazy = () => import('./lazy.js');
    export const load = () => require('./required.cjs');
  `);
  fs.writeFileSync(path.join(fixture, 'b.js'), "import './a.js'; export const value = 1;");
  fs.writeFileSync(path.join(fixture, 'lazy.js'), 'export default 1;');
  fs.writeFileSync(path.join(fixture, 'required.cjs'), 'module.exports = 1;');
  const parsed = await scanCoreDependencies(temporary);
  assert.deepEqual(parsed.edges.filter(e => e.from === 'src/a.js').map(e => [e.to, e.kind]), [
    ['src/b.js', 'import-statement'], ['src/lazy.js', 'dynamic-import'], ['src/required.cjs', 'require-call']
  ]);
  assert.deepEqual(dependencyCycles(parsed), [['src/a.js', 'src/b.js']]);
  assert.ok(dependencyViolations(parsed).some(row => row.code === 'IMPORT_CYCLE'), 'cycle must fail the architecture gate');

  const edge = (from, to) => ({ from, to, local: true, kind: 'import-statement' });
  const directed = edges => ({ nodes: [...new Set(edges.flatMap(row => [row.from, row.to]))], edges });
  for (const illegal of [
    edge('src/task/runtime.js', 'src/desktop/ui-service.js'),
    edge('src/task/types.js', 'src/app/service-container.js'),
    edge('src/memory/runtime.js', 'src/agent/broker.js'),
    edge('src/desktop/ui-service.js', 'src/task/store.js'),
    edge('src/agent/broker.js', 'src/workspace/registry.js')
  ]) assert.ok(dependencyViolations(directed([illegal])).length, JSON.stringify(illegal));
  for (const domain of ['task', 'memory', 'extension']) {
    const barrel = `src/${domain}/index.js`;
    const store = `src/${domain}/store.js`;
    assert.ok(dependencyViolations(directed([
      edge('src/desktop/ui-service.js', barrel), edge(barrel, store)
    ])).length, 'store-exporting barrel must not bypass state ownership: ' + domain);
  }
  assert.ok(dependencyViolations(directed([
    edge('src/task/runtime.js', 'src/task/helper.js'),
    edge('src/task/helper.js', 'src/agent/broker.js')
  ])).length, 'an intermediate helper must not hide a reversed runtime dependency');
  assert.deepEqual(dependencyViolations(directed([
    edge('src/app/service-container.js', 'src/task/service.js'),
    edge('src/app/service-container.js', 'src/desktop/ui-service.js'),
    edge('src/desktop/ui-service.js', 'src/workspace/index.js'),
    edge('src/workspace/index.js', 'src/workspace/registry.js'),
    edge('src/task/runtime.js', 'src/task/store.js'),
    edge('src/product/startup-diagnostics.js', 'src/task/store.js'),
    edge('src/workspace/service.js', 'src/workspace/registry.js')
  ])), [], 'composition and read-only schema validation are legitimate dependencies');

  const actual = await scanCoreDependencies(root);
  assert.deepEqual(dependencyViolations(actual), [], 'Core dependency direction / ownership regression');
  console.log(`PASS syntax-aware Core dependency directions: ${actual.nodes.length} files, ${actual.edges.filter(e => e.local).length} local edges, zero file cycles`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
