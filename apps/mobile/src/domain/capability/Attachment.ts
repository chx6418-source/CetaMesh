import type { Attachment } from '../chat/ChatRepository';
import { CetaError } from '../../shared/errors/CetaError';
export type AttachmentCapability = 'photos.select' | 'file.pick';
export interface AttachmentProvider {
  pick(name: AttachmentCapability): Promise<Attachment>;
}
export const IMAGE_LIMIT = 2 * 1024 * 1024;
export const TEXT_LIMIT = 128 * 1024;
export function validatePickedUri(uri: string): void {
  let path = uri;
  try {
    if (uri.startsWith('file:///')) {
      path = decodeURIComponent(uri);
    }
  } catch {
    throw new CetaError('permission_denied', 'Invalid selected file URI');
  }
  // content:// document IDs are opaque provider identifiers, not filesystem paths.
  if (
    !/^(file:\/\/\/|content:\/\/[^/]+\/)/.test(uri) ||
    Array.from(path).some(c => c.charCodeAt(0) < 32 || c === '\\') ||
    path.split('/').includes('..')
  ) {
    throw new CetaError('permission_denied', 'Unsafe selected file URI');
  }
}
export function validateAttachment(file: Attachment): Attachment {
  if (!file.name || !file.id || !Number.isFinite(file.size) || file.size <= 0) {
    throw new CetaError('invalid_protocol', 'Invalid attachment');
  }
  if (file.kind === 'text') {
    if (
      !['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(
        file.mime,
      )
    ) {
      throw new CetaError(
        'unsupported',
        'Only plain text documents are supported in M1',
      );
    }
    if (
      file.size > TEXT_LIMIT ||
      file.data.length > TEXT_LIMIT ||
      file.data.includes('\0')
    ) {
      throw new CetaError(
        'unsupported',
        'Text attachment is too large or contains binary data',
      );
    }
  } else if (file.kind === 'image') {
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.mime) ||
      file.size > IMAGE_LIMIT ||
      file.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)
    ) {
      throw new CetaError(
        'unsupported',
        'Only JPEG/PNG/WebP images up to 2 MiB are supported',
      );
    }
    const signature =
      file.mime === 'image/jpeg'
        ? '/9j/'
        : file.mime === 'image/png'
        ? 'iVBORw0KGgo'
        : 'UklGR';
    if (!file.data.startsWith(signature)) {
      throw new CetaError(
        'invalid_protocol',
        'Image does not match its declared type',
      );
    }
  } else {
    throw new CetaError('unsupported', 'Unsupported attachment type');
  }
  return {
    ...file,
    name: Array.from(file.name)
      .map(c => (c.charCodeAt(0) < 32 || c === '/' || c === '\\' ? '_' : c))
      .join('')
      .slice(0, 120),
  };
}

export function parseAttachmentCapabilityResult(
  name: AttachmentCapability,
  value: unknown,
): Attachment {
  if (!value || typeof value !== 'object') {
    throw new CetaError('invalid_protocol', 'Invalid attachment capability result');
  }
  const result = value as {name?: unknown; output?: unknown};
  if (result.name !== name || !result.output || typeof result.output !== 'object') {
    throw new CetaError('invalid_protocol', 'Invalid attachment capability result');
  }
  try {
    return validateAttachment(result.output as Attachment);
  } catch (error) {
    if (error instanceof CetaError) {
      throw error;
    }
    throw new CetaError('invalid_protocol', 'Invalid attachment capability result');
  }
}
