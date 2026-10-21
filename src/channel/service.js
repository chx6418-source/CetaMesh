// CetaMesh Desktop Node —— Channel Adapter 服务（阶段 11）。

import { CHANNEL_ADAPTERS, createChannelRegistry } from './registry.js';
import { meshError } from '../mesh/types.js';
import { createChannelDeliveryJournal, channelError } from './delivery-journal.js';
import { assertQqSendPolicy } from './qq/send-policy.js';
import { assertMcpToolEnabled, isBionicChatEnabled, isQqConnectorEnabled } from '../integrations/tool-policy.js';
import { QQ_READ_ACTIONS, inferQqMessageKind, inferQqTarget } from './qq/request.js';
import { assertQqAttachments } from './qq/attachments.js';
import path from 'node:path';
import { createQqSendLedger } from './qq/send-ledger.js';

export function createChannelService({ now, stateDir, dataRoot, config = {}, connectorFactory, broker, onEvent = () => {} } = {}) {
  const registry = createChannelRegistry({ now });
  let journal;
  try { journal = createChannelDeliveryJournal({ stateDir, now }); }
  catch (error) {
    registry.setState('qq', 'error', error?.code ?? 'CHANNEL_JOURNAL_UNAVAILABLE');
    const unavailable = () => { throw channelError('CHANNEL_JOURNAL_UNAVAILABLE', 'Channel journal cannot be trusted; original preserved and QQ disabled'); };
    journal = { snapshot: unavailable, append: unavailable, state: unavailable, resolve: unavailable };
  }
  const consumers = new Map();
  const sendReceipt = (requestId, accountId) => stateDir ? createQqSendLedger(path.join(stateDir, 'qq-send-ledger.json')).get(accountId, requestId) : null;
  let connector = null;
  let binding = null;
  let health = { ready: false, state: 'stopped', accountId: null };
  let starting = null;
  let bionic = null;
  let legacyConnector = null;
  const writeActions = new Set(['send_private_msg', 'send_group_msg', 'upload_private_file', 'upload_group_file',
    'group_poke', 'send_poke', 'click_inline_keyboard_button', 'add_custom_face', 'modify_custom_face']);
  async function validateSend(request) {
    const input = request.input ?? {};
    if (!writeActions.has(input.action) || !input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw channelError('QQ_ACTION_UNSUPPORTED', 'QQ write action is not supported');
    inferQqMessageKind(input.action, input.params, { kind: input.kind });
    if (!connector || !health.ready || String(input.accountId) !== String(health.accountId)) throw channelError('QQ_ACCOUNT_MISMATCH', 'Active Connector account required');
    if (!/^[A-Za-z0-9:._/-]{1,160}$/.test(request.requestId)) throw channelError('QQ_SEND_ID_INVALID', 'Stable QQ requestId required');
    const target = inferQqTarget(input.action, input.params, input.accountId);
    // Runtime independently infers the actual payload kind and checks it again.
    assertQqSendPolicy({ ...input.options, accountId: input.accountId, target, kind: input.kind, approvalVerified: true },
      { config, qqEnabled: isQqConnectorEnabled({ stateDir }), bionicEnabled: isBionicChatEnabled({ stateDir }),
        toolEnabled: name => assertMcpToolEnabled(['qq_send_file', 'qq_send_audio_from_url'].includes(name) ? 'qq-file-send' : 'snowluma', name, { stateDir }) });
    await assertQqAttachments(input.params, { config, dataRoot });
  }
  if (broker) broker.register({ id: 'channel.qq.send', permission: 'message.send', provider: 'channel', risk: 'high',
    description: 'Send an account-bound QQ action through the sole Connector after Owner approval.',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, action: { type: 'string' }, kind: { type: 'string' },
      params: { type: 'object' }, options: { type: 'object' } }, required: ['accountId', 'action', 'kind', 'params'], additionalProperties: false },
    validate: validateSend,
    execute: dispatchApproved });
  async function dispatchApproved(request) {
      await validateSend(request);
      const current = connector;
      const actual = await current.health();
      if (current !== connector || !actual.ready || actual.accountId !== request.input.accountId) throw channelError('QQ_CONNECTOR_EXPIRED', 'Connector identity expired before dispatch');
      let result;
      try {
        result = await current.send({ ...request.input,
          options: { ...request.input.options, requestId: request.requestId, kind: request.input.kind, approvalVerified: true } });
      } catch (error) {
        if (['QQ_OUTCOME_UNKNOWN', 'CHANNEL_PROCESS_CLOSED', 'CHANNEL_COMMAND_TIMEOUT'].includes(error.code)) error.effectStatus = 'unknown';
        onEvent('channel.delivery', { channelId: 'qq', accountId: request.input.accountId,
          requestId: request.requestId, status: error.effectStatus === 'unknown' ? 'outcome-unknown' : 'failed', code: error.code ?? 'QQ_SEND_FAILED' });
        throw error;
      }
      if (result?.status === 'outcome-unknown') throw Object.assign(channelError('QQ_OUTCOME_UNKNOWN', 'QQ delivery requires receipt verification; do not resend'), { effectStatus: 'unknown', requestId: request.requestId });
      onEvent('channel.delivery', { channelId: 'qq', accountId: request.input.accountId,
        requestId: request.requestId, messageId: result?.messageId ?? result?.message_id, status: result?.status ?? 'sent' });
      return result;
  }
  function send(request) {
    if (!broker) throw channelError('QQ_CORE_AUTH_REQUIRED', 'Core Capability Broker unavailable');
    return broker.execute({ ...request, capability: 'channel.qq.send' });
  }
  const allowed = (kind, id) => Array.isArray(config.allow?.[kind === 'group' ? 'groups' : 'private']) &&
    config.allow[kind === 'group' ? 'groups' : 'private'].map(String).includes(String(id));
  async function drainConsumer(id, consumer) {
    if (consumer.running) return consumer.running;
    consumer.running = (async () => {
      for (let index = 0; ; index++) {
        const event = journal.snapshot().events[index];
        if (!event) break;
        if (!consumer.enabled) break;
        const status = journal.snapshot().consumers[id]?.deliveries[event.eventId];
        if (status === 'outcome-unknown' || status === 'in-flight') break;
        if (status && status !== 'retry-authorized') continue;
        let authorized = false;
        try { authorized = await consumer.authorize(structuredClone(event)); }
        catch (error) { void error; /* Consumer authorization failure is fail closed, independent of other consumers. */ }
        if (!authorized) { journal.state(id, event, 'denied'); continue; }
        journal.state(id, event, 'in-flight');
        try {
          await consumer.handle(structuredClone(event));
          journal.state(id, event, 'acknowledged');
        } catch (error) {
          journal.state(id, event, 'outcome-unknown');
          onEvent('channel.delivery', { channelId: 'qq', accountId: event.accountId, consumerId: id, eventId: event.eventId, status: 'outcome-unknown', code: error?.code ?? 'CONSUMER_FAILED' });
          break;
        }
      }
    })().finally(() => { consumer.running = null; });
    return consumer.running;
  }
  async function drain() { await Promise.allSettled([...consumers].map(([id, consumer]) => drainConsumer(id, consumer))); }
  async function ingest(native, source) {
    if (binding && source === binding && starting && !health.ready) health = await connector.health();
    if (!binding || source !== binding || !health.ready) throw channelError('CHANNEL_CONNECTOR_EXPIRED', 'Connector identity is not active');
    if (String(native?.self_id ?? '') !== String(health.accountId)) throw channelError('CHANNEL_ACCOUNT_MISMATCH', 'Inbound account differs from authenticated Connector');
    const kind = native.message_type === 'group' || native.group_id !== undefined ? 'group' : 'private';
    const id = String(kind === 'group' ? native.group_id : native.user_id);
    const messageId = String(native.message_id ?? native.msg_id ?? '');
    const userId = String(native.user_id ?? '');
    if (!/^-?\d{1,30}$/.test(messageId) || !/^\d{1,20}$/.test(userId) || !/^\d{1,20}$/.test(id)) throw channelError('CHANNEL_MESSAGE_INVALID', 'Stable native message and external identity required');
    if (!allowed(kind, id)) throw channelError('CHANNEL_SOURCE_DENIED', 'QQ source is not allowlisted');
    if (Buffer.byteLength(JSON.stringify(native)) > 65536) throw channelError('CHANNEL_MESSAGE_TOO_LARGE', 'QQ message exceeds bounded Channel envelope');
    const result = journal.append({ channelId: 'qq', accountId: String(health.accountId), target: `${kind}:${id}`,
      messageId, externalUserId: userId, sessionId: `qq:${health.accountId}:${kind}:${id}`,
      actor: { kind: 'external', id: `qq:${health.accountId}:${userId}` }, native: structuredClone(native) });
    onEvent('channel.message', { channelId: 'qq', accountId: String(health.accountId), messageId,
      eventId: result.eventId, sequence: result.sequence });
    void drain();
    return result;
  }
  async function start() {
    journal.snapshot();
    if (health.ready) return health;
    if (starting) return starting;
    if (legacyConnector) {
      connector = legacyConnector;
      await connector.start();
      health = await connector.health();
      registry.setState('qq', health.ready ? 'connected' : 'unavailable');
      return structuredClone(health);
    }
    if (!connectorFactory) throw channelError('CHANNEL_UNAVAILABLE', 'QQ Connector process factory unavailable');
    starting = (async () => {
      const current = {};
      binding = current;
      if (connector) await connector.stop();
      connector = connectorFactory({ onMessage: native => ingest(native, current),
        onExit: () => { if (binding === current) { binding = null; health = { ready: false, state: 'crashed', accountId: null }; registry.setState('qq', 'unavailable'); void bionic?.stop(); } } });
      health = { ...await connector.start(), state: 'running' };
      if (!health.ready) registry.setState('qq', 'unavailable', health.error);
      else registry.setState('qq', 'connected');
      return structuredClone(health);
    })().finally(() => { starting = null; });
    return starting;
  }
  async function stop() {
    if (starting) await starting.catch(() => { /* Failed startup still requires cleanup of its owned child. */ });
    await bionic?.stop();
    binding = null;
    const result = await connector?.stop();
    connector = null;
    health = { ready: false, state: 'stopped', accountId: null };
    registry.setState('qq', 'unavailable');
    return result ?? { stopped: true };
  }
  const handlers = {
    'channel.list': () => ({ channels: registry.list(), independence: registry.independence() }),
    'channel.setstate': (p) => registry.setState(p.id, p.state, p.error),
    'channel.independence': () => registry.independence(),
    'channel.qq.start': start,
    'channel.qq.stop': stop,
    'channel.qq.reconnect': async () => { await stop(); return start(); },
    'channel.qq.health': async () => {
      if (connector) {
        health = { ...await connector.health(), state: health.state };
        registry.setState('qq', health.ready ? 'connected' : 'unavailable');
      }
      return { ...health, installed: true, configured: typeof config.snowluma?.wsUrl === 'string' && /^wss?:\/\//.test(config.snowluma.wsUrl),
        running: Boolean(connector) && health.state !== 'crashed', authenticated: health.ready === true && Boolean(health.accountId),
        canSend: health.ready === true && isQqConnectorEnabled({ stateDir }) };
    },
    'channel.delivery.status': () => journal.snapshot(),
    'channel.qq.send.status': p => sendReceipt(p.requestId, p.accountId)
  };
  return {
    registry,
    declarations: CHANNEL_ADAPTERS,
    start, stop, close: stop, drain, send, dispatchApproved, sendReceipt,
    attachBionic(service) { bionic = service; },
    adoptLegacy(runtime) {
      if (connector || legacyConnector) throw channelError('QQ_ACCOUNT_BUSY', 'Channel already owns a Connector');
      legacyConnector = {
        start: runtime.connect, stop: runtime.stop, health: async () => runtime.health(),
        read: (action, params, options) => options?.envelope ? runtime.client.request(action, params) : runtime.client.raw(action, params),
        send: request => {
          const options = { ...request.options, kind: request.kind };
          if (['send_private_msg', 'send_group_msg', 'upload_private_file', 'upload_group_file'].includes(request.action)) return runtime.sendOneBot(request.action, request.params, options);
          if (['group_poke', 'send_poke', 'click_inline_keyboard_button'].includes(request.action)) return runtime.rawWrite(request.action, request.params, options);
          return runtime.requestWrite(request.action, request.params, options);
        }
      };
      connector = legacyConnector;
    },
    async read(action, params = {}, options = {}) {
      if (!QQ_READ_ACTIONS.has(action)) throw channelError('QQ_READ_ACTION_DENIED', 'Only bounded QQ reads permitted');
      if (params.group_id !== undefined && !allowed('group', params.group_id)) throw channelError('CHANNEL_SOURCE_DENIED', 'QQ group is not allowlisted');
      if (!connector || !health.ready) throw channelError('QQ_UNAVAILABLE', 'QQ Connector is stopped');
      return connector.read(action, params, options);
    },
    deliverySnapshot: journal.snapshot,
    registerConsumer({ id, authorize, handle }) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ['constructor', 'prototype'].includes(id) || consumers.has(id) || consumers.size >= 32 || typeof authorize !== 'function' || typeof handle !== 'function') throw channelError('CHANNEL_CONSUMER_INVALID', 'Trusted unique consumer and authorization required');
      const consumer = { authorize, handle, enabled: true, running: null };
      consumers.set(id, consumer);
      return () => { consumer.enabled = false; consumers.delete(id); };
    },
    execute({ method, params, actor } = {}) {
      if (method === 'channel.delivery.resolve') return Promise.resolve().then(() => {
        if (actor?.kind !== 'owner') throw channelError('PERMISSION_DENIED', 'Only Owner may resolve unknown Channel effects');
        const result = journal.resolve({ ...params, actor });
        void drain();
        return result;
      });
      if (method === 'channel.qq.send') return Promise.resolve().then(() => send({ ...params, actor }));
      if (method.startsWith('channel.bionic.')) {
        const action = method.slice('channel.bionic.'.length);
        if (!bionic || !['start', 'stop', 'health'].includes(action)) return Promise.reject(channelError('METHOD_NOT_FOUND', 'Unknown Bionic lifecycle operation'));
        return bionic[action]();
      }
      const handler = handlers[method];
      if (!handler) return Promise.reject(meshError('METHOD_NOT_FOUND', '未知 Channel 方法：' + String(method)));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
