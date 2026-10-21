// tts-prosody.js — 本地 TTS（GPT-SoVITS ayane）韵律自适应引擎（纯 JS + ffmpeg，无额外依赖）。
//
// 能力：
//  1) 实时参数自适应：场景识别（闲聊/科普答疑/紧急提示）+ 情绪识别（开心/严肃/共情安慰/平静）
//     → 语速 0.8~1.3（闲聊 1.1 轻快 / 科普 0.9 稳速 / 紧急 1.25 提速，±0.03 浮动）
//     → 语调 ±15%（开心上扬 / 严肃下沉 / 共情安慰柔化降低，±0.02 浮动）
//     → 句中逻辑断点/情绪转折处插入 100~300ms 口语化停顿（按标点分级 + 转折词/情绪词增益）
//  2) 情感对齐：按真实情绪属性驱动语调/停顿，避免平铺直叙的机械感
//  3) 执行校验：合成前 clamp 参数、消解场景-情绪冲突并记录说明；无冲突后分段合成 → 静音拼接 → 语调后处理
// 全程调用本地 /tts（speed_factor 服务端调速），语速之外一律 ffmpeg 后处理，不依赖任何云端服务。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAudioFile } from './audio-probe.js';
import { APP_PATHS } from './app-paths.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const jitter = (v, amt) => v + (Math.random() * 2 - 1) * amt;

// ── 场景识别（关键词计数，取命中最多者） ──────────────────────────────────
// urgent 只收真正"马上行动/危险"型表达；警告/注意/必须/禁止/失败等归 serious/sad 情绪，避免误判成急提速
const SCENE_RULES = [
  { name: 'urgent', speed: 1.25, re: /(紧急|立刻|马上|赶紧|危险|出事|报警|快停|别乱|请立即|快撤|快跑)/ },
  { name: 'edu', speed: 0.9, re: /(因为|所以|原因|原理|解释|说明|如何|为什么|步骤|首先|其次|科普|是指|比如|例如|一般来说|本质上)/ },
  { name: 'chat', speed: 1.1, re: null },
];
const EMOTION_RULES = [
  { name: 'excited', pitch: 0.13, speedAdj: 1.06, re: /(天呐|天哪|天啊|激动|太兴奋|中奖|不可思议|万万没想到|尖叫|万岁|手都在抖)/ },
  { name: 'happy', pitch: 0.1, speedAdj: 1.0, re: /(哈哈|嘻嘻|嘿嘿|太棒|开心|耶|喜欢|恭喜|好消息|可爱|好玩|笑死|高兴|哇哦)/i },
  { name: 'playful', pitch: 0.04, speedAdj: 1.0, re: /(好不好嘛|求求你|撒娇|哼|才不是|人家|嘛|啦|~)/ },
  { name: 'sad', pitch: -0.05, speedAdj: 0.94, re: /(唉|哎|遗憾|可惜|差一点|差点|失望|失败|输|难过|伤心)/ },
  { name: 'comfort', pitch: -0.06, speedAdj: 0.97, re: /(别难过|别伤心|没事|抱抱|心疼|理解你|对不起|抱歉|别担心|会好|陪你|摸摸|不要太)/ },
  { name: 'serious', pitch: -0.12, speedAdj: 1.0, re: /(必须|禁止|严肃|责任|重要|警告|提醒|务必|认真|后果|郑重)/ },
  { name: 'gentle', pitch: -0.02, speedAdj: 0.95, re: /(晚安|好梦|早点休息|夜深|休息吧|温柔|安心)/ },
];

function matchByCount(text, rules) {
  let best = null;
  let bestN = 0;
  for (const r of rules) {
    if (!r.re) continue;
    const n = (String(text).match(new RegExp(r.re.source, 'g')) || []).length;
    if (n > bestN) {
      bestN = n;
      best = r;
    }
  }
  return best;
}

