// 自测脚本：不依赖 SnowLuma / QQ，只验证 DSH 侧链路——
//   1. 连接 DSH Web API（settings/describe 探活）
//   2. 创建一个独立测试会话（不会碰现有会话）
//   3. session/prompt 注入一条消息
//   4. 轮询会话快照，等 agent 回复并打印
// 用法：node src/self-test.js [baseUrl] [prompt文本]
//
// 说明：不靠 session/follow 的实时事件——该流在会话空闲时会「推完快照就结束」，
// 订阅时机稍晚就会整轮漏掉（曾表现为「等待回复超时」）。快照本身带完整历史，
// 这里改为轮询快照里最后一条 assistant 文本，稳定且不依赖订阅时序。
import fs from 'node:fs';
import { NodeApiClient } from './dsh-client.js';
import { APP_PATHS } from './app-paths.js';
import { isMainModule, reportEntrypointError } from './entrypoint.js';

export async function runSelfTest(options = {}) {
  const baseUrl = options.baseUrl ?? process.argv[2] ?? 'http://127.0.0.1:3080';
  const api = new NodeApiClient(baseUrl);
  const promptText = options.promptText ?? process.argv[3] ?? '只回复两个字：收到';

  await api.callEndpoint('settings/describe', {});
  console.log('✅ DSH 连接成功（settings/describe 探活通过）');

  // 独立测试会话，cwd 用临时目录
  const cwd = APP_PATHS.selfTestDir;
  fs.mkdirSync(cwd, { recursive: true });
  const created = await api.callEndpoint('session/create', { request: { cwd } });
  const sessionId = created.sessionId;
  console.log('✅ 测试会话已创建:', sessionId);

  /** 读一次会话快照，返回最后一条 assistant 文本与最后一条 turn 结束原因。 */
  async function readSessionState() {
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 8000);
    try {
      for await (const item of api.openRemoteStream('session/follow', { request: { address: { kind: 'session', sessionId } } }, { signal: controller.signal })) {
        if (item?.type !== 'snapshot') continue;
        let text = '';
        let reason = null;
        for (const record of item.records ?? []) {
          const event = record?.event;
          if (event?.type === 'assistant/message') {
            text = '';
            for (const block of event.data?.message?.content ?? []) {
              if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
            }
          } else if (event?.type === 'turn/end') {
            reason = event.data?.reason ?? null;
          }
        }
        return { text: text.trim(), reason };
      }
    } catch { /* 流断开：交给调用方重试 */ } finally {
      clearTimeout(guard);
    }
    return { text: '', reason: null };
  }

  const accepted = await api.callEndpoint('session/prompt', {
    request: { requestId: `self-test-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }
  });
  console.log('✅ prompt 已接受:', JSON.stringify(accepted));

  const deadline = Date.now() + 60_000;
  let state = { text: '', reason: null };
  while (Date.now() < deadline) {
    state = await readSessionState();
    if (state.text) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!state.text) throw new Error('等待回复超时（60s）');
  if (state.reason && state.reason.kind !== 'completed') throw new Error(`回合异常结束: ${state.reason.kind}`);
  console.log('✅ 回合结束 reason =', state.reason?.kind ?? '未知');
  console.log('🤖 agent 回复:');
  console.log(state.text);
  console.log('🎉 自测通过 —— DSH 侧链路可用');
}

if (isMainModule(import.meta.url)) {
  runSelfTest().catch((error) => reportEntrypointError('self-test', error));
}
