import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { acquireQqOwnership } from './ownership.js';
import { createQqReceipts } from './receipts.js';

const HTTP_SEND_ACTIONS = new Set(['send_private_msg', 'send_group_msg', 'upload_private_file', 'upload_group_file']);
const RAW_WRITE_ACTIONS = new Set(['group_poke', 'send_poke', 'click_inline_keyboard_button']);
const REQUEST_WRITE_ACTIONS = new Set(['add_custom_face', 'modify_custom_face']);

function assertWriteAction(action, allowed) {
  if (!allowed.has(action)) {
    throw Object.assign(new Error(`QQ write action unsupported: ${action}`), { code: 'QQ_ACTION_UNSUPPORTED' });
  }
}

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
  dedupFile,
  postAction
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
  let accountId = null;
  let stopped = false;
  let sendTail = Promise.resolve();
  let pendingSends = 0;
  const MAX_PENDING_SENDS = 256;
  const receipts = dedupFile ? createQqReceipts(dedupFile) : null;

  function status() {
    return { state, ready: state === 'ready', connected: state === 'ready', accountId };
  }

  function enqueueSend(action) {
    if (pendingSends >= MAX_PENDING_SENDS) {
      return Promise.reject(Object.assign(new Error('QQ 发送队列已满，请稍后重试并先核验上次发送结果'), { code: 'QQ_SEND_QUEUE_FULL' }));
    }
    pendingSends += 1;
    const result = sendTail.catch(error => { void error; /* An earlier send failure cannot block later authorized sends. */ }).then(() => {
      if (stopped || state !== 'ready') {
        throw Object.assign(new Error('QQ Connector 未连接'), { code: 'QQ_UNAVAILABLE' });
      }
      return action();
    });
    sendTail = result.catch(error => { void error; /* The caller receives the failure; keep the serial queue usable. */ })
      .finally(() => { pendingSends -= 1; });
    return result;
  }

  async function callHttpAction(action, params) {
    const httpUrl = String(config.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const response = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.snowluma?.accessToken ? { authorization: `Bearer ${config.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params), signal: AbortSignal.timeout(60000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = response.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || response.status}${hint}`);
    }
    return body.data;
  }

  async function defaultPostAction(action, params) {
    const login = await callHttpAction('get_login_info', {});
    const httpAccount = login?.user_id;
    if (!httpAccount || String(httpAccount) !== accountId) {
      throw Object.assign(new Error('OneBot HTTP account does not match the active QQ Connector account'), { code: 'QQ_ACCOUNT_CHANGED' });
    }
    return callHttpAction(action, params);
  }

  const sendOneBot = (action, params) => enqueueSend(() => {
    assertWriteAction(action, HTTP_SEND_ACTIONS);
    return (postAction ?? defaultPostAction)(action, params);
  });
  const sendPrivateMessage = (id, payload) => enqueueSend(() => client.sendPrivateMessage(id, payload));
  const sendGroupMessage = (id, payload) => enqueueSend(() => client.sendGroupMessage(id, payload));
  const rawWrite = (action, params) => enqueueSend(() => {
    assertWriteAction(action, RAW_WRITE_ACTIONS);
    return client.raw(action, params);
  });
  const requestWrite = (action, params) => enqueueSend(() => {
    assertWriteAction(action, REQUEST_WRITE_ACTIONS);
    return client.request(action, params);
  });

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
        const login = await client.getLoginInfo();
        const observedAccount = login?.user_id ?? login?.data?.user_id;
        if (!observedAccount) throw Object.assign(new Error('QQ account identity unavailable'), { code: 'QQ_ACCOUNT_UNVERIFIED' });
        if (accountId !== null && String(observedAccount) !== accountId) {
          throw Object.assign(new Error('QQ account changed during reconnect; stop and verify account state before taking over'), { code: 'QQ_ACCOUNT_CHANGED' });
        }
        if (ownershipDir && !accountLease) accountLease = acquireQqOwnership('account', String(observedAccount), ownershipDir);
        receipts?.validate();
        accountId = String(observedAccount);
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
    accountId = null;
    return { ok: true, stopped: true };
  }

  return { client, connect, start: connect, reconnect: connect, stop, status, health: status,
    sendOneBot, sendPrivateMessage, sendGroupMessage, rawWrite, requestWrite };
}
