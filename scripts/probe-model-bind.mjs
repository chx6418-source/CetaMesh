// 会话模型绑定 / 图片识别链路自检（会真的建一个 DSH 会话、跑一个回合，结束即归档）。
//
//   node scripts/probe-model-bind.mjs            # 无图冒烟：验证 config.json 的模型能正常出话
//   node scripts/probe-model-bind.mjs --image    # 带图：验证图片真的进了模型视觉上下文并答对
//   node scripts/probe-model-bind.mjs deepseek-v4-flash --image   # 指定模型（复现「图片识别失效」）
//
// 默认模型取 config.json 的 dsh.model（即桥接给新建会话绑定的那个）。
// 带图时模型应回答「红色」；若回答看不到图 / 描述不出画面，说明该模型不声明图像输入。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { NodeApiClient } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).dsh?.model;
const withImage = process.argv.includes('--image');
const keep = process.argv.includes('--keep');
const provider = process.env.PROBE_PROVIDER || 'deepseek-official';
const effort = process.env.PROBE_EFFORT || 'high';
const waitMs = Number(process.env.PROBE_WAIT_MS || 90000);

/** 生成一张纯红色 PNG（带正确 CRC，避免用坏图冤枉模型）。 */
function redPng(size = 64) {
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = 220; raw[at + 1] = 30; raw[at + 2] = 30;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const api = new NodeApiClient(process.env.PROBE_BASE_URL || 'http://127.0.0.1:3080');
const { sessionId } = await api.callEndpoint('session/create', { request: {} });
console.log('session', sessionId);
const selected = await api.callEndpoint('session/selectModel', { request: { sessionId, provider, model, reasoningEffort: effort } });
console.log('selectModel ->', JSON.stringify(selected.selected));

const content = [{ type: 'text', text: withImage ? '这张图里是什么颜色？只回一个词。' : '只回复：OK' }];
if (withImage) {
  content.push({ type: 'image', mediaType: 'image/png', data: redPng().toString('base64'), name: 'probe-red.png' });
}

// session/follow 在会话空闲时会「推完快照就结束」，只靠实时事件容易漏掉整轮；
// 快照本身带完整历史（records[].event），所以直接轮询快照里最后一条 assistant 文本。
async function readLatestAssistantText() {
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 8000);
  try {
    for await (const item of api.openRemoteStream('session/follow', { request: { address: { kind: 'session', sessionId } } }, { signal: controller.signal })) {
      if (item?.type !== 'snapshot') continue;
      let text = '';
      for (const record of item.records ?? []) {
        const event = record?.event;
        if (event?.type !== 'assistant/message') continue;
        text = '';
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        }
      }
      return text.trim();
    }
  } catch { /* 流断开：交给调用方重试 */ } finally {
    clearTimeout(guard);
  }
  return '';
}

const prompted = await api.callEndpoint('session/prompt', { request: { requestId: `probe-${Date.now()}`, sessionId, mode: 'queue', content } });
console.log('prompt ->', JSON.stringify(prompted));
const deadline = Date.now() + waitMs;
let answer = '';
while (Date.now() < deadline) {
  answer = await readLatestAssistantText();
  if (answer) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (answer) console.log('assistant:', JSON.stringify(answer));
else console.log(`⚠️ ${waitMs}ms 内没有拿到 assistant 回复`);

if (!keep) {
  await api.callEndpoint('workspace/archiveSession', { request: { sessionId } }).catch((error) => console.log('archive failed', error.message));
  console.log('archived');
}
process.exit(answer ? 0 : 1);
