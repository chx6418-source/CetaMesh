import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTROL_MODES, createControlService, migrateLegacyMode } from '../src/control/control-service.js';
import { PRIVILEGE_CONSOLE } from '../src/bridge-privilege.js';
import { RUNTIME_POLICIES, normalizeRuntimeMode } from '../src/runtime-policy.js';

assert.deepEqual(CONTROL_MODES, ['chat', 'owner-agent', 'social', 'workshop']);
assert.deepEqual(RUNTIME_POLICIES, ['social', 'owner-agent', 'workshop']);
assert.equal(normalizeRuntimeMode(' closed-agent '), 'owner-agent');
for (const [legacy, expected] of [['closed-agent', 'owner-agent'], ['reserved', 'chat'], ['reserved2', 'social'], ['owner-agent', 'owner-agent']]) {
  assert.equal(migrateLegacyMode(legacy), expected);
  let persisted = { mode: legacy, allow: { private: [123], groups: [456] }, ownerQQ: 123 };
  let runtime = { ...persisted };
  const writes = [];
  const ports = new Proxy({
    readPersistedPolicy: () => persisted,
    readRuntimePolicy: () => runtime,
    writePersistedPolicy: (value) => { writes.push(value); persisted = value; },
    writeRuntimePolicy: (value) => { runtime = value; return value; }
  }, { get: (target, key) => key in target ? target[key] : () => null });
  const service = createControlService(ports);
  const actor = { privilege: PRIVILEGE_CONSOLE };
  assert.equal(service.execute({ method: 'policy.get', actor }).policy.mode, expected);
  assert.equal(writes.length, 0, 'reading old config must not mutate it');
  assert.equal(service.execute({ method: 'policy.update', params: { allow: { groups: [789] } }, actor }).policy.mode, expected);
  assert.equal(writes[0].mode, expected);
  assert.equal(runtime.mode, expected);
  assert.equal(service.execute({ method: 'policy.update', params: { mode: legacy }, actor }).policy.mode, expected);
  const previousWrites = writes.length;
  assert.throws(() => service.execute({ method: 'policy.update', params: { mode: 'smart' }, actor }), { code: 'INVALID_MODE' });
  assert.equal(writes.length, previousWrites, 'Chat Session modes cannot become runtime policies');
}
assert.equal(migrateLegacyMode('unknown'), 'unknown', 'unknown modes must remain invalid');
assert.equal(migrateLegacyMode('toString'), 'toString', 'prototype names cannot become migration aliases');
const shell = fs.readFileSync(new URL('../desktop-shell/src/app_shell.rs', import.meta.url), 'utf8');
// UI v1：导航收敛为 5+2（对话第一），工程页仍保留用户语言标签（可从设置/关于到达）。
for (const label of ['对话', '工作', '记忆', '智能体', '插件', '设置', '关于', '状态与日志', '渠道控制台', '设备与连接', '服务连接', '安全通知']) {
  assert.ok(shell.includes('=> "' + label + '"'), 'missing product page: ' + label);
}
assert.ok(
  shell.indexOf('Self::Chat') < shell.indexOf('Self::Work') && shell.includes('PRIMARY: [Self; 5]'),
  'Chat must be the first primary nav page'
);
const ui = fs.readFileSync(new URL('../desktop-shell/src/native_ui.rs', import.meta.url), 'utf8');
assert.ok(ui.includes('"owner-agent"'));
assert.ok(ui.includes('"closedAgent"'), 'legacy preset key remains compatible');
assert.ok(!ui.includes('["chat", "closed-agent", "social", "workshop"]'), 'new mode selectors use canonical names');
assert.ok(ui.includes('for mode in ["social", "owner-agent", "workshop"]'), 'new runtime selector offers product policies only');
const chat = fs.readFileSync(new URL('../desktop-shell/src/chat_ui.rs', import.meta.url), 'utf8');
assert.ok(chat.includes('"chat"') && ui.includes('"smart"'), 'Chat Session modes stay independent');
const consoleUi = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
assert.ok(consoleUi.includes('data-mode="owner-agent"'));
assert.ok(consoleUi.includes('>Owner Agent '));
assert.ok(!consoleUi.includes('data-mode="closed-agent"'));
assert.ok(!consoleUi.includes('data-mode="reserved"') && !consoleUi.includes('data-mode="reserved2"'));
assert.ok(consoleUi.includes("'closed-agent': 'owner-agent'"), 'legacy response normalization remains available');
console.log('PASS owner-agent migration, policy compatibility, product navigation, and Chat Session modes');
