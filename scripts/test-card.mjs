// QQ 官方卡片查看能力自检脚本：
// 1. parseCardPayload：JSON / 双重编码 JSON / 对象 / XML / 非法 JSON / 控制字符 / 截断
// 2. extractCardsFromSegments：json / ark / xml / lightapp / miniapp 提取与上限
// 3. 结构化字段：普通消息卡片与活动类卡片的 app/view/title/desc/jumpUrl/coverUrl/tag/按钮
// 4. cardSummaryForMessage / buildCardHint / formatCardResponse
// 5. 源码接入断言：bridge.js 端点与开关、mcp-snowluma-safe.js 工具、控制台开关、config 默认值
// 6. MCP 常驻注册检查：进程内（内存传输）启动 mcp-snowluma-safe.js，确认 qq_get_card_msg 无条件注册
// 7. 桥接运行中时，校验 /api/socialV2/card-message 的安全拒绝逻辑
// 运行：node scripts/test-card.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD_SEGMENT_TYPES,
  MAX_CARDS_PER_MESSAGE,
  isCardSegment,
  cardSegmentPlaceholder,
  sanitizeCardRef,
  parseCardPayload,
  buildCardRecord,
  extractCardsFromSegments,
  extractCardMediaFromSegments,
  botMarkdownToText,
  inlineKeyboardButtonLabels,
  parseInlineKeyboard,
  summarizeCard,
  cardSummaryForMessage,
  buildCardHint,
  formatCardResponse,
  assessCardButtonRisk,
  selectCardButton
} from '../src/qq-card.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 优先用户 config.json；干净检出时使用随仓库的 config.example.json。
const CONFIG_FILE = [path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].find((candidate) => fs.existsSync(candidate));

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log('✅ ' + name + (extra ? ' — ' + extra : ''));
  } else {
    failed += 1;
    console.error('❌ ' + name + (extra ? ' — ' + extra : ''));
  }
}

// ── 1. parseCardPayload ────────────────────────────────────────────────────
const PLAIN_CARD = {
  app: 'com.tencent.structmsg',
  view: 'news',
  ver: '0.0.0.1',
  desc: '新闻',
  prompt: '[QQ小程序]腾讯新闻',
  config: { autosize: true, forward: true, type: 'normal' },
  meta: {
    news: {
      action: '',
      appid: '1109',
      appType: 0,
      jumpUrl: 'https://example.com/news?id=1',
      preview: 'https://example.com/cover.png',
      source: '腾讯新闻',
      tag: '新闻',
      title: 'DeepSeek 发布新模型'
    }
  }
};
// 活动类卡片（Ark）：QQ 官方机器人活动推送的典型结构
const ACTIVITY_CARD = {
  app: 'com.tencent.ark',
  view: 'activity',
  ver: '0.0.0.1',
  desc: '活动',
  prompt: '[活动]点击参与抽奖',
  config: { ctime: 1700000000, token: 'token-abcdef' },
  meta: {
    activity: {
      title: '官方活动 · 签到抽奖',
      jumpUrl: 'https://example.com/act/1',
      preview: 'https://example.com/act.png',
      tag: '活动',
      buttons: [{ text: '立即参与', jumpUrl: 'https://example.com/act/1' }]
    }
  }
};
const XML_CARD = '<msg serviceID="1" templateID="1" action="web" brief="[小程序]示例" url="https://example.com/x"><item layout="2"><picture cover="https://example.com/c.png"/><title>网页卡片标题</title><summary>描述文字</summary></item></msg>';

const pJson = parseCardPayload(JSON.stringify(PLAIN_CARD));
check('parseCardPayload 识别 JSON', pJson.rawType === 'json' && pJson.json?.app === 'com.tencent.structmsg');
check('parseCardPayload 保留完整原始内容', pJson.raw === JSON.stringify(PLAIN_CARD), pJson.raw.length + ' 字符');
const pDouble = parseCardPayload(JSON.stringify(JSON.stringify(PLAIN_CARD)));
check('parseCardPayload 兼容双重编码 JSON', pDouble.rawType === 'json' && pDouble.json?.view === 'news');
const pObj = parseCardPayload(PLAIN_CARD);
check('parseCardPayload 兼容对象输入', pObj.rawType === 'object' && pObj.json?.app === 'com.tencent.structmsg');
const pXml = parseCardPayload(XML_CARD);
check('parseCardPayload 识别 XML', pXml.rawType === 'xml' && pXml.raw.includes('serviceID'));
const pBad = parseCardPayload('{不是合法 JSON');
check('parseCardPayload 非法 JSON 不抛错并标记', pBad.rawType === 'json_invalid' && !!pBad.parseError);
const pEmpty = parseCardPayload('');
check('parseCardPayload 空输入', pEmpty.rawType === 'empty' && pEmpty.raw === '');
const pCtrl = parseCardPayload('{"app":"a\u0000\u0007b"}');
check('parseCardPayload 清洗控制字符', !/[\u0000\u0007]/.test(pCtrl.raw) && pCtrl.json?.app === 'ab');
const pLong = parseCardPayload(JSON.stringify({ app: 'x'.repeat(500) }), { maxRawChars: 100 });
check('parseCardPayload 超长截断并标记', pLong.raw.length === 100 && pLong.rawTruncated === true);

