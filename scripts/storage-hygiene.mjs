#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCleanup, inspectStorage, planCleanup } from '../src/storage/hygiene.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
const apply = args.includes('--apply');

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes (${(bytes / 1_000_000_000).toFixed(3)} GB)`;
}

function usage() {
  process.stdout.write('Usage: node scripts/storage-hygiene.mjs <status|dev|release> [--apply]\n');
  process.stdout.write('Cleanup is dry-run by default. --apply deletes only exact allowlisted paths.\n');
}

if (!['status', 'dev', 'release'].includes(command)) {
  usage();
  process.exitCode = 2;
} else if (command === 'status') {
  const entries = inspectStorage({ rootDir: ROOT });
  process.stdout.write('CetaMesh local storage (metadata only)\n');
  for (const entry of entries) process.stdout.write(`- ${entry.name}: ${formatBytes(entry.bytes)}\n`);
  const devPlan = planCleanup({ rootDir: ROOT, mode: 'dev' });
  const releasePlan = planCleanup({ rootDir: ROOT, mode: 'release' });
  process.stdout.write(`Potential safe dev cleanup: ${formatBytes(devPlan.candidates.reduce((sum, item) => sum + item.bytes, 0))}\n`);
  process.stdout.write(`Eligible backed-up release cleanup: ${formatBytes(releasePlan.candidates.reduce((sum, item) => sum + item.bytes, 0))}\n`);
  process.stdout.write('npm cache: use `npm cache verify`; this command does not clean it.\n');
} else {
  const plan = planCleanup({ rootDir: ROOT, mode: command });
  if (!plan.candidates.length) {
    process.stdout.write(`No ${command} cleanup candidates.\n`);
  } else {
    process.stdout.write(`${apply ? 'APPLY' : 'DRY RUN'} ${command} cleanup\n`);
    for (const item of plan.candidates) process.stdout.write(`- ${item.relativePath}: ${formatBytes(item.bytes)}\n`);
    if (!apply) {
      process.stdout.write('Nothing deleted. Add --apply to remove the listed allowlisted paths.\n');
    } else {
      const result = applyCleanup({ rootDir: ROOT, plan });
      process.stdout.write(`Removed ${result.removed.length} path(s); reclaimed ${formatBytes(result.reclaimedBytes)}.\n`);
    }
  }
}
