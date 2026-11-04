import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const slash = value => value.replaceAll('\\', '/');
const script = /\.(?:js|mjs|cjs)$/;
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() && script.test(file) ? [file] : [];
  }).sort();
}

/** Parse imports without executing product code. esbuild supplies syntax-aware
 * import/require kinds; comments and string literals cannot invent dependencies.
 * Computed module names, DI, IPC and event edges still need separate review.
 */
export async function scanCoreDependencies(root, { directory = 'src' } = {}) {
  root = path.resolve(root);
  const files = filesUnder(path.join(root, directory));
  const result = await build({ absWorkingDir: root, entryPoints: files,
    outdir: path.join(root, '.dependency-analysis-output'), bundle: true,
    write: false, metafile: true, treeShaking: false, platform: 'node', format: 'esm',
    logLevel: 'silent', plugins: [{ name: 'observe-imports', setup(api) {
      // Each source is an entry; imports are externalized to retain direct edges
      // without bundling or loading optional/native provider dependencies.
      api.onResolve({ filter: /.*/ }, args => args.kind === 'entry-point' ? undefined
        : { path: args.path, external: true });
    } }] });
  const nodes = files.map(file => slash(path.relative(root, file)));
  const edges = [];
  for (const [from, input] of Object.entries(result.metafile.inputs)) {
    for (const item of input.imports) {
      const specifier = item.original ?? item.path;
      let to = specifier;
      if (specifier.startsWith('.')) {
        const absolute = path.resolve(root, path.dirname(from), specifier);
        const resolved = [absolute, absolute + '.js', path.join(absolute, 'index.js')]
          .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
        to = slash(path.relative(root, resolved ?? absolute));
      }
      edges.push({ from: slash(from), to, kind: item.kind,
        local: specifier.startsWith('.'), specifier });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
  return { nodes, edges, warnings: result.warnings.map(row => ({ id: row.id, text: row.text,
    file: row.location?.file, line: row.location?.line })),
  limits: ['Only literal import/export/require paths are parsed.',
    'Dependency injection, RPC, events and computed paths require separate review.'] };
}

/** Strongly connected file components, including self imports. */
export function dependencyCycles({ nodes, edges }) {
  const adjacency = new Map(nodes.map(node => [node, new Set()]));
  for (const { from, to } of edges) if (adjacency.has(from) && adjacency.has(to)) adjacency.get(from).add(to);
  let next = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(node) {
    indices.set(node, next); low.set(node, next++); stack.push(node); active.add(node);
    for (const to of adjacency.get(node)) {
      if (!indices.has(to)) { visit(to); low.set(node, Math.min(low.get(node), low.get(to))); }
      else if (active.has(to)) low.set(node, Math.min(low.get(node), indices.get(to)));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do { member = stack.pop(); active.delete(member); component.push(member); } while (member !== node);
    if (component.length > 1 || adjacency.get(node).has(node)) cycles.push(component.sort());
  }
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

export function dependencyViolations(graph) {
  const violations = dependencyCycles(graph).map(files => ({ code: 'IMPORT_CYCLE', files }));
  // A schema validator may be read during startup preflight. Constructors and
  // mutations still belong to the existing domain runtime/service, not the UI.
  const stateConsumers = new Map([
    ['src/task/store.js', ['src/task/runtime.js', 'src/task/index.js', 'src/product/startup-diagnostics.js']],
    ['src/memory/store.js', ['src/memory/runtime.js', 'src/memory/index.js', 'src/product/startup-diagnostics.js']],
    ['src/workspace/registry.js', ['src/workspace/service.js', 'src/workspace/index.js']],
    ['src/extension/store.js', ['src/extension/service.js', 'src/extension/index.js']]
  ]);
  // These public barrels re-export store constructors. Core consumers import
  // service/type modules directly so a namespace or renamed import cannot hide
  // a second state owner. Workspace's barrel only re-exports registry metadata.
  const storeBarrelConsumers = new Map([
    ['src/task/index.js', []], ['src/memory/index.js', []],
    ['src/extension/index.js', []]
  ]);
  const adjacency = new Map(graph.nodes.map(node => [node, []]));
  for (const { from, to, local } of graph.edges) {
    if (!local) continue;
    adjacency.get(from)?.push(to);
    if (stateConsumers.has(to) && !stateConsumers.get(to).includes(from)) {
      violations.push({ code: 'STATE_OWNER_IMPORT', from, to });
    }
    if (storeBarrelConsumers.has(to) && !storeBarrelConsumers.get(to).includes(from)) {
      violations.push({ code: 'STATE_OWNER_BARREL', from, to });
    }
  }
  // Check the dependency closure, so an extra helper cannot conceal a reversed
  // dependency. Injected facts/commands remain valid; this is not a domain DAG.
  for (const from of graph.nodes.filter(node => /^src\/(task|memory)\/(runtime|store|types)\.js$/.test(node))) {
    const pending = [[from]], visited = new Set([from]);
    while (pending.length) {
      const trace = pending.pop();
      for (const to of adjacency.get(trace.at(-1)) ?? []) {
        if (visited.has(to)) continue;
        visited.add(to);
        if (/^src\/(app|desktop|agent|capability|continuity|extension)\//.test(to)) {
          violations.push({ code: 'DOMAIN_DIRECTION', from, to, trace: [...trace, to] });
        } else pending.push([...trace, to]);
      }
    }
  }
  return violations;
}