// ── 2. extractCardsFromSegments ───────────────────────────────────────────
check('isCardSegment 识别卡片段', isCardSegment('json') && isCardSegment('ark') && isCardSegment('xml') && isCardSegment('lightapp') && isCardSegment('miniapp') && isCardSegment('markdown') && isCardSegment('inline_keyboard') && isCardSegment('keyboard'));
check('isCardSegment 排除普通段', !isCardSegment('text') && !isCardSegment('image') && !isCardSegment('forward'));
check('cardSegmentPlaceholder 活动卡片标记', cardSegmentPlaceholder('ark') === '[活动卡片]');
check('cardSegmentPlaceholder 普通卡片标记', cardSegmentPlaceholder('json') === '[卡片消息]' && cardSegmentPlaceholder('xml') === '[卡片消息]');
check('CARD_SEGMENT_TYPES 覆盖 markdown 卡片/按钮/图文段', CARD_SEGMENT_TYPES.size === 8);
check('cardSegmentPlaceholder 按钮段标记', cardSegmentPlaceholder('inline_keyboard') === '[按钮]' && cardSegmentPlaceholder('markdown') === '[卡片消息]');

const segs = [
  { type: 'text', data: { text: '看这个卡片' } },
  { type: 'json', data: { data: JSON.stringify(PLAIN_CARD) } },
  { type: 'ark', data: { data: JSON.stringify(ACTIVITY_CARD) } },
  { type: 'xml', data: { data: XML_CARD } },
  { type: 'forward', data: { id: 'fwd_1' } }
];
const cards = extractCardsFromSegments(segs);
check('extractCardsFromSegments 提取 3 张卡片', cards.length === 3, '实际 ' + cards.length);
check('extractCardsFromSegments 保留消息段类型', cards.map((c) => c.type).join(',') === 'json,ark,xml');

// ── 3. 结构化字段 ─────────────────────────────────────────────────────────
const plain = cards[0];
check('普通消息卡片 kind=message_card', plain.kind === 'message_card' && plain.kindLabel === '普通消息卡片');
check('普通消息卡片 app/view', plain.app === 'com.tencent.structmsg' && plain.view === 'news');
check('普通消息卡片 title/source/tag', plain.title === 'DeepSeek 发布新模型' && plain.source === '腾讯新闻' && plain.tag === '新闻');
check('普通消息卡片 jumpUrl/coverUrl', plain.jumpUrl === 'https://example.com/news?id=1' && plain.coverUrl === 'https://example.com/cover.png');
check('普通消息卡片 prompt', plain.prompt === '[QQ小程序]腾讯新闻');
check('普通消息卡片 json 结构化保留', plain.json?.meta?.news?.appid === '1109');

const activity = cards[1];
check('活动类卡片 kind=activity_card', activity.kind === 'activity_card' && activity.kindLabel === '活动类卡片');
check('活动类卡片 app/view', activity.app === 'com.tencent.ark' && activity.view === 'activity');
check('活动类卡片 title/tag', activity.title === '官方活动 · 签到抽奖' && activity.tag === '活动');
check('活动类卡片 jumpUrl/coverUrl', activity.jumpUrl === 'https://example.com/act/1' && activity.coverUrl === 'https://example.com/act.png');
check('活动类卡片 按钮提取', activity.buttons.length === 1 && activity.buttons[0].text === '立即参与' && activity.buttons[0].url === 'https://example.com/act/1');

const xmlCard = cards[2];
check('XML 卡片 kind=lightapp_card', xmlCard.kind === 'lightapp_card');
check('XML 卡片 字段抽取', xmlCard.title === '网页卡片标题' && xmlCard.desc === '描述文字' && xmlCard.coverUrl === 'https://example.com/c.png' && xmlCard.jumpUrl === 'https://example.com/x');

const objSeg = extractCardsFromSegments([{ type: 'json', data: { data: { app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: '对象形态卡片' } } } } }]);
check('extractCardsFromSegments 兼容 data 为对象', objSeg.length === 1 && objSeg[0].title === '对象形态卡片');

const rawStrSeg = extractCardsFromSegments([{ type: 'json', data: JSON.stringify(PLAIN_CARD) }]);
check('extractCardsFromSegments 兼容 data 为字符串', rawStrSeg.length === 1 && rawStrSeg[0].view === 'news');

const lightappSeg = extractCardsFromSegments([{ type: 'lightapp', data: { data: JSON.stringify({ app: 'com.tencent.miniapp', view: 'miniapp', meta: { miniapp: { title: '小程序卡片' } } }) } }]);
check('extractCardsFromSegments 识别 lightapp 段', lightappSeg.length === 1 && lightappSeg[0].kind === 'lightapp_card');

const many = extractCardsFromSegments(Array.from({ length: 10 }, () => ({ type: 'json', data: { data: JSON.stringify(PLAIN_CARD) } })));
check('extractCardsFromSegments 单条消息卡片数上限', many.length === MAX_CARDS_PER_MESSAGE, '实际 ' + many.length);

