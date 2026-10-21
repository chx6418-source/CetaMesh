/* 融合合规校验（三条硬约束，任一不通过即失败）
   ① 落场层零改动：public/console.html 剥掉全部 bg-ripple 标记块后，必须与
      tools/fixtures/console.baseline.html 逐字节相同 —— 这次融合对控制台只做了「新增」，
      控制台自身的主题体系 / 落场卡片浮升 / 所有交互逻辑一个字符都没动。
   ② 登录页无涟漪：public/token-login.html 必须与 tools/fixtures/token-login.baseline.html
      逐字节相同 —— 涟漪动画只在「进入主页面」时出现，登录页保持原样。
   ③ 引擎一致：控制台内联的引擎副本必须与 design-demos/bg-ripple/ripple-bg.js 逐字节相同
      —— 引擎只有一份事实源，改引擎后必须重跑 fuse-console.mjs，避免两边漂移。
   用法：node design-demos/bg-ripple/tools/check-fusion.mjs
*/
import { readFileSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = HERE.replace(/design-demos\/bg-ripple\/tools\/$/, '');
const ENGINE = ROOT + 'design-demos/bg-ripple/ripple-bg.js';
const MARKERS = [
  ['<!-- == bg-ripple:css:start == -->', '<!-- == bg-ripple:css:end == -->'],
  ['<!-- == bg-ripple:markup:start == -->', '<!-- == bg-ripple:markup:end == -->'],
  ['<!-- == bg-ripple:engine:start == -->', '<!-- == bg-ripple:engine:end == -->'],
  ['<!-- == bg-ripple:init:start == -->', '<!-- == bg-ripple:init:end == -->']
];

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(readFileSync(p, 'utf8'));
const engine = read(ENGINE);

function strip(src) {
  let out = src, n = 0;
  for (const [a, b] of MARKERS) {
    while (true) {
      const i = out.indexOf(a);
      if (i === -1) break;
      const j = out.indexOf(b, i);
      if (j === -1) throw new Error('标记块不闭合：' + a);
      out = out.slice(0, i) + out.slice(j + b.length);
      n++;
    }
  }
  return { out, n };
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
function report(ok, label, a, b, extra) {
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5) + label + (extra ? '  ' + extra : ''));
  if (!ok) {
    const d = firstDiff(a, b);
    console.log('     首个差异位置 ' + d + '：');
    console.log('       实得: ' + JSON.stringify(a.slice(Math.max(0, d - 60), d + 60)));
    console.log('       期望: ' + JSON.stringify(b.slice(Math.max(0, d - 60), d + 60)));
  }
  return ok;
}

let pass = true;

/* ① 控制台：剥离标记块 == 基线 */
const consoleBase = read(HERE + 'fixtures/console.baseline.html');
const consoleNow = read(ROOT + 'public/console.html');
const c = strip(consoleNow);
pass = report(c.out.replace(/\s+$/, '') === consoleBase.replace(/\s+$/, ''),
  '① 控制台零改动（剥离标记块 == 基线）', c.out.replace(/\s+$/, ''), consoleBase.replace(/\s+$/, ''),
  `标记块 ${c.n} 个 · 融合后 ${consoleNow.length} 字符 · 基线 ${consoleBase.length} 字符 · 新增 ${consoleNow.length - consoleBase.length}`) && pass;

/* ② 登录页：与基线逐字节相同（不含涟漪） */
const loginBase = read(HERE + 'fixtures/token-login.baseline.html');
const loginNow = read(ROOT + 'public/token-login.html');
pass = report(loginNow === loginBase, '② 登录页无涟漪（与基线逐字节相同）', loginNow, loginBase,
  `${loginNow.length} 字符`) && pass;

/* ③ 内联引擎 == ripple-bg.js */
const ei = consoleNow.indexOf(MARKERS[2][0]);
const e2 = consoleNow.indexOf(MARKERS[2][1]);
const inlined = consoleNow.slice(consoleNow.indexOf('<script>', ei) + '<script>\n'.length, consoleNow.lastIndexOf('</script>', e2));
pass = report(inlined === engine, '③ 内联引擎 == ripple-bg.js', inlined, engine,
  `内联 ${inlined.length} 字符 / 源文件 ${engine.length} 字符`) && pass;

process.exit(pass ? 0 : 1);
