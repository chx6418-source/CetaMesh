export function inferQqMessageKind(action, params, options = {}) {
  let kind;
  if (action.startsWith('upload_')) kind = 'file';
  else if (action.includes('poke')) kind = 'poke';
  else if (action.includes('custom_face')) kind = 'custom-face';
  else if (action === 'click_inline_keyboard_button') kind = 'card';
  const segments = Array.isArray(params?.message) ? params.message : [params?.message];
  const mediaKinds = new Set();
  for (const segment of segments) {
    if (!segment || typeof segment === 'string') continue;
    const type = segment.type;
    if (['text', 'at', 'reply', 'face'].includes(type)) continue;
    const value = type === 'record' ? 'audio' : type === 'music' ? 'music' : type === 'image' ? 'sticker'
      : ['file', 'video'].includes(type) ? 'file'
        : ['json', 'xml', 'share', 'ark', 'markdown', 'inline_keyboard', 'keyboard', 'lightapp', 'miniapp', 'forward', 'node'].includes(type) ? 'card' : null;
    if (!value) throw Object.assign(new Error('Unsupported QQ media segment'), { code: 'QQ_MEDIA_UNSUPPORTED' });
    mediaKinds.add(value);
  }
  if (mediaKinds.size > 1) throw Object.assign(new Error('Mixed media requires separate authorized requests'), { code: 'QQ_MIXED_MEDIA_UNSUPPORTED' });
  if (!kind && mediaKinds.size) kind = [...mediaKinds][0];
  if (!kind && segments.some(segment => segment?.type === 'record')) kind = 'audio';
  if (!kind && segments.some(segment => segment?.type === 'music')) kind = 'music';
  if (!kind && segments.some(segment => segment?.type === 'image')) kind = 'sticker';
  if (!kind && segments.some(segment => ['json', 'xml', 'share', 'ark', 'markdown', 'inline_keyboard', 'keyboard', 'lightapp', 'miniapp'].includes(segment?.type))) kind = 'card';
  kind ??= 'text';
  if (options.kind && options.kind !== kind) throw Object.assign(new Error('QQ send kind does not match payload'), { code: 'QQ_MEDIA_KIND_MISMATCH' });
  if (typeof params?.message === 'string' && /\[CQ:/i.test(params.message)) throw Object.assign(new Error('Raw CQ payload is not accepted; use typed segments'), { code: 'QQ_MEDIA_KIND_MISMATCH' });
  return kind;
}
export const QQ_READ_ACTIONS = new Set(['get_login_info', 'get_status', 'get_msg', 'get_group_member_info',
  'get_group_member_list', 'get_group_list', 'get_group_msg_history', 'get_image', 'fetch_custom_face', 'get_custom_face', 'get_forward_msg', 'fetch_face_entity', 'fetch_custom_face_detail']);

export function inferQqTarget(action, params, accountId) {
  const fail = () => { throw Object.assign(new Error('QQ action has missing or conflicting recipient identities'), { code: 'QQ_TARGET_INVALID' }); };
  const positive = value => /^[1-9]\d{0,19}$/.test(String(value ?? ''));
  if (['send_private_msg', 'upload_private_file', 'send_poke'].includes(action)) {
    if (params.group_id !== undefined || !positive(params.user_id)) fail();
    return `private:${params.user_id}`;
  }
  if (['send_group_msg', 'upload_group_file', 'group_poke', 'click_inline_keyboard_button'].includes(action)) {
    if (!positive(params.group_id) || (action !== 'group_poke' && params.user_id !== undefined) ||
        (action === 'group_poke' && !positive(params.user_id))) fail();
    return `group:${params.group_id}`;
  }
  if (['add_custom_face', 'modify_custom_face'].includes(action)) {
    if (params.group_id !== undefined || params.user_id !== undefined || !positive(accountId)) fail();
    return `private:${accountId}`;
  }
  fail();
}