const emptySegs = extractCardsFromSegments([{ type: 'json', data: { data: '' } }, null, 'x', { type: 'text', data: { text: 'hi' } }]);
check('extractCardsFromSegments 空/异常段安全跳过', emptySegs.length === 0);
check('extractCardsFromSegments 非数组返回空', extractCardsFromSegments(null).length === 0 && extractCardsFromSegments(undefined).length === 0);

const badJsonSeg = extractCardsFromSegments([{ type: 'json', data: { data: '{坏 JSON' } }]);
check('extractCardsFromSegments 非法 JSON 仍返回原始内容', badJsonSeg.length === 1 && badJsonSeg[0].rawType === 'json_invalid' && badJsonSeg[0].raw === '{坏 JSON');
check('buildCardRecord 空原始内容返回 null', buildCardRecord('json', '') === null);

// ── 3.5 QQ 官方机器人 Markdown 卡片（真实抓包 payload） ────────────────────
// 这两条是 QQ 官方机器人「随机图」与「今日梦境」卡片在 NapCat/SnowLuma 下的真实形态：
// 插图是 markdown 里的 ![#宽 #高](https://qqbot.ugcimg.cn/…)，按钮在 inline_keyboard 段。
const BOT_MD_RANDOM = '[](%7B%22version%22%3A2%7D)\n![#3204px #3887px](https://qqbot.ugcimg.cn/100000001/37885e4b049089455eb4964dd328f107ceca4da0/f39bc97cb2ea30c1ee7cac92b0b0e20e)\n![#20px #20px](https://qqbot.ugcimg.cn/100000001/1db0bbfe38dbd3d653a2da093e033caf8e822adb/2b00cd42c7401674091d8320a4fead8d) [@测试成员A](mqqapi://markdown/mention?at_type=1&at_tinyid=100001)**的随机图** (剩余: **19**)\n\n> 图片作者: **Ohihil** (ID:73272100)\n\n![#20px #20px](https://qqbot.ugcimg.cn/100000001/7e99bc94eda363e8967dadc795f1a6d763ccd834/8e5fb5ae2c3db2f3c12b0d4d457c50d1) [🔗使用声明](https://xbdqwq.com/about/rule/image)';
const BOT_KB_RANDOM = {
  bot_appid: '100000001',
  rows: [
    { buttons: [
      { id: '1', label: '💖喜欢', visited_label: '💖喜欢', style: 1, type: 1, click_limit: 1, data: 'BOT1.0_xxx', permission_type: 2, unsupport_tips: '版本过低' },
      { id: '2', label: '💔不喜欢', visited_label: '💔不喜欢', style: 3, type: 1, click_limit: 1, data: 'BOT1.0_yyy', permission_type: 2 }
    ] },
    { buttons: [ { id: '3', label: '🔄再来一张', visited_label: '🔄再来一张', style: 4, type: 2, click_limit: 1, data: '随机图', permission_type: 2 } ] }
  ]
};
const BOT_MD_DREAM = '[](%7B%22version%22%3A2%7D)\n![#1672px #940px](https://qqbot.ugcimg.cn/100000001/74079e4681200f40248977de3953c1d4bda5abed/b9ce2982362d6b1ca125a548d54b6fac)\n\n![#20px #20px](https://qqbot.ugcimg.cn/100000001/b60869357240073efbffcbe373ea33ac08f97931/45983ec12383b36098a333082acd18f7) **今日梦境** [@测试成员B](mqqapi://markdown/mention?at_type=1&at_tinyid=100002) \n**你抽到了:** 泡影之梦\n**梦境名:**《贩卖机的心意》\n> **介绍:** 深夜的自动贩卖机多找了你一枚硬币，还朝你闪了两下灯。你们对视了很久，谁也没先说话。\n> —— 幻梦的评语: 它大概只是想请小人类喝一罐吧。这种小心意，收下就好啦。\n![#20px #20px](https://qqbot.ugcimg.cn/100000001/e96e02a28380c3a7fc1fa9ba2d33514e46be95b4/9fbfe6cb0796ca07ae39e5ff971bcf8e)梦境名: **「贩卖机的心意」**已收入梦境图鉴（1/65）\n> 你是今天第4395位入梦的~';

