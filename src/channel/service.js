// CetaMesh Desktop Node —— Channel Adapter 服务（阶段 11）。

import { CHANNEL_ADAPTERS, createChannelRegistry } from './registry.js';
import { meshError } from '../mesh/types.js';

export function createChannelService({ now } = {}) {
  const registry = createChannelRegistry({ now });
  const handlers = {
    'channel.list': () => ({ channels: registry.list(), independence: registry.independence() }),
    'channel.setstate': (p) => registry.setState(p.id, p.state, p.error),
    'channel.independence': () => registry.independence()
  };
  return {
    registry,
    declarations: CHANNEL_ADAPTERS,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(meshError('METHOD_NOT_FOUND', '未知 Channel 方法：' + String(method)));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
