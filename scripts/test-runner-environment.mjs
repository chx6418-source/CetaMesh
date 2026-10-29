import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { isLegacyBridgeTestOptedIn } from './environment-policy.mjs';

assert.equal(isLegacyBridgeTestOptedIn({}), false);
assert.equal(isLegacyBridgeTestOptedIn({ WHALEBRIDGE_TEST_LEGACY_BRIDGE: 'true' }), false);
assert.equal(isLegacyBridgeTestOptedIn({ WHALEBRIDGE_TEST_LEGACY_BRIDGE: '1' }), true);

const runner = fs.readFileSync(new URL('./run-all-tests.mjs', import.meta.url), 'utf8');
assert.match(runner, /'legacy-bridge':\s*isLegacyBridgeTestOptedIn\(\)\s*&&\s*await probeTcp\(consolePort\)/);
const testSource = fs.readFileSync(new URL('./test-console.mjs', import.meta.url), 'utf8');
assert.match(testSource, /127\.0\.0\.1:3100/, 'the legacy console test targets the fixed dev console port');

console.log('PASS console integration suite requires explicit environment opt-in');

// Direct invocations must not turn a missing real-environment opt-in into exit0.
for (const [file,flag] of [['test-claude-native-auth.mjs','WHALEBRIDGE_TEST_CLAUDE_AUTH_CONTRACT'],['test-gemini-qwen-native-policy.mjs','WHALEBRIDGE_TEST_REAL_GEMINI_QWEN'],['test-opencode-native-runtime.mjs','WHALEBRIDGE_TEST_REAL_OPENCODE']]) {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./'+file,import.meta.url))],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,[flag]:'0'}});
  assert.equal(result.error,undefined);
  assert.equal(result.status,77,file+' missing opt-in must not exit successfully');
  assert.match(result.stdout,/NOT_RUN_ENVIRONMENT/);
}
console.log('PASS real CLI missing opt-ins preserve explicit environment skip exit77');
