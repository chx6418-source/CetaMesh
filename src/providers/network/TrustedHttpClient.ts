import type {DeviceTrust} from '../../domain/device/DeviceTrust';
import type {HttpTransport} from './HttpTransport';
import {CetaError} from '../../shared/errors/CetaError';
import {endpointOrigin} from '../../protocol/PairingProtocol';

export type TrustedHttpRequest = {
  readonly trust: DeviceTrust;
  readonly path: string;
  readonly body?: unknown;
  readonly authToken?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

function path(value: string): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.split('/').some(part => part === '..') || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+$/.test(value)) {
    throw new CetaError('invalid_protocol', 'Unsafe trusted transport path');
  }
  return value;
}

function safeError(error: unknown): CetaError {
  if (error instanceof CetaError) {
    return error;
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'timeout') {
    return new CetaError('timeout', 'Trusted request timed out');
  }
  if (code === 'cancelled') {
    return new CetaError('cancelled', 'Trusted request cancelled');
  }
  if (code === 'certificate_error' || code === 'network_unavailable') {
    return new CetaError('network_unavailable', 'Trusted transport is unavailable');
  }
  return new CetaError('network_unavailable', 'Trusted transport is unavailable');
}

export class TrustedHttpClient {
  constructor(private readonly transport: HttpTransport) {}

  async json(request: TrustedHttpRequest): Promise<unknown> {
    if ((request.trust.trustState ?? 'trusted') !== 'trusted') {
      throw new CetaError('unauthorized', 'Device trust is not active');
    }
    const origin = endpointOrigin(request.trust.endpoint);
    const relativePath = path(request.path);
    if (request.signal?.aborted) {
      throw new CetaError('cancelled', 'Trusted request cancelled');
    }
    let body: string | undefined;
    if (request.body !== undefined) {
      try {
        const encodedBody = JSON.stringify(request.body);
        if (!encodedBody) {
          throw new CetaError('invalid_protocol', 'Trusted request body is invalid');
        }
        body = encodedBody;
      } catch (error) {
        if (error instanceof CetaError) {
          throw error;
        }
        throw new CetaError('invalid_protocol', 'Trusted request body is invalid');
      }
      if (body.length > 256 * 1024) {
        throw new CetaError('invalid_protocol', 'Trusted request body is too large');
      }
    }
    if (request.authToken !== undefined && (request.authToken.length < 1 || request.authToken.length > 4096)) {
      throw new CetaError('unauthorized', 'Trusted transport credential is invalid');
    }
    try {
      const result = await this.transport.json({
        url: origin + relativePath,
        headers: {
          'content-type': 'application/json',
          ...(request.authToken ? {authorization: `Bearer ${request.authToken}`} : {}),
        },
        body: body === undefined ? undefined : JSON.parse(body),
        signal: request.signal,
        timeoutMs: Math.min(Math.max(request.timeoutMs ?? 15_000, 1), 15_000),
      });
      const encodedResult = JSON.stringify(result);
      if (!encodedResult) {
        throw new CetaError('provider_error', 'Trusted response is invalid');
      }
      if (encodedResult.length > 1024 * 1024) {
        throw new CetaError('provider_error', 'Trusted response is too large');
      }
      return result;
    } catch (error) {
      throw safeError(error);
    }
  }
}