// 文本 → 韵律画像：{ scene, emotion, speed, pitch, notes }
export function analyzeProsody(text) {
  const scene = matchByCount(text, SCENE_RULES) ?? SCENE_RULES[SCENE_RULES.length - 1];
  const emotion = matchByCount(text, EMOTION_RULES);
  const notes = [];
  let speed = jitter(scene.speed, 0.03);
  if (emotion?.speedAdj) speed = speed * emotion.speedAdj;
  let pitch = emotion ? jitter(emotion.pitch, 0.02) : jitter(0, 0.01);

  // 校验 / 冲突消解（合成前参数合理性检查）
  if (scene.name === 'urgent' && emotion?.name === 'happy') {
    pitch = jitter(-0.1, 0.02);
    notes.push('紧急场景压制开心上扬：语调下沉以突出严肃提醒');
  } else if (scene.name === 'urgent') {
    pitch = Math.min(pitch, -0.05);
  } else if (scene.name === 'edu' && emotion?.name === 'happy') {
    pitch = jitter(0.06, 0.02);
    notes.push('科普场景带愉悦：轻快上扬但保持清晰');
  } else if (scene.name === 'chat' && (emotion?.name === 'serious' || emotion?.name === 'sad')) {
    speed = clamp(speed - 0.05, 0.8, 1.3);
    notes.push(`${emotion.name === 'serious' ? '语气严肃' : '情绪低落'}：语速微降`);
  }
  speed = clamp(speed, 0.8, 1.3);
  pitch = clamp(pitch, -0.15, 0.15);
  return {
    scene: scene.name,
    emotion: emotion?.name ?? 'flat',
    speed: Math.round(speed * 100) / 100,
    pitch: Math.round(pitch * 100) / 100,
    notes,
  };
}

// 分段：按句末标点拆，超长句再按逗号拆，最多 6 段（兼顾实时性）；返回 {segments, pauses}
// pauses[i] = seg[i] 与 seg[i+1] 之间的停顿毫秒
const MAX_SEG = 6;
const TRANSITION_RE = /(但是|不过|然而|于是|所以|而且|没想到|突然|结果)/;
const EMOTION_HINT_RE = /(哈哈|嘻嘻|哎|唉|唉呀|天呐|天哪|太|居然|竟然|好啦|行吧|嗯|啊哈)/;

function pauseFor(ending) {
  const base = /[。！？!?…~]$/.test(ending) ? 265
    : /[；;]$/.test(ending) ? 200
    : /[，,、：:]$/.test(ending) ? 145
    : 110;
  return clamp(Math.round(jitter(base, 22)), 100, 300);
}

export function splitForPause(text) {
  const sentences = String(text).split(/(?<=[。！？!?…~；;])/).map((s) => s.trim()).filter(Boolean);
  const segments = [];
  for (const s of sentences) {
    if (segments.length >= MAX_SEG) break;
    if (s.length <= 22) {
      segments.push(s);
    } else {
      const clauses = s.split(/(?<=[，,、])/).map((c) => c.trim()).filter(Boolean);
      for (const c of clauses) {
        if (segments.length >= MAX_SEG) break;
        segments.push(c);
      }
      if (segments.length >= MAX_SEG) {
        // 合并溢出：把剩余并进最后一段
        const rest = clauses.slice(segments.length - 1).join('');
        if (rest) segments[segments.length - 1] += rest;
        break;
      }
    }
  }
  if (segments.length === 0 && String(text).trim()) segments.push(String(text).trim().slice(0, 200));
  const pauses = [];
  for (let i = 0; i < segments.length - 1; i++) {
    let ms = pauseFor(segments[i]);
    const pair = segments[i].slice(-20) + segments[i + 1].slice(0, 12);
    if (TRANSITION_RE.test(pair)) ms += 45; // 情绪转折/逻辑断点加长
    if (EMOTION_HINT_RE.test(pair)) ms += 25;
    pauses.push(clamp(ms, 100, 300));
  }
  return { segments, pauses };
}

// ── 工具函数 ──
function ffmpegBin(cfg) {
  return String(cfg.fileSend?.ffmpegPath ?? '').trim() || path.join(APP_PATHS.toolsDir, 'ffmpeg', 'ffmpeg.exe');
}
function run(cmd, args, timeoutMs = 180000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
}
function wavInfo(file) {
  const r = parseAudioFile(file);
  if (!r.ok) return { rate: 32000, channels: 1 };
  return { rate: r.technical.sampleRate || 32000, channels: r.technical.channels || 1 };
}

