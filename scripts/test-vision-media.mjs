// 视觉/图片链路自检脚本：
// 1. 校验配置的会话模型支持图像输入（文本模型会让 QQ 图片静默失效）
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

// 优先用户 config.json；干净检出时使用随仓库的 config.example.json。
const configFile = [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')]
  .find((file) => fs.existsSync(file));
if (!configFile) {
  console.error('❌ 缺少 config.json 与 config.example.json：NOT_RUN_ENVIRONMENT');
  process.exit(2);
}
const config = readJson(configFile);
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
// 官方目录（deepseek-official，见 dsh-llm-deepseek 的 DEFAULT_MODELS）里声明了 image 输入的模型：
// 只有这些模型能让 QQ 图片工具返回的图片真正进入模型视觉上下文。
const IMAGE_CAPABLE_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash-vision-exp']);
const TEXT_ONLY_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const configuredModel = config.dsh?.model;
check('config.dsh.model 支持图像输入（否则 QQ 图片识别静默失效）', IMAGE_CAPABLE_MODELS.has(configuredModel),
  `当前 ${configuredModel}${TEXT_ONLY_MODELS.has(configuredModel) ? '（文本模型，请改用 deepseek-flash / DeepSeek-V41-Flash）' : ''}`);
check('会话模型可被 DSH 接受（provider/model 齐全）', Boolean(config.dsh?.provider && configuredModel), `provider ${config.dsh?.provider}`);
check('config.dsh.reasoningEffort 取值合法', ['off', 'low', 'high', 'max'].includes(config.dsh?.reasoningEffort ?? ''),
  `当前 ${config.dsh?.reasoningEffort}`);
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, `HTTP ${res.status}`);
        // 桥接在会话模型读不了图时会带 note 说明；note 里出现这句说明绑定的模型不对。
        check('桥接未报告「会话模型不支持图像输入」', !String(body?.note ?? '').includes('不支持图像输入'), String(body?.note ?? ''));
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
// 让 Node 自然排空 fetch/undici 的 Windows 异步句柄；Node 24 下在这里强制
// process.exit() 可能触发 libuv 的 UV_HANDLE_CLOSING 断言，即使所有检查均已通过。
process.exitCode = failed > 0 ? 1 : 0;
