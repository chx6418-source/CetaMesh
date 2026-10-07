import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLegacyBridgeTestOptedIn } from './environment-policy.mjs';

assert.equal(isLegacyBridgeTestOptedIn({}), false);
assert.equal(isLegacyBridgeTestOptedIn({ WHALEBRIDGE_TEST_LEGACY_BRIDGE: 'true' }), false);
assert.equal(isLegacyBridgeTestOptedIn({ WHALEBRIDGE_TEST_LEGACY_BRIDGE: '1' }), true);

const runner = fs.readFileSync(new URL('./run-all-tests.mjs', import.meta.url), 'utf8');
assert.match(runner, /'legacy-bridge':\s*isLegacyBridgeTestOptedIn\(\)\s*&&\s*await probeTcp\(consolePort\)/);
const testSource = fs.readFileSync(new URL('./test-console.mjs', import.meta.url), 'utf8');
assert.match(testSource, /127\.0\.0\.1:3100/, 'the legacy console test targets the fixed dev console port');

console.log('PASS console integration suite requires explicit environment opt-in');
