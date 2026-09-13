// QQ 官方机器人卡片（Markdown 卡片 / 活动类卡片 / 图文卡片）解析与格式化纯函数模块。
//
// 背景：
//   QQ 官方机器人（QQ 开放平台）推送的富文本消息，在 OneBot v11 事件里表现为特殊消息段：
//     * markdown + inline_keyboard
//         —— QQ 官方机器人**最主流的卡片形态**：正文是 QQ 机器人 Markdown 模板，
//            按钮是 inline keyboard。例如「随机图」「今日梦境」「今日运势」这类互动卡。
//            NapCat/SnowLuma 把正文放在 { type:'markdown', data:{ content } }，
//            把按钮放在 { type:'inline_keyboard', data:{ bot_appid, rows:[{buttons:[…]}] } }。
//            卡片插图是 markdown 里的 ![#宽 #高](https://qqbot.ugcimg.cn/…)。
//     * json      —— 结构化 JSON 卡片（图文/按钮/跳转小程序，app=com.tencent.structmsg）
//     * ark       —— Ark 卡片（活动报名/抽奖/公告等，app=com.tencent.ark）
//     * xml       —— LightApp / 网页卡片（app=com.tencent.miniapp / com.tencent.qqconnect）
//     * lightapp / miniapp / keyboard —— 部分 OneBot 实现的别名
//   这些段落在 segmentsToText 里原本只会被折叠成 [卡片消息]/[markdown]/[inline_keyboard]，
//   AI 完全看不到卡片内容，也拿不到卡片插图。
//
// 本模块负责：
//   1) 从消息段中提取卡片的**完整原始内容**（markdown 原文 + 按钮 JSON，供开发调试核对）；
//   2) 把 markdown 渲染成可读正文（去掉模板头、图片转占位、链接与 @ 还原），并抽出插图 URL；
//   3) 把 inline_keyboard 解析成结构化按钮（label/type/data/style…）；
//   4) 生成紧凑摘要与提示文案，供桥接的消息记录 / 提示词 / 媒体管线使用。
//
// 安全原则（与 forward.js 一致）：
//   - 纯函数，不访问网络、不读写文件；
//   - 对原始内容做控制字符清洗与长度上限，避免恶意/异常 payload 撑爆内存或状态文件；
//   - 调用方负责“该消息必须来自当前会话已见范围”的校验。

// OneBot 消息段类型 → 视为卡片段
export const CARD_SEGMENT_TYPES = new Set(['markdown', 'inline_keyboard', 'keyboard', 'json', 'ark', 'xml', 'lightapp', 'miniapp']);

export const CARD_KIND_BOT_MARKDOWN = 'bot_markdown_card'; // QQ 官方机器人 Markdown 卡片
export const CARD_KIND_MESSAGE = 'message_card';   // 普通消息卡片（json / miniapp 图文卡）
export const CARD_KIND_ACTIVITY = 'activity_card'; // 活动类卡片（ark）
export const CARD_KIND_LIGHTAPP = 'lightapp_card'; // 小程序 / 网页卡片（xml / lightapp）
export const CARD_KIND_UNKNOWN = 'unknown_card';

export const CARD_KIND_LABELS = {
  [CARD_KIND_BOT_MARKDOWN]: 'QQ 官方机器人卡片',
  [CARD_KIND_MESSAGE]: '普通消息卡片',
  [CARD_KIND_ACTIVITY]: '活动类卡片',
  [CARD_KIND_LIGHTAPP]: '小程序/网页卡片',
  [CARD_KIND_UNKNOWN]: '未知卡片'
};

// 单张卡片原始内容上限（字符）。真实 QQ 卡片远小于该值；超限只截断 raw 字段，
// 结构化字段仍照常解析，并在 rawTruncated 标记，便于开发调试判断是否被裁剪。
export const MAX_CARD_RAW_CHARS = 20000;
// 单条消息最多提取的卡片数（防刷屏 payload）
export const MAX_CARDS_PER_MESSAGE = 4;
// 卡片的「小图标」尺寸阈值：markdown 卡片里常夹带 18~20px 的装饰图标，
// 不把它们塞进媒体管线（真正的插图远大于此）。
export const CARD_ICON_MAX_PX = 64;

