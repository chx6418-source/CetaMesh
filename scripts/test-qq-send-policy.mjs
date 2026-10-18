import assert from 'node:assert/strict';
import { assertQqSendPolicy } from '../src/channel/qq/send-policy.js';

const config = { allow: { groups: ['42'], private: ['7'] }, deny: { groups: [], private: [] },
  allowAllWhenEmpty: false, socialV2: { sticker: { enabled: true } } };
const enabled = new Set(['qq_send_file', 'qq_send_audio_from_url', 'qq_send_poke',
  'qq_set_sticker_remark', 'qq_collect_sticker']);
const policy = (request, overrides = {}) => assertQqSendPolicy(request, {
  config, qqEnabled: true, bionicEnabled: true,
  toolEnabled: name => { if (!enabled.has(name)) throw Object.assign(new Error('disabled'), { code: 'TOOL_DISABLED' }); },
  ...overrides
});
const base = { accountId: '10001', target: 'group:42', action: 'send_group_msg', kind: 'text' };
assert.doesNotThrow(() => policy(base));
assert.doesNotThrow(() => policy(base, { bionicEnabled: false }),
  'disabling Bionic social policy must leave basic QQ text transport available');
assert.throws(() => policy({ ...base, accountId: null }), { code: 'QQ_ACCOUNT_UNVERIFIED' });
assert.throws(() => policy({ ...base, target: 'group:43' }), { code: 'QQ_TARGET_DENIED' });
assert.throws(() => policy(base, { qqEnabled: false }), { code: 'QQ_DISABLED' });
for (const kind of ['file', 'audio', 'music']) {
  assert.throws(() => policy({ ...base, kind }), { code: 'QQ_MEDIA_PERMISSION_REQUIRED' }, `${kind} needs its own tool permission`);
}
assert.doesNotThrow(() => policy({ ...base, kind: 'file', toolName: 'qq_send_file' }));
assert.doesNotThrow(() => policy({ ...base, kind: 'audio', toolName: 'qq_send_audio_from_url' }));
assert.doesNotThrow(() => policy({ ...base, kind: 'audio', toolName: 'qq_send_file' }), 'file-send can legally encode an audio file as a record');
assert.throws(() => policy({ ...base, kind: 'music', toolName: 'qq_send_file' }), { code: 'QQ_MEDIA_PERMISSION_REQUIRED' });
assert.throws(() => policy({ ...base, kind: 'file', toolName: 'qq_send_file' }, { toolEnabled: () => { throw Object.assign(new Error('disabled'), { code: 'TOOL_DISABLED' }); } }),
  { code: 'TOOL_DISABLED' }, 'a hot-disabled MCP or Plugin tool must deny before IO');
assert.throws(() => policy({ ...base, kind: 'sticker' }), { code: 'QQ_MEDIA_PERMISSION_REQUIRED' });
assert.doesNotThrow(() => policy({ ...base, kind: 'sticker', mediaAuthorized: true, toolName: 'qq_send_sticker' },
  { toolEnabled: () => {} }));
assert.throws(() => policy({ ...base, kind: 'sticker', mediaAuthorized: true }, { bionicEnabled: false }), { code: 'QQ_BIONIC_DISABLED' });
assert.throws(() => policy({ ...base, kind: 'card' }), { code: 'QQ_APPROVAL_REQUIRED' });
assert.doesNotThrow(() => policy({ ...base, kind: 'card', approvalVerified: true }));
assert.throws(() => policy({ ...base, kind: 'poke' }), { code: 'QQ_MEDIA_PERMISSION_REQUIRED' });
assert.doesNotThrow(() => policy({ ...base, kind: 'poke', toolName: 'qq_send_poke' }));
assert.throws(() => policy({ ...base, kind: 'custom-face', target: 'private:10001' }), { code: 'QQ_MEDIA_PERMISSION_REQUIRED' });
assert.doesNotThrow(() => policy({ ...base, kind: 'custom-face', target: 'private:10001',
  mediaAuthorized: true, toolName: 'qq_collect_sticker' }));
console.log('PASS QQ send policy account, allowlist, media, tool and approval denials');
