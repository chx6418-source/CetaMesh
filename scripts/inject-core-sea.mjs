// Isolated injector process: keep the compiler/blob/fuse and postject defaults.
// postject hides writeFile's errno; contain its final write so only EBUSY/open
// can wait for a transient handle. No permission or partial-write retries.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBusyOpenWriter } from './sea-write-retry.mjs';
const [file, blob, sentinelFuse, ...extra] = process.argv.slice(2);
if (!file || !blob || !sentinelFuse || extra.length) throw new Error('Executable, SEA blob and sentinel fuse are required');
const target = path.resolve(file);
const original = fs.promises.writeFile;
const write = original.bind(fs.promises);
const boundedWrite = createBusyOpenWriter(write, { onRetry: attempt => {
  if (attempt === 1) process.stdout.write('Generated executable is busy at open; waiting at most 15 seconds.\n');
} });
fs.promises.writeFile = (destination, ...args) => typeof destination === 'string' && path.resolve(destination) === target
  ? boundedWrite(destination, ...args) : write(destination, ...args);
try {
  const { inject } = createRequire(import.meta.url)('postject');
  await inject(target, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse });
  process.stdout.write('SEA injection completed.\n');
} finally { fs.promises.writeFile = original; }