// ── 主流程：韵律化合成，返回 { path, prosody, segments, applied } 或 { error } ──
export async function synthesizeProsody(cfg, text, cacheDir) {
  const prosody = analyzeProsody(text);
  const { segments, pauses } = splitForPause(text);
  const ttsUrl = String(cfg.ttsLocal?.url ?? 'http://127.0.0.1:9880/tts');
  const refAudio = String(cfg.ttsLocal?.refAudioPath ?? '');
  const lc = {
    refAudio,
    promptText: String(cfg.ttsLocal?.promptText ?? ''),
    promptLang: String(cfg.ttsLocal?.promptLang ?? 'zh'),
    textLang: String(cfg.ttsLocal?.textLang ?? 'zh'),
    timeoutMs: Number(cfg.ttsLocal?.timeoutMs) > 0 ? Number(cfg.ttsLocal.timeoutMs) : 120000,
  };
  if (!lc.refAudio) return { error: '未配置本地TTS参考音频（config.json ttsLocal.refAudioPath）' };
  // 执行校验：v3/v4 系 SoVITS 要求 prompt_text 非空（须与参考音频内容对应），缺失时提前结构化拦截
  if (!lc.promptText) return { error: '本地TTS 需要 prompt_text（config.json ttsLocal.promptText 为空；请填写与 refAudioPath 参考音频对应的文本，如 ayane 参考段为「昔々」）' };

  fs.mkdirSync(cacheDir, { recursive: true });
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const work = path.join(cacheDir, `prosody-${stamp}`);
  fs.mkdirSync(work, { recursive: true });

  // 1) 分段合成（speed_factor 服务端调速）
  const segFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const u = new URL(ttsUrl);
    u.searchParams.set('text', segments[i]);
    u.searchParams.set('text_lang', lc.textLang);
    u.searchParams.set('ref_audio_path', lc.refAudio);
    u.searchParams.set('prompt_lang', lc.promptLang);
    if (lc.promptText) u.searchParams.set('prompt_text', lc.promptText);
    u.searchParams.set('media_type', 'wav');
    u.searchParams.set('streaming_mode', 'false');
    u.searchParams.set('text_split_method', 'cut0');
    u.searchParams.set('batch_size', '1');
    u.searchParams.set('speed_factor', String(prosody.speed));
    const segFile = path.join(work, `seg${i}.wav`);
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(lc.timeoutMs) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `本地TTS 第${i + 1}段失败 HTTP ${res.status}${body ? '：' + body.slice(0, 180) : ''}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) return { error: `本地TTS 第${i + 1}段返回过小（${buf.length}B）` };
      fs.writeFileSync(segFile, buf);
      segFiles.push(segFile);
    } catch (e) {
      return { error: `本地TTS不可达（${ttsUrl}）：${e?.message ?? e}；请运行 start_api_ayane.bat 启动服务` };
    }
  }

  // 2) 拼接：生成停顿静音并按序 concat + 语调后处理（一个 ffmpeg 单趟完成）
  const ffmpeg = ffmpegBin(cfg);
  const info = wavInfo(segFiles[0]);
  const rate = info.rate;
  const mono = info.channels === 1 ? 'mono' : 'stereo';
  let outFile = segFiles[0];
  try {
    if (segFiles.length === 1 && Math.abs(prosody.pitch) < 0.005) {
      outFile = segFiles[0];
    } else {
      const listPath = path.join(work, 'list.txt');
      const lines = [];
      for (let i = 0; i < segFiles.length; i++) {
        lines.push(`file '${segFiles[i].replace(/'/g, "'\\''")}'`);
        if (i < pauses.length) {
          const sil = path.join(work, `sil${i}.wav`);
          const sr = run(ffmpeg, ['-y', '-f', 'lavfi', '-i', `anullsrc=r=${rate}:cl=${mono}`, '-t', String(pauses[i] / 1000), '-c:a', 'pcm_s16le', sil]);
          if (sr.status !== 0) return { error: `停顿静音生成失败（第${i + 1}处）` };
          lines.push(`file '${sil.replace(/'/g, "'\\''")}'`);
        }
      }
      fs.writeFileSync(listPath, lines.join('\n'), 'utf8');
      outFile = path.join(work, 'out.wav');
      const af = Math.abs(prosody.pitch) >= 0.005
        ? `asetrate=${rate}*${(1 + prosody.pitch).toFixed(4)},atempo=${(1 / (1 + prosody.pitch)).toFixed(4)},aresample=${rate}`
        : 'anull';
      const fr = run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-af', af, '-ar', String(rate), '-c:a', 'pcm_s16le', outFile]);
      if (fr.status !== 0 || !fs.existsSync(outFile)) {
        const tail = (fr.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ');
        return { error: `韵律拼接失败（ffmpeg exit=${fr.status}${tail ? '：' + tail : ''}）` };
      }
    }
    // 清理中间文件
    for (const f of segFiles) { try { if (f !== outFile) fs.unlinkSync(f); } catch {} }
    for (const f of fs.readdirSync(work)) { const p = path.join(work, f); try { if (p !== outFile) fs.unlinkSync(p); } catch {} }
    return { path: outFile, prosody, segments: segments.length, pauses };
  } catch (e) {
    return { error: `韵律合成失败：${e?.message ?? e}` };
  }
}
