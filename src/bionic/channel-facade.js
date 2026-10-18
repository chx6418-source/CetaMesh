import crypto from 'node:crypto';
import { channelError } from '../channel/delivery-journal.js';
import { inferQqMessageKind } from '../channel/qq/request.js';

export function createBionicChannelFacade({ request, accountId }) {
  const read = (action, params, envelope = false) => request('read', { action, params, envelope });
  const send = async (action, params, options = {}) => {
    const result = await request('send', { action, params, kind: inferQqMessageKind(action, params, options),
      options: { ...options, requestId: options.requestId ?? crypto.randomUUID() } }, 70000);
    if (result.status !== 'completed') throw Object.assign(channelError('QQ_APPROVAL_REQUIRED', 'Owner approval required before QQ dispatch'), { approvalId: result.approvalId });
    return result.result;
  };
  return { client: {
    getLoginInfo: () => read('get_login_info', {}),
    getGroupMemberInfo: (group_id, user_id) => read('get_group_member_info', { group_id, user_id }),
    getGroupMemberList: group_id => read('get_group_member_list', { group_id }),
    getMessage: message_id => read('get_msg', { message_id }),
    getImage: file => read('get_image', { file }),
    fetchFaceEntity: (face_id, options = {}) => read('fetch_face_entity', { face_id, refresh: options.refresh ?? false }),
    raw: (action, params) => read(action, params), request: (action, params) => read(action, params, true)
  }, status: () => ({ ready: true, accountId }), connect: async () => ({ connected: true }),
  sendOneBot: send, rawWrite: send, requestWrite: send,
  sendPrivateMessage: (user_id, message, options) => send('send_private_msg', { user_id, message }, options),
  sendGroupMessage: (group_id, message, options) => send('send_group_msg', { group_id, message }, options),
  sendReceipt: (requestId, requestedAccountId = accountId) => request('receipt', { requestId, accountId: String(requestedAccountId) }) };
}
