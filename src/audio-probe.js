// audio-probe.js — 本地音频无损读取/探测（纯 JS，无任何外部依赖）。
//
// 目标：
// - 兼容全格式全规格：WAV(含 extensible/float) / MP3(ID3v2+MPEG1/2/2.5 Layer I/II/III) /
//   FLAC / OGG(Opus/Vorbis) / M4A·MP4(AAC/ALAC) / AMR(NB/WB) / WMA(ASF) / SILK / AIFF·AIFC，
//   任意采样率/位深/声道数。
// - 异常错误识别：魔数校验、头截断、块大小越界、缺关键块、无有效帧等，返回结构化错误码。
// - 解码无音质损伤：只解析容器/元数据、定位原始音频载荷，绝不做转码/重编码；
//   PCM-WAV 直接给出原始 PCM 字节区间（startByte/byteLength），其余格式给出无损源文件流。
// - 输出结构化音频流 + 元数据：供 Agent 后续工具（发送/转码/流式处理）直接消费。
import fs from 'node:fs';

// ── 错误构造 ──────────────────────────────────────────────────────────────
const ERR = {
  E_NOFILE: '文件不存在',
  E_NOTFILE: '路径不是普通文件',
  E_EMPTY: '文件为空',
  E_TOOSMALL: '文件过小，无法构成有效音频',
  E_UNREADABLE: '文件不可读',
  E_MAGIC: '魔数校验失败，不是声称的音频格式',
  E_HEADER: '容器头部解析失败',
  E_TRUNCATED: '文件截断：声明长度超出实际大小',
  E_UNSUPPORTED: '不支持的音频格式/规格',
  E_PARSE: '音频数据解析失败',
};
function err(code, detail) {
  return { ok: false, errorCode: code, message: `${ERR[code] || '解析失败'}：${detail}` };
}

// ── 读取策略：头 2MB + 尾 512KB，足够所有容器解析（避免整读大文件） ────────
const HEAD_LIMIT = 2 * 1024 * 1024;
const TAIL_LIMIT = 512 * 1024;

function readAudioFile(path) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch {
    return { err: err('E_NOFILE', path) };
  }
  if (!stat.isFile()) return { err: err('E_NOTFILE', path) };
  if (stat.size === 0) return { err: err('E_EMPTY', path) };
  const size = stat.size;
  let fd;
  try {
    fd = fs.openSync(path, 'r');
    const headLen = Math.min(size, HEAD_LIMIT);
    const tailStart = Math.max(0, size - TAIL_LIMIT);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    let tail = null;
    if (size > HEAD_LIMIT) {
      const tailLen = Math.min(size - tailStart, TAIL_LIMIT);
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, tailStart);
    }
    return { size, head, tail };
  } catch (e) {
    return { err: err('E_UNREADABLE', e?.message ?? String(e)) };
  } finally {
    try { if (fd) fs.closeSync(fd); } catch {}
  }
}

// ── 通用辅助 ──────────────────────────────────────────────────────────────
function pick(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}
function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function fmtKbps(bitrate) {
  return Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : null;
}
function s(s) {
  return String(s ?? '');
}

