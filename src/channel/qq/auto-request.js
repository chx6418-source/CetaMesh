import crypto from 'node:crypto';

export function autoReplyRequestId({ sessionId, target, terminalSequence, partIndex } = {}) {
  if (!sessionId || !/^(group|private):[1-9]\d*$/.test(String(target ?? '')) ||
      !Number.isSafeInteger(terminalSequence) || terminalSequence < 1 ||
      !Number.isSafeInteger(partIndex) || partIndex < 0) {
    throw Object.assign(new Error('automatic QQ send requires a verified native terminal sequence and target'),
      { code: 'QQ_AUTO_REQUEST_UNVERIFIED' });
  }
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([String(sessionId), String(target), terminalSequence, partIndex])).digest('hex');
  return `auto:${digest}`;
}
