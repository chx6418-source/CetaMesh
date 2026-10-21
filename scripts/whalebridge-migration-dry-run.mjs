#!/usr/bin/env node
// Intentionally read-only. There is no --apply, --force, credential export or process-control mode.
import os from 'node:os';
import path from 'node:path';
import { createAppPaths } from '../src/app-paths.js';
import { discoverMigrationRoots, dryRunMigration } from '../src/migration/inventory.js';
const args = process.argv.slice(2), roots = [], executables = [], homes = [];
let account;
try {
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--root') roots.push(path.resolve(args[++index]));
    else if (key === '--app-exe') executables.push(path.resolve(args[++index]));
    else if (key === '--dsh-home') homes.push(path.resolve(args[++index]));
    else if (key === '--account') account = args[++index];
    else if (key === '--data-dir') index++;
    else if (key === '--help') {
      console.log('Read-only: node scripts/whalebridge-migration-dry-run.mjs [--root PATH] [--app-exe EXE] [--dsh-home PATH] [--account PROPOSED_ID] [--data-dir PATH]');
      process.exit(0);
    } else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  const paths = createAppPaths();
  const discovered = discoverMigrationRoots({ paths, extraRoots: roots, executables });
  if (account && (discovered.length !== 1 || !/^[1-9]\d{0,19}$/.test(account))) throw new Error('AMBIGUOUS_ACCOUNT_MAPPING');
  const result = dryRunMigration({ roots: discovered, bindings: account ? { [discovered[0].dataRoot]: account } : {},
    dshHomes: [...homes, process.env.DSH_HOME || path.join(os.homedir(), '.dsh')] });
  console.log(JSON.stringify(result.report, null, 2));
  process.exitCode = result.report.status === 'DRY_RUN_PASS' ? 0 : 2;
} catch (error) { console.error(JSON.stringify({ status: 'BLOCKED', code: error.code ?? 'INVALID_DRY_RUN_INPUT' })); process.exitCode = 2; }
