// B站视频搜索 / 热门推荐 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 数据源锁定 B 站官方公开接口（免登录）：
//   - bili_search_video(query, limit?, page?)  视频搜索（search_type=video）
//   - bili_hot_videos(limit?)                  热门视频推荐
// 每条结果都带：标题 title、简介 description、原链接 url（https://www.bilibili.com/video/{bvid}）。
// 返回固定结构 {statusCode, message, ...}：0=成功；429=触发 B 站风控/限流；500=请求失败。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import { APP_PATHS } from './app-paths.js';
import { isMainModule, reportEntrypointError } from './entrypoint.js';

const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type';
const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular';
const TIMEOUT_MS = 20000;

// 工具总开关：socialV2.tools.bilibili（桥接控制台 12e 面板 / 07 工具开关），false 时返回 403。
function loadConfig() {
  try {
    let text = fs.readFileSync(APP_PATHS.configFile, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch { return {}; }
}
function bilibiliDisabled(cfg) {
  return (cfg.socialV2?.tools ?? {}).bilibili === false;
}

// ── 进程级匿名访客指纹（buvid 等 cookie），降低无登录态请求被风控的概率 ──
let buvidCookie = '';
function randomHex(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}
function ensureCookie() {
  if (buvidCookie) return buvidCookie;
  const n = Math.floor(Date.now() / 1000);
  buvidCookie = 'buvid3=' + randomHex(36) + 'infoc; buvid4=' + randomHex(36) + 'infoc; b_nut=' + n + '; b_lsid=' + randomHex(8) + '_' + randomHex(8) + '; CURRENT_FNVAL=4048';
  return buvidCookie;
}

// ── 展示格式化 ──
function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
function normalizeDesc(s) {
  const d = String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return d && d !== '-' ? d : '';
}
function httpsCover(pic) {
  const p = String(pic ?? '').trim();
  if (!p) return null;
  if (p.startsWith('//')) return 'https:' + p;
  if (p.startsWith('http://') || p.startsWith('https://')) return p;
  return 'https:' + p;
}
function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v >= 100000000) return (Math.round((v / 100000000) * 10) / 10) + '亿';
  if (v >= 10000) return (Math.round((v / 10000) * 10) / 10) + '万';
  return v;
}
function fmtDate(unix) {
  const t = Number(unix);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function parseDuration(raw) {
  // search 接口 duration 形如 "222:28" / "3:22:28"；popular 为秒数
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? '');
  const parts = s.split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ── B 站 API 请求（带 UA/referer/cookie；识别风控 HTML 响应） ──
async function biliGet(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': BILI_UA,
      referer: 'https://search.bilibili.com/',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      cookie: ensureCookie(),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!json || typeof json !== 'object' || json.code === undefined) {
    // 命中 B 站风控时返回 HTML 而非 JSON
    const err = new Error('B 站返回非 JSON（可能触发风控/限流），请稍后重试');
    err.code = 'RISK';
    throw err;
  }
  if (json.code !== 0) {
    const err = new Error('B 站接口错误 code=' + json.code + ' ' + String(json.message ?? ''));
    err.code = json.code === -412 ? 'RISK' : 'API';
    throw err;
  }
  return json;
}

function toSearchItem(it) {
  const title = stripTags(it.title) || '';
  const desc = normalizeDesc(it.description || it.desc || '');
  const bvid = String(it.bvid ?? '');
  return {
    title,
    description: desc.slice(0, 200),
    url: 'https://www.bilibili.com/video/' + bvid,
    bvid,
    author: stripTags(it.author) || null,
    typeName: String(it.typename ?? ''),
    duration: String(it.duration ?? ''),
    durationSec: parseDuration(it.duration),
    playCount: Number(it.play) || 0,
    playCountText: fmtCount(it.play),
    danmaku: Number(it.danmaku) || 0,
    pubDate: fmtDate(it.pubdate),
    coverUrl: httpsCover(it.pic),
  };
}

function toPopularItem(it) {
  const title = stripTags(it.title) || '';
  const desc = normalizeDesc(it.desc || it.description || '');
  const bvid = String(it.bvid ?? '');
  const stat = it.stat ?? {};
  return {
    title,
    description: desc.slice(0, 200),
    url: 'https://www.bilibili.com/video/' + bvid,
    bvid,
    author: String(it.owner?.name ?? ''),
    typeName: String(it.tname ?? ''),
    duration: '',
    durationSec: Number(it.duration) || 0,
    playCount: Number(stat.view) || 0,
    playCountText: fmtCount(stat.view),
    danmaku: Number(stat.danmaku) || 0,
    pubDate: fmtDate(it.pubdate),
    coverUrl: httpsCover(it.pic),
  };
}

