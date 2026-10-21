import path from 'node:path';
import fs from 'node:fs';
const exe = path.resolve(process.env.WHALEBRIDGE_DIST_DIR ?? path.join(import.meta.dirname, '../dist/core'), 'WhaleBridgeCore.exe');
if (!fs.existsSync(exe)) throw new Error('Core SEA executable must be built before Channel release verification');
process.env.WHALEBRIDGE_TEST_QQ_CONNECTOR_EXE = exe;
// A packaged child must use its own runtime, not a Node executable from PATH.
process.env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
await import('./test-qq-connector-process.mjs');
await import('./test-bionic-runtime-lifecycle.mjs');
await import('./test-core-channel-assembly.mjs');
console.log('SEA QQ Connector and Bionic lifecycle executed without system Node');
