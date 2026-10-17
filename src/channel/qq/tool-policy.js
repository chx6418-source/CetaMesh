import { assertMcpToolEnabled, isIntegrationToolEnabled } from '../../integrations/tool-policy.js';

// Existing Social config flags remain an additional, independent safety gate.
export const QQ_SOCIAL_FLAG_TOOLS = Object.freeze({
  getPrompt: ['qq_get_prompt'], getUnread: ['qq_get_unread_messages'], getRecent: ['qq_get_recent_messages'],
  socialState: ['qq_social_state'], sendGroup: ['qq_send_group_message'], sendPrivate: ['qq_send_private_message'],
  reply: ['qq_reply'], sendBurst: ['qq_send_burst'], sendMessage: ['qq_send_message'], waitMessages: ['qq_wait_for_messages'],
  feedback: ['qq_report_feedback'], getMyRecent: ['qq_get_my_recent_messages'], getMessageDetail: ['qq_get_message_detail'],
  getActiveMembers: ['qq_get_active_members'], setWakeConfig: ['qq_set_wake_config'], markRead: ['qq_mark_read'],
  memory: ['qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear'],
  slangQuery: ['qq_slang_query'], slangSubmit: ['qq_slang_submit'], getImages: ['qq_get_message_images'],
  getForwardMsg: ['qq_get_forward_msg'], getCardMsg: ['qq_get_card_msg'], clickCardButton: ['qq_click_card_button'],
  sendPoke: ['qq_send_poke'], listStickers: ['qq_list_stickers'], getStickerImage: ['qq_get_sticker_image'],
  sendSticker: ['qq_send_sticker'], setStickerRemark: ['qq_set_sticker_remark'], stickerNote: ['qq_sticker_note'],
  collectSticker: ['qq_collect_sticker'], getSelfImage: ['qq_get_self_image']
});

const QQ_DATA_ROUTES = Object.freeze({
  '/api/send/group': 'qq_send_group_message', '/api/send/private': 'qq_send_private_message', '/api/send/reply': 'qq_reply',
  '/api/images/message': 'qq_get_message_images',
  '/api/socialV2/prompt': 'qq_get_prompt', '/api/socialV2/unread': 'qq_get_unread_messages',
  '/api/socialV2/recent': 'qq_get_recent_messages', '/api/socialV2/state': 'qq_social_state',
  '/api/socialV2/mark-read': 'qq_mark_read', '/api/socialV2/wake-config': 'qq_set_wake_config',
  '/api/socialV2/send-burst': 'qq_send_burst', '/api/socialV2/send-message': 'qq_send_message',
  '/api/socialV2/send-poke': 'qq_send_poke', '/api/socialV2/wait': 'qq_wait_for_messages',
  '/api/socialV2/feedback': 'qq_report_feedback', '/api/socialV2/my-recent': 'qq_get_my_recent_messages',
  '/api/socialV2/message-detail': 'qq_get_message_detail', '/api/socialV2/active-members': 'qq_get_active_members',
  '/api/socialV2/memory-append': 'qq_memory_append', '/api/socialV2/memory-update': 'qq_memory_append',
  '/api/socialV2/memory': 'qq_memory_query', '/api/socialV2/memory-remove': 'qq_memory_remove',
  '/api/socialV2/memory-clear': 'qq_memory_clear', '/api/socialV2/slang/query': 'qq_slang_query',
  '/api/socialV2/slang/submit': 'qq_slang_submit', '/api/socialV2/sticker-list': 'qq_list_stickers',
  '/api/socialV2/sticker-image': 'qq_get_sticker_image', '/api/socialV2/send-sticker': 'qq_send_sticker',
  '/api/socialV2/collect-sticker': 'qq_collect_sticker', '/api/socialV2/self-image': 'qq_get_self_image',
  '/api/socialV2/sticker-note': 'qq_sticker_note', '/api/socialV2/sticker-remark': 'qq_set_sticker_remark',
  '/api/socialV2/forward-message': 'qq_get_forward_msg', '/api/socialV2/forward-media': 'qq_get_forward_msg',
  '/api/socialV2/card-message': 'qq_get_card_msg', '/api/socialV2/card-button-click': 'qq_click_card_button',
  '/api/socialV2/card-button-approval': 'qq_get_card_button_approval'
});

export function qqToolPolicyEnabled(name, options) {
  return isIntegrationToolEnabled('mcp__snowluma__' + name, options);
}

export function qqSocialFlagPolicyEnabled(flag, options) {
  return (QQ_SOCIAL_FLAG_TOOLS[flag] ?? []).some(name => qqToolPolicyEnabled(name, options));
}

export function assertQqDataToolEnabled(pathname, options) {
  const name = QQ_DATA_ROUTES[pathname];
  if (name) assertMcpToolEnabled('snowluma', name, options);
}
