/* ============================================================================
   湖面涟漪主题背景渐变 · ripple-bg.js（唯一事实源）
   ----------------------------------------------------------------------------
   做什么：把「起始背景 → 目标背景」的颜色过渡做成湖面涟漪扩散的样子。
   两种用法：
     ① once（生产用法）：从「登录页带过来的主题底色」涟漪扩散到「当前主题的画布」，
        进入主页面时播一次即落定 —— 主题是哪个，就扩散到哪个，天然联动。
     ② loop3（参考用法）：起始基座（参考图 1）↔ 三套主题画布（参考图 2/3/4）循环，
        用来演示最初那三组「起始图 → 第 N 张目标图」的渐变。
   四套背景配方（配色直接取控制台真实 token，与控制台 :root[data-theme=*] 逐层对齐）：
     base = 参考图 1 = 登录页自身背景（linear 150deg + 左上白光 + 右下冷光）
     soda = 参考图 2 = 控制台 light 主题 .bg-decor
     deep = 参考图 3 = 控制台 dark  主题 .bg-decor
     warm = 参考图 4 = 控制台 warm  主题 .bg-decor
   做法：
     ① 2D canvas 按 CSS 层叠顺序 1:1 复刻背景（线性渐变 / 椭圆光斑 / blur(72px) 光斑层 / 顶部薄雾），
        烘成纹理；纯平滑渐变，降采样放大无损观感。
     ② WebGL 只算一张「涟漪遮罩」把两张纹理混合：波前推进 + 与波前同速的同心波列
        + 噪声有机扰动 + 波面折射 + 波峰亮线 + 水面微光；频散与耗散都按距离衰减，
        涟漪包络在起落两端为 0 —— 所以过渡的首尾都是干净的静止色。
   坐标约定：uv (0,0)=左上，(1,1)=右下（与 CSS 一致）；顶点着色器里做 y 翻转。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- 背景配方：layers 按「先画的在下」排列，等价 CSS background 层叠顺序 ---------- */
  var BG_SPECS = {
    base: {
      id: 'base',
      label: '起始基座 · 登录页环境光（参考图 1）',
      layers: [
        { kind: 'linear', angle: 150, stops: [[0, '#eef2fc'], [1, '#e6ebfa']] },
        { kind: 'radial', at: ['88%', '96%'], r: ['60%', '46%'],
          stops: [[0, 'rgba(190,205,245,.5)'], [0.68, 'rgba(190,205,245,0)']] },
        { kind: 'radial', at: ['18%', '8%'], r: ['70%', '50%'],
          stops: [[0, 'rgba(255,255,255,.85)'], [0.66, 'rgba(255,255,255,0)']] }
      ]
    },
    soda: {
      id: 'soda',
      label: '目标 A · 苏打 light（参考图 2）',
      layers: [
        { kind: 'linear', angle: 130, stops: [[0, '#d5e3ff'], [0.48, '#ded7ff'], [1, '#ccf1ef']] },
        { kind: 'blobs', inset: -0.22, blur: 72, items: [
          { kind: 'radial', at: ['15%', '10%'], r: ['44vw', '44vw'], stops: [[0, 'rgba(140,175,255,.45)'], [0.62, 'rgba(140,175,255,0)']] },
          { kind: 'radial', at: ['88%', '24%'], r: ['40vw', '40vw'], stops: [[0, 'rgba(180,155,255,.36)'], [0.64, 'rgba(180,155,255,0)']] },
          { kind: 'radial', at: ['60%', '94%'], r: ['46vw', '46vw'], stops: [[0, 'rgba(120,220,215,.32)'], [0.62, 'rgba(120,220,215,0)']] }
        ] },
        { kind: 'radial', at: ['50%', '-12%'], r: ['130vw', '92vh'],
          stops: [[0, 'rgba(255,255,255,.32)'], [0.56, 'rgba(255,255,255,0)']] }
      ]
    },
    deep: {
      id: 'deep',
      label: '目标 B · 深海 dark（参考图 3）',
      layers: [
        { kind: 'linear', angle: 130, stops: [[0, '#182347'], [0.48, '#1c1d42'], [1, '#12262e']] },
        { kind: 'blobs', inset: -0.22, blur: 72, items: [
          { kind: 'radial', at: ['15%', '10%'], r: ['44vw', '44vw'], stops: [[0, 'rgba(100,140,255,.18)'], [0.62, 'rgba(100,140,255,0)']] },
          { kind: 'radial', at: ['88%', '24%'], r: ['40vw', '40vw'], stops: [[0, 'rgba(150,120,255,.15)'], [0.64, 'rgba(150,120,255,0)']] },
          { kind: 'radial', at: ['60%', '94%'], r: ['46vw', '46vw'], stops: [[0, 'rgba(70,210,210,.11)'], [0.62, 'rgba(70,210,210,0)']] }
        ] },
        { kind: 'radial', at: ['50%', '-12%'], r: ['130vw', '92vh'],
          stops: [[0, 'rgba(255,255,255,.08)'], [0.56, 'rgba(255,255,255,0)']] }
      ]
    },
    warm: {
      id: 'warm',
      label: '目标 C · 护眼 warm（参考图 4）',
      layers: [
        { kind: 'linear', angle: 130, stops: [[0, '#eaeddd'], [0.48, '#e7ebe4'], [1, '#e4eee8']] },
        { kind: 'blobs', inset: -0.22, blur: 72, items: [
          { kind: 'radial', at: ['15%', '10%'], r: ['44vw', '44vw'], stops: [[0, 'rgba(170,185,175,.3)'], [0.62, 'rgba(170,185,175,0)']] },
          { kind: 'radial', at: ['88%', '24%'], r: ['40vw', '40vw'], stops: [[0, 'rgba(185,180,200,.24)'], [0.64, 'rgba(185,180,200,0)']] },
          { kind: 'radial', at: ['60%', '94%'], r: ['46vw', '46vw'], stops: [[0, 'rgba(160,190,175,.22)'], [0.62, 'rgba(160,190,175,0)']] }
        ] },
        { kind: 'radial', at: ['50%', '-12%'], r: ['130vw', '92vh'],
          stops: [[0, 'rgba(255,255,255,.32)'], [0.56, 'rgba(255,255,255,0)']] }
      ]
    }
  };

  /* 控制台三个主题 → 各自 .bg-decor 画布 + 各自的 --bg 底色（登录页转场铺的就是这个底色） */
  var THEME_MAP = {
    light: { canvas: 'soda', bg: '#eef2fc' },
    dark: { canvas: 'deep', bg: '#131a2e' },
    warm: { canvas: 'warm', bg: '#eaede0' }
  };

  /* 把 'soda' / { solid: '#131a2e' } / 完整配方对象 统一成配方 */
  function resolveSpec(x) {
    if (!x) return BG_SPECS.base;
    if (typeof x === 'string') return BG_SPECS[x] || BG_SPECS.base;
    if (x.solid) return { id: 'solid:' + x.solid, label: '主题底色 ' + x.solid, layers: [{ kind: 'solid', color: x.solid }] };
    return x;
  }

  /* ---------- 定版参数（选定方案「涟漪原波」）----------
     origin     起波点（uv）：右下角略出屏，与登录页退场 .morph 同向
     travel     波列速度 / 波前速度 —— 关键物理量：1 表示涟漪跟着波前一起跑，
                0.85 是"波峰略慢于波前"（真实水面就是这个关系，越小涟漪越像拖尾）
     waveCount  源到最远角的波峰个数；ringCount 同心涟漪环的环数
     amp        波列把波前扭曲的幅度；decay 涟漪随距离的衰减（耗散）
     soft       染色边界柔和度（会随距离继续变糊 = 频散）
     warp       有机扰动强度（湖面不是完美几何）
     crest      波峰亮线强度（水波折射的亮边）
     refract    波面折射位移（像透过水波看背景）
     span/bias  波前跨度/起始偏移（>1、>0 保证 p=1 全覆盖、p=0 完全静止）
  ---------------------------------------------------- */
  var PRESET = {
    origin: [1.02, 1.02],
    waveCount: 7, ringCount: 11, travel: 0.85,
    amp: 0.042, decay: 1.05, soft: 0.038,
    warp: 0.016, warpScale: 1.6, warpDrift: 0.16,
    crest: 0.070, crestW: 0.030, ring: 0.042, refract: 0.0045, shimmer: 0.020,
    span: 1.16, bias: 0.075, dither: 0.9,
    duration: 1500,                       // once 模式的扩散时长
    /* loop3 模式的时间轴：扩散 → 停留 → 涟漪回落 → 静息（每组都回到起始基座再起下一组） */
    inDur: 1550, hold: 1100, outDur: 1350, gap: 800, easeIn: 'out', easeOut: 'out'
  };

  /* ---------- 缓动 ---------- */
  var EASE = {
    linear: function (x) { return x; },
    out: function (x) { return 1 - Math.pow(1 - x, 3); },   // 起手快、尾段收敛（像涟漪失去能量）
    inout: function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  };

  /* ============================ 背景烘焙（2D canvas → 纹理位图）============================ */
  /* 长度解析：'44vw'→视口宽 44%，'92vh'→视口高 92%，'60%'→宿主盒百分比 */
  function len(spec, host, view, axis) {
    var s = String(spec);
    if (s.slice(-2) === 'vw') return parseFloat(s) / 100 * view.w;
    if (s.slice(-2) === 'vh') return parseFloat(s) / 100 * view.h;
    if (s.slice(-1) === '%') return parseFloat(s) / 100 * (axis === 'x' ? host.w : host.h);
    return parseFloat(s);
  }

  function blank(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    return c;
  }

  /* 椭圆径向渐变：canvas 的 createRadialGradient 只支持正圆，用 scale 变换拉成椭圆 */
  function paintEllipse(ctx, cx, cy, rx, ry, stops) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(rx, 1e-3), Math.max(ry, 1e-3));
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    ctx.fillStyle = g;
    ctx.fillRect(-1e6, -1e6, 2e6, 2e6);
    ctx.restore();
  }

  function drawStack(ctx, layers, view, host) {
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (L.kind === 'solid') {
        ctx.fillStyle = L.color;
        ctx.fillRect(0, 0, host.w, host.h);
      } else if (L.kind === 'linear') {
        // CSS 角度：0deg=向上，顺时针（canvas 的 y 轴向下，所以取 -cos）
        var a = L.angle * Math.PI / 180;
        var dx = Math.sin(a), dy = -Math.cos(a);
        var lineLen = Math.abs(host.w * Math.sin(a)) + Math.abs(host.h * Math.cos(a));
        var g = ctx.createLinearGradient(host.w / 2 - dx * lineLen / 2, host.h / 2 - dy * lineLen / 2,
                                         host.w / 2 + dx * lineLen / 2, host.h / 2 + dy * lineLen / 2);
        for (var s = 0; s < L.stops.length; s++) g.addColorStop(L.stops[s][0], L.stops[s][1]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, host.w, host.h);
      } else if (L.kind === 'radial') {
        paintEllipse(ctx,
          len(L.at[0], host, view, 'x'), len(L.at[1], host, view, 'y'),
          len(L.r[0], host, view, 'x'), len(L.r[1], host, view, 'y'), L.stops);
      } else if (L.kind === 'blobs') {
        // 等价 .bg-decor::before：inset:-22% 的盒子 + filter: blur(72px)
        // 注意 inset 为负值表示盒子向外扩张，所以盒子左上角在 (ins*W, ins*H)（负坐标）；
        // 光斑位置/半径按「扩张后的盒子」计算（vw/vh 仍是绝对视口单位），再整体偏移到宿主。
        var ins = L.inset || 0;
        var blur = (L.blur || 0) * view.scale;
        var pad = blur * 2;
        var bw = view.w * (1 - 2 * ins), bh = view.h * (1 - 2 * ins);
        var b = blank(bw + pad * 2, bh + pad * 2);
        var bc = b.getContext('2d');
        bc.translate(pad, pad);                       // 之后以「扩张后盒子」的左上角为原点
        drawStack(bc, L.items, view, { w: bw, h: bh });
        ctx.save();
        ctx.filter = 'blur(' + blur + 'px)';
        ctx.drawImage(b, ins * view.w - pad, ins * view.h - pad);
        ctx.restore();
      } else {
        throw new Error('未知层类型 ' + L.kind);
      }
    }
  }

  /* 长边压到 longSide 再烘：纯平滑渐变，等比缩小后模糊半径同比缩小，观感完全一致 */
  function bakeBackground(spec, W, H, longSide) {
    var scale = Math.min(1, longSide / Math.max(W, H));
    var c = blank(W * scale, H * scale);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    var view = { w: c.width, h: c.height, scale: scale };
    drawStack(ctx, spec.layers, view, view);
    return c;
  }

  /* ============================ 顶点 / 片元着色器 ============================ */
  /* 全屏三角形；uv 约定 (0,0)=左上（与 CSS 一致），所以 y 要翻转 */
  var VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){
  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  var FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexA;      // 起始背景
uniform sampler2D uTexB;      // 目标背景
uniform vec2  uOrigin;        // 涟漪源（uv）
uniform float uAspect;        // 宽高比
uniform float uRMax;          // 涟漪源到最远角的距离（高度单位）
uniform float uTime;          // 秒
uniform float uP;             // 过渡进度 0..1
uniform float uMix;           // 目标背景强度
uniform float uWaveCount;     // 波峰个数（源 → 最远角）
uniform float uWaveRate;      // 波列在 field 上的行进速度（field/秒），与波前同源
uniform float uRingCount;     // 同心涟漪环环数
uniform float uAmp;           // 波列扭曲波前的幅度
uniform float uDecay;         // 涟漪随距离的耗散
uniform float uSoft;          // 染色边界柔和度（基准值，随距离变糊）
uniform float uWarp;          // 有机扰动强度
uniform float uWarpScale;     // 有机扰动尺度
uniform float uWarpDrift;     // 有机扰动漂移速度
uniform float uCrest;         // 波峰亮线强度
uniform float uCrestW;        // 波峰亮线宽度（基准值，随距离变宽）
uniform float uRing;          // 同心涟漪环强度
uniform float uRefract;       // 波面折射位移
uniform float uSpan;          // 波前推进跨度（>1 保证 p=1 全覆盖）
uniform float uBias;          // 波前起始偏移（>0 保证 p=0 完全静止）
uniform float uShimmer;       // 水面微光起伏
uniform float uDither;        // 抖动（消除 8bit 渐变的色带）

float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, amp = 0.5;
  for (int i = 0; i < 3; i++) { s += amp * vnoise(p); p *= 2.03; amp *= 0.5; }
  return s;
}