// ── WAV / RIFF ────────────────────────────────────────────────────────────
function parseWav(head, size) {
  if (head.length < 12) return err('E_TOOSMALL', 'WAV 头不足 12 字节');
  if (s(head.toString('ascii', 0, 4)) !== 'RIFF' || s(head.toString('ascii', 8, 12)) !== 'WAVE') {
    return err('E_MAGIC', '缺少 RIFF/WAVE 标识');
  }
  let off = 12;
  let fmt = null;
  let dataStart = -1;
  let dataSize = -1;
  while (off + 8 <= head.length) {
    const id = head.toString('ascii', off, off + 4);
    let chunkSize = head.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'data' && chunkSize === 0xffffffff) chunkSize = size - body; // 流式 WAV
    if (body + Math.min(chunkSize, 64) > head.length && id !== 'data') break;
    if (id === 'fmt ' && chunkSize >= 16) {
      const audioFormat = head.readUInt16LE(body);
      fmt = {
        audioFormat,
        channels: head.readUInt16LE(body + 2),
        sampleRate: head.readUInt32LE(body + 4),
        byteRate: head.readUInt32LE(body + 8),
        blockAlign: head.readUInt16LE(body + 12),
        bits: head.readUInt16LE(body + 14),
        extensible: audioFormat === 0xfffe,
        subFormat: null,
      };
      if (fmt.extensible && chunkSize >= 40) fmt.subFormat = head.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataStart = body;
      dataSize = chunkSize;
      break;
    }
    off = body + chunkSize + (chunkSize % 2);
  }
  if (!fmt) return err('E_HEADER', '缺少 fmt 块');
  if (dataStart < 0) return err('E_HEADER', '缺少 data 块');
  if (dataSize > size - dataStart) return err('E_TRUNCATED', `data 块声明 ${dataSize}B，实际可用 ${size - dataStart}B`);
  const tag = fmt.extensible && fmt.subFormat ? fmt.subFormat : fmt.audioFormat;
  let codec, encoding, lossless = true;
  if (tag === 1) { codec = 'PCM'; encoding = `pcm${fmt.bits}`; }
  else if (tag === 3) { codec = 'IEEE Float'; encoding = `float${fmt.bits}`; }
  else if (tag === 6) { codec = 'A-law'; encoding = 'alaw'; lossless = false; }
  else if (tag === 7) { codec = 'Mu-law'; encoding = 'mulaw'; lossless = false; }
  else { codec = `format-${tag}`; encoding = 'unknown'; lossless = false; }
  if (fmt.channels < 1 || fmt.sampleRate < 1) return err('E_HEADER', `非法规格：声道 ${fmt.channels}，采样率 ${fmt.sampleRate}`);
  const bytesPerSample = Math.max(1, Math.floor(fmt.blockAlign / Math.max(1, fmt.channels)));
  const duration = fmt.byteRate > 0 ? dataSize / fmt.byteRate : null;
  return {
    ok: true,
    format: 'wav',
    codec,
    metadata: {},
    technical: {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitDepth: fmt.bits,
      blockAlign: fmt.blockAlign,
      bytesPerSample,
      bitrateKbps: fmt.byteRate ? fmtKbps(fmt.byteRate * 8) : null,
      durationSec: round2(duration),
      totalSamples: duration ? Math.round(duration * fmt.sampleRate) : null,
    },
    stream: {
      container: 'wav',
      encoding,
      lossless,
      transcodeFree: true,
      startByte: dataStart,
      byteLength: dataSize,
      dataBytes: dataSize,
    },
    quality: { lossless, decode: 'raw-pcm', note: '未转码，PCM 原始字节区间已给出，可直接流式读取' },
  };
}

// ── MP3：ID3v2 + MPEG 帧头 + Xing/Info ────────────────────────────────────
const MPEG_V = ['2.5', null, '2', '1'];
const MPEG_SR = [
  [11025, 12000, 8000, null], // 2.5
  [null, null, null, null],
  [22050, 24000, 16000, null], // 2
  [44100, 48000, 32000, null], // 1
];
const MPEG_BR = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // V1 L1
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // V1 L2
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // V1 L3
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // V2 L1
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // V2 L2/L3
];
// MPEG 层值（规范）：1=Layer III，2=Layer II，3=Layer I
const LAYER_NAME = ['', 'III', 'II', 'I'];
const BR_V1 = { 3: MPEG_BR[0], 2: MPEG_BR[1], 1: MPEG_BR[2] }; // MPEG-1：L1/L2/L3
const BR_V2 = { 3: MPEG_BR[3], 2: MPEG_BR[4], 1: MPEG_BR[4] }; // MPEG-2/2.5：L1 独立，L2/L3 共用
function mpegFrameLen(verIdx, layerIdx, brK, sr, pad) {
  if (layerIdx === 1) return Math.floor(((verIdx === 3 ? 144 : 72) * brK * 1000) / sr + pad);
  if (layerIdx === 2) return Math.floor((144 * brK * 1000) / sr + pad);
  return Math.floor(((12 * brK * 1000) / sr + pad) * 4);
}
function mpegSpf(verIdx, layerIdx) {
  if (layerIdx === 1) return verIdx === 3 ? 1152 : 576;
  if (layerIdx === 2) return 1152;
  return 384;
}