export function isCardSegment(type) {
  return CARD_SEGMENT_TYPES.has(String(type ?? ''));
}

// 消息段折叠成文本时使用的占位符（供 bridge.segmentsToText 兜底使用）
export function cardSegmentPlaceholder(type) {
  const t = String(type ?? '').toLowerCase();
  if (t === 'ark') return '[活动卡片]';
  if (t === 'inline_keyboard' || t === 'keyboard') return '[按钮]';
  return '[卡片消息]';
}

export function cardKindLabel(kind) {
  return CARD_KIND_LABELS[kind] ?? CARD_KIND_LABELS[CARD_KIND_UNKNOWN];
}

// 去掉除 \n \t 之外的控制字符，避免污染日志 / 状态文件 / 终端输出。
export function stripCardControlChars(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// 消息引用（messageId / seq）清洗：只允许数字、字母与少量符号，长度受限。
export function sanitizeCardRef(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 64) return '';
  if (!/^[A-Za-z0-9_\-:.]+$/.test(s)) return '';
  return s;
}

function tryJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, value: null, error: error?.message ?? String(error) };
  }
}

function safeStringify(value, maxChars = MAX_CARD_RAW_CHARS) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const clean = stripCardControlChars(text);
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}

// 按 key 广度优先查找第一个非空字符串字段：浅层字段优先，避免被深层同名干扰。
function findFieldByKeys(root, keys, options = {}) {
  const maxDepth = Number(options.maxDepth) || 8;
  const maxNodes = Number(options.maxNodes) || 800;
  const wanted = new Set(keys);
  const queue = [{ node: root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (++visited > maxNodes) break;
    if (Array.isArray(node)) {
      for (const v of node) queue.push({ node: v, depth: depth + 1 });
      continue;
    }
    for (const [k, v] of Object.entries(node)) {
      if (wanted.has(k) && typeof v === 'string' && v.trim()) return v.trim();
      if (wanted.has(k) && typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 });
    }
  }
  return '';
}

// title 先取专用字段，取不到才退到摘要类字段（避免把顶层 desc 误当标题）。
const TITLE_KEYS = ['title'];
const TITLE_FALLBACK_KEYS = ['name', 'summary', 'desc', 'description', 'content', 'text', 'preview'];
const TAG_KEYS = ['tag', 'tagName', 'tagText', 'label', 'category'];
const SOURCE_KEYS = ['source', 'sourceName', 'from', 'author', 'publisher'];
const JUMP_KEYS = ['jumpUrl', 'jump_url', 'qqdocurl', 'pcJumpUrl', 'pc_jump_url', 'h5JumpUrl', 'h5_jump_url', 'mobileJumpUrl', 'mobile_jump_url', 'actionUrl', 'action_url', 'url'];
const BUTTON_TEXT_KEYS = ['text', 'name', 'title', 'label', 'buttonText'];

// ── QQ 官方机器人 Markdown 卡片 ────────────────────────────────────────────
// markdown 照片段形如：![#3204px #3887px](https://qqbot.ugcimg.cn/…)
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
// 普通链接 / @提及 / 机器人指令链接： [文案](mqqapi://…)
const MD_LINK_RE = /\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
// 模板头： [](/%7B%22version%22%3A2%7D) 或 [](#…)
const MD_TEMPLATE_RE = /^\[\]\([^)]*\)[ \t]*$/gm;

