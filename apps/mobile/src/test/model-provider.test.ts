import {
  CompatibleProvider,
  validateEndpoint,
} from '../providers/model/CompatibleProvider';
import { ProviderRegistry } from '../runtime/chat/ProviderRegistry';
import { SseDecoder } from '../providers/network/SseDecoder';
import { XhrTransport } from '../providers/network/XhrTransport';

test('SSE preserves frames split across chunks and CRLF boundaries', () => {
  const decoder = new SseDecoder();
  expect(decoder.push('data: {"a":')).toEqual([]);
  expect(decoder.push('1}\r')).toEqual([]);
  expect(decoder.push('\n\r\ndata: [DONE]\n\n')).toEqual(['{"a":1}', '[DONE]']);
});
test('SSE bounds untrusted incomplete frames', () => {
  expect(() => new SseDecoder().push('x'.repeat(1024 * 1024 + 1))).toThrow();
});
test.each([
  'http://example.com/v1',
  'https://a:b@example.com/v1',
  'https://example.com/v1?key=x',
  'file:///tmp/x',
])('rejects unsafe endpoint %s', url => {
  expect(() => validateEndpoint(url)).toThrow();
});

function provider(frames: string[], supportsReasoning = true) {
  const bodies: unknown[] = [];
  const p = new CompatibleProvider(
    {
      id: 'p',
      name: 'Test',
      baseUrl: 'https://example.com/v1',
      credentialRef: 'provider:p',
      supportsReasoning,
    },
    { get: async () => 'secret' },
    {
      json: async () => ({ data: [{ id: 'model' }] }),
      stream: async function* (request) {
        bodies.push(request.body);
        for (const frame of frames) {
          yield frame;
        }
      },
    },
  );
  return { p, bodies };
}
const request = {
  modelId: 'model',
  reasoning: 'high' as const,
  messages: [{ role: 'user' as const, content: 'Hi' }],
};
test('provider streams text, sends reasoning, lists models and aggregates chat', async () => {
  const { p, bodies } = provider([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  expect(await p.listModels()).toEqual([
    { id: 'model', name: 'model', supportsReasoning: true },
  ]);
  expect(await p.chat(request)).toEqual({ content: '你好' });
  expect(bodies[0]).toMatchObject({
    model: 'model',
    reasoning_effort: 'high',
    stream: true,
    stream_options: {include_usage: true},
  });
});
test('provider emits reported usage before stream completion', async () => {
  const {p} = provider([
    'data: {"choices":[{"delta":{"content":"好"}}],"usage":null}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102,"prompt_cache_hit_tokens":92,"prompt_cache_miss_tokens":8}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const chunks = [];
  for await (const chunk of p.stream(request)) {chunks.push(chunk);}
  expect(chunks).toEqual([
    {type: 'delta', text: '好'},
    {type: 'usage', usage: {inputTokens: 100, outputTokens: 2, totalTokens: 102, cachedInputTokens: 92, cacheMissInputTokens: 8, providerReported: true}},
    {type: 'done'},
  ]);
});
test('unsupported provider omits reasoning and incomplete/malformed/error streams fail safely', async () => {
  const { p, bodies } = provider(['data: [DONE]\n\n'], false);
  await p.chat(request);
  expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  for (const frame of [
    'data: bad\n\n',
    'data: {"error":{"message":"secret"}}\n\n',
    'data: {"choices":[]}\n\n',
  ]) {
    await expect(provider([frame]).p.chat(request)).rejects.not.toThrow(
      'secret',
    );
  }
});
test('registry rejects duplicates and unknown providers', () => {
  const r = new ProviderRegistry();
  const { p } = provider([]);
  r.register(p);
  expect(r.get('p')).toBe(p);
  expect(() => r.register(p)).toThrow();
  expect(() => r.get('missing')).toThrow();
});

class FakeXhr {
  status = 200;
  responseText = '';
  timeout = 0;
  readyState = 0;
  responseURL = 'https://example.com/v1';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.onabort?.();
  }
}
test('transport maps unauthorized without exposing response body', async () => {
  const xhr = new FakeXhr();
  const t = new XhrTransport(() => xhr as unknown as XMLHttpRequest);
  const pending = t.json({
    url: 'https://example.com/v1',
    headers: {},
    timeoutMs: 50,
  });
  xhr.status = 401;
  xhr.responseText = 'secret';
  xhr.onload?.();
  await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
});
test.each(['cancelled', 'timeout', 'network_unavailable'])(
  'transport maps %s and terminates',
  async code => {
    const xhr = new FakeXhr();
    const t = new XhrTransport(() => xhr as unknown as XMLHttpRequest);
    const controller = new AbortController();
    const pending = t.json({
      url: 'https://example.com/v1',
      headers: {},
      timeoutMs: 50,
      signal: controller.signal,
    });
    if (code === 'cancelled') {
      controller.abort();
    } else if (code === 'timeout') {
      xhr.ontimeout?.();
    } else {
      xhr.onerror?.();
    }
    await expect(pending).rejects.toMatchObject({ code });
  },
);
test('already aborted transport does not send', async () => {
  const c = new AbortController();
  c.abort();
  await expect(
    new XhrTransport().json({
      url: 'https://example.com',
      headers: {},
      signal: c.signal,
    }),
  ).rejects.toMatchObject({ code: 'cancelled' });
});
