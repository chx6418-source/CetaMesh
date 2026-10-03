import {CetaError} from '../../shared/errors/CetaError';

export type CameraCaptureNativeResult = {
  readonly uri: string;
  readonly mime: 'image/jpeg';
  readonly name: string;
};

export function parseCameraCaptureNativeResult(
  raw: string,
): CameraCaptureNativeResult {
  if (raw.length === 0 || raw.length > 4096) {
    throw new CetaError('invalid_protocol', 'Invalid camera capture result');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CetaError('invalid_protocol', 'Invalid camera capture result');
  }
  if (!value || typeof value !== 'object') {
    throw new CetaError('permission_denied', 'Unsafe camera capture result');
  }
  const result = value as {uri?: unknown; mime?: unknown; name?: unknown};
  if (
    typeof result.uri !== 'string' ||
    result.mime !== 'image/jpeg' ||
    typeof result.name !== 'string' ||
    result.name.length === 0 ||
    result.name.length > 120 ||
    !result.uri.startsWith('file:///') ||
    result.uri.includes('..') ||
    Array.from(result.name).some(
      character =>
        character.charCodeAt(0) < 32 || character === '/' || character === '\\',
    )
  ) {
    throw new CetaError('permission_denied', 'Unsafe camera capture result');
  }
  return result as CameraCaptureNativeResult;
}