function id3Text(buf, encodingByte, start, len) {
  const enc = buf[start];
  const text = buf.slice(start + 1, start + len);
  try {
    if (enc === 0 || enc === 3) return text.toString('utf8').replace(/\u0000+$/, '');
    if (enc === 1) return text.toString('utf16le').replace(/\u0000+$/, '').replace(/^\uFEFF/, '');
    if (enc === 2) return text.toString('utf16be').replace(/\u0000+$/, '').replace(/^\uFEFF/, '');
  } catch {}
  return '';
}

function parseMp3(head, size) {
  let off = 0;
  const metadata = {};
  if (head.length >= 10 && head.toString('ascii', 0, 3) === 'ID3') {
    const ver = head[3];
    const flags = head[5];
    let tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const footer = (flags & 0x10) ? 10 : 0;
    if (tagSize + 10 + footer > head.length) tagSize = head.length - 10 - footer;
    let p = 10;
    const end = 10 + tagSize;
    const frameLen = (b) => (ver === 4 ? ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f) : b.readUInt32BE(0));
    while (p + 10 <= end) {
      const fid = head.toString('ascii', p, p + 4);
      if (fid === 'TXXX' || (fid.charCodeAt(0) === 0)) break;
      const flen = frameLen(head.slice(p + 4, p + 8));
      const fbody = p + 10;
      if (fid.startsWith('T') && flen > 1) {
        const val = id3Text(head, fbody, 0, Math.min(flen, 512));
        if (val) {
          if (fid === 'TIT2') metadata.title = val;
          else if (fid === 'TPE1') metadata.artist = val;
          else if (fid === 'TALB') metadata.album = val;
          else if (fid === 'TYER' || fid === 'TDRC') metadata.year = val.slice(0, 4);
        }
      }
      p = fbody + flen;
    }
    off = 10 + tagSize + footer;
  }
  // 找第一个 MPEG 帧头（完整校验：版本/层合法 + 位率/采样率索引有效 + 下一帧同步）
  let sync = -1;
  for (let i = off; i + 4 <= head.length && i < off + 65536; i++) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = head[i + 1];
    const b2 = head[i + 2];
    const verIdx = (b1 >> 3) & 3;
    const layerIdx = (b1 >> 1) & 3;
    if (verIdx === 1 || layerIdx === 0) continue; // 保留版本/层
    const brIdx = (b2 >> 4) & 0xf;
    const srIdx = (b2 >> 2) & 3;
    if (brIdx === 15 || srIdx === 3) continue; // 非法位率/采样率索引
    // 用计算出的帧长校验下一帧是否也是同步头（排除封面图等随机字节误判）
    const srTable = MPEG_SR[verIdx];
    const sampleRate = srTable[srIdx];
    if (!sampleRate) continue;
    const brTable2 = (verIdx === 3 ? BR_V1 : BR_V2)[layerIdx];
    const brK = (brTable2 || [])[brIdx] || 0;
    if (!brK) continue;
    const frameLen = mpegFrameLen(verIdx, layerIdx, brK, sampleRate, (b2 >> 1) & 1);
    const next = i + frameLen;
    if (next + 2 <= head.length && !(head[next] === 0xff && (head[next + 1] & 0xe0) === 0xe0)) continue;
    sync = i;
    break;
  }
  if (sync < 0) return err('E_MAGIC', '未找到有效的 MPEG 音频帧头（可能是非 MP3 或已损坏）');
  const b1 = head[sync + 1];
  const b2 = head[sync + 2];
  const b3 = head[sync + 3];
  const verIdx = (b1 >> 3) & 3;
  const layerIdx = (b1 >> 1) & 3;
  const layer = LAYER_NAME[layerIdx];
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 3;
  const padding = (b2 >> 1) & 1;
  const chMode = (b3 >> 6) & 3;
  const bitrateK = ((verIdx === 3 ? BR_V1 : BR_V2)[layerIdx] || [])[brIdx];
  const sampleRate = MPEG_SR[verIdx][srIdx];
  if (!bitrateK || !sampleRate) return err('E_HEADER', '帧头位率/采样率索引无效');
  const channels = chMode === 3 ? 1 : 2;
  const spf = mpegSpf(verIdx, layerIdx);
  const frameLen = mpegFrameLen(verIdx, layerIdx, bitrateK, sampleRate, padding);
  // Xing/Info 帧数（VBR/CBR 精确时长；仅 Layer III 有）
  let duration = null;
  let totalFrames = null;
  if (layerIdx === 1) {
    const xOff = sync + (verIdx === 3 ? 4 + 32 : 4 + 17);
    if (xOff + 8 <= head.length && (head.toString('ascii', xOff, xOff + 4) === 'Xing' || head.toString('ascii', xOff, xOff + 4) === 'Info')) {
      const flags = head.readUInt32BE(xOff + 4);
      if (flags & 1) totalFrames = head.readUInt32BE(xOff + 8);
    }
  }
  const isXing = totalFrames && head.toString('ascii', sync + (verIdx === 3 ? 36 : 21), sync + (verIdx === 3 ? 40 : 25)) === 'Xing';
  if (totalFrames) {
    duration = (totalFrames * spf) / sampleRate;
  } else if (bitrateK > 0 && frameLen > 0) {
    const approxFrames = (size - sync) / frameLen;
    duration = (approxFrames * spf) / sampleRate;
  }
  return {
    ok: true,
    format: 'mp3',
    codec: `MPEG-${MPEG_V[verIdx]} Layer ${layer} (MP3)`,
    metadata,
    technical: {
      sampleRate,
      channels,
      bitDepth: null,
      bitrateKbps: bitrateK,
      durationSec: round2(duration),
      totalFrames: totalFrames ?? Math.round((size - sync) / frameLen),
      mpegVersion: `MPEG-${MPEG_V[verIdx]}`,
      layer,
      vbr: !!isXing,
    },
    stream: { container: 'mp3', encoding: 'mp3-lossless', lossless: true, transcodeFree: true, startByte: off, byteLength: size - off, dataBytes: size - off },
    quality: { lossless: true, decode: 'container-preserve', note: '未转码；原始 MP3 流（含 ID3 之后全部字节）原样保留' },
  };
}