function parseMarkdownImageAlt(alt) {
  const s = String(alt ?? '').trim();
  const m = /#(\d+)px\s+#(\d+)px/.exec(s);
  if (!m) return { alt: s, width: 0, height: 0 };
  return { alt: s.replace(/#\d+px\s*#?\d*px?/, '').trim(), width: Number(m[1]) || 0, height: Number(m[2]) || 0 };
}

// 把 QQ 机器人 markdown 渲染成可读文本，同时抽出插图 / 链接 / @提及。
export function parseBotMarkdown(content) {
  const raw = stripCardControlChars(String(content ?? '')).replace(/\r\n?/g, '\n');
  if (!raw.trim()) return { raw: '', text: '', images: [], links: [], mentions: [] };
  const images = [];
  const links = [];
  const mentions = [];
  let text = raw.replace(MD_TEMPLATE_RE, '');
  // 图片先处理，避免后续链接规则吃掉 ![alt](url) 的 [alt](url) 部分。
  text = text.replace(MD_IMAGE_RE, (_m, alt, url) => {
    const meta = parseMarkdownImageAlt(alt);
    images.push({ url: String(url).slice(0, 2000), alt: meta.alt.slice(0, 200), width: meta.width, height: meta.height });
    return '[图片]';
  });
  text = text.replace(MD_LINK_RE, (_m, label, url) => {
    const cleanLabel = stripCardControlChars(String(label ?? '')).trim();
    const href = String(url ?? '').trim();
    const mention = /^mqqapi:\/\/markdown\/mention/i.test(href);
    if (mention) {
      const tiny = /at_tinyid=(\d+)/.exec(href);
      mentions.push({ name: cleanLabel, userId: tiny ? tiny[1] : '' });
      return cleanLabel || (tiny ? '@' + tiny[1] : '@某人');
    }
    if (/^mqqapi:\/\//i.test(href)) {
      links.push({ text: cleanLabel, url: href, kind: 'command' });
      return cleanLabel || '[按钮]';
    }
    if (/^(https?:)?\/\//i.test(href) || /^https?:/i.test(href)) {
      links.push({ text: cleanLabel, url: href, kind: 'web' });
      return cleanLabel ? cleanLabel + '（' + href + '）' : href;
    }
    // 其余（例如裸域名、相对路径）只保留文案
    return cleanLabel || href;
  });
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { raw, text, images, links, mentions };
}

// 只取渲染后的纯文本（供 bridge.segmentsToText 使用）
export function botMarkdownToText(content, options = {}) {
  const maxChars = Math.max(1, Number(options.maxChars) || 800);
  const parsed = parseBotMarkdown(content);
  if (!parsed.text) return '';
  return parsed.text.length > maxChars ? parsed.text.slice(0, maxChars) : parsed.text;
}

// QQ 按钮 type → 语义（0=链接 1=回调 2=指令）
function keyboardActionOf(type) {
  if (type === 0) return 'link';
  if (type === 1) return 'callback';
  if (type === 2) return 'command';
  return 'unknown';
}

// 解析 inline_keyboard（或旧版 keyboard）段：结构化按钮 + 原始 rows。
export function parseInlineKeyboard(data) {
  const d = data && typeof data === 'object' ? data : {};
  const rows = [];
  const buttons = [];
  const rawRows = Array.isArray(d.rows) ? d.rows : [];
  for (const row of rawRows) {
    const rowButtons = [];
    for (const b of (Array.isArray(row?.buttons) ? row.buttons : [])) {
      if (!b || typeof b !== 'object') continue;
      const type = Number(b.type) || 0;
      const button = {
        id: b.id != null ? stripCardControlChars(String(b.id)).slice(0, 50) : '',
        label: stripCardControlChars(String(b.label ?? '')).slice(0, 100),
        visitedLabel: stripCardControlChars(String(b.visited_label ?? '')).slice(0, 100),
        style: Number(b.style) || 0,
        type,
        action: keyboardActionOf(type),
        data: stripCardControlChars(String(b.data ?? '')).slice(0, 500),
        clickLimit: Number(b.click_limit) || 0,
        permissionType: Number(b.permission_type) || 0,
        unsupportedTips: stripCardControlChars(String(b.unsupport_tips ?? '')).slice(0, 200)
      };
      rowButtons.push(button);
      buttons.push(button);
      if (buttons.length >= 40) break;
    }
    if (rowButtons.length) rows.push({ buttons: rowButtons });
    if (buttons.length >= 40) break;
  }
  return {
    botAppId: d.bot_appid != null ? stripCardControlChars(String(d.bot_appid)).slice(0, 50) : '',
    rows,
    buttons,
    labels: buttons.map((b) => b.label).filter(Boolean)
  };
}

// 按钮文案列表（供 bridge.segmentsToText 生成 [按钮:…]）
export function inlineKeyboardButtonLabels(data, options = {}) {
  const max = Math.max(1, Number(options.max) || 6);
  return parseInlineKeyboard(data).labels.slice(0, max);
}

function firstMeaningfulLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const clean = line
      .replace(/\[图片\]/g, '')
      .replace(/\*\*/g, '')
      .replace(/^>\s*/, '')
      .replace(/^@\S+\s*/, '')
      .trim();
    if (clean) return clean.slice(0, 120);
  }
  return '';
}