const botSegs = [
  { type: 'at', data: { qq: '100001' } },
  { type: 'markdown', data: { content: BOT_MD_RANDOM } },
  { type: 'inline_keyboard', data: BOT_KB_RANDOM }
];
const botCards = extractCardsFromSegments(botSegs);
check('Markdown 卡片：markdown+按钮合并为一张卡', botCards.length === 1 && botCards[0].type === 'markdown+inline_keyboard');
const botCard = botCards[0];
check('Markdown 卡片 kind=bot_markdown_card', botCard.kind === 'bot_markdown_card' && botCard.kindLabel === 'QQ 官方机器人卡片');
check('Markdown 卡片 bot_appid 提取', botCard.app === '100000001' && botCard.botAppId === '100000001');
check('Markdown 卡片 去掉模板头 [](/%7B%22version%22…)', !botCard.text.includes('version') && !botCard.raw.startsWith('[](#'));
check('Markdown 卡片 插图提取（含尺寸）', botCard.markdownImages.length === 3 && botCard.markdownImages[0].width === 3204 && botCard.markdownImages[0].height === 3887);
check('Markdown 卡片 @提及还原为文案', botCard.mentions.length === 1 && botCard.mentions[0].userId === '100001' && botCard.text.includes('@测试成员A'));
check('Markdown 卡片 外链还原', botCard.markdownLinks.some((l) => l.kind === 'web' && l.url === 'https://xbdqwq.com/about/rule/image'));
check('Markdown 卡片 按钮结构化', botCard.buttons.length === 3 && botCard.buttons[0].text === '💖喜欢' && botCard.buttons[0].action === 'callback' && botCard.buttons[2].action === 'command' && botCard.buttons[2].data === '随机图');
const pickedCallback = selectCardButton(botCards, { cardIndex: 0, buttonIndex: 0 });
check('卡片按钮点击：按索引派生网关参数', pickedCallback.selection?.botAppId === '100000001' && pickedCallback.selection?.buttonId === '1' && pickedCallback.selection?.callbackData === 'BOT1.0_xxx');
check('卡片风险分级：明确偏好按钮为低风险', pickedCallback.selection?.riskLevel === 'low' && pickedCallback.selection?.requiresApproval === false);
const pickedCommand = selectCardButton(botCards, { cardIndex: 0, buttonIndex: 2 });
check('卡片按钮点击：支持指令按钮', pickedCommand.selection?.action === 'command' && pickedCommand.selection?.callbackData === '随机图');
check('卡片风险分级：明确刷新类指令为低风险', pickedCommand.selection?.riskLevel === 'low' && pickedCommand.selection?.requiresApproval === false);
const riskyCard = {
  ...botCard,
  title: '充值抽奖活动',
  desc: '绑定账号后支付并领取奖励',
  text: '绑定账号后支付并领取奖励',
  prompt: '立即领取',
  buttons: [{ id: 'risk-1', text: '立即领取', action: 'callback', data: 'claim_reward' }]
};
const riskySelection = selectCardButton([riskyCard], { buttonIndex: 0 });
check('卡片风险分级：资金/授权/领奖内容必须审批', riskySelection.selection?.riskLevel === 'high' && riskySelection.selection?.requiresApproval === true && riskySelection.selection?.riskReasons.length >= 2);
const unknownCard = {
  ...botCard,
  title: '机器人操作',
  desc: '请选择操作',
  text: '请选择操作',
  prompt: '立即执行',
  buttons: [{ id: 'unknown-1', text: '立即执行', action: 'callback', data: 'do_something' }]
};
const unknownRisk = assessCardButtonRisk(unknownCard, unknownCard.buttons[0]);
check('卡片风险分级：未知用途默认交管理员审批', unknownRisk.riskLevel === 'high' && unknownRisk.requiresApproval === true && unknownRisk.riskReasons.some((x) => x.includes('低风险白名单')));
const linkOnlyCard = { ...botCard, buttons: [{ id: '9', text: '打开网页', action: 'link', data: 'https://example.com' }] };
const blockedLink = selectCardButton([linkOnlyCard], { buttonIndex: 0 });
check('卡片按钮点击：拒绝链接按钮', !blockedLink.selection && /链接按钮/.test(blockedLink.error));
check('卡片按钮点击：拒绝越界索引', !selectCardButton(botCards, { cardIndex: 0, buttonIndex: 99 }).selection);
check('Markdown 卡片 标题取自正文', botCard.title.includes('随机图'));
check('Markdown 卡片 保留完整原始 markdown + 按钮 JSON', botCard.markdown.includes('的随机图') && botCard.keyboard.includes('BOT1.0_xxx') && botCard.raw.includes('[inline_keyboard]'));
check('Markdown 卡片 正文可读（图片转占位）', botCard.text.includes('[图片]') && botCard.text.includes('图片作者'));

const dreamCard = extractCardsFromSegments([{ type: 'markdown', data: { content: BOT_MD_DREAM } }])[0];
check('Markdown 卡片：无按钮也能单独成卡', dreamCard.kind === 'bot_markdown_card' && dreamCard.type === 'markdown' && dreamCard.buttons.length === 0);
check('Markdown 卡片：梦境正文完整可读', dreamCard.text.includes('你抽到了') && dreamCard.text.includes('贩卖机的心意') && dreamCard.text.includes('第4395位入梦'));

check('botMarkdownToText 限制长度', botMarkdownToText(BOT_MD_DREAM, { maxChars: 20 }).length === 20);
check('inlineKeyboardButtonLabels 提取按钮文案', JSON.stringify(inlineKeyboardButtonLabels(BOT_KB_RANDOM, { max: 6 })) === JSON.stringify(['💖喜欢', '💔不喜欢', '🔄再来一张']));
check('parseInlineKeyboard 空值安全', parseInlineKeyboard(null).buttons.length === 0 && inlineKeyboardButtonLabels(null).length === 0);

