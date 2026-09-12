// 自测脚本：不依赖 SnowLuma / QQ，只验证 DSH 侧链路——
//   1. 连接 DSH Web API（settings/describe 探活）
//   2. 创建一个独立测试会话（不会碰现有会话）
//   3. 订阅该会话的 session/follow 事件流
//   4. session/prompt 注入一条消息
//   5. 等 agent 回复（turn/end）并打印
// 用法：node src/self-test.js [baseUrl] [prompt文本]
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, createTurnCollector } from './dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080';
  const api = new NodeApiClient(baseUrl);
  const promptText = process.argv[3] ?? '只回复两个字：收到';

  await api.callEndpoint('settings/describe', {});
  console.log('✅ DSH 连接成功（settings/describe 探活通过）');

  // 独立测试会话，cwd 用临时目录
  const cwd = path.join(ROOT, 'state', 'self-test');
  fs.mkdirSync(cwd, { recursive: true });
  const created = await api.callEndpoint('session/create', { request: { cwd } });
  const sessionId = created.sessionId;
  console.log('✅ 测试会话已创建:', sessionId);

  // 先订阅会话流（在 prompt 之前），再注入消息。
  // follow 流首帧是历史快照（丢弃），之后才是实时事件。
  const collector = createTurnCollector();
  let resolveOpened;
  let openTimer;
  const opened = new Promise((resolve, reject) => {
    openTimer = setTimeout(() => reject(new Error('等待 follow 流建立超时（10s）')), 10_000);
    resolveOpened = () => { clearTimeout(openTimer); resolve(); };
  });
  const stream = api.openRemoteStream('session/follow', { request: { address: { kind: 'session', sessionId } } });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（60s）')), 60_000);
    (async () => {
      let sawFirst = false;
      for await (const item of stream) {
        if (!sawFirst) {
          sawFirst = true;
          resolveOpened();
        }
        if (item.type !== 'event') continue; // snapshot 等非实时帧
        const ended = collector.push(item.event);
        if (ended && ended.reason?.kind === 'completed') {
          clearTimeout(timer);
          resolve(ended);
          return;
        }
        if (ended) {
          clearTimeout(timer);
          reject(new Error(`回合异常结束: ${ended.reason?.kind}`));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });
  await opened;

  const accepted = await api.callEndpoint('session/prompt', {
    request: { requestId: `self-test-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }
  });
  console.log('✅ prompt 已接受:', JSON.stringify(accepted));

  const ended = await done;
  console.log('✅ 回合结束 reason =', ended.reason.kind);
  console.log('🤖 agent 回复:');
  console.log(ended.text || '（无文本）');
  console.log('🎉 自测通过 —— DSH 侧链路可用');
  process.exit(0);
}

main().catch((error) => {
  console.error('❌ 自测失败:', error?.message ?? error);
  process.exit(1);
});
