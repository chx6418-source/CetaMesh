// per-provider API key store tests: masking, atomic writes, fail-closed corruption, outbound test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderSecrets, ProviderSecretError } from '../src/providers/secrets.js';

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} - ${error?.message ?? error}`);
  }
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-provider-secrets-'));
const secrets = createProviderSecrets({ root: temp });
const rawKey = 'sk-test-deepseek-1234567890';

try {
  await check('list is empty before configuration', () => {
    assert.deepEqual(secrets.list(), []);
  });

  await check('set stores a masked entry and never returns the raw key', () => {
    const entry = secrets.set({ provider: 'deepseek-official', apiKey: rawKey });
    assert.equal(entry.provider, 'deepseek-official');
    assert.equal(entry.configured, true);
    assert.match(entry.hint, /^••••/);
    assert.ok(!entry.hint.includes(rawKey));
    const listed = secrets.list();
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(rawKey), 'list output must not contain the key');
  });

  await check('re-set overwrites the same provider and rejects invalid input', () => {
    const updated = secrets.set({ provider: 'openai', apiKey: 'sk-openai-abcdefgh', baseUrl: 'https://api.openai.com/v1/' });
    assert.equal(updated.baseUrl, 'https://api.openai.com/v1');
    assert.equal(secrets.list().length, 2);
    assert.throws(() => secrets.set({ provider: 'Bad Provider', apiKey: rawKey }), (error) => error.code === 'PROVIDER_SECRET_INVALID');
    assert.throws(() => secrets.set({ provider: 'openai', apiKey: 'short' }), (error) => error.code === 'PROVIDER_SECRET_INVALID');
    assert.throws(() => secrets.set({ provider: 'openai', apiKey: rawKey, baseUrl: 'http://insecure.example' }), (error) => error.code === 'PROVIDER_SECRET_INVALID');
  });

  await check('atomic write leaves no temp files and keeps 0600 semantics', () => {
    const leftovers = fs.readdirSync(path.join(temp, 'state')).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  await check('outbound test uses the key but reports only status', async () => {
    const ok = await secrets.test({
      provider: 'deepseek-official',
      fetchImpl: async (url, options) => {
        assert.match(String(url), /^https:\/\/api\.deepseek\.com\/models$/);
        assert.equal(options.headers.authorization, `Bearer ${rawKey}`);
        return { ok: true, status: 200 };
      }
    });
    assert.deepEqual(ok, { provider: 'deepseek-official', ok: true, status: 200, message: 'API Key 可用' });
    const denied = await secrets.test({
      provider: 'deepseek-official',
      fetchImpl: async () => ({ ok: false, status: 401 })
    });
    assert.equal(denied.ok, false);
    assert.match(denied.message, /认证失败/);
    assert.ok(!JSON.stringify(denied).includes(rawKey));
  });

  await check('remove deletes the entry; corrupt file fails closed without echoing values', () => {
    assert.equal(secrets.remove({ provider: 'openai' }).removed, true);
    assert.equal(secrets.remove({ provider: 'openai' }).removed, false);
    fs.writeFileSync(path.join(temp, 'state', 'provider-keys.json'), '{not json with sk-sentinel-987654');
    assert.throws(() => secrets.list(), (error) => {
      assert.ok(error instanceof ProviderSecretError);
      assert.equal(error.code, 'PROVIDER_SECRET_INVALID');
      assert.ok(!String(error.message).includes('sk-sentinel-987654'));
      return true;
    });
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