// 卡片插图必须进入媒体管线（否则 AI 永远看不到卡片图片）
const cardMedia = extractCardMediaFromSegments(botSegs);
check('extractCardMediaFromSegments 提取插图', cardMedia.length === 1 && cardMedia[0].kind === 'image' && /^https:\/\/qqbot\.ugcimg\.cn\//.test(cardMedia[0].url), '实际 ' + cardMedia.length);
check('extractCardMediaFromSegments 过滤 20px 装饰图标', !cardMedia.some((m) => m.url.includes('1db0bbfe38db')));
check('extractCardMediaFromSegments 去重', extractCardMediaFromSegments([...botSegs, ...botSegs]).length === 1);
check('extractCardMediaFromSegments json 卡片封面也进入媒体', extractCardMediaFromSegments([{ type: 'json', data: { data: JSON.stringify(PLAIN_CARD) } }]).some((m) => m.url === 'https://example.com/cover.png'));

// ── 4. 摘要 / 提示 / 结果整形 ──────────────────────────────────────────────
check('summarizeCard 含类型与标题', summarizeCard(activity).includes('活动类卡片') && summarizeCard(activity).includes('官方活动'));
const summary = cardSummaryForMessage(cards);
check('cardSummaryForMessage 统计卡片数', summary.cardCount === 3 && summary.hasCard === true);
check('cardSummaryForMessage 汇总卡片种类', summary.cardKinds.includes('message_card') && summary.cardKinds.includes('activity_card') && summary.cardKinds.includes('lightapp_card'));
check('cardSummaryForMessage 无卡片返回 null', cardSummaryForMessage([]) === null && cardSummaryForMessage(null) === null);
const hint = buildCardHint('group:123', '987654', summary);
check('buildCardHint 关联查看与点击工具', hint.includes('qq_get_card_msg') && hint.includes('qq_click_card_button') && hint.includes('group:123') && hint.includes('987654') && hint.includes('3 张卡片'));
check('buildCardHint 无卡片返回空', buildCardHint('group:123', '1', null) === '');

const full = formatCardResponse(cards);
check('formatCardResponse 默认返回全部', full.total === 3 && full.cards.length === 3);
const interactive = formatCardResponse(botCards);
check('formatCardResponse 返回稳定按钮索引/可点击性/风险级别', interactive.cards[0].cardIndex === 0 && interactive.cards[0].buttons[2].buttonIndex === 2 && interactive.cards[0].buttons[2].clickable === true && interactive.cards[0].buttons[2].riskLevel === 'low' && interactive.cards[0].buttons[2].requiresApproval === false);
const one = formatCardResponse(cards, { index: 1 });
check('formatCardResponse index 选中单张', one.card?.kind === 'activity_card' && one.total === 3);
const oob = formatCardResponse(cards, { index: 9 });
check('formatCardResponse index 越界', oob.card === null && !!oob.error);
check('formatCardResponse 空数组', formatCardResponse([]).total === 0);

check('sanitizeCardRef 接受数字/字母 id', sanitizeCardRef('123456') === '123456' && sanitizeCardRef('a-b_c:1') === 'a-b_c:1');
check('sanitizeCardRef 拒绝空白与超长', sanitizeCardRef('1 2') === '' && sanitizeCardRef('x'.repeat(80)) === '' && sanitizeCardRef(null) === '');

// ── 5. 源码接入断言 ───────────────────────────────────────────────────────
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
// 历史设计实验已移出公开仓库。直接验证当前维护的控制台实现，
// 不再把已废弃的设计基线当作安全行为测试的依赖。

check('bridge.js 引入 qq-card 模块', /from '\.\/qq-card\.js'/.test(bridgeSrc));
check('bridge.js 导入 extractCardsFromSegments', /extractCardsFromSegments/.test(bridgeSrc));
check('bridge.js 提供 /api/socialV2/card-message 端点', bridgeSrc.includes("url.pathname === '/api/socialV2/card-message'"));
check('bridge.js 端点受 getCardMsg 开关控制', /v2ToolEnabled\('getCardMsg'\)/.test(bridgeSrc));
// 默认值在 TASK-D1-001 后由 src/config 持有（bridge.js 只保留严格 === true 的使用点）。
const configSources = [
  fs.readFileSync(path.join(ROOT, 'src', 'config', 'migrate.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'src', 'config', 'schema.js'), 'utf8')
].join('\n');
check('config 工具开关默认含 getCardMsg', /getCardMsg:\s*true/.test(configSources));
check('config 卡片点击工具严格默认关闭', /clickCardButton:\s*false/.test(configSources) && /clickCardButton\s*===\s*true/.test(bridgeSrc));
check('bridge.js toolFlags 含 getCardMsg', /'getCardMsg'/.test(bridgeSrc));
check('bridge.js toolMap 映射 qq_get_card_msg', bridgeSrc.includes("getCardMsg: 'qq_get_card_msg'"));
check('bridge.js 提供卡片按钮点击端点并经 QQ Runtime 执行动作', bridgeSrc.includes("url.pathname === '/api/socialV2/card-button-click'") && bridgeSrc.includes("qqRuntime.rawWrite('click_inline_keyboard_button'"));
check('bridge.js toolMap 映射 qq_click_card_button', bridgeSrc.includes("clickCardButton: 'qq_click_card_button"));
check('bridge.js 卡片点击逐次确认与防连点', /body\.confirm\s*!==\s*true/.test(bridgeSrc) && /CARD_BUTTON_CLICK_COOLDOWN_MS/.test(bridgeSrc));
check('bridge.js 风险按钮进入隔离审批队列', /pending_approval/.test(bridgeSrc) && /cardButtonApprovals/.test(bridgeSrc) && /CARD_BUTTON_APPROVAL_TTL_MS/.test(bridgeSrc));
check('bridge.js 管理员审批前后重新回源并校验指纹', /decideCardButtonApproval/.test(bridgeSrc) && /target\.fingerprint !== record\.fingerprint/.test(bridgeSrc) && /resolveCardButtonClickTarget/.test(bridgeSrc));
check('bridge.js 管理员审批支持控制台与 ownerQQ 命令', /card-button-approvals/.test(bridgeSrc) && /card-\(approve\|reject\)/.test(bridgeSrc));
check('bridge.js Agent 只能查询本会话审批状态', bridgeSrc.includes("url.pathname === '/api/socialV2/card-button-approval'") && /approval\.key !== key/.test(bridgeSrc));
check('bridge.js 工具关闭或二代暂停会撤销待审批请求', /cancelPendingCardButtonApprovals/.test(bridgeSrc) && /socialV2\.paused/.test(bridgeSrc));
check('bridge.js 审批错误状态对 Agent 脱敏且限长', /safeCardApprovalError/.test(bridgeSrc) && /redactKnownTokensOnly/.test(bridgeSrc));
check('bridge.js 消息段落使用卡片占位符', /cardSegmentPlaceholder/.test(bridgeSrc));
check('bridge.js 渲染 markdown 卡片正文', /botMarkdownToText/.test(bridgeSrc));
check('bridge.js 列出按钮文案', /inlineKeyboardButtonLabels/.test(bridgeSrc));
check('bridge.js 卡片插图接入媒体管线', /extractCardMediaFromSegments/.test(bridgeSrc));
check('bridge.js 卡片/媒体支持按需回源 get_msg', /backfillMessageCache/.test(bridgeSrc) && /fetchRawMessageByRef/.test(bridgeSrc));
check('bridge.js 启动后回填历史卡片元数据', /backfillRecentCardsV2/.test(bridgeSrc));
check('bridge.js /api/status 暴露 cardSegments 能力自描述', /cardSegments: \[\.\.\.CARD_SEGMENT_TYPES\]/.test(bridgeSrc));
check('bridge.js 消息记录带卡片摘要', /cardSummaryForMessage/.test(bridgeSrc));
const forwardSrc = fs.readFileSync(path.join(ROOT, 'src', 'forward.js'), 'utf8');
check('forward.js 识别 markdown/按钮段', /case 'markdown'/.test(forwardSrc) && /case 'inline_keyboard'/.test(forwardSrc));

check('mcp-snowluma-safe.js 注册 qq_get_card_msg', mcpSrc.includes("'qq_get_card_msg'"));
check('mcp-snowluma-safe.js 运行期读配置实现即时开关', /getCardMsg === false/.test(mcpSrc));
check('mcp-snowluma-safe.js 调用桥接 card-message 端点', mcpSrc.includes('/api/socialV2/card-message'));
check('mcp-snowluma-safe.js 注册 qq_click_card_button', mcpSrc.includes("'qq_click_card_button'"));
check('mcp-snowluma-safe.js 卡片点击严格检查显式开启', /clickCardButton !== true/.test(mcpSrc));
check('mcp-snowluma-safe.js 卡片点击要求 confirm=true', /confirm:\s*z\.literal\(true\)/.test(mcpSrc));
check('mcp-snowluma-safe.js 注册审批状态查询工具', mcpSrc.includes("'qq_get_card_button_approval'") && mcpSrc.includes('/api/socialV2/card-button-approval'));

check('控制台开关面板含 getCardMsg（public/console.html）', consoleHtml.includes('data-v2-tool="getCardMsg"'));
check('控制台卡片读取工具只验证当前维护的控制台入口', consoleHtml.includes('data-v2-tool="getCardMsg"'));
check('控制台卡片点击开关默认关闭并标注风险', consoleHtml.includes('data-v2-tool="clickCardButton"') && consoleHtml.includes('data-v2-tool-default="off"') && consoleHtml.includes('高风险 · 默认关闭'));
check('控制台卡片点击风险标记与持久开启告知保持完整', consoleHtml.includes('data-v2-tool="clickCardButton"') && consoleHtml.includes('data-risk-tool="card-button"') && consoleHtml.includes('首次确认后立即保存并持续开启'));
check('控制台开启卡片点击前弹出风险确认', consoleHtml.includes('知晓风险并开启') && consoleHtml.includes('每次工具调用仍需显式确认'));
check('控制台风险开关确认后保持开启、再次开启需复核', consoleHtml.includes('确认后工具会持续开启') && consoleHtml.includes('下次从关闭状态重新开启时仍需再次确认'));
check('控制台风险开关开启/关闭即时持久化', consoleHtml.includes('persistCardButtonTool') && /clickCardButton:\s*enabled/.test(consoleHtml) && consoleHtml.includes('待审批请求已撤销'));
check('控制台可批准或拒绝风险卡片按钮', consoleHtml.includes('data-card-approval-approve') && consoleHtml.includes('data-card-approval-reject') && consoleHtml.includes('批准并执行'));

// 6. 配置默认开关
let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  check('config.socialV2.tools.getCardMsg 默认开启', config.socialV2?.tools?.getCardMsg !== false);
  // config.json 是本机运行态配置，用户确认风险后可以持久化开启；默认值以模板为准。
  check('config.socialV2.tools.clickCardButton 运行态为显式布尔', typeof config.socialV2?.tools?.clickCardButton === 'boolean');
} catch (error) {
  check('config.json/config.example.json 可读', false, error?.message);
}
try {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  check('config.example.json 含 getCardMsg', example.socialV2?.tools?.getCardMsg !== undefined);
  check('config.example.json 卡片点击默认关闭', example.socialV2?.tools?.clickCardButton === false);
} catch (error) {
  check('config.example.json 可读', false, error?.message);
}

// ── 7. 桥接端点安全拒绝（可选，桥接运行且状态存在时） ──────────────────────
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File) && config) {
  try {
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const base = 'http://127.0.0.1:' + (config.consolePort || 3100) + '/api/socialV2/card-message';
      const authHeaders = { 'x-console-token': consoleToken };
      if (agentToken) {
        const resNoToken = await fetch(base + '?key=' + encodeURIComponent(key) + '&messageId=1', { headers: authHeaders, signal: AbortSignal.timeout(5000) });
        const bodyNoToken = await resNoToken.json().catch(() => ({}));
        // 运行中的桥接若是旧进程（还没加载新端点），通用 404 处理器返回 error='not found'；
        // 这时跳过端点检查而不是误报失败——重启桥接后即可生效。
        const routeMissing = resNoToken.status === 404 && /not found/i.test(String(bodyNoToken.error || ''));
        if (routeMissing) {
          console.log('⚠️ 跳过桥接端点检查：运行中的桥接尚未包含 card-message 端点（重启桥接后生效）');
        } else {
          check('桥接端点：无 agent token 被拒绝', resNoToken.status === 403 && /agent token|仅 (social|reserved2) 模式可用|当前模式不允许|本机 IPC|原生桌面模式/.test(String(bodyNoToken.error || '')), 'HTTP ' + resNoToken.status + ' ' + (bodyNoToken.error || ''));
          const resUnknown = await fetch(base + '?key=' + encodeURIComponent(key) + '&messageId=not_seen_card_ref', {
            headers: { ...authHeaders, 'x-agent-token': agentToken },
            signal: AbortSignal.timeout(5000)
          });
          const bodyUnknown = await resUnknown.json().catch(() => ({}));
          const v2Inactive = resUnknown.status === 403 && /二代模式已关闭|仅 (social|reserved2) 模式可用|当前模式不允许|本机 IPC|原生桌面模式/.test(String(bodyUnknown.error || ''));
          if (v2Inactive) {
            console.log('⚠️ 跳过桥接端点正向检查：运行中的桥接当前未处于 social 模式');
          } else {
            check('桥接端点：未知 messageId 被拒绝', resUnknown.status === 404 && /没有卡片内容|不在当前会话可见范围/.test(String(bodyUnknown.error || '')), 'HTTP ' + resUnknown.status + ' ' + (bodyUnknown.error || ''));

            // ── 正向端到端验证（需要运行中的桥接已加载 markdown 卡片支持，否则跳过） ──
            // 用 /api/status.cardSegments 判断能力，避免把“没重启”误判成回归。
            let liveChecked = false;
            try {
            const statusRes = await fetch('http://127.0.0.1:' + (config.consolePort || 3100) + '/api/status', { headers: authHeaders, signal: AbortSignal.timeout(5000) });
            const statusBody = await statusRes.json().catch(() => ({}));
            const segments = Array.isArray(statusBody.cardSegments) ? statusBody.cardSegments : [];
            if (!segments.includes('markdown')) {
              console.log('⚠️ 跳过卡片正向验证：运行中的桥接尚未加载 QQ 官方 markdown 卡片支持（重启桥接后生效）');
            } else if (conv[0].startsWith('group:')) {
              // 从 OneBot 真实历史里挑一条带卡片的群消息，走桥接端点读回卡片与插图。
              const rawCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
              const ob = rawCfg.snowluma ?? {};
              const groupId = Number(conv[0].slice('group:'.length));
              const histRes = await fetch(String(ob.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '') + '/get_group_msg_history', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(ob.accessToken ? { authorization: 'Bearer ' + ob.accessToken } : {}) },
                body: JSON.stringify({ group_id: groupId, count: 30 }),
                signal: AbortSignal.timeout(15000)
              });
              const histBody = await histRes.json().catch(() => null);
              const histList = Array.isArray(histBody?.data) ? histBody.data : (Array.isArray(histBody?.data?.messages) ? histBody.data.messages : []);
              const cardMsg = histList.find((m) => (Array.isArray(m?.message) ? m.message : []).some((s) => s?.type === 'markdown' || s?.type === 'json' || s?.type === 'ark'));
              if (!cardMsg) {
                console.log('⚠️ 跳过卡片正向验证：最近 30 条群消息里没有卡片，稍后重跑即可');
              } else {
                const cid = String(cardMsg.message_id);
                const cardRes = await fetch(base + '?key=' + encodeURIComponent(conv[0]) + '&messageId=' + encodeURIComponent(cid), {
                  headers: { ...authHeaders, 'x-agent-token': agentToken },
                  signal: AbortSignal.timeout(15000)
                });
                const cardBody = await cardRes.json().catch(() => ({}));
                check('桥接正向：能读回真实卡片（含完整原始内容）', cardRes.status === 200 && cardBody.ok === true && cardBody.total >= 1 && !!cardBody.cards?.[0]?.raw, 'HTTP ' + cardRes.status + ' ' + String(cardBody.error || '') + ' total=' + cardBody.total);
                liveChecked = true;
                const imgRes = await fetch('http://127.0.0.1:' + (config.consolePort || 3100) + '/api/images/message?key=' + encodeURIComponent(conv[0]) + '&messageId=' + encodeURIComponent(cid), {
                  headers: { ...authHeaders, 'x-agent-token': agentToken },
                  signal: AbortSignal.timeout(60000)
                });
                const imgBody = await imgRes.json().catch(() => ({}));
                const imgCount = Array.isArray(imgBody.images) ? imgBody.images.length : 0;
                check('桥接正向：卡片插图进入图片管线（AI 可看图）', imgRes.status === 200 && imgCount >= 1, 'HTTP ' + imgRes.status + ' images=' + imgCount + ' ' + String(imgBody.note || ''));
              }
            }
            } catch (error) {
              console.log('⚠️ 卡片正向验证跳过：' + (error?.message ?? error));
            }
            if (!liveChecked) console.log('ℹ️ 正向验证未执行；重启桥接后重跑本脚本即可完成端到端确认');
          }
        }
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken');
      }
    }
  } catch (error) {
    console.log('⚠️ 桥接端点检查跳过：' + (error?.message ?? error));
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

// ── 7. MCP 常驻注册检查（进程内内存传输，绕开子进程管道沙箱限制） ──────────
// 「开关即时生效」的前提是工具**无条件注册**、开关只在执行期判断：
// 因此这里断言 qq_get_card_msg 在 MCP server 启动时就一定出现在工具列表里。
try {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { runMcpSnowLuma } = await import('../src/mcp-snowluma-safe.js');
  check('MCP 常驻注册：提供显式 runMcpSnowLuma 入口', typeof runMcpSnowLuma === 'function');
  if (typeof runMcpSnowLuma === 'function') {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = await runMcpSnowLuma(serverTransport);
    const client = new Client({ name: 'card-test', version: '0.0.1' });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    check('MCP 常驻注册 qq_get_card_msg（不随启动期开关消失）', names.includes('qq_get_card_msg'));
    check('MCP 常驻注册 qq_click_card_button（默认关闭仍可发现）', names.includes('qq_click_card_button'));
    check('MCP 常驻注册 qq_get_card_button_approval', names.includes('qq_get_card_button_approval'));
    const tool = listed.tools.find((t) => t.name === 'qq_get_card_msg');
    const props = Object.keys(tool?.inputSchema?.properties ?? {});
    check('MCP 工具入参含 key/token/messageId（可选 index）', props.includes('key') && props.includes('token') && props.includes('messageId') && props.includes('index'));
    check('MCP 卡片查看工具描述说明只读', /只读/.test(String(tool?.description || '')));
    const clickTool = listed.tools.find((t) => t.name === 'qq_click_card_button');
    const clickProps = Object.keys(clickTool?.inputSchema?.properties ?? {});
    check('MCP 点击工具参数仅索引选择且含逐次确认', clickProps.includes('key') && clickProps.includes('token') && clickProps.includes('messageId') && clickProps.includes('cardIndex') && clickProps.includes('buttonIndex') && clickProps.includes('confirm') && !clickProps.includes('callback_data') && !clickProps.includes('bot_appid'));
    check('MCP 点击工具明确标注高风险/默认关闭', /高风险/.test(String(clickTool?.description || '')) && /默认关闭/.test(String(clickTool?.description || '')));
    const approvalTool = listed.tools.find((t) => t.name === 'qq_get_card_button_approval');
    const approvalProps = Object.keys(approvalTool?.inputSchema?.properties ?? {});
    check('MCP 审批查询仅需会话令牌和审批编号', approvalProps.includes('key') && approvalProps.includes('token') && approvalProps.includes('approvalId'));
    await client.close();
    try { await mcpServer.close(); } catch {}
  }
} catch (error) {
  check('MCP 常驻注册检查（内存传输）', false, error?.message ?? String(error));
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exitCode = failed > 0 ? 1 : 0;
