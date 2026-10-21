// gen-pinyin-table.mjs — 从 pinyin-data 包生成内嵌拼音表 src/pinyin-data.js
//
// 一次性构建步骤（生成后运行时不依赖任何 npm 包）：
//   1) npm pack pinyin-data --registry=https://registry.npmmirror.com/ 并解压到 scripts/.pinyin-tmp/
//   2) node scripts/gen-pinyin-table.mjs
// 产物：src/pinyin-data.js —— 字 → 无音调拼音变体数组（首字母小写，ü 写作 v）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const DATA_FILE = path.join(__dirname, '.pinyin-tmp', 'package', '全拼数据.js');
const OUT_FILE = path.join(ROOT, 'src', 'pinyin-data.js');

if (!fs.existsSync(DATA_FILE)) {
  console.error(`未找到拼音数据 ${DATA_FILE}；请先：npm pack pinyin-data 并解压到 scripts/.pinyin-tmp/`);
  process.exit(1);
}

const { 带音调拼音 } = require(DATA_FILE);

const TONE_MAP = {
  ā: 'a', á: 'a', ǎ: 'a', à: 'a', ǟ: 'a',
  ē: 'e', é: 'e', ě: 'e', è: 'e', ĕ: 'e',
  ī: 'i', í: 'i', ǐ: 'i', ì: 'i',
  ō: 'o', ó: 'o', ǒ: 'o', ò: 'o',
  ū: 'u', ú: 'u', ǔ: 'u', ù: 'u',
  ǖ: 'v', ǘ: 'v', ǚ: 'v', ǜ: 'v', ü: 'v', ǹ: 'n', ń: 'n', ň: 'n', ḿ: 'm', ề: 'e', ế: 'e',
};

function stripTones(py) {
  return [...String(py).toLowerCase()].map((c) => TONE_MAP[c] ?? c).join('');
}

const table = {};
for (const [ch, variants] of Object.entries(带音调拼音)) {
  if (ch.length !== 1) continue;
  const list = String(variants).split(',').map((v) => stripTones(v.trim())).filter(Boolean);
  if (list.length > 0) table[ch] = [...new Set(list)];
}

const keys = Object.keys(table).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
const lines = keys.map((ch) => {
  const py = table[ch].map((v) => JSON.stringify(v)).join(',');
  return `  ${JSON.stringify(ch)}:[${py}]`;
});

const out = `// 内嵌拼音表（自动生成，勿手改）：scripts/gen-pinyin-table.mjs，来源 pinyin-data@1.0.0。
// 字 → 无音调拼音变体数组（小写，ü 写作 v，保留多音字全部读音）。
export const PINYIN = Object.freeze({
${lines.join(',\n')}
});
`;
fs.writeFileSync(OUT_FILE, out, 'utf8');
console.log(`written ${OUT_FILE} (${keys.length} chars, ${(out.length / 1024).toFixed(0)} KB)`);
