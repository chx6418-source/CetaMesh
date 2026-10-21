// CetaMesh Desktop —— 更新公告（产品化任务 D，第二节）。
//
// 更新公告来自**远程清单**（releases/stable.json → update checker 验签后的 manifest），
// 所以它是不可信输入。展示层绝不允许把它当 HTML 注入，这里的处理是：
//   1) 先删 <script>/<style> 整块，再删所有标签；
//   2) 非 http(s) 的 Markdown 链接目标直接丢弃（javascript:/data:/vbscript: 等）；
//   3) 走既有 mdToPlain 转纯文本（标题/粗体/列表/表格糖衣去掉，保留可读文本）；
//   4) 残存的 < > 字符转成实体字面量，保证任何"顺手 innerHTML"都不会构成标签；
//   5) 控制字符删除、长度有界。
//
// 输出契约：notes 数组里每一项都是 **plain text**，且 format='plain-text'；
// UI 只做文本渲染，不做 HTML 解释。

import { mdToPlain } from '../md-to-plain.js';

export const RELEASE_TITLE_MAX = 120;
export const RELEASE_NOTE_MAX = 800;
export const RELEASE_NOTES_MAX_ITEMS = 50;
export const RELEASE_TEXT_MAX = 8000;

/** 去掉控制字符（保留换行与制表符），避免把终端控制序列带进 UI。 */
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function stripHtmlBlocks(value) {
  const text = String(value ?? '');
  // script/style 连内容一起删：只删标签会留下脚本正文。
  const withoutBlocks = text
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  // 残存的尖括号转成实体字面量：纯文本里永远不再出现可构成标签的 < >。
  return withoutBlocks.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 丢弃非 http(s) 的 Markdown 链接目标（javascript:/data:/file: ...）。 */
function dropUnsafeLinkTargets(value) {
  return String(value ?? '').replace(/\]\(\s*(?![hH][tT][tT][pP][sS]?:)[^)]*\)/g, ']');
}

/** 把任意远程文本安全渲染成纯文本（供 UI 直接显示）。 */
export function plainTextFromMarkdown(value, max = RELEASE_NOTE_MAX) {
  const preprocessed = dropUnsafeLinkTargets(stripHtmlBlocks(value));
  const plain = mdToPlain(preprocessed);
  return stripControlChars(plain).trim().slice(0, max);
}

/**
 * 归一化 manifest 里的 notes 字段。
 * 兼容三种发布习惯：字符串数组（既有格式）、单个字符串、带 {title, text} 的对象数组。
 * 任何无法安全解析的条目被丢弃，而不是原样透传。
 */
export function sanitizeReleaseNotes(notes) {
  const list = Array.isArray(notes) ? notes : (typeof notes === 'string' && notes.trim() ? [notes] : []);
  const out = [];
  for (const item of list.slice(0, RELEASE_NOTES_MAX_ITEMS)) {
    let raw = null;
    if (typeof item === 'string') raw = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) raw = item.text ?? item.note ?? item.body ?? null;
    if (typeof raw !== 'string') continue;
    const safe = plainTextFromMarkdown(raw);
    if (safe) out.push(safe);
  }
  return out;
}

/**
 * 组装「一条更新公告」：version / title / publishedAt / notes（已安全渲染）。
 * title 缺失时**不编造**：返回 null，由 UI 决定回落到版本号当标题。
 */
export function buildReleaseAnnouncement({ version, title, publishedAt, notes, source = null } = {}) {
  const safeVersion = typeof version === 'string' && version.trim() ? version.trim().slice(0, 40) : null;
  const safeTitle = typeof title === 'string' && title.trim()
    ? plainTextFromMarkdown(title, RELEASE_TITLE_MAX)
    : null;
  const safePublishedAt = typeof publishedAt === 'string' && publishedAt.trim()
    ? publishedAt.trim().slice(0, 40)
    : null;
  const safeNotes = sanitizeReleaseNotes(notes);
  const text = [
    safeTitle || (safeVersion ? 'CetaMesh ' + safeVersion : ''),
    ...safeNotes.map((note) => '• ' + note)
  ].filter(Boolean).join('\n').slice(0, RELEASE_TEXT_MAX);

  return {
    format: 'plain-text',
    version: safeVersion,
    title: safeTitle,
    publishedAt: safePublishedAt,
    notes: safeNotes,
    text,
    source: typeof source === 'string' && source ? source.slice(0, 40) : null
  };
}
