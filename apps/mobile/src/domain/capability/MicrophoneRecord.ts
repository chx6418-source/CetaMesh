import {CetaError} from '../../shared/errors/CetaError';

export type MicrophoneRecordNativeResult = {
  readonly uri: string;
  readonly mime: 'audio/mp4';
  readonly name: string;
  readonly durationMs: number;
};

export type MicrophoneRecording = {
  readonly id: string;
  readonly name: string;
  readonly mime: 'audio/mp4';
  readonly kind: 'audio';
  readonly data: string;
  readonly size: number;
  readonly durationMs: number;
};

export function parseMicrophoneRecordNativeResult(
  raw: string,
): MicrophoneRecordNativeResult {
  if (raw.length === 0 || raw.length > 4096) {
    throw new CetaError('invalid_protocol', 'Invalid microphone recording result');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CetaError('invalid_protocol', 'Invalid microphone recording result');
  }
  if (!value || typeof value !== 'object') {
    throw new CetaError('permission_denied', 'Unsafe microphone recording result');
  }
  const result = value as {
    uri?: unknown;
    mime?: unknown;
    name?: unknown;
    durationMs?: unknown;
  };
  if (
    typeof result.uri !== 'string' ||
    result.mime !== 'audio/mp4' ||
    typeof result.name !== 'string' ||
    result.name.length === 0 ||
    result.name.length > 120 ||
    !result.uri.startsWith('file:///') ||
    result.uri.includes('..') ||
    !Number.isInteger(result.durationMs) ||
    Number(result.durationMs) <= 0 ||
    Number(result.durationMs) > 60_000 ||
    Array.from(result.name).some(
      character =>
        character.charCodeAt(0) < 32 || character === '/' || character === '\\',
    )
  ) {
    throw new CetaError('permission_denied', 'Unsafe microphone recording result');
  }
  return result as MicrophoneRecordNativeResult;
}
