/* 采样 PNG 背景配色（纯 Node，无第三方依赖）
   用途：从参考截图里取出「起始基底 / 三组目标背景」的渐变锚点色，
        供 bg-ripple 引擎的 GLSL 渐变函数（canvas 回退同样使用）取值。
   用法：node design-demos/bg-ripple/tools/sample-colors.mjs <png> [<png> ...]
*/
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

function decodePng(buf) {
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

const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const avg = (img, x0, y0, x1, y1) => {
  const acc = [0, 0, 0]; let n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const c = img.px(x, y); acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++;
  }
  return acc.map((v) => v / n);
};

const files = process.argv.slice(2);
for (const f of files) {
  const img = decodePng(await readFile(f));
  console.log(`\n=== ${f.split(/[\\/]/).pop()}  ${img.w}x${img.h} ===`);
  // 3x3 网格（避开边缘 6%），另加四角内缩块，用于看渐变的走向
  const MX = Math.round(img.w * 0.06), MY = Math.round(img.h * 0.06);
  const cw = Math.round((img.w - MX * 2) / 3), chh = Math.round((img.h - MY * 2) / 3);
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const x0 = MX + c * cw, y0 = MY + r * chh;
      row.push(hex(avg(img, x0, y0, x0 + cw, y0 + chh)));
    }
    rows.push(row.join('  '));
  }
  console.log('3x3 网格:'); rows.forEach((r) => console.log('  ' + r));
  const pts = {
    'TL 角': [MX, MY], 'TR 角': [img.w - MX - 40, MY],
    'BL 角': [MX, img.h - MY - 40], 'BR 角': [img.w - MX - 40, img.h - MY - 40],
    '正中': [img.w / 2 - 20, img.h / 2 - 20],
    '左中': [MX, img.h / 2 - 20], '右中': [img.w - MX - 40, img.h / 2 - 20],
    '上中': [img.w / 2 - 20, MY], '下中': [img.w / 2 - 20, img.h - MY - 40]
  };
  for (const [k, [x, y]] of Object.entries(pts)) console.log(`  ${k.padEnd(6)} ${hex(avg(img, Math.round(x), Math.round(y), Math.round(x) + 40, Math.round(y) + 40))}`);
}