// ── FLAC ──────────────────────────────────────────────────────────────────
function parseFlac(head, size) {
  if (head.length < 4 || head.toString('ascii', 0, 4) !== 'fLaC') return err('E_MAGIC', '缺少 fLaC 标识');
  let off = 4;
  let streamInfo = null;
  let blockIdx = 0;
  while (off + 4 <= head.length) {
    const b = head[off];
    const isLast = (b & 0x80) !== 0;
    const type = b & 0x7f;
    const len = head.readUIntBE(off + 1, 3);
    const body = off + 4;
    if (blockIdx === 0 && type !== 0) return err('E_HEADER', 'STREAMINFO 必须是第一个元数据块');
    if (type === 0) {
      if (len < 34) return err('E_HEADER', 'STREAMINFO 块过短');
      // STREAMINFO 位布局（bytes 10..17 = 64bit）：
      //   sampleRate(20) | channels-1(3) | bitsPerSample-1(5) | totalSamples(36)
      const b10 = head[body + 10];
      const b11 = head[body + 11];
      const b12 = head[body + 12];
      const b13 = head[body + 13];
      streamInfo = {
        minBlockSize: head.readUInt16BE(body),
        maxBlockSize: head.readUInt16BE(body + 2),
        minFrameSize: head.readUIntBE(body + 4, 3),
        maxFrameSize: head.readUIntBE(body + 7, 3),
        sampleRate: (b10 << 12) | (b11 << 4) | (b12 >> 4),
        channels: ((b12 >> 1) & 0x07) + 1,
        bitsPerSample: (((b12 & 1) << 4) | (b13 >> 4)) + 1,
        totalSamples: ((b13 & 0x0f) * 2 ** 32) + head.readUInt32BE(body + 14),
      };
    }
    blockIdx += 1;
    off = body + len;
    if (isLast) break;
  }
  if (!streamInfo) return err('E_HEADER', '缺少 STREAMINFO');
  if (streamInfo.sampleRate < 1) return err('E_HEADER', 'STREAMINFO 采样率无效');
  const duration = streamInfo.totalSamples > 0 ? streamInfo.totalSamples / streamInfo.sampleRate : null;
  return {
    ok: true,
    format: 'flac',
    codec: 'FLAC',
    metadata: {},
    technical: {
      sampleRate: streamInfo.sampleRate,
      channels: streamInfo.channels,
      bitDepth: streamInfo.bitsPerSample,
      bitrateKbps: null,
      durationSec: round2(duration),
      totalSamples: streamInfo.totalSamples || null,
      blockSizeMin: streamInfo.minBlockSize,
      blockSizeMax: streamInfo.maxBlockSize,
    },
    stream: { container: 'flac', encoding: 'flac-lossless', lossless: true, transcodeFree: true, startByte: off, byteLength: size - off, dataBytes: size - off },
    quality: { lossless: true, decode: 'flac-lossless', note: 'FLAC 为无损编码；原始流原样保留，解码需在后续工具中进行' },
  };
}

