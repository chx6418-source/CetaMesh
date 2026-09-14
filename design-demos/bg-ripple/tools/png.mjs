/* 极简 PNG 解码（纯 Node，无第三方依赖）：只支持 8bit、非隔行，够用于截图比对 */
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  let palette = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported png depth=${depth} interlace=${interlace}`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!ch) throw new Error(`unsupported color type ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  const px = (x, y) => {
    const o = y * stride + x * ch;
    if (color === 3) { const i = out[o] * 3; return [palette[i], palette[i + 1], palette[i + 2]]; }
    if (color === 0 || color === 4) return [out[o], out[o], out[o]];
    return [out[o], out[o + 1], out[o + 2]];
  };
  return { w, h, px };
}

export const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
