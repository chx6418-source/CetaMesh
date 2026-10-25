import { CetaError } from '../../shared/errors/CetaError';
import type { HttpRequest, HttpTransport } from './HttpTransport';

// RN's built-in XHR provides incremental text on both native platforms.
export class XhrTransport implements HttpTransport {
  constructor(
    private readonly factory: () => XMLHttpRequest = () => new XMLHttpRequest(),
  ) {}
  async json(request: HttpRequest): Promise<unknown> {
    let text = '';
    for await (const part of this.stream(request)) {
      text += part;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CetaError('invalid_protocol', 'Invalid provider response');
    }
  }
  async *stream(request: HttpRequest): AsyncIterable<string> {
    if (request.signal?.aborted) {
      throw new CetaError('cancelled', 'Request cancelled');
    }
    const xhr = this.factory();
    const queue: string[] = [];
    let done = false;
    let error: CetaError | undefined;
    let offset = 0;
    let wake: (() => void) | undefined;
    const finish = (failure?: CetaError) => {
      if (!done) {
        done = true;
        error = failure;
        wake?.();
      }
    };
    const read = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const text = xhr.responseText;
        if (text.length > 32 * 1024 * 1024) {
          finish(
            new CetaError('unsupported', 'Provider response too large'),
          );
          xhr.abort();
          return;
        }
        if (text.length > offset) {
          queue.push(text.slice(offset));
          offset = text.length;
          wake?.();
        }
      }
    };
    const abort = () => {
      finish(new CetaError('cancelled', 'Request cancelled'));
      xhr.abort();
    };
    try {
      xhr.open(request.body === undefined ? 'GET' : 'POST', request.url, true);
      // XHR timeout covers the entire request, including active streaming.
      // ChatRuntime owns first-response, idle, and hard safety timers instead.
      xhr.timeout = request.streaming ? 0 : request.timeoutMs ?? 60000;
      xhr.responseType = 'text';
      Object.entries(request.headers).forEach(([name, value]) =>
        xhr.setRequestHeader(name, value),
      );
      xhr.onprogress = read;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(
            new CetaError(
              xhr.status === 401 || xhr.status === 403
                ? 'unauthorized'
                : 'provider_error',
              'Provider rejected the request',
            ),
          );
        } else {
          read();
          finish();
        }
      };
      xhr.onerror = () =>
        finish(new CetaError('network_unavailable', 'Network unavailable'));
      xhr.ontimeout = () =>
        finish(new CetaError('timeout', 'Provider request timed out'));
      xhr.onabort = () =>
        finish(new CetaError('cancelled', 'Request cancelled'));
      request.signal?.addEventListener('abort', abort);
      xhr.send(
        request.body === undefined ? null : JSON.stringify(request.body),
      );
      while (!done || queue.length) {
        if (error) {
          throw error;
        }
        if (queue.length) {
          yield queue.shift()!;
        } else {
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      }
      if (error) {
        throw error;
      }
    } catch (failure) {
      throw failure instanceof CetaError
        ? failure
        : new CetaError('network_unavailable', 'Network request failed');
    } finally {
      request.signal?.removeEventListener('abort', abort);
      xhr.onprogress = null;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
      if (!done) {
        xhr.abort();
      }
    }
  }
}
