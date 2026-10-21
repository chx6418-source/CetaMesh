#!/usr/bin/env node
/**
 * 鲸桥控制台 · UI Demo 构建脚本（已选型：海盐苏打 软糖拟物 × 糖果玻璃融合）
 * 用法: node design-demos/src/build.mjs
 * 产物: design-demos/fusion-4-soda.html + index.html
 * 未选中的方案已归档至 design-demos/archive/（git 忽略，不入库）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const OUT = resolve(SRC, '..');
const T = (p) => readFileSync(join(SRC, p), 'utf8');

const template = T('template.html');
const dataJs = T('data.js');
const appJs = T('app.js');

const DEMOS = [
  {
    id: 'F4', slug: 'soda', name: '海盐苏打', en: 'Soda Gummy',
    ratio: '苏打蓝 4 · 薰衣草 3 · 冰薄荷 3',
    desc: '已选型落地方案：苏打蓝气泡感 + 薰衣草柔紫 + 冰薄荷收口，软糖质感 × 糖果玻璃。',
    themes: [
      { id: 'light', label: '苏打', sw: '#5b7cfa' },
      { id: 'dark', label: '深海', sw: '#8ba4ff' },
      { id: 'warm', label: '护眼', sw: '#6a7fae' }
    ],
    preview: ['#d5e3ff', '#5b7cfa'], defaultTheme: 'light',
    file: 'fusion-4-soda.html',
    layout: 'layout-sidebar', palette: false,
    css: ['fusion-base.css', 'fusion-soda.css']
  }
];

function fill(str, map) {
  let out = str;
  for (const [k, v] of Object.entries(map)) out = out.split('{{' + k + '}}').join(v);
  if (out.includes('{{')) throw new Error('存在未替换占位符: ' + out.match(/\{\{\w+\}\}/g));
  return out;
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) {
  if (/^(demo-\d\d-.*\.html|index\.html)$/.test(f)) unlinkSync(join(OUT, f));
}

for (const d of DEMOS) {
  const cfg = 'window.DEMO_CONFIG = ' + JSON.stringify({ demoId: d.id, themes: d.themes, palette: !!d.palette }) + ';\n';
  const html = fill(template, {
    DEFAULT_THEME: d.defaultTheme,
    TITLE: d.name + ' ' + d.en,
    DEMO_ID: d.id,
    STYLE_NAME: d.name + ' · ' + d.en,
    BODY_CLASS: d.layout,
    CSS: d.css.map((f) => T(join('css', f))).join('\n\n'),
    DATA: cfg + '\n' + dataJs,
    APP: appJs
  });
  writeFileSync(join(OUT, d.file), html, 'utf8');
  console.log('  ✓ ' + d.file);
}

const d = DEMOS[0];
const indexHtml = `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲸桥控制台 · 已选型方案预览</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #333d5c;
    font-family: "Segoe UI", system-ui, "Microsoft YaHei", sans-serif;
    background: linear-gradient(130deg, #d5e3ff, #ded7ff 50%, #ccf1ef); background-attachment: fixed; }
  .box { text-align: center; background: rgba(255,255,255,.6); border: 1px solid rgba(255,255,255,.9);
    border-radius: 26px; padding: 40px 52px; box-shadow: 16px 18px 42px rgba(135,150,215,.35), -10px -13px 32px rgba(255,255,255,.95); backdrop-filter: blur(18px) saturate(1.4); }
  h1 { margin: 0 0 8px; font-size: 24px; }
  p { color: #5a6482; margin: 0 0 20px; font-size: 13px; }
  a { display: inline-block; text-decoration: none; color: #fff; font-weight: 600; padding: 11px 26px; border-radius: 16px;
    background: linear-gradient(140deg, #5b7cfa, #7cc7f2); box-shadow: 6px 8px 18px rgba(110,130,230,.45); }
</style>
</head>
<body>
  <div class="box">
    <h1>海盐苏打 · Soda Gummy</h1>
    <p>已选型落地方案预览（${d.ratio}）<br>正式控制台：<code>http://127.0.0.1:3100</code> · 未选中方案见 <code>archive/</code>（不入库）</p>
    <a href="fusion-4-soda.html">打开交互预览（Mock 数据）</a>
  </div>
</body>
</html>
`;
writeFileSync(join(OUT, 'index.html'), indexHtml, 'utf8');
console.log('  ✓ index.html');
console.log('\n构建完成 → ' + OUT);
