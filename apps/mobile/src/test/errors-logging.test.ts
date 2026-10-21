import {CetaError} from '../shared/errors/CetaError';
import type {CetaErrorCode} from '../shared/errors/CetaErrorCode';
import {
  createTraceId,
  redactSecrets,
  StructuredLogger,
} from '../shared/logging/StructuredLogger';

test('redacts secret fields recursively while preserving ordinary fields', () => {
  const value = redactSecrets({
    apiKey: 'api-secret',
    ordinary: 'visible',
    nested: {
      pairingToken: 'pairing-secret',
      headers: {
        Authorization: 'Bearer token-secret',
        Cookie: 'session-secret',
        'Set-Cookie': 'set-cookie-secret',
      },
      count: 3,
    },
    values: [{privateKey: 'private-secret'}, {label: 'kept'}],
  });

  expect(value).toEqual({
    apiKey: '[REDACTED]',
    ordinary: 'visible',
    nested: {
      pairingToken: '[REDACTED]',
      headers: {
        Authorization: '[REDACTED]',
        Cookie: '[REDACTED]',
        'Set-Cookie': '[REDACTED]',
      },
      count: 3,
    },
    values: [{privateKey: '[REDACTED]'}, {label: 'kept'}],
  });
});

test('redacting circular diagnostic fields does not throw', () => {
  const value: {name: string; self?: unknown} = {name: 'circular'};
  value.self = value;

  expect(redactSecrets(value)).toEqual({
    name: 'circular',
    self: '[CIRCULAR]',
  });
});

test('structured logger preserves fields and attaches a trace id without secrets', () => {
  const entries: Array<{
    level: string;
    message: string;
    traceId: string;
    fields: Record<string, unknown>;
  }> = [];
  const logger = new StructuredLogger(entry => entries.push(entry), {
    traceId: 'trace-test',
  });

  logger.info('provider ready', {model: 'test-model', token: 'hidden'});

  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    level: 'info',
    message: 'provider ready',
    traceId: 'trace-test',
    fields: {model: 'test-model', token: '[REDACTED]'},
  });
});

test('CetaError is a standard Error with a typed code and correlation context', () => {
  const code: CetaErrorCode = 'provider_error';
  const error = new CetaError(code, 'Provider failed', {
    context: {traceId: 'trace-1', sessionId: 'session-1'},
  });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('CetaError');
  expect(error.code).toBe(code);
  expect(error.context).toEqual({
    traceId: 'trace-1',
    sessionId: 'session-1',
  });
});

test('createTraceId returns non-empty distinct trace identifiers', () => {
  const first = createTraceId();
  const second = createTraceId();

  expect(first).toMatch(/^trace_/);
  expect(second).toMatch(/^trace_/);
  expect(second).not.toBe(first);
});
