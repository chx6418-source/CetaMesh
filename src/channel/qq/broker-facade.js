import crypto from 'node:crypto';
import { channelError } from '../delivery-journal.js';
import { inferQqMessageKind, QQ_READ_ACTIONS } from './request.js';

// Legacy policy sees a Channel facade, never the raw transport write methods.
export function createBrokeredQqRuntime({ runtime, resolveService }) {
  const service = () => {
    const value = resolveService();
    if (!value) throw channelError('QQ_CORE_AUTH_REQUIRED', 'Core Channel authority unavailable');
    return value;
  };
  const send = async (action, params, options = {}) => {
    const authority = service();
    const status = await authority.execute({ method: 'channel.qq.health' });
    const result = await authority.send({ requestId: options.requestId ?? crypto.randomUUID(),
      actor: { kind: 'extension', id: 'legacy-qq', grants: { capabilities: ['channel.qq.send'] } },
      input: { accountId: status.accountId, action, kind: inferQqMessageKind(action, params, options), params, options } });
    if (result.status !== 'completed') throw Object.assign(channelError('QQ_APPROVAL_REQUIRED', 'Owner approval required before QQ dispatch'), { approvalId: result.approvalId });
    return result.result;
  };
  const client = {};
  for (const name of ['getLoginInfo', 'getGroupMemberInfo', 'getGroupMemberList', 'getMessage', 'getImage', 'fetchFaceEntity']) {
    client[name] = (...args) => runtime.client[name](...args);
  }
  for (const method of ['raw', 'request']) client[method] = (action, params) => {
    if (!QQ_READ_ACTIONS.has(action)) throw channelError('QQ_READ_ACTION_DENIED', 'Policy cannot access raw QQ writes');
    return runtime.client[method](action, params);
  };
  return { client, status: runtime.status, health: runtime.health, sendReceipt: runtime.sendReceipt,
    connect: async () => { const status = await service().start(); return { ...status, ok: status.ready, connected: status.ready }; },
    sendOneBot: send, rawWrite: send, requestWrite: send,
    sendPrivateMessage: (user_id, message, options) => send('send_private_msg', { user_id, message }, options),
    sendGroupMessage: (group_id, message, options) => send('send_group_msg', { group_id, message }, options) };
}