// ── OGG（Opus / Vorbis） ──────────────────────────────────────────────────
function parseOgg(head, tail, size) {
  if (head.length < 4 || head.toString('ascii', 0, 4) !== 'OggS') return err('E_MAGIC', '缺少 OggS 捕获标识');
  if (head[4] !== 0) return err('E_HEADER', 'Ogg 版本不支持');
  let codec = null;
  let channels = null;
  let sampleRate = null;
  let preskip = 0;
  // 首页：查找 OpusHead / vorbis 标识
  for (let i = 0; i + 8 <= head.length; i++) {
    if (head.toString('ascii', i, i + 8) === 'OpusHead') {
      codec = 'Opus';
      channels = head[i + 9];
      preskip = head.readUInt16LE(i + 10);
      sampleRate = head.readUInt32LE(i + 12); // 输入采样率（编码器参考）
      break;
    }
    if (head.toString('ascii', i, i + 7) === '\x01vorbis') {
      codec = 'Vorbis';
      channels = head[i + 11];
      sampleRate = head.readUInt32LE(i + 12);
      break;
    }
  }
  if (!codec) return err('E_HEADER', '未识别到 OpusHead / Vorbis 标识');
  // 尾页 granule position（最后一个 OggS）
  const scan = tail || head;
  let lastPos = -1;
  let granule = null;
  for (let i = scan.length - 4; i >= 0; i--) {
    if (scan.toString('ascii', i, i + 4) === 'OggS' && scan[i + 4] === 0) {
      lastPos = i;
      granule = Number(scan.readBigUInt64LE(i + 6));
      break;
    }
  }
  if (lastPos < 0) return err('E_HEADER', '未找到 Ogg 页');
  const granuleSeconds = codec === 'Opus'
    ? (granule - preskip) / 48000
    : (sampleRate ? granule / sampleRate : null);
  const duration = granuleSeconds !== null && granuleSeconds > 0 ? granuleSeconds : null;
  return {
    ok: true,
    format: 'ogg',
    codec,
    metadata: {},
    technical: {
      sampleRate: codec === 'Opus' ? 48000 : sampleRate,
      inputSampleRate: codec === 'Opus' ? sampleRate : null,
      channels,
      bitDepth: null,
      bitrateKbps: null,
      durationSec: round2(duration),
      granulePosition: granule,
      preskipSamples: codec === 'Opus' ? preskip : null,
    },
    stream: { container: 'ogg', encoding: `ogg-${codec.toLowerCase()}`, lossless: false, transcodeFree: true, startByte: 0, byteLength: size, dataBytes: size },
    quality: { lossless: false, decode: 'container-preserve', note: `${codec} 为有损编码；原始流原样保留` },
  };
}

// ── M4A / MP4 ─────────────────────────────────────────────────────────────
function walkBoxes(buf, from, to, visitor) {
  let off = from;
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > to) break;
      size = Number(buf.readBigUInt64BE(off + 8));
    } else if (size === 0) {
      size = to - off;
    }
    if (size < 8 || off + size > to) break;
    const cont = visitor(type, off + 8, size);
    if (cont === false) return false;
    off += size;
  }
  return true;
}

