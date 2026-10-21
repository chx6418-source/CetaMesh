import assert from 'node:assert/strict';
import { createUpdateChecker } from '../src/update/checker.js';

async function probe(location, { statuses = null, allowedHosts = ['updates.example.test'] } = {}) {
  const calls = [];
  const checker = createUpdateChecker({ currentVersion: '1.0.0-rc.2', currentBuildNumber: 1088,
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      const status = statuses?.[calls.length - 1] ?? 302;
      return { status, headers: { get: name => name === 'location' ? location : null }, text: async () => 'not a signed manifest' };
    } });
  const result = await checker.check({ manifestUrl: 'https://updates.example.test/stable.json', pinnedPublicKey: 'synthetic-transport-test-only', allowedHosts });
  return { calls, result };
}
const downgrade = await probe('http://updates.example.test/plain.json');
assert.equal(downgrade.calls[0].redirect, 'manual', 'native fetch must not automatically follow a manifest redirect before TLS/source checks');
assert.equal(downgrade.result.sources[0].code, 'REDIRECT_INSECURE'); assert.equal(downgrade.calls.length, 1);
const foreign = await probe('https://foreign.example.test/manifest.json');
assert.equal(foreign.result.sources[0].code, 'REDIRECT_HOST_NOT_ALLOWED'); assert.equal(foreign.calls.length, 1);
const same = await probe('/next.json', { statuses: [302, 200] });
assert.equal(same.calls.length, 2); assert.equal(same.calls[1].url, 'https://updates.example.test/next.json');
assert.equal(same.result.sources[0].code, 'BODY_INVALID', 'following safe HTTPS does not bypass schema/signature checks');
const loop = await probe('/loop.json'); assert.equal(loop.result.sources[0].code, 'TOO_MANY_REDIRECTS'); assert.equal(loop.calls.length, 6);
const invalid = await probe(null); assert.equal(invalid.result.sources[0].code, 'REDIRECT_INVALID');
console.log('PASS manifest transport rejects TLS downgrade, unapproved hosts, loops and missing Location; safe redirects still require signed valid content');
