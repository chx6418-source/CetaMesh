// In-memory OpenAI-compatible fixture. It never binds a socket and never calls global fetch.
// Provider requests are accepted only for this reserved loopback endpoint.
export const OPENAI_COMPATIBLE_FIXTURE_BASE_URL = 'https://127.0.0.1:43127/v1';

const fixtureOrigin = new URL(OPENAI_COMPATIBLE_FIXTURE_BASE_URL).origin;
const fixturePaths = new Set(['/v1/models', '/v1/chat/completions']);

function encodeBody(body) {
  return typeof body === 'string' ? body : JSON.stringify(body ?? {});
}

function fixtureAbortError() {
  return Object.assign(new Error('The fixture request was aborted'), { name: 'AbortError' });
}

function makeSseResponse({ chunks, status = 200 }, signal, activeStreams) {
  if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new TypeError('SSE fixture chunks must be an array of strings');
  }
  let streamController = null;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      activeStreams.add(controller);
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      const abort = () => {
        try {
          controller.error(fixtureAbortError());
        } catch {
          // The consumer may have already cancelled or finished reading this response.
        }
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
    cancel() {
      if (streamController) activeStreams.delete(streamController);
    }
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function makeResponse(response, signal, activeStreams) {
  if (!response || typeof response !== 'object') throw new TypeError('Fixture response must be an object');
  const status = Number.isInteger(response.status) ? response.status : response.kind === 'http-error' ? 500 : 200;
  if (response.kind === 'json' || response.kind === 'http-error') {
    return new Response(encodeBody(response.body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (response.kind === 'sse') return makeSseResponse({ ...response, status }, signal, activeStreams);
  throw new TypeError(`Unsupported OpenAI fixture response kind: ${String(response.kind)}`);
}

export function createOpenAiCompatibleFixture({ responses = [] } = {}) {
  if (!Array.isArray(responses)) throw new TypeError('responses must be an array');
  const pending = [...responses];
  const requests = [];
  const activeStreams = new Set();
  let closed = false;

  async function fetchImpl(input, init = {}) {
    if (closed) throw new Error('OpenAI-compatible fixture is closed');
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== fixtureOrigin || !fixturePaths.has(url.pathname) || url.search || url.hash) {
      throw new Error('OpenAI-compatible fixture rejected a URL outside its loopback endpoint');
    }
    const headers = new Headers(init.headers ?? (typeof input === 'object' ? input.headers : undefined));
    requests.push({
      url: url.href,
      method: init.method ?? (typeof input === 'object' ? input.method : undefined) ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      authorizationConfigured: /^Bearer\s+\S+/.test(headers.get('authorization') ?? ''),
      signalPresent: Boolean(init.signal)
    });
    if (pending.length === 0) throw new Error('OpenAI-compatible fixture has no queued response');
    return makeResponse(pending.shift(), init.signal, activeStreams);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const controller of activeStreams) {
      try {
        controller.close();
      } catch {
        // An aborted response can already be errored while its controller remains tracked.
      }
    }
    activeStreams.clear();
  }

  return Object.freeze({ fetchImpl, requests, close });
}