function parseM4a(head, tail, size) {
  if (head.length < 8) return err('E_TOOSMALL', 'MP4 头不足');
  const brands = [];
  const bodies = [head];
  if (tail && tail !== head) bodies.push(tail);
  let moovBuf = null;
  let moovBase = 0;
  for (const b of bodies) {
    walkBoxes(b, 0, b.length, (type, body, bsize) => {
      if (type === 'ftyp' && bsize >= 12) brands.push(b.toString('ascii', body + 4, body + 8));
      if (type === 'moov') { moovBuf = b; moovBase = 0; return false; }
      return true;
    });
    if (moovBuf) break;
  }
  if (!moovBuf) return err('E_HEADER', '缺少 moov 盒子（文件可能未完整写入）');
  let mdhd = null;
  let audioEntry = null;
  walkBoxes(moovBuf, 0, moovBuf.length, (type, body, bsize) => {
    if (type === 'trak') {
      let mdhdLocal = null;
      let stsdLocal = null;
      walkBoxes(moovBuf, body, body + bsize, (t2, b2, s2) => {
        if (t2 === 'mdia') {
          walkBoxes(moovBuf, b2, b2 + s2, (t3, b3, s3) => {
            if (t3 === 'mdhd') {
              const ver = moovBuf[b3];
              if (ver === 1) {
                mdhdLocal = { timescale: moovBuf.readUInt32BE(b3 + 20), duration: Number(moovBuf.readBigUInt64BE(b3 + 24)) };
              } else {
                mdhdLocal = { timescale: moovBuf.readUInt32BE(b3 + 12), duration: moovBuf.readUInt32BE(b3 + 16) };
              }
            }
            return true;
          });
        } else if (t2 === 'minf') {
          walkBoxes(moovBuf, b2, b2 + s2, (t4, b4, s4) => {
            if (t4 === 'stbl') {
              walkBoxes(moovBuf, b4, b4 + s4, (t5, b5, s5) => {
                if (t5 === 'stsd' && s5 >= 16) {
                  const count = moovBuf.readUInt32BE(b5 + 4);
                  if (count > 0) {
                    const entryType = moovBuf.toString('ascii', b5 + 8, b5 + 12);
                    const ebody = b5 + 8 + 8; // entry box header
                    const channels = moovBuf.readUInt16BE(ebody + 8);
                    const bits = moovBuf.readUInt16BE(ebody + 10);
                    const sampleRate = moovBuf.readUInt32BE(ebody + 16) / 65536;
                    stsdLocal = { entryType, channels, bits, sampleRate };
                  }
                }
                return true;
              });
            }
            return true;
          });
        }
        return true;
      });
      if (stsdLocal) audioEntry = { ...stsdLocal, mdhd: mdhdLocal };
      return true;
    }
    return true;
  });
  if (!audioEntry) return err('E_HEADER', '未找到音频轨道 (stsd)');
  const codecMap = { mp4a: 'AAC', alac: 'ALAC', 'mp4a.': 'AAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus' };
  const codec = codecMap[audioEntry.entryType] || audioEntry.entryType;
  const duration = audioEntry.mdhd && audioEntry.mdhd.timescale > 0 ? audioEntry.mdhd.duration / audioEntry.mdhd.timescale : null;
  const lossless = codec === 'ALAC' || codec === 'PCM';
  return {
    ok: true,
    format: 'm4a',
    codec,
    metadata: {},
    technical: {
      sampleRate: audioEntry.sampleRate || null,
      channels: audioEntry.channels || null,
      bitDepth: audioEntry.bits || null,
      bitrateKbps: null,
      durationSec: round2(duration),
      brands: brands.length ? brands : undefined,
    },
    stream: { container: 'm4a', encoding: `m4a-${codec.toLowerCase()}`, lossless, transcodeFree: true, startByte: 0, byteLength: size, dataBytes: size },
    quality: { lossless, decode: 'container-preserve', note: lossless ? 'ALAC 为无损编码；原始流原样保留' : `${codec} 为有损编码；原始流原样保留` },
  };
}

// ── AMR ───────────────────────────────────────────────────────────────────
const AMR_NB_SIZES = [12, 13, 15, 17, 19, 20, 26, 31, 5, 6, 5, 5, 0, 0, 0, 0];
const AMR_WB_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, 0, 0, 0, 0, 0, 0];
function parseAmr(head, size) {
  const tag = head.toString('ascii', 0, 6);
  let wb = false;
  if (tag === '#!AMR\n') wb = false;
  else if (head.toString('ascii', 0, 9) === '#!AMR-WB\n') wb = true;
  else return err('E_MAGIC', '缺少 #!AMR 标识');
  const sr = wb ? 16000 : 8000;
  const table = wb ? AMR_WB_SIZES : AMR_NB_SIZES;
  // 帧计数（用前 64KB 的帧大小估计平均帧长，再按文件大小推算时长）
  const start = wb ? 9 : 6;
  let off = start;
  let frames = 0;
  let avgSize = 0;
  let n = 0;
  const limit = Math.min(head.length, start + 65536);
  while (off + 1 <= limit) {
    const type = (head[off] >> 3) & 0xf;
    const fsize = table[type];
    if (fsize === 0) break; // NO_DATA / 保留
    avgSize += fsize + 1;
    n += 1;
    off += fsize + 1;
  }
  if (n === 0) return err('E_HEADER', '未找到有效 AMR 帧');
  const avg = avgSize / n;
  const totalFrames = Math.floor((size - start) / avg);
  const duration = (totalFrames * 20) / 1000;
  return {
    ok: true,
    format: 'amr',
    codec: wb ? 'AMR-WB' : 'AMR-NB',
    metadata: {},
    technical: { sampleRate: sr, channels: 1, bitDepth: null, bitrateKbps: null, durationSec: round2(duration), totalFrames, wideband: wb },
    stream: { container: 'amr', encoding: wb ? 'amr-wb' : 'amr-nb', lossless: false, transcodeFree: true, startByte: start, byteLength: size - start, dataBytes: size - start },
    quality: { lossless: false, decode: 'container-preserve', note: 'AMR 为有损编码；原始流原样保留' },
  };
}