function dedupeImages(list) {
  const out = [];
  const seen = new Set();
  for (const img of Array.isArray(list) ? list : []) {
    if (!img || !img.url || seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
  }
  return out;
}

// 组装一张 QQ 官方机器人 markdown 卡片（markdown 正文 + inline keyboard 属于同一条卡片消息）。
export function buildBotMarkdownCard(markdownContents, keyboards, options = {}) {
  const maxRaw = Math.max(1, Number(options.maxRawChars) || MAX_CARD_RAW_CHARS);
  const parts = (Array.isArray(markdownContents) ? markdownContents : []).map((c) => parseBotMarkdown(c));
  const kbList = (Array.isArray(keyboards) ? keyboards : []).map((k) => parseInlineKeyboard(k));
  const rawMarkdown = parts.map((p) => p.raw).filter(Boolean).join('\n\n---\n\n');
  const rawKeyboard = kbList.length ? safeStringify(kbList.map((k) => ({ bot_appid: k.botAppId, rows: k.rows })), maxRaw) : '';
  if (!rawMarkdown && !kbList.length) return null;

  const images = dedupeImages(parts.flatMap((p) => p.images));
  const links = parts.flatMap((p) => p.links);
  const mentions = parts.flatMap((p) => p.mentions);
  const buttons = kbList.flatMap((k) => k.buttons).map((b) => ({
    text: b.label,
    url: b.action === 'link' ? b.data : '',
    data: b.data,
    action: b.action,
    type: b.type,
    style: b.style,
    id: b.id
  }));
  const text = parts.map((p) => p.text).filter(Boolean).join('\n\n');
  const webLink = links.find((l) => l.kind === 'web');
  const rawCombined = (rawMarkdown + (rawKeyboard ? '\n\n[inline_keyboard]\n' + rawKeyboard : '')).slice(0, maxRaw);

  return {
    type: kbList.length && rawMarkdown ? 'markdown+inline_keyboard' : (rawMarkdown ? 'markdown' : (kbList.length ? 'inline_keyboard' : 'markdown')),
    kind: CARD_KIND_BOT_MARKDOWN,
    kindLabel: cardKindLabel(CARD_KIND_BOT_MARKDOWN),
    app: (kbList[0]?.botAppId || 'qq-bot-markdown').slice(0, 200),
    view: 'markdown',
    title: firstMeaningfulLine(text),
    desc: text.slice(0, 1000),
    text,
    preview: images[0]?.url ? String(images[0].url).slice(0, 1000) : '',
    tag: '',
    source: '',
    prompt: buttons.map((b) => b.text).filter(Boolean).join(' / ').slice(0, 500),
    jumpUrl: webLink ? String(webLink.url).slice(0, 2000) : '',
    coverUrl: images[0]?.url ? String(images[0].url).slice(0, 2000) : '',
    buttons,
    // QQ 官方机器人卡片专有字段
    markdown: rawMarkdown,
    keyboard: rawKeyboard,
    markdownImages: images,
    markdownLinks: links,
    mentions,
    rows: kbList.flatMap((k) => k.rows),
    botAppId: kbList[0]?.botAppId || '',
    rawType: 'markdown',
    raw: rawCombined,
    rawChars: rawCombined.length,
    rawTruncated: rawMarkdown.length + rawKeyboard.length > maxRaw,
    parseError: '',
    json: null
  };
}

// ── json / ark / xml 类卡片 ────────────────────────────────────────────────
// 从卡片 JSON 中提取按钮列表（Ark/图文卡常见：[{text/name, url/jumpUrl}, ...]）。
function extractButtons(json) {
  if (!json || typeof json !== 'object') return [];
  const candidates = [];
  const push = (v) => { if (Array.isArray(v)) candidates.push(...v); };
  push(json.buttons);
  push(json.button);
  push(json.prompt?.buttons);
  push(json.meta?.buttons);
  push(json.config?.buttons);
  const meta = json.meta && typeof json.meta === 'object' ? json.meta : {};
  for (const v of Object.values(meta)) {
    if (v && typeof v === 'object') {
      push(v.buttons);
      push(v.button);
    }
  }
  const out = [];
  for (const item of candidates) {
    if (out.length >= 8) break;
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string' && item.trim()) out.push({ text: item.trim().slice(0, 100), url: '' });
      continue;
    }
    const text = findFieldByKeys(item, BUTTON_TEXT_KEYS, { maxDepth: 3 }) || '';
    const url = findFieldByKeys(item, JUMP_KEYS, { maxDepth: 3 }) || '';
    if (!text && !url) continue;
    out.push({ text: text.slice(0, 100), url: url.slice(0, 1000) });
  }
  return out;
}

