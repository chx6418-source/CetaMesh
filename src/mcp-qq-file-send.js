// 文件/音频发送 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 设计要点：
// - 单工具 qq_send_file：入参仅两个必填项 —— target（目标接收地址，private:QQ号 / group:群号）
//   与 filePath（待发送文件绝对路径），可直接嵌入任意 Agent 的工具调用列表。
// - 原子能力按文件扩展名自动选择：
//     * 音频（mp3/wav/flac/ogg/m4a/aac/amr/silk/opus/wma）→ OneBot record 段（语音消息）
//     * 其他文件 → OneBot upload_private_file / upload_group_file（文件消息）
// - 强制白名单校验：目标必须命中 config.json 的 allow.private / allow.groups（allowAllWhenEmpty
//   语义与桥接一致），否则拒绝 —— agent 只能往被允许的地方发文件。
// - 受 socialV2.tools.fileSend 开关控制（桥接控制台 3100 的“文件发送工具”面板可开关）；
//   关闭时工具直接返回 statusCode=403。
// - 返回值固定为 { statusCode, message, ... }：
//     statusCode 0  = 发送成功
//     statusCode 400= 入参错误（target 格式 / 非绝对路径）
//     statusCode 403= 工具被禁用或目标不在白名单
//     statusCode 404= 文件不存在或不是普通文件
//     statusCode 413= 超过文件大小上限（fileSend.maxSizeMb，默认 25MB）
//     statusCode 500= OneBot 发送失败（详见 message）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { safeFetchAudioBuffer, looksLikeAudioBuffer } from './safe-fetch.js';
import { PINYIN } from './pinyin-data.js';
import { parseAudioFile } from './audio-probe.js';
import { synthesizeProsody } from './tts-prosody.js';
import { kugouSearch, resolveSongUrl } from './kugou-api.js';
import { APP_PATHS } from './app-paths.js';
import { isMainModule, reportEntrypointError } from './entrypoint.js';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.amr', '.silk', '.opus', '.wma']);
const DEFAULT_MAX_SIZE_MB = 25;