// ── ASF / WMA ─────────────────────────────────────────────────────────────
const GUID_HEADER = '3026b2758e66cf11a6d900aa0062ce6c';
const GUID_FILE = '8cabdca1a94711cf8ee400c00c205365';
const GUID_STREAM = '9107dcb7b7a9cf118ee600c00c205365';
const GUID_AUDIO = '409e69f84d5bcf11a8fd00805f5c442b';
function guidHex(buf, off) {
  return [...buf.slice(off, off + 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function parseAsf(head, size) {
  if (head.length < 30) return err('E_TOOSMALL', 'ASF 头不足');
  if (guidHex(head, 0) !== GUID_HEADER) return err('E_MAGIC', '缺少 ASF 头 GUID');
  let duration = null;
  let audio = null;
  let off = 30;
  while (off + 24 <= head.length) {
    const g = guidHex(head, off);
    const objSize = Number(head.readBigUInt64LE(off + 16));
    if (objSize < 24 || off + objSize > head.length + 0) break;
    const body = off + 24;
    if (g === GUID_FILE && objSize >= 80) {
      duration = Number(head.readBigUInt64LE(body + 40)) / 10000000; // play duration, 100ns
    } else if (g === GUID_STREAM && objSize >= 54) {
      const streamType = guidHex(head, body);
      const typeDataLen = head.readUInt32LE(body + 40);
      if (streamType === GUID_AUDIO && typeDataLen >= 18) {
        const td = body + 54;
        const codecId = head.readUInt16LE(td);
        audio = {
          codecId,
          channels: head.readUInt16LE(td + 2),
          sampleRate: head.readUInt32LE(td + 4),
          bits: head.readUInt16LE(td + 16),
          codecName: codecId === 0x0161 ? 'WMA v2' : codecId === 0x0162 ? 'WMA Pro' : codecId === 0x0163 ? 'WMA Lossless' : `codec-${codecId.toString(16)}`,
        };
      }
    }
    off += objSize;
    if (off > 2 * 1024 * 1024) break;
  }
  if (!audio) return err('E_HEADER', '未找到音频流属性对象');
  const lossless = audio.codecId === 0x0163;
  return {
    ok: true,
    format: 'wma',
    codec: audio.codecName,
    metadata: {},
    technical: { sampleRate: audio.sampleRate || null, channels: audio.channels || null, bitDepth: audio.bits || null, bitrateKbps: null, durationSec: round2(duration) },
    stream: { container: 'asf', encoding: 'wma', lossless, transcodeFree: true, startByte: 0, byteLength: size, dataBytes: size },
    quality: { lossless, decode: 'container-preserve', note: lossless ? 'WMA Lossless 为无损编码；原始流原样保留' : 'WMA 为有损编码；原始流原样保留' },
  };
}

// ── SILK ──────────────────────────────────────────────────────────────────
function parseSilk(head, size) {
  const tag = head.toString('ascii', 0, 7);
  if (tag !== '#!SILK') return err('E_MAGIC', '缺少 #!SILK 标识');
  let sampleRate = null;
  if (head.length >= 9 && head.toString('ascii', 0, 9) === '#!SILK_V3') {
    const hint = head[8];
    if (hint === 1) sampleRate = 24000;
    else if (hint === 2) sampleRate = 16000;
    else if (hint === 0) sampleRate = 24000;
  }
  return {
    ok: true,
    format: 'silk',
    codec: 'SILK',
    metadata: {},
    technical: { sampleRate, channels: 1, bitDepth: null, bitrateKbps: null, durationSec: null },
    stream: { container: 'silk', encoding: 'silk', lossless: false, transcodeFree: true, startByte: 0, byteLength: size, dataBytes: size },
    quality: { lossless: false, decode: 'container-preserve', note: 'SILK 为 QQ 语音编码；原始流原样保留' },
  };
}

// ── AIFF / AIFC ───────────────────────────────────────────────────────────
function parseAiff(head, size) {
  if (head.length < 12) return err('E_TOOSMALL', 'AIFF 头不足');
  if (s(head.toString('ascii', 0, 4)) !== 'FORM') return err('E_MAGIC', '缺少 FORM 标识');
  const formType = head.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') return err('E_MAGIC', `未知 FORM 类型 ${formType}`);
  let comm = null;
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.toString('ascii', off, off + 4);
    const len = head.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === 'COMM' && len >= 18) {
      const channels = head.readUInt16BE(body);
      const frames = head.readUInt32BE(body + 2);
      const bits = head.readUInt16BE(body + 6);
      // 80-bit extended float sample rate
      const exp = ((head[body + 8] & 0x7f) << 8) | head[body + 9];
      const mantHi = head.readUInt32BE(body + 10);
      const mantLo = head.readUInt32BE(body + 14);
      const mantissa = mantHi * 2 ** 32 + mantLo;
      const sampleRate = mantissa * 2 ** (exp - 16383 - 63);
      comm = { channels, frames, bits, sampleRate: Math.round(sampleRate) };
      break;
    }
    off = body + len + (len % 2);
  }
  if (!comm) return err('E_HEADER', '缺少 COMM 块');
  const duration = comm.frames > 0 && comm.sampleRate > 0 ? comm.frames / comm.sampleRate : null;
  return {
    ok: true,
    format: 'aiff',
    codec: formType === 'AIFC' ? 'AIFC' : 'PCM (AIFF)',
    metadata: {},
    technical: { sampleRate: comm.sampleRate || null, channels: comm.channels, bitDepth: comm.bits, bitrateKbps: null, durationSec: round2(duration), totalSamples: comm.frames },
    stream: { container: 'aiff', encoding: 'pcm-aiff', lossless: true, transcodeFree: true, startByte: 0, byteLength: size, dataBytes: size },
    quality: { lossless: true, decode: 'container-preserve', note: 'AIFF 通常为未压缩 PCM；原始流原样保留' },
  };
}

// ── 总入口：按魔数分发 + 未知格式识别 ──────────────────────────────────────
export function parseAudioFile(path) {
  const { head, tail, size, err: rerr } = readAudioFile(path);
  if (rerr) return rerr;
  const h = head;
  try {
    if (h.length >= 12 && s(h.toString('ascii', 0, 4)) === 'RIFF' && s(h.toString('ascii', 8, 12)) === 'WAVE') return parseWav(h, size);
    if (h.length >= 4 && s(h.toString('ascii', 0, 4)) === 'fLaC') return parseFlac(h, size);
    if (h.length >= 4 && s(h.toString('ascii', 0, 4)) === 'OggS') return parseOgg(h, tail, size);
    if (h.length >= 8 && s(h.toString('ascii', 4, 8)) === 'ftyp') return parseM4a(h, tail, size);
    if (h.length >= 12 && s(h.toString('ascii', 0, 4)) === 'FORM') return parseAiff(h, size);
    if (s(h.toString('ascii', 0, 6)) === '#!AMR\n' || s(h.toString('ascii', 0, 9)) === '#!AMR-WB\n') return parseAmr(h, size);
    if (s(h.toString('ascii', 0, 7)) === '#!SILK') return parseSilk(h, size);
    if (guidHex(h, 0) === GUID_HEADER) return parseAsf(h, size);
    if (s(h.toString('ascii', 0, 3)) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return parseMp3(h, size);
    return err('E_UNSUPPORTED', `无法识别的音频容器（魔数: ${h.slice(0, 8).toString('hex')}）`);
  } catch (e) {
    return err('E_PARSE', e?.message ?? String(e));
  }
}

// 附注：pick() 未用则忽略（保留给调用方做字段裁剪）
void pick;