// 供测试/导出：视频搜索
export async function searchVideos(keyword, page, pageSize) {
  const u = new URL(SEARCH_URL);
  u.searchParams.set('search_type', 'video');
  u.searchParams.set('keyword', String(keyword ?? ''));
  u.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  const ps = Math.max(1, Math.min(20, Number(pageSize) || 10));
  u.searchParams.set('page_size', String(ps));
  const json = await biliGet(u.toString());
  const list = (json?.data?.result ?? []).filter(function (it) { return it && it.type === 'video'; });
  return list.map(toSearchItem);
}

// 供测试/导出：热门视频
export async function hotVideos(ps, pn) {
  const u = new URL(POPULAR_URL);
  u.searchParams.set('ps', String(Math.max(1, Math.min(20, Number(ps) || 10))));
  u.searchParams.set('pn', String(Math.max(1, Number(pn) || 1)));
  const json = await biliGet(u.toString());
  const list = json?.data?.list ?? [];
  return list.map(toPopularItem);
}

const server = new McpServer({ name: 'bilibili', version: '0.1.0' });

server.tool(
  'bili_search_video',
  'B站视频搜索（数据源 B 站官方搜索接口，免登录）。按关键词搜索视频，返回结构化列表 [{title 标题, description 简介, url 原链接, bvid, author 作者, duration 时长, playCount 播放, coverUrl 封面}]。Agent 可直接把 title/description/url 组织成推荐文案发给用户。入参 query（必填，关键词）与 limit（可选，默认 5，最大 10）、page（可选，默认 1）。',
  {
    query: z.string().describe('搜索关键词：视频标题/主题/UP主/事件，如「周杰伦 演唱会」「科普 黑洞」「蔡徐坤」'),
    limit: z.number().int().min(1).max(10).optional().describe('最多返回条数，默认 5'),
    page: z.number().int().min(1).max(50).optional().describe('页码，默认 1')
  },
  async ({ query, limit, page }) => {
    const cfg = loadConfig();
    if (bilibiliDisabled(cfg)) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「B站视频工具」开关', source: 'bilibili' }) }], isError: true };
    }
    const q = String(query ?? '').trim();
    if (!q) return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 400, message: 'query 为空', source: 'bilibili' }) }], isError: true };
    const max = Math.max(1, Math.min(10, Number(limit) || 5));
    try {
      const results = await searchVideos(q, page, max);
      const withIdx = results.map(function (it, i) { return { index: i + 1, ...it }; });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          statusCode: 0,
          message: 'B站搜索到 ' + results.length + ' 个视频',
          query: q,
          source: 'bilibili',
          total: results.length,
          results: withIdx
        }, null, 2) }]
      };
    } catch (error) {
      const code = error?.code === 'RISK' ? 429 : 500;
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: code, source: 'bilibili', message: 'B站搜索失败：' + (error?.message ?? error) }) }], isError: true };
    }
  }
);

server.tool(
  'bili_hot_videos',
  'B站热门视频推荐（数据源 B 站官方热门接口，免登录）。返回当前热门视频列表，每条含 {title 标题, description 简介, url 原链接, bvid, author 作者, duration 时长, playCount 播放, coverUrl 封面}，可直接组织成推荐文案。入参仅 limit（可选，默认 5，最大 10）。',
  {
    limit: z.number().int().min(1).max(10).optional().describe('最多返回条数，默认 5')
  },
  async ({ limit }) => {
    const cfg = loadConfig();
    if (bilibiliDisabled(cfg)) {
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: 403, message: '工具已禁用：请先在桥接控制台开启「B站视频工具」开关', source: 'bilibili' }) }], isError: true };
    }
    const max = Math.max(1, Math.min(10, Number(limit) || 5));
    try {
      const results = await hotVideos(max, 1);
      const withIdx = results.map(function (it, i) { return { index: i + 1, ...it }; });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          statusCode: 0,
          message: 'B站热门视频 ' + results.length + ' 条',
          source: 'bilibili',
          total: results.length,
          results: withIdx
        }, null, 2) }]
      };
    } catch (error) {
      const code = error?.code === 'RISK' ? 429 : 500;
      return { content: [{ type: 'text', text: JSON.stringify({ statusCode: code, source: 'bilibili', message: 'B站热门获取失败：' + (error?.message ?? error) }) }], isError: true };
    }
  }
);

export async function runMcpBilibili(transport = new StdioServerTransport()) {
  await server.connect(transport);
  return server;
}

if (isMainModule(import.meta.url)) {
  runMcpBilibili().catch((error) => reportEntrypointError('mcp-bilibili', error));
}
