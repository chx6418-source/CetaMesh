import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { acquireQqOwnership } from './ownership.js';
import { createQqReceipts } from './receipts.js';

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
  connectionTimeoutMs = 15000,
  ownershipDir,
  dedupFile
} = {}) {
  const client = clientFactory({
    url: config.snowluma?.wsUrl,
    accessToken: config.snowluma?.accessToken || undefined,
    reconnect: true
  });
  let state = 'unknown';
  let connectPromise = null;
  let gatewayLease = null;
  let accountLease = null;
  let stopped = false;
  const receipts = dedupFile ? createQqReceipts(dedupFile) : null;

  function status() {
    return { state, ready: state === 'ready', connected: state === 'ready' };
  }

  function invoke(handler, label, event) {
    if (stopped || typeof handler !== 'function') return;
    try {
      if (receipts && (label === '处理私聊消息出错' || label === '处理群消息出错')) {
        if (state !== 'ready' || !receipts.claim(label === '处理群消息出错' ? 'group' : 'private', event)) return;
      }
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
    if (stopped) return;
    if (!ownershipDir || accountLease) state = 'ready';
    invoke(onOpen, 'SnowLuma open callback failed');
  });
  client.on('close', info => {
    if (stopped) return;
    state = 'unavailable';
    invoke(onClose, 'SnowLuma close callback failed', info);
  });
  client.on('error', error => {
    invoke(onError, 'SnowLuma error callback failed', error);
  });

  function connect() {
    if (stopped) return Promise.resolve({ ok: false, code: 'QQ_CONNECTOR_STOPPED' });
    if (state === 'ready') return Promise.resolve({ ok: true, connected: true });
    if (connectPromise) return Promise.resolve({ ok: false, pending: true, message: 'SnowLuma 连接正在建立' });
    connectPromise = (async () => {
      let timer;
      try {
        if (ownershipDir && !gatewayLease) {
          gatewayLease = acquireQqOwnership('gateway', config.snowluma?.wsUrl ?? 'default', ownershipDir);
        }
        await Promise.race([
          Promise.resolve().then(() => client.connect()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('SnowLuma WebSocket 连接超时')), connectionTimeoutMs);
          })
        ]);
        if (stopped) throw Object.assign(new Error('QQ Connector stopped during connect'), { code: 'QQ_CONNECTOR_STOPPED' });
        if (ownershipDir && !accountLease) {
          const login = await client.getLoginInfo();
          const accountId = login?.user_id ?? login?.data?.user_id;
          if (!accountId) throw Object.assign(new Error('QQ account identity unavailable'), { code: 'QQ_ACCOUNT_UNVERIFIED' });
          accountLease = acquireQqOwnership('account', String(accountId), ownershipDir);
        }
        receipts?.validate();
        state = 'ready';
        return { ok: true, connected: true };
      } catch (error) {
        state = 'unavailable';
        if (accountLease) { accountLease.release(); accountLease = null; }
        if (gatewayLease) { gatewayLease.release(); gatewayLease = null; }
        if (ownershipDir) client.close?.();
        log('SnowLuma WebSocket 连接失败，桥接继续独立运行：' + (error?.message ?? error));
        return { ok: false, code: error?.code ?? 'QQ_CONNECT_FAILED', error: error?.message ?? String(error) };
      } finally {
        if (timer) clearTimeout(timer);
        connectPromise = null;
      }
    })();
    return connectPromise;
  }

  async function stop() {
    stopped = true;
    state = 'unavailable';
    client.close?.();
    if (connectPromise) await connectPromise;
    if (accountLease) { accountLease.release(); accountLease = null; }
    if (gatewayLease) { gatewayLease.release(); gatewayLease = null; }
    return { ok: true, stopped: true };
  }

  return { client, connect, start: connect, reconnect: connect, stop, status, health: status };
}
