/* 融合生成器：把「湖面涟漪主题背景渐变」叠加到控制台的落场时刻
   ----------------------------------------------------------------------------
   输入：tools/fixtures/console.baseline.html（融合前的控制台基线）
        ../ripple-bg.js（涟漪背景引擎，唯一事实源）
   输出：public/console.html = 基线 + 四处「纯新增」标记块
     · css   ：.ripple-bg 定位 + 只在落场时显示（html.login-arrive 才 display:block）
     · markup：<canvas class="ripple-bg">（排在 .bg-decor 之后 → 盖住主题画布、仍在所有内容之下）
     · engine：ripple-bg.js 的内联副本（桥接只服务两个固定 HTML，没有静态资源通道，只能内联）
     · init  ：只有「从登录页进来」（html.login-arrive）才播一次；起始 = 登录页转场铺下的
               同一主题底色（--bg），目标 = 当前主题自己的画布（.bg-decor）→ 主题是哪个就扩散到哪个
   幂等：先剥离已有标记块再重新插入，可反复执行。
   校验：node tools/check-fusion.mjs（引擎副本一致性 + 剥离标记块后与基线逐字节相同）
   用法：node design-demos/bg-ripple/tools/fuse-console.mjs [--dry]
*/
import { readFileSync, writeFileSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = HERE.replace(/design-demos\/bg-ripple\/tools\/$/, '');
const BASELINE = HERE + 'fixtures/console.baseline.html';
const ENGINE = ROOT + 'design-demos/bg-ripple/ripple-bg.js';
const TARGET = ROOT + 'public/console.html';
const dry = process.argv.includes('--dry');

const M = {
  css: ['<!-- == bg-ripple:css:start == -->', '<!-- == bg-ripple:css:end == -->'],
  markup: ['<!-- == bg-ripple:markup:start == -->', '<!-- == bg-ripple:markup:end == -->'],
  engine: ['<!-- == bg-ripple:engine:start == -->', '<!-- == bg-ripple:engine:end == -->'],
  init: ['<!-- == bg-ripple:init:start == -->', '<!-- == bg-ripple:init:end == -->']
};

function stripBlocks(html) {
  let out = html;
  for (const [a, b] of Object.values(M)) {
    let i;
    while ((i = out.indexOf(a)) !== -1) {
      const j = out.indexOf(b, i);
      if (j === -1) throw new Error('标记块不闭合: ' + a);
      out = out.slice(0, i) + out.slice(j + b.length);
    }
  }
  return out;
}

const engine = readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
let html = readFileSync(BASELINE, 'utf8').replace(/\r\n/g, '\n');
if (html !== stripBlocks(html)) throw new Error('基线文件里不应存在 bg-ripple 标记块');

/* ① CSS：紧随原样式表之后（原表最后一条规则就是落场注释，正好接在它后面） */
const CSS_BLOCK = `${M.css[0]}
<style>
  /* ── 主题背景渐变 · 湖面涟漪（落场层，纯新增）──────────────────────────────
     从登录页进来时播一次：起始 = 登录页转场铺下的同一主题底色（--bg，跨页零色差），
     目标 = 当前主题自己的画布（.bg-decor）—— 主题是哪个就涟漪扩散到哪个，
     所以这一层天然与主题联动，深色用户看到的是深海画布、护眼用户看到的是护眼画布。
     平时 display:none（普通刷新根本不参与渲染）；只有落场那一刻才让它出来，
     扩散落定后立刻撤掉这一层，把背景交还给控制台自己的 .bg-decor。
     图层位置：排在 .bg-decor 之后、同为 z-index:-1 —— 同级按文档顺序绘制，
     所以它盖住主题画布，但仍在所有内容（含毛玻璃面板）之下，不会挡住任何卡片。 */
  .ripple-bg {
    display: none; position: fixed; inset: 0; width: 100%; height: 100%;
    z-index: -1; pointer-events: none; background: var(--bg);
    transition: opacity .3s ease;   /* 落定后淡出交还背景，杜绝任何硬切 */
  }
  /* 注意：这一层的显隐**只由接线脚本用内联样式控制**，不挂 html.login-arrive 类 ——
     控制台会在落场 2s 时摘掉那个类，若显隐依赖它，正在播（或已落定但尚未撤走）的这一层
     会被那一刻瞬间隐藏，看起来就像背景"咔"地跳了一下。 */
  /* 常驻滚动条槽（顺手修掉一次「整页横移」）：控制台的数据是异步到的，页面高度会在加载
     过程中跨过「一屏」这个临界点，滚动条随之出现/消失 —— 每次都会让整页横向位移一个
     滚动条宽度（本机 9~15px），观感就像动画断层，而且与落场动画结束的时刻接近，最容易被
     当成动画的 bug。这里让滚动条常驻（轨道本就是透明的、只滚时才画滑块，视觉不变），
     于是内容宽度恒定、不再位移。 */
  /* 关键：底色写在 html 上、body 透明（否则这一层等于没画）。
     控制台原本把底色写在 body 上，浏览器会把它当作普通元素背景绘制并盖住 z-index:-1 的
     涟漪层 —— 实测画布内容被整层吞掉、只剩画布兜底色：表现就是「背景冻住 / 只有局部有
     动画 / 前后对不上」。把底色挪到 html 后，负 z 层重新正常参与合成，视觉完全一致。 */
  html { background: var(--bg); }
  body { background: transparent; }
  html { overflow-y: scroll; }
</style>
${M.css[1]}`;

/* ② markup：紧跟在 .bg-decor 之后 */
const MARKUP_BLOCK = `${M.markup[0]}
<canvas class="ripple-bg" id="rippleBg" aria-hidden="true"></canvas>${M.markup[1]}`;

/* ③ engine + init：原脚本之后 */
const INIT_BLOCK = `${M.init[0]}
<script>
/* 涟漪落场的接线（与上方控制台逻辑完全独立，互不引用、互不修改） */
(function () {
  var el = document.documentElement;
  var canvas = document.getElementById('rippleBg');
  if (!canvas) return;
  var mo = null;
  function drop() {
    if (mo) { mo.disconnect(); mo = null; }
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }
  // 只有「从登录页进来」才播：落场标记由登录页写入、控制台 head 消费后给 html 打类
  if (!el.classList.contains('login-arrive')) return drop();
  // 「减少动态效果」：不播动画，直接交还给控制台自己的画布
  try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return drop(); } catch (e) {}
  var map = (window.RippleBg && window.RippleBg.THEME_MAP) || {};
  var themeName = el.dataset.theme || 'light';
  var theme = map[themeName] || map.light;
  var base = '';
  try { base = getComputedStyle(el).getPropertyValue('--bg').trim(); } catch (e) {}
  var gone = false;
  function drop() {                       // 立刻撤层（主题被切换时用）
    if (gone) return; gone = true;
    if (mo) { mo.disconnect(); mo = null; }
    bg && bg.destroy();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }
  function fadeOut() {                    // 落定后淡出再撤层：即使两层有一点点色差也不会"跳"
    if (gone) return; gone = true;
    if (mo) { mo.disconnect(); mo = null; }
    canvas.style.opacity = '0';
    setTimeout(function () {
      bg && bg.destroy();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }, 340);                              // 与 CSS 的 .3s 过渡对齐
  }
  canvas.style.display = 'block';         // 显隐只由这里的内联样式控制（不依赖 login-arrive 类）
  var bg = null, mo = null;
  try {
    bg = new window.RippleBg({
      canvas: canvas,
      mode: 'once',
      from: { solid: base || theme.bg }, // 起始 = 登录页转场铺下的同一主题底色
      to: theme.canvas,                  // 目标 = 当前主题的画布（主题联动就在这里）
      duration: 1500,                    // 与控制台「卡片依次浮升」同一档窗口
      longSide: 1024,                    // 落场目标纹理精度（纯平滑渐变，烘焙仅 ~2ms）
      autoplay: false,                   // 不立刻开播：等页面空闲（见下）
      onDone: fadeOut                    // 落定 → 淡出交还给控制台自己的画布
    });
  } catch (e) {
    gone = true;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if (window.console && console.warn) console.warn('[bg-ripple] 已跳过涟漪落场：' + e.message);
    return;
  }
  window.__arriveRipple = bg;
  /* 等页面空闲再起波：控制台首屏要建大量 DOM + 发多个请求，会把主线程占满 ——
     这时开播只会被卡住（波前停在半途）。requestIdleCallback 让动画从"页面能正常出帧"
     的时刻开始，配合引擎内的起帧门，动画一定是完整、按时播完的。 */
  (function start() {
    try {
      if (window.requestIdleCallback) window.requestIdleCallback(function () { bg.play(); }, { timeout: 1200 });
      else setTimeout(function () { bg.play(); }, 300);
    } catch (e) { setTimeout(function () { bg.play(); }, 300); }
  })();
  // 落场期间用户切了主题：立刻收尾，别让这一层挡着新主题。
  // 只在**主题真的变了**时才收尾 —— 控制台自己启动时会把同样的值重写一次，
  // 那种同值写入不能当作切换（否则涟漪会被中途撤掉，看起来就是「断层」）。
  try {
    mo = new MutationObserver(function () {
      if ((el.dataset.theme || 'light') === themeName) return;
      drop();
    });
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}
})();
</script>${M.init[1]}`;

const ENGINE_BLOCK = `${M.engine[0]}
<script>
${engine}</script>
${M.engine[1]}`;

/* 插入：CSS 在第一个 </style> 之后；markup 在 .bg-decor 之后；engine+init 在最后一个 </script> 之后。
   每块插入物都以标记块开头、以标记块结尾，块外不留任何空白 —— 剥掉标记块即可逐字节还原基线。 */
const insertAt = (src, needle, offset, block) => {
  const i = src.indexOf(needle);
  if (i === -1) throw new Error('基线缺少锚点: ' + needle);
  const p = i + offset;
  return src.slice(0, p) + block + src.slice(p);
};
let fused = insertAt(html, '</style>', 8, CSS_BLOCK);
fused = insertAt(fused, '<div class="bg-decor" aria-hidden="true"></div>', '<div class="bg-decor" aria-hidden="true"></div>'.length, MARKUP_BLOCK);
const tailEnd = fused.lastIndexOf('</script>') + '</script>'.length;
fused = fused.slice(0, tailEnd) + ENGINE_BLOCK + INIT_BLOCK + fused.slice(tailEnd);

if (dry) {
  console.log('（dry-run）融合后长度', fused.length, '基线', html.length, '新增', fused.length - html.length);
} else {
  writeFileSync(TARGET, fused);
  console.log(`已生成 ${TARGET}`);
  console.log(`  基线 ${html.length} B → 融合后 ${fused.length} B（新增 ${fused.length - html.length} B，内联引擎 ${engine.length} B）`);
}
