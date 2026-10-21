/* 逐像素比对两张截图（用于验证「静止基座 == 登录页背景」）
   用法：node design-demos/bg-ripple/tools/compare-bg.mjs <a.png> <b.png> [--exclude x0,y0,x1,y1 ...]
   不带 --exclude 时比对整幅；带 --exclude 时跳过这些矩形（例如登录卡片与浮雕底纹占据的区域）。 */
import { readFile } from 'node:fs/promises';
import { decodePng, hex } from './png.mjs';

const args = process.argv.slice(2);
const files = [];
const excl = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exclude') excl.push(args[++i].split(',').map(Number));
  else files.push(args[i]);
}
if (files.length !== 2) {
  console.error('用法: node compare-bg.mjs <a.png> <b.png> [--exclude x0,y0,x1,y1 ...]');
  process.exit(2);
}
const [A, B] = await Promise.all(files.map(async (f) => decodePng(await readFile(f))));
if (A.w !== B.w || A.h !== B.h) {
  console.log(`尺寸不同：${A.w}x${A.h} vs ${B.w}x${B.h}`);
  process.exit(1);
}
const inExcl = (x, y) => excl.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
let n = 0, sum = 0, max = 0, over2 = 0, over6 = 0, argmax = null;
let sa = [0, 0, 0], sb = [0, 0, 0];
for (let y = 0; y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    if (inExcl(x, y)) continue;
    const a = A.px(x, y), b = B.px(x, y);
    let d = 0;
    for (let k = 0; k < 3; k++) { d = Math.max(d, Math.abs(a[k] - b[k])); sa[k] += a[k]; sb[k] += b[k]; }
    n++; sum += d;
    if (d > max) { max = d; argmax = [x, y, a, b]; }
    if (d > 2) over2++;
    if (d > 6) over6++;
  }
}
console.log(`比对像素 ${n}（排除 ${excl.length} 个矩形区域）`);
console.log(`  平均最大通道差 ${(sum / n).toFixed(3)}   峰值 ${max} @ ${argmax ? `(${argmax[0]},${argmax[1]}) ${hex(argmax[2])} vs ${hex(argmax[3])}` : '-'}`);
console.log(`  差值>2 的像素占比 ${(over2 / n * 100).toFixed(2)}% ，>6 的占比 ${(over6 / n * 100).toFixed(2)}%`);
console.log(`  平均色 A=${hex(sa.map((v) => v / n))}  B=${hex(sb.map((v) => v / n))}`);