void main(){
  vec2 uv = vUv;
  vec2 q = (uv - uOrigin) * vec2(uAspect, 1.0);
  float field = length(q) / max(uRMax, 1e-4);        // 0 = 涟漪源，1 = 最远角

  // 有机扰动：低频大尺度（湖面起伏）+ 高频小尺度（细碎波褶）
  vec2 qw = (uv - 0.5) * vec2(uAspect, 1.0);
  float warp  = (fbm(qw * uWarpScale + vec2(uTime * uWarpDrift, -uTime * uWarpDrift * 0.63)) - 0.5) * 2.0 * uWarp;
  float warp2 = (vnoise(qw * uWarpScale * 3.1 - vec2(uTime * uWarpDrift * 1.7)) - 0.5) * 2.0 * uWarp * 0.35;

  // 涟漪包络：起落两端为 0（起手干净、落定干净），中段最强；指数 <1 让"落水"那一下更利落
  float env = pow(sin(3.14159265 * clamp(uP, 0.0, 1.0)), 0.85);

  // 频散：越往外波前越糊、波峰线越宽 —— 远处的高频先被水吃掉
  float atten  = exp(-field * uDecay);
  float soft   = uSoft * (1.0 + field * 0.55);
  float crestW = uCrestW * (1.0 + field * 0.9);

  // 波列：与波前同源同速（uWaveRate 是 field 上的行进速度），双频叠加避免死板
  float ph = (field - uTime * uWaveRate) * uWaveCount * 6.28318;
  float ripple = (sin(ph) * 0.62 + sin(ph * 1.87 + 1.9) * 0.38) * uAmp * atten * env;

  float front = uP * uSpan - uBias;
  float d = front - (field + ripple + warp + warp2);
  float m = smoothstep(-soft, soft, d);

  // 波峰亮线：水波折射的亮边（近处细亮、远处宽淡）
  float crest = exp(-abs(d) / max(crestW, 1e-4)) * env * uCrest;

  // 同心涟漪环：跟在波前之后的一组明暗带（波前跑过后水面才慢慢平下来）
  // 相位同样吃扰动、再用一层斑驳调制打散，避免出现等高线般的规则同心圆
  float behind = front - field;
  float ringGate = exp(-max(behind, 0.0) * 2.6) * smoothstep(0.0, 0.05, behind) * env * exp(-field * 0.35);
  float ringPatch = 0.55 + 0.75 * vnoise(qw * 3.4 + vec2(uTime * 0.05, -uTime * 0.04));
  float ringK = ringGate * ringPatch
              * sin((field + warp * 0.85 + warp2 - uTime * uWaveRate) * uRingCount * 6.28318);

  // 波面折射：沿波前法线做极微位移，像透过水波看背景
  vec2 uvR = uv + normalize(q + 1e-5) * (cos(ph) * atten * env * uRefract);

  vec3 ca = texture2D(uTexA, clamp(uvR, 0.0, 1.0)).rgb;
  vec3 cb = texture2D(uTexB, clamp(uvR, 0.0, 1.0)).rgb;
  vec3 col = mix(ca, mix(ca, cb, uMix), m);

  col += crest;                                // 波峰亮线
  col *= 1.0 + uRing * ringK;                  // 同心涟漪环的明暗
  col *= 1.0 + uShimmer * env * (fbm(qw * 2.4 + vec2(uTime * 0.09, uTime * 0.06)) - 0.5) * 2.0;

  col += (hash21(gl_FragCoord.xy) - 0.5) * (uDither / 255.0);   // 静态抖动消色带（不含时间项 → 落定后画面完全静止）
  gl_FragColor = vec4(col, 1.0);
}
`;

  /* ============================ 时间轴 ============================ */
  function makeTimeline(mode, v, fromSpec, targetSpecs) {
    var segs = [], t = 0;
    function push(seg) { seg.t0 = t; seg.t1 = t + seg.dur; segs.push(seg); t += seg.dur; }
    if (mode === 'once') {
      /* 落场：从起始背景扩散到目标背景，落定后一直停在那里（等宿主收掉这一层） */
      push({ type: 'in', from: fromSpec.id, to: targetSpecs[0].id, dur: v.duration, ease: 'out' });
      push({ type: 'hold', from: targetSpecs[0].id, to: targetSpecs[0].id, dur: 1e9, p: 1 });
    } else {
      /* 参考用法：每次都从起始基座出发，涟漪回落一次再起下一组 */
      for (var i = 0; i < targetSpecs.length; i++) {
        push({ type: 'in', from: fromSpec.id, to: targetSpecs[i].id, dur: v.inDur, ease: v.easeIn });
        push({ type: 'hold', from: targetSpecs[i].id, to: targetSpecs[i].id, dur: v.hold, p: 1 });
        push({ type: 'out', from: targetSpecs[i].id, to: fromSpec.id, dur: v.outDur, ease: v.easeOut });
        push({ type: 'gap', from: fromSpec.id, to: fromSpec.id, dur: v.gap, p: 0 });
      }
    }
    return { segs: segs, total: t, mode: mode };
  }

  function sampleTimeline(tl, ms) {
    var t = ms % tl.total; if (t < 0) t += tl.total;
    for (var i = 0; i < tl.segs.length; i++) {
      var s = tl.segs[i];
      if (t < s.t1 || i === tl.segs.length - 1) {
        var x = s.dur > 0 ? Math.min(1, Math.max(0, (t - s.t0) / s.dur)) : 1;
        var p = s.type === 'in' ? EASE[s.ease](x) : (s.type === 'out' ? 1 - EASE[s.ease](x) : s.p);
        return { seg: s, p: p, local: x, t: t, index: i };
      }
    }
  }

  function phaseLabel(seg, mode) {
    if (mode === 'once') return seg.type === 'hold' ? '已落定 · 主题画布' : '扩散 · 当前主题';
    if (seg.type === 'hold') return '停留 · ' + seg.to;
    if (seg.type === 'gap') return '静息 · 起始基座';
    if (seg.type === 'out') return '涟漪回落 · 起始基座';
    return '扩散 · ' + seg.to;
  }

  /* ============================ WebGL 引擎 ============================ */
  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader error');
    return sh;
  }

  function RippleBg(opts) {
    opts = opts || {};
    this.canvas = typeof opts.canvas === 'string' ? document.querySelector(opts.canvas) : opts.canvas;
    if (!this.canvas) throw new Error('RippleBg: 缺少 canvas');
    this.v = Object.assign({}, PRESET, opts.preset || {});
    this.mode = opts.mode === 'once' ? 'once' : 'loop3';
    this.fromSpec = resolveSpec(opts.from);
    if (this.mode === 'once') {
      this.targetSpecs = [resolveSpec(opts.to)];
    } else {
      this.targetSpecs = (opts.targets || ['soda', 'deep', 'warm']).map(resolveSpec);
    }
    this.specs = [this.fromSpec].concat(this.targetSpecs);
    this.mix = opts.intensity == null ? 1 : opts.intensity;
    this.longSide = opts.longSide || 768;            // 背景纹理长边
    this.maxPixels = opts.maxPixels || 2400000;      // 渲染面积上限（≈1920×1250，超出按比例降采样）
    this.maxDpr = opts.maxDpr || 1.25;
    this.onPhase = opts.onPhase || null;
    this.onDone = opts.onDone || null;
    /* 必须保留绘制缓冲（默认开）：宿主页面只要有一次重绘（控制台的数据更新、卡片动画、
       任何 DOM/样式变化），合成器就会拿这张画布重新合成；不保留缓冲时它已被消费清的
       内容会被当成"空"，画布只剩 CSS 兜底色 —— 表现就是「背景只在某些时刻/某些区域
       出现，其余像冻住或断层」。纯色兜底看起来"没问题"，所以静态页面上根本复现不出来。 */
    this.preserve = opts.preserve == null ? true : !!opts.preserve;
    this.tl = makeTimeline(this.mode, this.v, this.fromSpec, this.targetSpecs);
    this.elapsed = 0; this.playing = false; this.raf = 0; this.doneFired = false;
    this.lastTs = 0; this.started = false;   // 动画时钟：等页面能稳定出帧才开始按帧推进
    this.tex = {}; this.bakedAspect = 0;
    this.initWebGL();
    this.buildTextures();
    this.bindResize();
    this.render(true);                               // 先出一帧静止的起始背景（首帧不闪；构造期不回调 onPhase）
    if (opts.autoplay) this.play();
  }

  RippleBg.prototype.initWebGL = function () {
    var attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
                  preserveDrawingBuffer: !!this.preserve, powerPreference: 'low-power' };
    var gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('WebGL 不可用');
    this.gl = gl;
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.prog = prog;
    this.u = {};
    ['uTexA', 'uTexB', 'uOrigin', 'uAspect', 'uRMax', 'uTime', 'uP', 'uMix', 'uWaveCount', 'uWaveRate',
     'uRingCount', 'uAmp', 'uDecay', 'uSoft', 'uWarp', 'uWarpScale', 'uWarpDrift', 'uCrest', 'uCrestW',
     'uRing', 'uRefract', 'uSpan', 'uBias', 'uShimmer', 'uDither']
      .forEach(function (n) { this.u[n] = gl.getUniformLocation(prog, n); }, this);
    gl.uniform1i(this.u.uTexA, 0);
    gl.uniform1i(this.u.uTexB, 1);
  };

  RippleBg.prototype.makeTexture = function (bitmap) {
    var gl = this.gl;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 不翻转上传：位图第一行落在 t=0，配合顶点着色器里的 y 翻转即 uv(0,0)=左上
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };

  /* 视口尺寸同步：画布像素尺寸跟着走，但**背景纹理只在宽高比实质变化时**才重烘。
     理由：滚动条出现/消失会改动 ~0.4% 的宽度，重烘会让正在播的涟漪背景换一张纹理；
     而纯缩放的渐变是等比的，比例没变就没必要重烘 —— 既省一次烘焙，也避免中途「断层」。 */
  RippleBg.prototype.buildTextures = function () {
    var rect = this.canvas.getBoundingClientRect();
    var W = Math.max(2, Math.round(rect.width || global.innerWidth || 2));
    var H = Math.max(2, Math.round(rect.height || global.innerHeight || 2));
    this.cssW = W; this.cssH = H;
    var aspect = W / H;
    var needBake = !this.bakedAspect || Math.abs(aspect - this.bakedAspect) / this.bakedAspect > 0.02;
    if (needBake) {
      var gl = this.gl, self = this, next = {};
      this.specs.forEach(function (spec) {
        var old = self.tex[spec.id];
        if (old) gl.deleteTexture(old);
        next[spec.id] = self.makeTexture(bakeBackground(spec, W, H, self.longSide));
      });
      this.tex = next;
      this.bakedAspect = aspect;
    }
    this.applySize();
  };

  RippleBg.prototype.applySize = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, this.maxDpr);
    // 面积封顶：4K/超宽屏不再按 1:1 渲染（纯平滑背景，降采样不可感知）
    var area = this.cssW * this.cssH * dpr * dpr;
    if (area > this.maxPixels) dpr *= Math.sqrt(this.maxPixels / area);
    var w = Math.max(2, Math.round(this.cssW * dpr));
    var h = Math.max(2, Math.round(this.cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
    var aspect = this.cssW / this.cssH;
    this.aspect = aspect;
    var o = this.v.origin, corners = [[0, 0], [1, 0], [0, 1], [1, 1]], m = 0;
    for (var i = 0; i < corners.length; i++) {
      var dx = (corners[i][0] - o[0]) * aspect, dy = corners[i][1] - o[1];
      m = Math.max(m, Math.sqrt(dx * dx + dy * dy));
    }
    this.rmax = m;
    // 波列速度 = 波前速度 × travel（波前速度 = span / 扩散时长），量纲：field/秒
    var dur = this.mode === 'once' ? this.v.duration : this.v.inDur;
    this.waveRate = (this.v.span / (dur / 1000)) * this.v.travel;
  };

  RippleBg.prototype.bindResize = function () {
    var self = this, pending = 0;
    this.onWinResize = function () {
      clearTimeout(pending);
      pending = setTimeout(function () { self.buildTextures(); self.render(); }, 160);
    };
    if (global.ResizeObserver) { this.ro = new ResizeObserver(this.onWinResize); this.ro.observe(this.canvas); }
    global.addEventListener('resize', this.onWinResize);
  };

  /* 运行时微调（改完立即生效；改到 span/duration 会连带重算波列速度） */
  RippleBg.prototype.configure = function (patch) {
    Object.assign(this.v, patch);
    if (patch.duration || patch.inDur || patch.span || patch.travel) this.applySize();
    return this.render();
  };
  RippleBg.prototype.setIntensity = function (x) { this.mix = x; return this.render(); };

  /* ── 单帧渲染：把时间轴上某一时刻的状态画出来（silent=true 时不回调 onPhase）── */
  RippleBg.prototype.render = function (silent) {
    var gl = this.gl, v = this.v;
    var st = sampleTimeline(this.tl, this.elapsed);
    var seg = st.seg;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[seg.from] || this.tex[this.fromSpec.id]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex[seg.to] || this.tex[this.fromSpec.id]);
    var u = this.u;
    gl.uniform2f(u.uOrigin, v.origin[0], v.origin[1]);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uRMax, this.rmax);
    gl.uniform1f(u.uTime, this.elapsed / 1000);
    gl.uniform1f(u.uP, st.p);
    gl.uniform1f(u.uMix, this.mix);
    gl.uniform1f(u.uWaveCount, v.waveCount);
    gl.uniform1f(u.uWaveRate, this.waveRate);
    gl.uniform1f(u.uRingCount, v.ringCount);
    gl.uniform1f(u.uAmp, v.amp);
    gl.uniform1f(u.uDecay, v.decay);
    gl.uniform1f(u.uSoft, v.soft);
    gl.uniform1f(u.uWarp, v.warp);
    gl.uniform1f(u.uWarpScale, v.warpScale);
    gl.uniform1f(u.uWarpDrift, v.warpDrift);
    gl.uniform1f(u.uCrest, v.crest);
    gl.uniform1f(u.uCrestW, v.crestW);
    gl.uniform1f(u.uRing, v.ring);
    gl.uniform1f(u.uRefract, v.refract);
    gl.uniform1f(u.uSpan, v.span);
    gl.uniform1f(u.uBias, v.bias);
    gl.uniform1f(u.uShimmer, v.shimmer);
    gl.uniform1f(u.uDither, v.dither);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.phase = {
      type: seg.type, from: seg.from, to: seg.to, p: st.p, t: st.t, total: this.tl.total,
      index: st.index, label: phaseLabel(seg, this.mode)
    };
    if (this.onPhase && !silent) this.onPhase(this.phase);
    return this.phase;
  };

  RippleBg.prototype.tick = function (ts) {
    if (!this.playing) return;
    var self = this;
    if (!this.lastTs) {                  // 第一帧只做时间基准
      this.lastTs = ts;
      this.raf = global.requestAnimationFrame(function (t) { self.tick(t); });
      return;
    }
    var dt = ts - this.lastTs;
    this.lastTs = ts;
    /* 起帧门：页面还在忙（首屏建 DOM / 发请求）时先不出动画。
       连续两帧间隔正常（<40ms）才说明页面在稳定出帧，从这一刻起算 ——
       等待期间画布停在起始背景（与上一页同色），看不出异常。 */
    if (!this.started) {
      if (dt < 40) { this.started = true; }
      else { this.raf = global.requestAnimationFrame(function (t) { self.tick(t); }); return; }
    }
    /* 动画期间出现长卡顿（>250ms）：这一帧本来就没渲染出来，硬撑着播只会让波前
       「冻在半途、上方半天不动」。这里**不补渲染到落定态**（那会造成 0.7→1 的跳），
       直接交还给宿主 —— 宿主会把这一层淡出（300ms 交叉溶解到主题画布），全程无硬切。 */
    if (dt > 250 && this.mode === 'once' && !this.doneFired) {
      this.doneFired = true;
      this.pause();
      if (this.onDone) this.onDone(this.phase);
      return;
    }
    this.elapsed += dt;                  // 按真实帧间隔推进：不加速、也不被拉长
    if (this.mode === 'once' && !this.doneFired && this.elapsed >= this.v.duration) {
      this.doneFired = true;
      this.elapsed = this.v.duration;
      this.render();
      this.pause();
      if (this.onDone) this.onDone(this.phase);
      return;
    }
    this.render();
    this.raf = global.requestAnimationFrame(function (t) { self.tick(t); });
  };

  RippleBg.prototype.play = function () {
    if (this.playing) return;
    if (this.mode === 'once' && this.doneFired) return;
    this.playing = true;
    this.lastTs = 0;
    this.started = false;
    var self = this;
    this.raf = global.requestAnimationFrame(function (t) { self.tick(t); });
  };
  RippleBg.prototype.pause = function () {
    this.playing = false;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.raf = 0; this.lastTs = 0; this.started = false;
  };
  RippleBg.prototype.setTime = function (ms) {
    this.elapsed = ms; this.lastTs = 0; this.started = false;
    return this.render();
  };
  RippleBg.prototype.replay = function () { this.elapsed = 0; this.doneFired = false; this.play(); return 0; };
  RippleBg.prototype.start = function () { this.play(); };
  /* 跳到某个目标背景的过渡中段（frac=0.5 即扩散到一半），便于定格观察 */
  RippleBg.prototype.jumpTo = function (name, frac) {
    var f = frac == null ? 0.5 : frac;
    for (var i = 0; i < this.tl.segs.length; i++) {
      var s = this.tl.segs[i];
      if (s.type === 'in' && (s.to === name || this.tl.mode === 'once')) return this.setTime(s.t0 + s.dur * f);
    }
    return this.render();
  };
  RippleBg.prototype.destroy = function () {
    this.pause();
    if (this.ro) this.ro.disconnect();
    global.removeEventListener('resize', this.onWinResize);
  };

  /* ============================ 导出 ============================ */
  global.RippleBg = RippleBg;
  global.RippleBg.PRESET = PRESET;
  global.RippleBg.BG_SPECS = BG_SPECS;
  global.RippleBg.THEME_MAP = THEME_MAP;
  global.RippleBg.EASE = EASE;
})(typeof window !== 'undefined' ? window : this);
