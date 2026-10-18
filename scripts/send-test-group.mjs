// Development-only QQ send probe. It is excluded from SEA resources and uses
// the same account lock, final policy and durable send ledger as the product.
// Usage: node scripts/send-test-group.mjs <group keyword> <message> <requestId>
import path from 'node:path';
import os from 'node:os';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { APP_PATHS } from '../src/app-paths.js';
import { readJsonFile } from '../src/storage/json-file.js';
import { createQqRuntime } from '../src/channel/qq/runtime.js';
import { assertQqSendPolicy } from '../src/channel/qq/send-policy.js';
import { isQqConnectorEnabled } from '../src/integrations/tool-policy.js';

if (process.env.CETAMESH_QQ_DIAGNOSTIC_SEND !== 'I_UNDERSTAND_THIS_SENDS_A_REAL_MESSAGE') {
  console.error('QQ diagnostic send disabled: explicit development opt-in required');
  process.exit(2);
}
const [keyword, message, requestId] = process.argv.slice(2);
if (!keyword || !message || !/^[A-Za-z0-9:._/-]{1,160}$/.test(String(requestId ?? ''))) {
  console.error('QQ diagnostic requires a group keyword, explicit message and stable requestId');
  process.exit(2);
}

const cfg = readJsonFile(APP_PATHS.configFile);
const runtime = createQqRuntime({
  config: cfg,
  clientFactory: options => new SnowLumaWebSocketClient({ ...options, reconnect: false }),
  ownershipDir: path.join(os.tmpdir(), 'cetamesh-qq-ownership'),
  outboundFile: path.join(APP_PATHS.stateDir, 'qq-send-ledger.json'),
  authorizeSend: request => assertQqSendPolicy(request, {
    config: cfg, qqEnabled: isQqConnectorEnabled({ stateDir: APP_PATHS.stateDir }), bionicEnabled: false
  })
});

try {
  const connected = await runtime.connect();
  if (!connected.ok) throw Object.assign(new Error(connected.error ?? 'QQ diagnostic connection unavailable'), { code: connected.code });
  const groups = await runtime.client.raw('get_group_list', {});
  const list = Array.isArray(groups) ? groups : (groups?.data ?? []);
  const target = list.find(group => String(group.group_name ?? '').includes(keyword));
  if (!target) throw new Error(`未找到名称包含「${keyword}」的群`);
  // A name match is only discovery; the Runtime checks the numeric target
  // against the current allowlist immediately before the external side effect.
  const result = await runtime.sendGroupMessage(target.group_id, text(message), { requestId });
  if (result?.status === 'outcome-unknown') {
    throw Object.assign(new Error(`QQ 发送结果未知；核验 requestId ${requestId} 后才能重试`), { code: 'QQ_OUTCOME_UNKNOWN' });
  }
  console.log(`QQ 网关已处理群 ${target.group_id}（${target.group_name}）的请求 ${requestId}`);
} catch (error) {
  console.error('QQ diagnostic failed:', error?.code ?? 'QQ_DIAGNOSTIC_FAILED', error?.message ?? error);
  process.exitCode = 1;
} finally {
  const stopped = await runtime.stop();
  if (!stopped.ok) {
    console.error('QQ diagnostic could not safely release ownership:', stopped.code);
    process.exitCode = 1;
  }
}
