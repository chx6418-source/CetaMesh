import { text } from './onebot-client.js';

export function createQqTransport({ client, textSegment = text, authorize = () => {} } = {}) {
  if (!client || typeof client.sendPrivateMessage !== 'function' || typeof client.sendGroupMessage !== 'function') {
    throw new TypeError('QQ transport requires a SnowLuma message client');
  }
  return {
    send(kind, id, content, options = {}) {
      authorize({ kind, id, content, options });
      const targetId = Number(id);
      const payload = textSegment(content);
      if (kind === 'private') return client.sendPrivateMessage(targetId, payload, options);
      if (kind === 'group') return client.sendGroupMessage(targetId, payload, options);
      throw new TypeError('QQ message kind must be private or group');
    }
  };
}
