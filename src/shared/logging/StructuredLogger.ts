export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export type LogEntry = {
  readonly level: LogLevel;
  readonly message: string;
  readonly traceId: string;
  readonly fields: LogFields;
};

export type LogSink = (entry: LogEntry) => void;

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = [
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'password',
  'pairingtoken',
  'privatekey',
  'secret',
  'session',
  'setcookie',
  'token',
];

let traceSequence = 0;

export function createTraceId(): string {
  traceSequence += 1;
  return `trace_${Date.now().toString(36)}_${traceSequence.toString(36)}`;
}

function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEY_PARTS.some(part => normalizedKey.includes(part));
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }

    seen.add(value);
    const redacted = value.map(item => redactValue(item, seen));
    seen.delete(value);
    return redacted;
  }

  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }

    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactValue(nestedValue, seen),
      ]),
    );
    seen.delete(value);
    return redacted;
  }

  return value;
}

export function redactSecrets(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function defaultSink(entry: LogEntry): void {
  if (__DEV__) {
    console.log('[CetaMesh]', entry);
  }
}

export class StructuredLogger {
  private readonly sink: LogSink;
  private readonly traceId: string;

  constructor(sink: LogSink = defaultSink, context: {readonly traceId?: string} = {}) {
    this.sink = sink;
    this.traceId = context.traceId ?? createTraceId();
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    this.sink({
      level,
      message,
      traceId: this.traceId,
      fields: redactSecrets(fields) as LogFields,
    });
  }
}
