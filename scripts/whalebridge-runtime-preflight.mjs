#!/usr/bin/env node
// No connect/stop/recover/apply mode. Missing observations never mean safe to migrate.
import { discoverMigrationRoots } from '../src/migration/inventory.js';
import { inspectRuntimePreflight } from '../src/migration/runtime-preflight.js';
const args = process.argv.slice(2), roots = [], executables = [];
try {
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENT');
    if (key === '--root') roots.push(value);
    else if (key === '--app-exe') executables.push(value);
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  console.log(JSON.stringify({ status: 'MIGRATION_BLOCKED', observations: discoverMigrationRoots({ extraRoots: roots, executables })
    .map(root => inspectRuntimePreflight({ dataRoot: root.dataRoot })) }, null, 2));
  process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'MIGRATION_BLOCKED', code: error.code ?? 'INVALID_PREFLIGHT_INPUT' }));
  process.exitCode = 2;
}
