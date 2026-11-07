// Owned loopback protocol peers: no remote model, account or production credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import * as model from '../src/model/index.js';

assert.equal(typeof model.discoverModels, 'function', 'Model Runtime exports bounded connection discovery');
const key = 'sk-fixture-discovery-private-91234';
const requests = [];
let handler = (_req, res) => { res.writeHead(404); res.end(); };
const server = http.createServer((req, res) => {
  requests.push({ path: req.url, authorization: req.headers.authorization });
  handler(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = (res, payload, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
let checks = 0;
const ok = label => console.log(`PASS ${++checks}: ${label}`);
try {
  for (const [shape, payload] of [
    ['bare', [{ name: 'z-model' }, { id: 'a-model' }, { model: 'a-model' }, 'middle']],
    ['data', { data: [{ id: 'z-model' }, { name: 'a-model' }, { model: 'middle' }] }],
    ['models', { models: ['middle', { model: 'z-model' }, { name: 'a-model' }] }]
  ]) {
    requests.length = 0;
    handler = (req, res) => req.url === '/tenant/models' ? json(res, {}, 404) : json(res, payload);
    const result = await model.discoverModels({ baseUrl: `${base}/tenant`, credential: key });
    assert.deepEqual(result.models.map(entry => entry.id), ['a-model', 'middle', 'z-model']);
    assert.ok(result.models.every(entry => entry.enabled === false), 'newly discovered models are opt-in');
    assert.deepEqual(requests.map(entry => entry.path), ['/tenant/models', '/v1/models']);
    assert.ok(requests.every(entry => entry.authorization === `Bearer ${key}`));
    assert.equal(JSON.stringify(result).includes(key), false);
    ok(`${shape} list normalizes IDs, deduplicates, sorts and falls back only after 404`);
  }
  for (const status of [401, 403, 429, 500, 503]) {
    requests.length = 0;
    handler = (_req, res) => json(res, { error: `echo ${key}` }, status);
    await assert.rejects(model.discoverModels({ baseUrl: `${base}/tenant`, credential: key }), error => {
      assert.equal(error.code, 'MODEL_DISCOVERY_HTTP_ERROR');
      assert.equal(error.status, status);
      assert.equal(JSON.stringify(error).includes(key) || error.message.includes(key), false);
      return true;
    });
    assert.equal(requests.length, 1);
  }
  ok('authentication, rate and server failures stop without retry or provider-body disclosure');

  let secondOriginRequests = 0;
  const second = http.createServer((_req, res) => { secondOriginRequests++; res.end('[]'); });
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
  try {
    handler = (_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${second.address().port}/models` }); res.end(); };
    await assert.rejects(model.discoverModels({ baseUrl: base, credential: key }), error => error.code === 'MODEL_DISCOVERY_REDIRECT');
    assert.equal(secondOriginRequests, 0, 'redirect destinations never receive a credential');
    await assert.rejects(model.discoverModels({ baseUrl: base, credential: key, paths: [`http://127.0.0.1:${second.address().port}/models`] }), error => error.code === 'MODEL_DISCOVERY_INVALID');
  } finally { await new Promise(resolve => second.close(resolve)); }
  ok('redirects and candidate-origin changes are refused before credential transmission');

  requests.length = 0;
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); };
  await assert.rejects(model.discoverModels({ baseUrl: base, credential: key, timeoutMs: 50 }), error => error.code === 'MODEL_DISCOVERY_TIMEOUT');
  assert.equal(requests.length, 1);
  const abort = new AbortController();
  const cancelled = model.discoverModels({ baseUrl: base, credential: key, signal: abort.signal });
  setTimeout(() => abort.abort(), 25);
  await assert.rejects(cancelled, error => error.code === 'ABORTED');
  ok('body stalls obey the complete discovery deadline and cancellation');

  handler = (_req, res) => json(res, { data: [{ id: 'safe', capabilities: { tools: true, reasoning: false } }, { id: key }] });
  const declared = await model.discoverModels({ baseUrl: base, credential: key });
  assert.deepEqual(declared.models.map(entry => entry.id), ['safe']);
  assert.deepEqual(declared.models[0].capabilities.tools, { value: true, source: 'protocol-declared', status: 'declared', ruleId: null, version: 'model-catalog-v1' });
  assert.equal(declared.models[0].capabilities.reasoning.value, false);
  handler = (_req, res) => json(res, ['one', 'two', 'three']);
  const limited = await model.discoverModels({ baseUrl: base, credential: key, maxModels: 2 });
  assert.equal(limited.models.length, 2);
  assert.equal(limited.truncated, true);
  handler = (_req, res) => json(res, ['x'.repeat(2000)]);
  await assert.rejects(model.discoverModels({ baseUrl: base, credential: key, maxResponseBytes: 128 }), error => error.code === 'MODEL_DISCOVERY_LIMIT');
  handler = (_req, res) => json(res, { unknown: ['not-a-catalog'] });
  await assert.rejects(model.discoverModels({ baseUrl: base, credential: key }), error => error.code === 'MODEL_DISCOVERY_INVALID_RESPONSE');
  ok('bounded results retain capability provenance, reject invalid shapes and omit credential echoes');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`Model discovery: ${checks} checks passed (owned loopback only).`);