// 解析卡片原始内容：支持对象 / JSON 字符串 / 双重编码 JSON / XML / key=value 文本。
export function parseCardPayload(raw, options = {}) {
  const maxRaw = Math.max(1, Number(options.maxRawChars) || MAX_CARD_RAW_CHARS);
  const result = {
    rawType: 'empty',
    json: null,
    raw: '',
    rawTruncated: false,
    parseError: ''
  };
  if (raw === undefined || raw === null || raw === '') return result;

  if (typeof raw === 'object') {
    result.rawType = 'object';
    result.json = raw;
    result.raw = safeStringify(raw, maxRaw);
    result.rawTruncated = result.raw.length >= maxRaw;
    return result;
  }

  const text = stripCardControlChars(raw).trim();
  if (!text) return result;
  result.rawType = 'text';
  result.raw = text.length > maxRaw ? text.slice(0, maxRaw) : text;
  result.rawTruncated = text.length > maxRaw;

  // 允许以 { [ " 开头：" 开头是 OneBot 常见的“JSON 再包一层字符串”双重编码形态。
  if (/^[[{"]/.test(text)) {
    let parsed = tryJsonParse(text);
    // 双重编码：OneBot 有时把 JSON 再包一层字符串，例如 "\"{\\\"app\\\":...}\""
    if (parsed.ok && typeof parsed.value === 'string') parsed = tryJsonParse(parsed.value);
    if (parsed.ok) {
      result.rawType = 'json';
      result.json = parsed.value;
      return result;
    }
    result.parseError = parsed.error || 'JSON 解析失败';
    result.rawType = 'json_invalid';
    return result;
  }

  if (/^</.test(text)) {
    result.rawType = 'xml';
    return result;
  }
  result.rawType = 'text';
  return result;
}

function detectKind(segmentType, app, json) {
  const t = String(segmentType ?? '').toLowerCase();
  const appStr = String(app ?? '').toLowerCase();
  if (t === 'ark' || appStr.includes('.ark')) return CARD_KIND_ACTIVITY;
  if (t === 'xml' || t === 'lightapp' || t === 'miniapp') return CARD_KIND_LIGHTAPP;
  if (t === 'json') {
    if (appStr.includes('miniapp') || appStr.includes('qqconnect')) return CARD_KIND_LIGHTAPP;
    return CARD_KIND_MESSAGE;
  }
  return json ? CARD_KIND_MESSAGE : CARD_KIND_UNKNOWN;
}

// 从 XML 文本里提取关键属性（不引入 XML 依赖，仅做只读正则抽取）。
function extractFromXmlText(text) {
  const pick = (names) => {
    for (const name of names) {
      const re = new RegExp(name + '="([^"]{1,2000})"', 'i');
      const m = re.exec(text);
      if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  };
  const pickTag = (names) => {
    for (const name of names) {
      const re = new RegExp('<' + name + '>([\\s\\S]{1,2000}?)</' + name + '>', 'i');
      const m = re.exec(text);
      if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  };
  return {
    app: pick(['app', 'appid']) || pickTag(['app']),
    view: pick(['view', 'type']) || pickTag(['view']),
    title: pick(['title']) || pickTag(['title']),
    desc: pick(['desc', 'description']) || pickTag(['desc', 'summary', 'description']),
    coverUrl: pick(['cover', 'picUrl', 'imageUrl', 'preview']) || pickTag(['cover']),
    jumpUrl: pick(['url', 'jumpUrl', 'qqdocurl']) || pickTag(['url'])
  };
}

// 由单个 json/ark/xml 卡片消息段构造卡片记录（含完整原始内容 + 结构化字段）。
export function buildCardRecord(segmentType, raw, options = {}) {
  const maxRaw = Math.max(1, Number(options.maxRawChars) || MAX_CARD_RAW_CHARS);
  const parsed = parseCardPayload(raw, { maxRawChars: maxRaw });
  if (parsed.rawType === 'empty') return null;
  const json = parsed.json && typeof parsed.json === 'object' ? parsed.json : null;
  const xml = parsed.rawType === 'xml' ? extractFromXmlText(parsed.raw) : null;

  const app = findFieldByKeys(json, ['app', 'appid', 'appId'], { maxDepth: 3 }) || xml?.app || '';
  const view = findFieldByKeys(json, ['view', 'viewType'], { maxDepth: 3 }) || xml?.view || '';
  const kind = detectKind(segmentType, app, json);
  // 「预览/封面」与「正文摘要」在 QQ 卡片里常常同名字段，按卡片类型分别取用，避免语义混淆。
  const title = findFieldByKeys(json, TITLE_KEYS, { maxDepth: 6 })
    || findFieldByKeys(json, TITLE_FALLBACK_KEYS, { maxDepth: 6 })
    || xml?.title || '';
  const desc = findFieldByKeys(json, ['desc', 'description', 'summary'], { maxDepth: 6 }) || xml?.desc || '';
  const preview = findFieldByKeys(json, ['preview', 'cover', 'coverUrl', 'picUrl', 'imageUrl'], { maxDepth: 6 }) || xml?.coverUrl || '';
  const tag = findFieldByKeys(json, TAG_KEYS, { maxDepth: 6 }) || '';
  const source = findFieldByKeys(json, SOURCE_KEYS, { maxDepth: 6 }) || '';
  const jumpUrl = findFieldByKeys(json, JUMP_KEYS, { maxDepth: 6 }) || xml?.jumpUrl || '';
  const prompt = findFieldByKeys(json, ['prompt', 'promptText'], { maxDepth: 3 }) || '';
  const buttons = extractButtons(json);

  const record = {
    type: String(segmentType ?? ''),
    kind,
    kindLabel: cardKindLabel(kind),
    app: app.slice(0, 200),
    view: String(view).slice(0, 100),
    title: title.slice(0, 500),
    desc: desc.slice(0, 1000),
    text: desc.slice(0, 1000),
    preview: String(preview).slice(0, 1000),
    tag: String(tag).slice(0, 200),
    source: String(source).slice(0, 200),
    prompt: String(prompt).slice(0, 500),
    jumpUrl: String(jumpUrl).slice(0, 2000),
    coverUrl: String(preview).slice(0, 2000),
    buttons,
    markdown: '',
    keyboard: '',
    markdownImages: [],
    markdownLinks: [],
    mentions: [],
    rows: [],
    botAppId: '',
    rawType: parsed.rawType,
    raw: parsed.raw,
    rawChars: parsed.raw.length,
    rawTruncated: parsed.rawTruncated,
    parseError: parsed.parseError || '',
    json
  };
  return record;
}

// 从 OneBot 消息段数组中提取全部卡片记录（有界）：
// - markdown + inline_keyboard 属于同一条卡片消息，合并成一张；
// - json / ark / xml / lightapp / miniapp 一段一张。
export function extractCardsFromSegments(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const maxCards = Math.max(1, Math.min(20, Number(options.maxCards) || MAX_CARDS_PER_MESSAGE));
  const out = [];

  const mdContents = [];
  const keyboards = [];
  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'markdown') mdContents.push(String(seg.data?.content ?? ''));
    else if (seg.type === 'inline_keyboard' || seg.type === 'keyboard') keyboards.push(seg.data);
  }
  if (mdContents.length || keyboards.length) {
    try {
      const rec = buildBotMarkdownCard(mdContents, keyboards, options);
      if (rec) out.push(rec);
    } catch {
      // 单张卡片解析异常不影响其它卡片与整条消息
    }
  }

  for (const seg of list) {
    if (out.length >= maxCards) break;
    if (!seg || typeof seg !== 'object') continue;
    const t = String(seg.type ?? '').toLowerCase();
    if (t !== 'json' && t !== 'ark' && t !== 'xml' && t !== 'lightapp' && t !== 'miniapp') continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
    // 兼容三种常见投递形态：data.data（标准 json/ark 段）、data 本体为字符串、data 直接是对象。
    const raw = data.data ?? data.raw ?? data.content ?? data.json ?? data.xml
      ?? (typeof seg.data === 'string' ? seg.data : (Object.keys(data).length ? data : ''));
    try {
      const rec = buildCardRecord(seg.type, raw, options);
      if (rec) out.push(rec);
    } catch {
      // 单张卡片解析异常不影响其它卡片与整条消息
    }
  }
  return out.slice(0, maxCards);
}

// 从卡片段里提取**可读图片**（markdown 内嵌插图 + json/ark 封面），交给桥接的媒体管线，
// 这样 qq_get_message_images 就能把卡片插图喂给视觉模型（否则 AI 只看到「[图片]」占位）。
export function extractCardMediaFromSegments(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const maxImages = Math.max(1, Number(options.maxImages) || 5);
  const out = [];
  const seen = new Set();
  const pushImage = (url, alt) => {
    const u = String(url ?? '').trim();
    if (!u || seen.has(u)) return;
    if (!/^https?:\/\//i.test(u)) return;
    seen.add(u);
    out.push({ kind: 'image', file: '', url: u, subType: 'card', summary: String(alt ?? '').slice(0, 100) });
  };
  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'markdown') {
      const md = parseBotMarkdown(seg.data?.content);
      for (const img of md.images) {
        // 跳过 18~20px 的装饰图标，只保留真正的插图。
        if (!img.width && !img.height) pushImage(img.url, img.alt);
        else if (img.width > CARD_ICON_MAX_PX || img.height > CARD_ICON_MAX_PX) pushImage(img.url, img.alt);
      }
    }
  }
  // json / ark 卡片的封面图（preview）同样值得暴露给视觉模型。
  for (const card of extractCardsFromSegments(list, options)) {
    if (card.kind === CARD_KIND_BOT_MARKDOWN) continue;
    pushImage(card.coverUrl, card.title);
  }
  return out.slice(0, maxImages);
}

// 卡片紧凑摘要（用于消息记录 / 活动日志，不放完整 raw）
export function summarizeCard(card) {
  if (!card || typeof card !== 'object') return '';
  const bits = [card.kindLabel || cardKindLabel(card.kind)];
  if (card.app) bits.push(card.app);
  const text = card.title || card.desc || card.prompt || '';
  if (text) bits.push(text.slice(0, 40));
  return bits.join(' · ');
}

// 供消息记录使用的卡片摘要信息（写入每条消息对象，随状态落盘）
export function cardSummaryForMessage(cards) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (!list.length) return null;
  return {
    cardCount: list.length,
    cardKinds: [...new Set(list.map((c) => c.kind))],
    cardLabels: [...new Set(list.map((c) => c.kindLabel || cardKindLabel(c.kind)))],
    cardTitles: list.map((c) => String(c.title || c.desc || c.prompt || '').slice(0, 80)),
    hasCard: true
  };
}

// 给 AI 的卡片提示（与 bridge.mediaHintFor 风格一致）
export function buildCardHint(key, messageRef, summary) {
  const count = Number(summary?.cardCount) || 0;
  if (!count || !messageRef) return '';
  const labels = Array.isArray(summary?.cardLabels) && summary.cardLabels.length
    ? summary.cardLabels.join('/')
    : 'QQ 官方卡片';
  return '\n【' + labels + '】本条消息包含 ' + count + " 张卡片（消息ID=" + messageRef + '）。如需查看卡片完整原始内容（markdown 原文 / 按钮数据），请调用 mcp__snowluma__qq_get_card_msg，参数 key="' + key + '", messageId="' + messageRef + '"。';
}

// 对外返回给工具的结果整形（保留完整 raw；index 用于挑选单张）
export function formatCardResponse(records, options = {}) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  const index = Number(options.index);
  if (Number.isInteger(index) && index >= 0) {
    if (index >= list.length) return { total: list.length, index, card: null, error: '卡片序号越界' };
    return { total: list.length, index, card: list[index] };
  }
  return { total: list.length, cards: list };
}
