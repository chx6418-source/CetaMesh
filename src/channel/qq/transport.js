import { text } from '@snowluma/sdk';

export function createQqTransport({ client, textSegment = text, authorize = () => {} } = {}) {
  if (!client || typeof client.sendPrivateMessage !== 'function' || typeof client.sendGroupMessage !== 'function') {
    throw new TypeError('QQ transport requires a SnowLuma message client');
  }
  return {
    send(kind, id, content) {
      authorize({ kind, id, content });
      const targetId = Number(id);
      const payload = textSegment(content);
      if (kind === 'private') return client.sendPrivateMessage(targetId, payload);
      if (kind === 'group') return client.sendGroupMessage(targetId, payload);
      throw new TypeError('QQ message kind must be private or group');
    }
  };
}
