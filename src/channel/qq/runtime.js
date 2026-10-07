import { SnowLumaWebSocketClient } from '@snowluma/sdk';

function reportCallbackError(log, label, error) {
  log(label + ': ' + (error?.message ?? error));
}

export function createQqRuntime({
  config = {},
  clientFactory = options => new SnowLumaWebSocketClient(options),
  onPrivateMessage,
  onGroupMessage,
  onNotice,
  onOpen,
  onClose,
  onError,
  log = () => {},
  connectionTimeoutMs = 15000
} = {}) {
  const client = clientFactory({
    url: config.snowluma?.wsUrl,
    accessToken: config.snowluma?.accessToken || undefined,
    reconnect: true
  });
  let state = 'unknown';
  let connectPromise = null;

  function status() {
    return { state, ready: state === 'ready', connected: state === 'ready' };
  }

  function invoke(handler, label, event) {
    if (typeof handler !== 'function') return;
    try {
      const result = handler(event);
      if (result && typeof result.catch === 'function') {
        result.catch(error => reportCallbackError(log, label, error));
      }
    } catch (error) {
      reportCallbackError(log, label, error);
    }
  }

  client.onPrivateMessage(event => invoke(onPrivateMessage, '处理私聊消息出错', event));
  client.onGroupMessage(event => invoke(onGroupMessage, '处理群消息出错', event));
  client.onNotice('notify', event => invoke(onNotice, '处理 QQ 通知出错', event));
  client.on('open', () => {
    state = 'ready';
    invoke(onOpen, 'SnowLuma open callback failed');
  });
  client.on('close', info => {
    state = 'unavailable';
    invoke(onClose, 'SnowLuma close callback failed', info);
  });
  client.on('error', error => {
    invoke(onError, 'SnowLuma error callback failed', error);
  });

  function connect() {
    if (state === 'ready') return Promise.resolve({ ok: true, connected: true });
    if (connectPromise) return Promise.resolve({ ok: false, pending: true, message: 'SnowLuma 连接正在建立' });
    connectPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => client.connect()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('SnowLuma WebSocket 连接超时')), connectionTimeoutMs);
          })
        ]);
        state = 'ready';
        return { ok: true, connected: true };
      } catch (error) {
        state = 'unavailable';
        log('SnowLuma WebSocket 连接失败，桥接继续独立运行：' + (error?.message ?? error));
        return { ok: false, error: error?.message ?? String(error) };
      } finally {
        if (timer) clearTimeout(timer);
        connectPromise = null;
      }
    })();
    return connectPromise;
  }

  return { client, connect, status };
}