function loadConfig() {
  try {
    let text = fs.readFileSync(APP_PATHS.configFile, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// 与桥接 allowed() 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

function getOneBotConfig(cfg) {
  return {
    httpUrl: (cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: cfg.snowluma?.accessToken ?? ''
  };
}

async function onebot(cfg, action, params) {
  const { httpUrl, token } = getOneBotConfig(cfg);
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口）' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// ── 本地 TTS 合成（GPT-SoVITS ayane，启动入口 start_api_ayane.bat，韵律自适应）/ 缓存 / 语音发送 ──
const CACHE_DIR = APP_PATHS.fileSendCacheDir;

function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// 本地 TTS 合成（韵律自适应）：委托 tts-prosody 引擎完成 场景/情绪→语速(0.8~1.3)/语调(±15%)/停顿(100~300ms) 参数
// 自适应与冲突校验、分段合成、静音拼接与语调后处理。返回 {buf, ext, prosody, pauses, audioFile} 或 {error}。
async function ttsSynthesize(cfg, text) {
  const result = await synthesizeProsody(cfg, String(text ?? ''), CACHE_DIR);
  if (result.error) return { error: result.error };
  try {
    const buf = fs.readFileSync(result.path);
    if (buf.length < 200) return { error: '本地TTS 韵律合成结果过小' };
    if (!looksLikeAudioBuffer(buf)) return { error: '本地TTS 韵律合成结果不是有效音频' };
    return {
      buf,
      ext: 'wav',
      prosody: result.prosody,
      pauses: result.pauses ?? [],
      audioFile: result.path,
    };
  } catch (e) {
    return { error: `本地TTS 韵律合成读取失败：${e?.message ?? e}` };
  }
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // 清理 7 天前的缓存音频，避免无限增长
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

function cacheAudio(buf, ext, prefix) {
  ensureCacheDir();
  const p = path.join(CACHE_DIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}

function extFromUrl(raw) {
  try {
    const m = /\.(mp3|wav|ogg|m4a|flac|amr|opus|silk)$/i.exec(new URL(String(raw)).pathname);
    if (m) return m[1].toLowerCase();
  } catch {}
  return 'mp3';
}

// 发送语音消息（OneBot record 段）
async function sendVoiceRecord(cfg, kind, id, filePath) {
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  return onebot(cfg, action, {
    [kind === 'private' ? 'user_id' : 'group_id']: id,
    message: [{ type: 'record', data: { file: filePath.replace(/\\/g, '/') } }]
  });
}

// target 解析 + 白名单校验；失败返回 {error:{statusCode,message}}
function resolveTarget(cfg, target) {
  const m = /^(private|group):(\d+)$/.exec(String(target ?? '').trim());
  if (!m) return { error: { statusCode: 400, message: `target 格式应为 private:QQ号 或 group:群号，收到: ${String(target)}` } };
  const kind = m[1];
  const id = Number(m[2]);
  const allowAllWhenEmpty = cfg.allowAllWhenEmpty === true;
  const allowList = kind === 'private' ? (cfg.allow?.private ?? []).map(String) : (cfg.allow?.groups ?? []).map(String);
  const denyList = kind === 'private' ? (cfg.deny?.private ?? []).map(String) : (cfg.deny?.groups ?? []).map(String);
  if (!isAllowed(allowList, denyList, id, allowAllWhenEmpty)) {
    return { error: { statusCode: 403, message: `目标 ${kind}:${id} 不在白名单内（allow.${kind === 'private' ? 'private' : 'groups'}）` } };
  }
  return { kind, id };
}

// ── 本地音频文件名搜索：模糊匹配 + 拼音容错 + 关联度排序（纯 JS，无额外依赖） ──
const CJK_RE = /[\u4e00-\u9fff]/;
const AUDIO_SCAN_LIMIT = 10000;

// 归一化：NFKC + 小写 + 去空白/标点
function normText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-—–.，,、。!！?？"'“”‘’()（）[\]【】:：;；/\\|+*=~`^$@#%&]+/g, '')
    .trim();
}

function stripAudioExt(name) {
  return name.replace(/\.[A-Za-z0-9]+$/, '');
}

// 逐字拼音变体列表（拉丁字符/数字原样保留，未知汉字返回 null）
function toPinyinLists(text) {
  return [...text].map((ch) => {
    const py = PINYIN[ch];
    if (py) return py;
    if (/[a-z0-9]/.test(ch)) return [ch];
    return null;
  });
}

// DP：目标串能否由逐字拼音变体按序拼出（多音字容错，如「音乐」yīn+yuè 命中 yinyue）
function pinyinPathMatch(lists, target) {
  if (!target) return true;
  let dp = new Set([0]);
  for (const variants of lists) {
    if (!variants) return false;
    const next = new Set();
    for (const pos of dp) {
      for (const v of variants) {
        if (target.startsWith(v, pos)) next.add(pos + v.length);
      }
    }
    if (next.size === 0) return false;
    dp = next;
  }
  return dp.has(target.length);
}

// b 的字符是否按序出现在 a 中（模糊子序列匹配）
function subsequenceMatch(a, b) {
  let i = 0;
  for (const ch of b) {
    const j = a.indexOf(ch, i);
    if (j < 0) return false;
    i = j + 1;
  }
  return true;
}

// 变体感知的拼音子串匹配：从任一位置起，连续若干字的拼音变体能否拼出 target（多音字容错）
function pinyinSubstringMatch(lists, target) {
  if (!target || !lists || lists.length === 0) return false;
  for (let start = 0; start < lists.length; start++) {
    let dp = new Set([0]);
    for (let k = start; k < lists.length; k++) {
      const variants = lists[k];
      if (!variants) break;
      const next = new Set();
      for (const pos of dp) {
        for (const v of variants) {
          if (target.startsWith(v, pos)) next.add(pos + v.length);
        }
      }
      if (next.size === 0) break;
      if (next.has(target.length)) return true;
      dp = next;
    }
  }
  return false;
}

// 单个文件打分：返回 {score, type} 或 null（不匹配）
// queryNorm=归一化查询串；tokens=按空白/标点切分的词；queryPyTarget=查询的拼音目标（纯拼音查询即 queryNorm）
function scoreFile(name, queryNorm, tokens, queryPyTarget) {
  const nameNorm = normText(stripAudioExt(name));
  if (!nameNorm) return null;
  const lists = toPinyinLists(nameNorm);
  const firstPy = lists ? lists.map((l) => (l ? l[0] : '')).join('') : '';
  if (nameNorm === queryNorm) return { score: 100, type: 'exact' };
  if (nameNorm.includes(queryNorm)) return { score: 92, type: 'substring' };
  if (tokens.length > 1 && tokens.every((t) => t.length >= 2 && nameNorm.includes(t))) return { score: 85, type: 'all-tokens' };
  if (queryPyTarget) {
    if (lists && pinyinPathMatch(lists, queryPyTarget)) return { score: 82, type: 'pinyin-path' };
    if (lists && pinyinSubstringMatch(lists, queryPyTarget)) return { score: 76, type: 'pinyin-substr' };
    if (queryPyTarget.length >= 3 && subsequenceMatch(firstPy, queryPyTarget)) return { score: 58, type: 'pinyin-fuzzy' };
  }
  if (queryNorm.length >= 2 && subsequenceMatch(nameNorm, queryNorm)) return { score: 65, type: 'fuzzy' };
  if (tokens.some((t) => t.length >= 2 && nameNorm.includes(t))) return { score: 45, type: 'partial-token' };
  return null;
}

// 递归扫描本地读取目录中的音频文件（带数量上限）
function scanAudioFiles(dirs) {
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= AUDIO_SCAN_LIMIT) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
        const key = full.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          out.push({ path: full, name: e.name, size });
        }
      }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

// ── 音量增益（ffmpeg 解码重编码；压缩格式音量调节的可行途径，纯 JS 无法直接放大压缩音频） ──
function resolveGain(cfg, gainArg) {
  const raw = gainArg !== undefined && gainArg !== null ? Number(gainArg) : Number(cfg.fileSend?.volumeGain);
  if (Number.isFinite(raw) && raw >= 0.5 && raw <= 8) return Math.round(raw * 100) / 100;
  return 1;
}
function ffmpegPath(cfg) {
  return String(cfg.fileSend?.ffmpegPath ?? '').trim() || path.join(APP_PATHS.toolsDir, 'ffmpeg', 'ffmpeg.exe');
}
function ffmpegExists(cfg) {
  try { return fs.existsSync(ffmpegPath(cfg)); } catch { return false; }
}
// 返回 {path}（增益后的 mp3，写入缓存）或 {error}
function applyVolumeGain(cfg, srcPath, gain) {
  if (!ffmpegExists(cfg)) {
    return { error: `音量增益需要 ffmpeg（未找到 ${ffmpegPath(cfg)}；可在 config.json fileSend.ffmpegPath 指定）` };
  }
  ensureCacheDir();
  const out = path.join(CACHE_DIR, `gain-${gain}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  try {
    const r = spawnSync(ffmpegPath(cfg), ['-y', '-i', srcPath, '-af', `volume=${gain}`, '-c:a', 'libmp3lame', '-q:a', '2', out], {
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    });
    if (r.status !== 0 || !fs.existsSync(out)) {
      const tail = (r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
      return { error: `音量增益失败（ffmpeg exit=${r.status}${tail ? '：' + tail : ''}）` };
    }
    return { path: out };
  } catch (e) {
    return { error: `音量增益失败：${e?.message ?? e}` };
  }
}

// 酷狗搜索 / 音源解析已迁移到 ./kugou-api.js（完整移植 kugou.rs 的签名算法、音质链与 4 级降级解析）。
// 从 config.json kugou.session 组装登录 cookie：优先 session.cookie，缺 mid/dfid 时用 session 独立字段补上。
function kugouCookie(cfg) {
  const s = cfg.kugou?.session;
  if (!s || typeof s !== 'object') return '';
  let cookie = String(s.cookie ?? '').trim();
  if (!cookie) return '';
  if (!/(^|;\s*)(kg_mid|KG_MID)=/i.test(cookie) && s.mid) cookie += '; kg_mid=' + String(s.mid).trim();
  if (!/(^|;\s*)(kg_dfid|KG_DFID)=/i.test(cookie) && s.dfid) cookie += '; kg_dfid=' + String(s.dfid).trim();
  return cookie;
}

const server = new McpServer({ name: 'qq-file-send', version: '0.1.0' });

server.tool(
  'qq_send_file',
  '向指定 QQ 好友/群发送一个本地文件或音频文件。入参两个必填项：target（目标接收地址，格式 private:QQ号 或 group:群号，目标必须命中系统白名单 config.json 的 allow.private / allow.groups）与 filePath（待发送文件的绝对路径）；可选 gain（音量增益倍数 0.5~8，默认取 config fileSend.volumeGain）。规则：默认音频文件（mp3/wav/flac/ogg/m4a/aac/amr/silk/opus/wma）以语音消息发送（先按增益重编码，音量大）；但当用户明确要求发送「音频原文件 / 原始文件 / 不转码 / 无损原样」时，必须传 original=true，工具将直接上传原始音频文件（不做任何转码/增益/压缩修改，走文件消息，保留原始文件名与字节），异常结果结构化返回。其余文件以文件消息发送。filePath 必须位于 config.json fileSend.localDirs 声明的本地读取目录内（已配置时）。返回固定结构 {statusCode, message}：statusCode=0 发送成功；400 入参错误；403 工具被禁用、目标不在白名单或文件不在本地读取目录；404 文件不存在；413 超过大小上限；422 音量增益失败；500 发送失败。',
  {
    target: z.string().describe('目标接收地址，格式 private:QQ号 或 group:群号（必须命中白名单）'),
    filePath: z.string().describe('待发送文件的绝对路径（必须存在且位于本地读取目录内；音频扩展名默认走语音消息）'),
    original: z.boolean().optional().describe('true=用户要求音频原文件时传此参数：直接发送原始音频文件（不转码/不增益/不压缩，走文件消息）；缺省按语音消息发送'),
    gain: z.number().min(0.5).max(8).optional().describe('音量增益倍数（0.5~8，默认取 config.json fileSend.volumeGain，当前 1.5）')
  },
  async ({ target, filePath, gain, original }) => {
    const cfg = loadConfig();
    // 1) 开关检查（桥接控制台“文件发送工具”面板可开关）
    if ((cfg.socialV2?.tools ?? {}).fileSend === false) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「文件发送工具」开关' }) }], isError: true };
    }
    // 2) target 格式
    const m = /^(private|group):(\d+)$/.exec(String(target ?? '').trim());
    if (!m) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: `target 格式应为 private:QQ号 或 group:群号，收到: ${String(target)}` }) }], isError: true };
    }
    const kind = m[1];
    const id = Number(m[2]);
    // 3) 白名单校验
    const allowAllWhenEmpty = cfg.allowAllWhenEmpty === true;
    const allowList = kind === 'private' ? (cfg.allow?.private ?? []).map(String) : (cfg.allow?.groups ?? []).map(String);
    const denyList = kind === 'private' ? (cfg.deny?.private ?? []).map(String) : (cfg.deny?.groups ?? []).map(String);
    if (!isAllowed(allowList, denyList, id, allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: `目标 ${kind}:${id} 不在白名单内（allow.${kind === 'private' ? 'private' : 'groups'}）` }) }], isError: true };
    }
    // 4) 文件校验
    const fp = String(filePath ?? '').trim();
    if (!path.isAbsolute(fp)) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: `filePath 必须是绝对路径: ${fp}` }) }], isError: true };
    }
    // 4.5) 本地读取目录限制（config.json fileSend.localDirs；配置后仅允许这些目录内的文件）。
    //      工具的音频缓存目录 state/file-send-cache 始终放行（qq_search_audio / qq_send_audio_from_url
    //      生成的缓存文件可能被 agent 通过 qq_send_file 再次转发）。
    const localDirs = Array.isArray(cfg.fileSend?.localDirs)
      ? cfg.fileSend.localDirs.map((d) => String(d).trim()).filter(Boolean).map((d) => path.resolve(d))
      : [];
    const allowedDirs = localDirs.length > 0 ? [...localDirs, CACHE_DIR] : [];
    if (allowedDirs.length > 0) {
      const fpResolved = path.resolve(fp);
      const lower = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
      const inside = allowedDirs.some((d) => {
        const dl = lower(d);
        const fl = lower(fpResolved);
        return fl === dl || fl.startsWith(dl.endsWith(path.sep) ? dl : dl + path.sep);
      });
      if (!inside) {
        return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: `filePath 不在允许的本地读取目录内（fileSend.localDirs: ${localDirs.join('; ')}；缓存目录: ${CACHE_DIR}）` }) }], isError: true };
      }
    }
    let stat;
    try {
      stat = fs.statSync(fp);
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 404, message: `文件不存在或不可读: ${fp}` }) }], isError: true };
    }
    if (!stat.isFile()) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 404, message: `路径不是普通文件: ${fp}` }) }], isError: true };
    }
    const maxMb = Number(cfg.fileSend?.maxSizeMb) > 0 ? Number(cfg.fileSend.maxSizeMb) : DEFAULT_MAX_SIZE_MB;
    if (stat.size > maxMb * 1024 * 1024) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 413, message: `文件大小 ${(stat.size / 1048576).toFixed(1)}MB 超过上限 ${maxMb}MB（config.json fileSend.maxSizeMb 可调）` }) }], isError: true };
    }
    // 5) 按扩展名选择原子能力并发送（路径统一转正斜杠，OneBot 侧更稳）
    const normPath = fp.replace(/\\/g, '/');
    const ext = path.extname(fp).toLowerCase();
    const isAudio = AUDIO_EXTS.has(ext);
    const idKey = kind === 'private' ? 'user_id' : 'group_id';
    try {
      let data;
      if (isAudio) {
        // 原文件直传规则：用户要求发送音频原文件时（original=true），
        // 直接上传原始音频文件，不做任何转码/增益/压缩，保留原始文件名与字节。
        if (original === true) {
          const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
          data = await onebot(cfg, action, {
            [idKey]: id,
            file: normPath,
            name: path.basename(fp)
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({
              statusCode: 0,
              message: `原文件发送成功（${kind}:${id}）`,
              fileId: data?.file_id,
              file: path.basename(fp),
              type: 'original-file',
              mode: 'original',
              transcode: false,
              gain: 1,
              sizeBytes: stat.size
            }, null, 2) }]
          };
        }
        // 音量增益：显式 gain 参数优先；否则用 config fileSend.volumeGain（默认 1.5）
        const gainVal = resolveGain(cfg, gain);
        let sendFile = fp;
        let gainApplied = 1;
        let gainNote = null;
        if (Math.abs(gainVal - 1) >= 0.01) {
          const g = applyVolumeGain(cfg, fp, gainVal);
          if (g.error) {
            if (gain !== undefined && gain !== null) {
              return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 422, message: g.error }) }], isError: true };
            }
            gainNote = g.error;
          } else {
            sendFile = g.path;
            gainApplied = gainVal;
          }
        }
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        data = await onebot(cfg, action, {
          [idKey]: id,
          message: [{ type: 'record', data: { file: sendFile.replace(/\\/g, '/') } }]
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ statusCode: 0, message: `语音消息发送成功（${kind}:${id}）`, messageId: data?.message_id, file: path.basename(fp), type: 'audio', gain: gainApplied, gainNote }, null, 2) }]
        };
      }
      const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
      data = await onebot(cfg, action, {
        [idKey]: id,
        file: normPath,
        name: path.basename(fp)
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ statusCode: 0, message: `文件发送成功（${kind}:${id}）`, fileId: data?.file_id, file: path.basename(fp), type: 'file' }, null, 2) }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 500, message: `发送失败：${error?.message ?? error}` }) }], isError: true };
    }
  }
);

server.tool(
  'qq_search_audio',
  '从酷狗音乐官方音源库搜索歌曲（数据源锁定酷狗平台，所有音频资源均从酷狗官方音源拉取）。返回结构化音频资源列表 [{index, songName, singer, filename, albumName, durationSec, hash, bitrate, fileSizeBytes, ext, coverUrl, payType, privilege, audioUrl, backupUrl, playable}]，其中 audioUrl 为可播放/可下载直链（付费歌曲可能为 null）。Agent 可直接把 audioUrl 交给 qq_send_audio_from_url 完成发送等后续处理。可选 read=true 时，额外用本地TTS（GPT-SoVITS ayane）把搜索结果摘要合成一段语音（返回 audioFile，可用 qq_send_file 发送）。入参仅 query（必填，歌名/歌手/关键词）与 limit（可选，默认 5，最大 10）、read（可选）。',
  {
    query: z.string().describe('搜索关键词：歌名/歌手/片段，如「生日快乐」「周杰伦 晴天」'),
    limit: z.number().int().min(1).max(10).optional().describe('最多返回条数，默认 5'),
    read: z.boolean().optional().describe('true=额外用本地TTS把搜索结果摘要合成语音（返回 audioFile）')
  },
  async ({ query, limit, read }) => {
    const cfg = loadConfig();
    if ((cfg.socialV2?.tools ?? {}).audioSearch === false) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「音频搜索发送」开关' }) }], isError: true };
    }
    const q = sanitizeQuery(query);
    if (!q) return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: 'query 为空' }) }], isError: true };
    const max = Math.max(1, Math.min(10, Number(limit) || 5));
    try {
      const cookie = kugouCookie(cfg);
      const list = await kugouSearch(q, max, cookie);
      const results = [];
      for (const it of list) {
        // 有登录态优先无损→极高→标准，否则标准音质；4 级降级解析（H5→Mobile→Web→Gateway，含签名）
        const quality = cookie ? 'lossless' : 'standard';
        const r = await resolveSongUrl(it, cookie, quality);
        results.push({
          index: results.length + 1,
          songName: it.name,
          singer: it.singer,
          filename: it.filename,
          albumName: it.album,
          durationSec: it.durationSec,
          hash: it.hash,
          hash320: it.hqHash || null,
          hashSQ: it.sqHash || null,
          hashRes: it.resHash || null,
          bitrate: null,
          fileSizeBytes: null,
          ext: (r.level === 'lossless' || r.level === 'jymaster' || r.level === 'hires') ? 'flac' : 'mp3',
          coverUrl: it.coverUrl || null,
          payType: it.fee,
          privilege: it.privilege,
          audioUrl: r.url || null,
          backupUrl: null,
          playable: !!r.playable,
          vip: !!r.playable && !!cookie,
          level: r.level || null,
          quality: r.quality || null,
          source: r.source || null,
          reason: r.reason || null,
        });
      }
      const playableCount = results.filter((r) => r.playable).length;
      // 本地 TTS 朗读搜索结果摘要（可选，韵律自适应）
      let audioFile = null;
      let ttsNote = null;
      let ttsProsody = null;
      let ttsPauses = null;
      if (read === true) {
        const top = results.slice(0, 2).map((r) => `${r.singer}的${r.songName}`).join('，');
        const summary = Array.from(`关于「${q}」，${top || '未找到相关歌曲'}。`).slice(0, 120).join('');
        const t = await ttsSynthesize(cfg, summary);
        if (t.error) ttsNote = t.error;
        else {
          audioFile = cacheAudio(t.buf, t.ext || 'wav', 'tts');
          ttsProsody = t.prosody;
          ttsPauses = t.pauses;
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({
          statusCode: 0,
          message: `酷狗搜索到 ${results.length} 首（含可播放直链 ${playableCount} 首）`,
          query: q,
          source: 'kugou',
          total: results.length,
          results,
          audioFile,
          ttsNote,
          ttsProsody,
          ttsPauses
        }, null, 2) }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 500, message: `酷狗搜索失败：${error?.message ?? error}` }) }], isError: true };
    }
  }
);

server.tool(
  'qq_send_audio_from_url',
  '向白名单目标发送音频语音消息。两种模式：1) 传 url（http/https 音频直链，带 SSRF 防护 + 音频格式校验 + 大小限制）时下载并发送；2) 传 text（可选）时改用本地TTS（GPT-SoVITS ayane，start_api_ayane.bat 启动）把文本合成语音后发送——TTS 链路完全本地化，无任何云端合成/搜索依赖。返回 {statusCode, message, bytes, sourceUrl, audioFile}。',
  {
    target: z.string().describe('目标接收地址，格式 private:QQ号 或 group:群号（必须命中白名单）'),
    url: z.string().optional().describe('音频文件的 http(s) 直链，如 https://example.com/xx.mp3（与 text 二选一）'),
    text: z.string().optional().describe('要合成的文本（与 url 二选一）：用本地TTS合成语音发送')
  },
  async ({ target, url, text }) => {
    const cfg = loadConfig();
    if ((cfg.socialV2?.tools ?? {}).audioSearch === false) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「音频搜索发送」开关' }) }], isError: true };
    }
    const rt = resolveTarget(cfg, target);
    if (rt.error) return { content: [{ type: 'text', text: JSON.stringify(rt.error) }], isError: true };
    const maxMb = Number(cfg.fileSend?.maxSizeMb) > 0 ? Number(cfg.fileSend.maxSizeMb) : DEFAULT_MAX_SIZE_MB;
    try {
      const textVal = String(text ?? '').trim();
      let finalUrl = null;
      let bytes = 0;
      let file;
      let ttsProsody = null;
      let ttsPauses = null;
      if (textVal) {
        // 本地 TTS 合成语音发送（完全本地，韵律自适应：语速/语调/停顿按场景情绪动态调整）
        const t = await ttsSynthesize(cfg, Array.from(textVal).slice(0, 200).join(''));
        if (t.error) {
          return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 422, message: t.error }) }], isError: true };
        }
        file = cacheAudio(t.buf, t.ext || 'wav', 'tts');
        bytes = t.buf.length;
        finalUrl = 'local-tts(ayane)';
        ttsProsody = t.prosody;
        ttsPauses = t.pauses;
      } else {
        if (!String(url ?? '').trim()) {
          return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: 'url 与 text 至少传一个' }) }], isError: true };
        }
        const dl = await safeFetchAudioBuffer(String(url).trim(), maxMb * 1024 * 1024);
        finalUrl = dl.url;
        bytes = dl.buffer.length;
        file = cacheAudio(dl.buffer, extFromUrl(finalUrl), 'url');
      }
      // 音量增益（config fileSend.volumeGain 默认 1.5；ffmpeg 不可用则原样发送）
      let gainApplied = 1;
      const gainVal = resolveGain(cfg, undefined);
      if (Math.abs(gainVal - 1) >= 0.01) {
        const g = applyVolumeGain(cfg, file, gainVal);
        if (!g.error) {
          file = g.path;
          gainApplied = gainVal;
        }
      }
      const data = await sendVoiceRecord(cfg, rt.kind, rt.id, file);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          statusCode: 0,
          message: `语音已发送（${rt.kind}:${rt.id}）`,
          sourceUrl: finalUrl,
          bytes,
          audioFile: file,
          gain: gainApplied,
          messageId: data?.message_id,
          ttsProsody,
          ttsPauses
        }, null, 2) }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 500, message: `下载/合成/发送失败：${error?.message ?? error}` }) }], isError: true };
    }
  }
);

server.tool(
  'qq_search_local_audio',
  '在本地读取目录（config.json 的 fileSend.localDirs，例如 D:\\Music）中按文件名搜索音频文件。支持：精确/子串/分词匹配、拼音容错（如查 huahai 命中「花海」，yinyue 命中「音乐」）、模糊子序列匹配，结果按关联度降序返回。返回结构化列表 [{index,path,name,ext,sizeMb,score,matchType}]，可直接把 path 交给 qq_send_file 发送。入参仅 query（必填）与 limit（可选，默认 10，最大 50）。',
  {
    query: z.string().describe('搜索关键词：中文/拼音/英文片段均可，如「花海」「huahai」「Moment」「Odesza」'),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回条数，默认 10')
  },
  async ({ query, limit }) => {
    const cfg = loadConfig();
    if ((cfg.socialV2?.tools ?? {}).fileSend === false) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「文件发送工具」开关' }) }], isError: true };
    }
    const localDirs = Array.isArray(cfg.fileSend?.localDirs)
      ? cfg.fileSend.localDirs.map((d) => String(d).trim()).filter(Boolean).map((d) => path.resolve(d))
      : [];
    if (localDirs.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: '未配置本地读取目录（config.json fileSend.localDirs）' }) }], isError: true };
    }
    const q = String(query ?? '').trim();
    if (!q) return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: 'query 为空' }) }], isError: true };
    const max = Math.max(1, Math.min(50, Number(limit) || 10));

    const tokens = String(q).normalize('NFKC').toLowerCase()
      .split(/[\s,，、.;；:：!！?？_\-—–.()（）[\]【】"'“”‘’]+/)
      .map((t) => normText(t)).filter(Boolean);
    const queryNorm = tokens.join('');
    const queryHasCJK = CJK_RE.test(queryNorm);
    // 查询的拼音目标串：中文查询取其拼音；纯拼音查询原样（作拼音匹配）
    const queryPyTarget = queryHasCJK
      ? toPinyinLists(queryNorm).map((l) => (l ? l[0] : '')).join('')
      : (queryNorm.length >= 2 ? queryNorm : null);

    const files = scanAudioFiles(localDirs);
    const scored = [];
    for (const f of files) {
      const s = scoreFile(f.name, queryNorm, tokens, queryPyTarget);
      if (s) scored.push({ ...f, score: s.score, matchType: s.type });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN') || a.path.length - b.path.length);

    const results = scored.slice(0, max).map((r, i) => ({
      index: i + 1,
      path: r.path,
      name: r.name,
      ext: path.extname(r.name).slice(1).toLowerCase(),
      sizeMb: Math.round((r.size / 1048576) * 10) / 10,
      score: r.score,
      matchType: r.matchType
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        statusCode: 0,
        message: `共 ${scored.length} 个匹配，已返回前 ${results.length} 个`,
        query: q,
        localDirs,
        total: scored.length,
        results
      }, null, 2) }]
    };
  }
);

server.tool(
  'qq_read_local_audio',
  '无损读取/探测本地音频文件：解析容器头部与元数据（兼容 WAV/MP3/FLAC/OGG·Opus·Vorbis/M4A·AAC·ALAC/AMR/WMA·ASF/SILK/AIFF，任意采样率/位深/声道），识别异常（魔数错误、截断、缺关键块、无有效帧等，返回结构化错误码），全程不转码、不损伤音质。输出结构化「音频流 + 元数据」：{format, codec, metadata, technical, stream, quality}，其中 stream 给出原始音频流的位置（PCM-WAV 为精确字节区间 startByte/byteLength，其余为无损源文件流），可直接供后续工具（发送/转码/流式处理）使用。入参仅 filePath（本地读取目录内的绝对路径）。',
  {
    filePath: z.string().describe('待读取音频文件的绝对路径（须位于本地读取目录内，可用 qq_search_local_audio 搜索）')
  },
  async ({ filePath }) => {
    const cfg = loadConfig();
    if ((cfg.socialV2?.tools ?? {}).fileSend === false) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「文件发送工具」开关' }) }], isError: true };
    }
    const fp = String(filePath ?? '').trim();
    if (!path.isAbsolute(fp)) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: `filePath 必须是绝对路径: ${fp}` }) }], isError: true };
    }
    // 本地读取目录限制（与 qq_send_file 一致：localDirs + 工具缓存目录）
    const localDirs = Array.isArray(cfg.fileSend?.localDirs)
      ? cfg.fileSend.localDirs.map((d) => String(d).trim()).filter(Boolean).map((d) => path.resolve(d))
      : [];
    const allowedDirs = localDirs.length > 0 ? [...localDirs, CACHE_DIR] : [];
    if (allowedDirs.length > 0) {
      const fpResolved = path.resolve(fp);
      const lower = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
      const inside = allowedDirs.some((d) => {
        const dl = lower(d);
        const fl = lower(fpResolved);
        return fl === dl || fl.startsWith(dl.endsWith(path.sep) ? dl : dl + path.sep);
      });
      if (!inside) {
        return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: `filePath 不在允许的本地读取目录内（fileSend.localDirs: ${localDirs.join('; ')}；缓存目录: ${CACHE_DIR}）` }) }], isError: true };
      }
    }
    const r = parseAudioFile(fp);
    if (!r.ok) {
      const statusCode = r.errorCode === 'E_NOFILE' || r.errorCode === 'E_NOTFILE' ? 404 : 422;
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode, ok: false, errorCode: r.errorCode, message: r.message }, null, 2) }], isError: true };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        statusCode: 0,
        ok: true,
        path: r.path || fp,
        name: r.name || path.basename(fp),
        format: r.format,
        codec: r.codec,
        metadata: r.metadata || {},
        technical: r.technical || {},
        stream: r.stream || {},
        quality: r.quality || {},
      }, null, 2) }]
    };
  }
);

export async function runMcpQqFileSend(transport = new StdioServerTransport()) {
  // 启动标记：写入 state/mcp-qq-file-send.version（时间戳），供确认 MCP 进程已加载本版代码。
  try {
    fs.mkdirSync(APP_PATHS.stateDir, { recursive: true });
    fs.writeFileSync(path.join(APP_PATHS.stateDir, 'mcp-qq-file-send.version'), 'kugou-gateway-resolve ' + new Date().toISOString() + '\n');
  } catch {}
  await server.connect(transport);
  return server;
}

if (isMainModule(import.meta.url)) {
  runMcpQqFileSend().catch((error) => reportEntrypointError('mcp-qq-file-send', error));
}
