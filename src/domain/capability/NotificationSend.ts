import {CetaError} from '../../shared/errors/CetaError';

export type NotificationPayload = {
  readonly title: string;
  readonly body?: string;
};

const MAX_PAYLOAD_BYTES = 4096;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;

function isSafeText(value: string, maxLength: number, allowEmpty: boolean): boolean {
  return (
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0) &&
    Array.from(value).every(character => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function parseNotificationPayload(value: unknown): NotificationPayload {
  if (!value || typeof value !== 'object') {
    throw new CetaError('invalid_protocol', 'Invalid notification payload');
  }
  const payload = value as {title?: unknown; body?: unknown};
  if (
    typeof payload.title !== 'string' ||
    !isSafeText(payload.title, MAX_TITLE_LENGTH, false) ||
    (payload.body !== undefined &&
      (typeof payload.body !== 'string' ||
        !isSafeText(payload.body, MAX_BODY_LENGTH, true)))
  ) {
    throw new CetaError('invalid_protocol', 'Invalid notification payload');
  }
  const normalized: NotificationPayload = {
    title: payload.title,
    ...(payload.body === undefined ? {} : {body: payload.body}),
  };
  if (utf8ByteLength(JSON.stringify(normalized)) > MAX_PAYLOAD_BYTES) {
    throw new CetaError('invalid_protocol', 'Notification payload is too large');
  }
  return normalized;
}

export const NOTIFICATION_PAYLOAD_LIMIT = MAX_PAYLOAD_BYTES;
