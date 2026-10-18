// 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。
// 用法：node scripts/send-test-group.mjs <群名关键词> [消息内容]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { acquireQqOwnership } from '../src/channel/qq/ownership.js';
import os from 'node:os';

// Developer-only probe. It is not in the SEA payload and must never compete
// with a product QQ consumer or infer authorization from a group name.
if (process.env.CETAMESH_QQ_DIAGNOSTIC_SEND !== 'I_UNDERSTAND_THIS_SENDS_A_REAL_MESSAGE') {
  console.error('QQ diagnostic send disabled: explicit development opt-in required');
  process.exit(2);
}
if (!process.argv[2] || !process.argv[3]) {
  console.error('QQ diagnostic send requires a group keyword and explicit message');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;

const keyword = process.argv[2];
const message = process.argv[3];

const bot = new SnowLumaWebSocketClient({ url: wsUrl, accessToken: accessToken || undefined, reconnect: false });
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000));
let gatewayLease;
let accountLease;

try {
  gatewayLease = acquireQqOwnership('gateway', wsUrl, path.join(os.tmpdir(), 'cetamesh-qq-ownership'));
  await Promise.race([bot.connect(), timeout]);
  const login = await bot.getLoginInfo();
  const accountId = login?.user_id ?? login?.data?.user_id;
  if (!accountId) throw new Error('QQ diagnostic account identity unavailable');
  accountLease = acquireQqOwnership('account', String(accountId), path.join(os.tmpdir(), 'cetamesh-qq-ownership'));
  console.log('✅ 已连接网关');

  const groups = await bot.raw('get_group_list', {});
  const list = Array.isArray(groups) ? groups : (groups?.data ?? []);
  console.log(`共 ${list.length} 个群：`, list.map((g) => `${g.group_id}(${g.group_name})`).join('、'));

  const target = list.find((g) => String(g.group_name ?? '').includes(keyword));
  if (!target) {
    console.error(`❌ 未找到名称包含「${keyword}」的群`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.allow?.groups) || !cfg.allow.groups.map(String).includes(String(target.group_id)) ||
      (cfg.deny?.groups ?? []).map(String).includes(String(target.group_id))) {
    throw new Error('QQ diagnostic target is not explicitly allowlisted');
  }

  const result = await bot.sendGroupMessage(target.group_id, text(message));
  console.log(`✅ 已发送到群 ${target.group_id}（${target.group_name}）: ${message}`);
  console.log('  响应:', JSON.stringify(result));
} catch (error) {
  console.error('❌ 发送失败:', error?.message ?? error);
  process.exit(1);
} finally {
  try { bot.close(); } catch {}
  accountLease?.release();
  gatewayLease?.release();
}
