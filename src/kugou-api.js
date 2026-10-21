// 酷狗音乐 API — 完整移植自 kugou.rs（Mineradio kugou-api.js）
//
// 所有签名算法、API 端点、请求参数、降级策略均与 kugou.rs / kugou-api.js 一致。
// 供 qq_search_audio（MCP 工具）与桥接控制台「酷狗登录」共用。
import crypto from 'node:crypto';

// ============================================================
//  常量 (对照 kugou.rs)
// ============================================================
const KUGOU_SEARCH_URL = 'http://songsearch.kugou.com/song_search_v2';
const KUGOU_PLAY_MOBILE = 'http://m.kugou.com/app/i/getSongInfo.php';
const KUGOU_PLAY_WEB = 'https://wwwapi.kugou.com/yy/index.php';
const KUGOU_GATEWAY = 'https://gateway.kugou.com';

const KUGOU_APPID = 1005;
const KUGOU_WEB_APPID = 1014;
const KUGOU_CLIENTVER = 20489;
const KUGOU_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';
const KUGOU_H5_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KUGOU_H5_SRC_APPID = '2919';
const KUGOU_H5_CLIENTVER = 20000;
const KUGOU_SIGN_KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d';
const KUGOU_GATEWAY_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const KUGOU_H5_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const KUGOU_REFERER = 'https://www.kugou.com/';
const KUGOU_VIP_ROLEINFO_URL = 'https://vip.kugou.com/recharge/roleinfo';

// Web roleinfo 角色映射 (对照 kugou.rs KUGOU_WEB_VIP_ROLES / SVIP / MUSIC_PACKAGE)
const KUGOU_WEB_VIP_ROLES = [1, 2];
const KUGOU_WEB_SVIP_ROLES = [6, 11, 13];
const KUGOU_WEB_ROLE_KEYS = [
  'role', 'user_type', 'userType', 'usertype',
  'user_y_type', 'userYType', 'userytype', 'y_type', 'yType', 'ytype',
];

// 音质降级链 (对照 kugou.rs KUGOU_QUALITY_CHAIN)
const KUGOU_QUALITY_CHAIN = [
  ['jymaster', 'Hi-Res', 'ResFileHash'],
  ['hires', 'Hi-Res', 'ResFileHash'],
  ['lossless', '无损', 'SQFileHash'],
  ['exhigh', '极高', 'HQFileHash'],
  ['standard', '标准', 'FileHash'],
];

// ============================================================
//  MD5 工具
// ============================================================
export function md5Hex(input) {
  return crypto.createHash('md5').update(String(input ?? ''), 'utf8').digest('hex');
}

function nowMs() { return Date.now(); }
function nowSecs() { return Math.floor(Date.now() / 1000); }

// ============================================================
//  Cookie 解析 (对照 kugou.rs)
// ============================================================
export function parseCookieString(cookie) {
  const map = new Map();
  for (const part of String(cookie ?? '').split(';')) {
    const p = part.trim();
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

export function parseKugooCompound(raw) {
  const out = new Map();
  let text = String(raw ?? '').trim();
  if (!text) return out;
  try { text = decodeURIComponent(text); } catch {}
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out.set(key, value);
  }
  return out;
}

// 解码酷狗显示文本 (对照 decodeKugouDisplayText)
function decodeDisplayText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  let result = raw;
  // 1. %uXXXX 非标准 Unicode 编码
  if (result.includes('%u')) {
    result = result.replace(/%u([0-9a-fA-F]{4})/g, function (_, hex) {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '%u' + hex;
    });
  }
  // 2. 标准 URL 解码（仅当无 CJK 字符时，避免破坏已解码内容）
  const hasCjk = /[\u3400-\u9fff]/.test(result);
  if (!hasCjk && result.includes('%')) {
    try { result = decodeURIComponent(result.replace(/\+/g, ' ')); } catch {}
  }
  return result.trim();
}

function stripHtml(text) {
  let result = '';
  let inTag = false;
  for (const ch of String(text ?? '')) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) result += ch;
  }
  return decodeDisplayText(result.trim());
}

// ============================================================
//  认证信息提取 (对照 extract_kugou_auth)
// ============================================================
function createKugouMid(seed) {
  return md5Hex(String(seed ?? '') + Math.floor(Math.random() * 1e15));
}

function firstPositiveKugouCookie(objects, keys) {
  for (const obj of objects) {
    for (const key of keys) {
      const raw = obj.get(key);
      if (raw === undefined) continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
      const lower = String(raw).trim().toLowerCase();
      if (['true', 'yes', 'active', 'valid', 'enabled', 'vip', 'svip', 'premium', 'member'].includes(lower)) return 1;
    }
  }
  return 0;
}

export function extractKugouAuth(cookie) {
  const obj = parseCookieString(cookie);
  const kugoo = parseKugooCompound(obj.get('KuGoo') ?? obj.get('kugou') ?? obj.get('Kugou') ?? '');

  const userid = (obj.get('userid') ?? obj.get('UserId') ?? obj.get('KugooID') ?? obj.get('kugouID')
    ?? kugoo.get('KugooID') ?? kugoo.get('kugouID') ?? kugoo.get('userid') ?? kugoo.get('uid') ?? '')
    .toString().replace(/\D/g, '');

  const token = String(obj.get('token') ?? obj.get('Token') ?? obj.get('t') ?? obj.get('T')
    ?? kugoo.get('t') ?? kugoo.get('token') ?? '').trim();

  const mid = String(obj.get('kg_mid') ?? obj.get('KG_MID') ?? obj.get('KUGOU_API_MID') ?? obj.get('mid') ?? '').trim()
    || createKugouMid('nexbox');

  const dfid = String(obj.get('kg_dfid') ?? obj.get('KG_DFID') ?? obj.get('dfid') ?? obj.get('DFID') ?? '').trim() || '-';

  const nickname = decodeDisplayText(String(kugoo.get('NickName') ?? kugoo.get('nickname')
    ?? obj.get('NickName') ?? obj.get('nickname') ?? obj.get('UserName') ?? obj.get('username') ?? ''));

  const avatar = String(kugoo.get('Pic') ?? kugoo.get('pic') ?? obj.get('Pic') ?? obj.get('avatar') ?? '').trim();

  const loggedIn = (!!userid && userid !== '0') || obj.has('KuGoo') || obj.has('kugou') || obj.has('Kugou');
  const playbackReady = !!userid && userid !== '0' && !!token;

  const vipType = firstPositiveKugouCookie([obj, kugoo], [
    'isVIP', 'isVip', 'is_vip', 'vip_type', 'VIPType', 'vipLevel', 'vip_level',
    'vip_status', 'member_type', 'member_level', 'vip',
  ]);
  const svipType = firstPositiveKugouCookie([obj, kugoo], [
    'isSVIP', 'isSvip', 'is_svip', 'svip_type', 'SVIPType', 'superVip', 'super_vip',
    'svip_level', 'svip_status', 'svip',
  ]);
  const isSvip = svipType > 0;
  const isVip = isSvip || vipType > 0;
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');

  return { userid, token, mid, dfid, nickname, avatar, vipType, svipType, vipLevel, isVip, isSvip, loggedIn, playbackReady };
}

export function kugouCookieHasLogin(cookie) { return extractKugouAuth(cookie).loggedIn; }
export function kugouCookieHasPlayback(cookie) { return extractKugouAuth(cookie).playbackReady; }

// ============================================================
//  签名与请求构建 (对照 kugou.rs)
// ============================================================
function kugouCloudKey(hash) { return md5Hex(hash + 'kgcloud'); }
function signKey(hash, mid, userid, appid) { return md5Hex(hash + KUGOU_SIGN_KEY_SALT + appid + mid + userid); }

function signatureAndroid(params, body) {
  const sorted = [...params].sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  const paramsStr = sorted.map(function (kv) { return kv[0] + '=' + kv[1]; }).join('');
  return md5Hex(KUGOU_ANDROID_SALT + paramsStr + (body ?? '') + KUGOU_ANDROID_SALT);
}

function signatureH5(params, body) {
  const sorted = [...params].sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  const parts = sorted.map(function (kv) { return kv[0] + '=' + kv[1]; });
  if (body !== undefined && body !== null) parts.push(typeof body === 'string' ? body : JSON.stringify(body));
  return md5Hex(KUGOU_H5_SALT + parts.join('') + KUGOU_H5_SALT);
}

// Object.assign 语义：extra 覆盖默认同名 key
function assignParams(base, extra) {
  const out = [...base];
  for (const entry of extra) {
    const idx = out.findIndex(function (kv) { return kv[0] === entry[0]; });
    if (idx >= 0) out[idx] = [entry[0], entry[1]];
    else out.push([entry[0], entry[1]]);
  }
  return out;
}

function buildH5Params(auth, extra) {
  const now = nowMs();
  return assignParams([
    ['srcappid', KUGOU_H5_SRC_APPID],
    ['clientver', String(KUGOU_H5_CLIENTVER)],
    ['clienttime', String(now)],
    ['mid', auth.mid || createKugouMid('gateway')],
    ['uuid', String(now)],
    ['dfid', auth.dfid || '-'],
    ['appid', String(KUGOU_WEB_APPID)],
    ['token', auth.token],
    ['userid', auth.userid || '0'],
  ], extra);
}

function buildGatewayParams(auth, extra) {
  const clienttime = nowSecs();
  return assignParams([
    ['dfid', auth.dfid || '-'],
    ['mid', auth.mid || createKugouMid('gateway')],
    ['uuid', '-'],
    ['appid', String(KUGOU_APPID)],
    ['clientver', String(KUGOU_CLIENTVER)],
    ['clienttime', String(clienttime)],
    ['token', auth.token],
    ['userid', auth.userid || '0'],
  ], extra);
}

// 构建 Cookie 请求头 (补充 mid/dfid)
export function buildRequestCookie(cookie) {
  const obj = parseCookieString(cookie);
  const mid = obj.get('kg_mid') ?? obj.get('KG_MID') ?? createKugouMid('nexbox');
  const dfid = obj.get('kg_dfid') ?? obj.get('KG_DFID') ?? '-';

  const parts = [];
  if (String(cookie ?? '').trim()) parts.push(String(cookie).trim());
  if (!obj.has('kg_mid') && !obj.has('KG_MID')) parts.push('kg_mid=' + mid);
  if (!obj.has('kg_dfid') && !obj.has('KG_DFID')) parts.push('kg_dfid=' + dfid);

  const merged = new Map();
  for (const part of parts.join('; ').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) merged.set(key, value);
  }
  return [...merged.entries()].map(function (kv) { return kv[0] + '=' + kv[1]; }).join('; ');
}

// ============================================================
//  HTTP 请求
// ============================================================
async function requestJson(url, method, headers = {}, timeoutMs = 12000) {
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch (e) { throw new Error('Failed to parse JSON: ' + text.slice(0, 200)); }
}

// ============================================================
//  工具函数
// ============================================================
function kugouCoverUrl(raw, size) {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return 'https://imge.kugou.com' + url;
  return url.replace(/\{size\}/g, String(size));
}

function firstString(item, keys) {
  for (const k of keys) {
    const v = item?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

// ============================================================
//  搜索 (对照 kugou.rs search + map_search_item)
// ============================================================
export async function kugouSearch(query, limit, cookie) {
  const auth = extractKugouAuth(cookie);
  const pageSize = Math.max(1, Math.min(20, Number(limit) || 5));
  const url = new URL(KUGOU_SEARCH_URL);
  url.searchParams.set('keyword', String(query ?? ''));
  url.searchParams.set('page', '1');
  url.searchParams.set('pagesize', String(pageSize));
  url.searchParams.set('userid', auth.userid || '-1');
  url.searchParams.set('clientver', '2000');
  url.searchParams.set('platform', 'WebFilter');
  url.searchParams.set('tag', 'em');
  url.searchParams.set('filter', '2');
  url.searchParams.set('iscorrection', '1');
  url.searchParams.set('privilege_filter', '0');
  url.searchParams.set('filter_ver', '2');
  url.searchParams.set('appid', String(KUGOU_WEB_APPID));
  url.searchParams.set('token', auth.token);
  url.searchParams.set('mid', auth.mid);

  const headers = {
    'user-agent': KUGOU_H5_UA,
    referer: KUGOU_REFERER,
    cookie: buildRequestCookie(cookie),
  };
  const json = await requestJson(url.toString(), 'GET', headers);
  const list = (json?.data?.lists ?? []).filter(function (it) { return it && typeof it === 'object'; });
  return list.map(mapSearchItem).filter(function (s) { return s.name && (s.hash || s.id); });
}

function mapSearchItem(item) {
  const hash = firstString(item, ['FileHash']).toLowerCase();
  const albumId = firstString(item, ['AlbumID']);
  const mixSongId = firstString(item, ['MixSongID']);
  const albumAudioIdRaw = firstString(item, ['EMixSongID', 'AlbumAudioID', 'album_audio_id']);
  const albumAudioId = (/^\d+$/.test(mixSongId) && mixSongId) ? mixSongId : albumAudioIdRaw;

  const name = stripHtml(firstString(item, ['SongName', 'FileName', 'OriSongName']));
  const singer = stripHtml(firstString(item, ['SingerName']));
  const album = stripHtml(firstString(item, ['AlbumName']));
  const privilege = Number(item.Privilege ?? 0) || 0;
  const durationSec = Number(item.Duration ?? 0) || 0;

  const coverRaw = firstString(item, ['Image', 'AlbumImage', 'cover', 'img']);
  const coverFromAlbuminfo = firstString(item.albuminfo || {}, ['img', 'cover', 'sizable_cover']);
  const coverFromTrans = firstString(item.trans_param || {}, ['union_cover']);

  const hqHash = firstString(item, ['HQFileHash']).toLowerCase();
  const sqHash = firstString(item, ['SQFileHash']).toLowerCase();
  const resHash = firstString(item, ['ResFileHash']).toLowerCase();

  return {
    provider: 'kugou',
    id: hash || mixSongId || albumAudioId,
    name,
    singer,
    album,
    filename: stripHtml(firstString(item, ['FileName'])) || name,
    coverUrl: kugouCoverUrl(coverRaw || coverFromAlbuminfo || coverFromTrans, 240),
    durationSec,
    hash,
    hqHash,
    sqHash,
    resHash,
    albumId,
    albumAudioId,
    privilege,
    fee: privilege >= 10 ? 1 : 0,
    playable: privilege <= 8,
  };
}

// ============================================================
//  播放 URL 解析 — 4 级降级 (对照 play_via_h5/mobile/web/gateway + song_url)
// ============================================================
function normalizeQualityPreference(q) {
  const s = String(q ?? '').toLowerCase();
  return ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'].includes(s) ? s : 'standard';
}

function kugouQualityParam(requestedQuality) {
  const level = normalizeQualityPreference(requestedQuality);
  const map = { jymaster: 'viper_tape', hires: 'hires', lossless: 'flac', exhigh: '320' };
  return map[level] ?? '128';
}

function kugouQualityFromParam(param, fallbackLevel) {
  const text = String(param ?? '').toLowerCase();
  if (text === 'viper_tape' || text === 'jymaster') return 'jymaster';
  if (text === 'hires' || text === 'hi_res') return 'hires';
  if (text === 'flac' || text === 'lossless' || text === 'sq') return 'lossless';
  if (text === '320' || text === 'exhigh' || text === 'hq') return 'exhigh';
  const n = Number(param);
  if (Number.isFinite(n) && n >= 320) return 'exhigh';
  if (Number.isFinite(n) && n >= 192) return 'exhigh';
  return normalizeQualityPreference(fallbackLevel);
}

function pickPlayUrl(json) {
  if (!json || typeof json !== 'object') return '';
  const pick = function (val) {
    if (Array.isArray(val)) {
      for (const v of val) { if (v !== null && v !== undefined) return String(v); }
      return null;
    }
    if (typeof val === 'string' && val) return val;
    return null;
  };
  const data = json.data ?? {};
  const url = pick(json.url) ?? pick(json.play_url) ?? pick(json.backupUrl)
    ?? pick(data.url) ?? pick(data.play_url) ?? pick(data.backupUrl) ?? '';
  return url.replace(/\\\//g, '/').trim();
}

async function playViaH5(hash, albumId, albumAudioId, cookie, requestedQuality) {
  const auth = extractKugouAuth(cookie);
  if (!auth.playbackReady) return null;
  const quality = kugouQualityParam(requestedQuality);
  const fileHash = hash.toLowerCase();
  const params = buildH5Params(auth, [
    ['album_id', String(parseInt(albumId, 10) || 0)],
    ['area_code', '1'],
    ['hash', fileHash],
    ['ssa_flag', 'is_fromtrack'],
    ['version', '11430'],
    ['quality', quality],
    ['album_audio_id', String(parseInt(albumAudioId, 10) || 0)],
    ['behavior', 'play'],
    ['pid', '2'],
    ['cmd', '26'],
    ['pidversion', '3001'],
    ['IsFreePart', '1'],
    ['cdnBackup', '1'],
    ['module', ''],
  ]);
  params.push(['key', signKey(fileHash, auth.mid, auth.userid, KUGOU_WEB_APPID)]);
  params.push(['signature', signatureH5(params, undefined)]);

  const url = new URL(KUGOU_GATEWAY + '/v5/url');
  for (const entry of params) url.searchParams.append(entry[0], entry[1]);

  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_H5_UA,
    referer: KUGOU_REFERER,
    'x-router': 'trackercdn.kugou.com',
    cookie: buildRequestCookie(cookie),
  });
  const urlStr = pickPlayUrl(json);
  if (Number(json?.status) === 1 && urlStr) {
    const level = kugouQualityFromParam(quality, requestedQuality);
    return { url: urlStr, level, quality: level, trial: false, source: 'h5', restricted: false };
  }
  const errMsg = String(json?.error ?? json?.msg ?? '');
  if (/付费|会员|vip|登录/i.test(errMsg)) {
    return { url: '', restricted: true, category: auth.playbackReady ? 'vip_required' : 'login_required', message: errMsg };
  }
  return null;
}

async function playViaMobile(hash, albumId, cookie) {
  const auth = extractKugouAuth(cookie);
  const key = kugouCloudKey(hash);
  const url = new URL(KUGOU_PLAY_MOBILE);
  url.searchParams.set('cmd', 'playInfo');
  url.searchParams.set('hash', hash);
  url.searchParams.set('key', key);
  url.searchParams.set('album_id', String(albumId ?? ''));
  url.searchParams.set('pid', '1');
  url.searchParams.set('forceDown', '0');
  url.searchParams.set('vip', '65530');
  if (auth.userid) url.searchParams.set('userid', auth.userid);
  if (auth.token) url.searchParams.set('token', auth.token);

  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_H5_UA,
    referer: 'https://m.kugou.com/',
    cookie: buildRequestCookie(cookie),
  });
  const urlStr = String(json?.url ?? json?.backup_url ?? '');
  if (Number(json?.status) === 1 && urlStr) {
    return { url: urlStr, level: 'standard', quality: '标准', trial: false, source: 'mobile', restricted: false };
  }
  const errMsg = String(json?.error ?? json?.errmsg ?? '');
  if (/付费|会员|vip/i.test(errMsg)) {
    return { url: '', restricted: true, category: 'vip_required', message: '酷狗歌曲需要会员或付费权限' };
  }
  return null;
}

async function playViaWeb(hash, albumId, albumAudioId, cookie) {
  const auth = extractKugouAuth(cookie);
  const url = new URL(KUGOU_PLAY_WEB);
  url.searchParams.set('r', 'play/getdata');
  url.searchParams.set('hash', hash);
  url.searchParams.set('album_id', String(albumId ?? ''));
  if (albumAudioId) url.searchParams.set('album_audio_id', String(albumAudioId));
  url.searchParams.set('appid', String(KUGOU_WEB_APPID));
  url.searchParams.set('platid', '4');
  url.searchParams.set('mid', auth.mid);
  url.searchParams.set('dfid', auth.dfid || '-');
  url.searchParams.set('userid', auth.userid || '0');
  url.searchParams.set('token', auth.token);

  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_H5_UA,
    referer: KUGOU_REFERER,
    cookie: buildRequestCookie(cookie),
  });
  const data = json?.data ?? {};
  const urlStr = String(data.play_url ?? data.play_backup_url ?? '').replace(/\\\//g, '/').trim();
  if (Number(json?.status) === 1 && urlStr) {
    const bitrate = Number(data.bitrate ?? 0) || 0;
    const level = bitrate >= 900 ? 'lossless' : (bitrate >= 300 ? 'exhigh' : 'standard');
    return { url: urlStr, level, quality: level, trial: false, source: 'web', restricted: false };
  }
  return null;
}

async function playViaGateway(hash, albumId, albumAudioId, cookie, requestedQuality) {
  const auth = extractKugouAuth(cookie);
  if (!auth.playbackReady) return null;
  const quality = kugouQualityParam(requestedQuality);
  const clienttime = nowSecs();
  const base = [
    ['dfid', auth.dfid || '-'],
    ['mid', auth.mid],
    ['uuid', '-'],
    ['appid', String(KUGOU_APPID)],
    ['clientver', String(KUGOU_CLIENTVER)],
    ['clienttime', String(clienttime)],
    ['token', auth.token],
    ['userid', auth.userid],
    ['album_id', String(parseInt(albumId, 10) || 0)],
    ['area_code', '1'],
    ['hash', hash.toLowerCase()],
    ['ssa_flag', 'is_fromtrack'],
    ['version', '11430'],
    ['quality', quality],
    ['album_audio_id', String(parseInt(albumAudioId, 10) || 0)],
    ['behavior', 'play'],
    ['pid', '2'],
    ['cmd', '26'],
    ['pidversion', '3001'],
    ['IsFreePart', '1'],
    ['cdnBackup', '1'],
    ['module', ''],
  ];
  const key = signKey(hash.toLowerCase(), auth.mid, auth.userid, KUGOU_APPID);
  const allParams = [...base, ['key', key]];
  const sig = signatureAndroid(allParams, '');
  allParams.push(['signature', sig]);

  const url = new URL(KUGOU_GATEWAY + '/v5/url');
  for (const entry of allParams) url.searchParams.append(entry[0], entry[1]);

  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_GATEWAY_UA,
    referer: KUGOU_REFERER,
    dfid: auth.dfid,
    mid: auth.mid,
    clienttime: String(clienttime),
    'x-router': 'trackercdn.kugou.com',
    cookie: buildRequestCookie(cookie),
  });
  const data = json?.data ?? json;
  const urlStr = String(data?.url ?? data?.play_url ?? data?.play_backup_url ?? '').replace(/\\\//g, '/').trim();
  if (urlStr) {
    const level = kugouQualityFromParam(quality, requestedQuality);
    return { url: urlStr, level, quality: level, trial: false, source: 'gateway', restricted: false };
  }
  return null;
}

function hashCandidatesFromSong(song, requestedQuality) {
  const requested = normalizeQualityPreference(requestedQuality);
  const idx = KUGOU_QUALITY_CHAIN.findIndex(function (c) { return c[0] === requested; });
  const startIdx = idx >= 0 ? idx : 0;
  const chain = KUGOU_QUALITY_CHAIN.slice(startIdx);

  const out = [];
  const seen = new Set();
  for (const entry of chain) {
    const key = entry[0], label = entry[1], field = entry[2];
    let hash = '';
    if (field === 'FileHash') hash = song.hash || '';
    else if (field === 'HQFileHash') hash = song.hqHash || '';
    else if (field === 'SQFileHash') hash = song.sqHash || '';
    else if (field === 'ResFileHash') hash = song.resHash || '';
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    out.push([hash, key, label]);
  }
  if (song.hash && !seen.has(song.hash)) out.push([song.hash, 'standard', '标准']);
  return out;
}

// 解析歌曲播放 URL（4 级降级 + 音质链）— 对照 kugou.rs song_url
export async function resolveSongUrl(song, cookie, requestedQuality = 'standard') {
  const auth = extractKugouAuth(cookie);
  const hash = String(song.hash ?? '').trim();
  if (!hash) {
    return { url: null, playable: false, level: '', quality: '', source: null, reason: 'MISSING_HASH', message: '缺少酷狗歌曲 hash' };
  }
  const quality = normalizeQualityPreference(requestedQuality);

  let candidates = hashCandidatesFromSong(song, quality);
  if (!candidates.length) candidates = [[hash, 'standard', '标准']];

  let lastRestriction = null;
  for (const candidate of candidates) {
    const candidateHash = candidate[0];
    const level = candidate[1];
    try {
      const h5 = await playViaH5(candidateHash, song.albumId, song.albumAudioId, cookie, level);
      if (h5?.url) return { url: h5.url, playable: true, level: h5.level, quality: h5.quality, source: h5.source, reason: null, message: null };
      if (h5?.restricted) lastRestriction = h5;
    } catch {}
    try {
      const mobile = await playViaMobile(candidateHash, song.albumId, cookie);
      if (mobile?.url) return { url: mobile.url, playable: true, level, quality: level, source: mobile.source, reason: null, message: null };
      if (mobile?.restricted) lastRestriction = mobile;
    } catch {}
    try {
      const web = await playViaWeb(candidateHash, song.albumId, song.albumAudioId, cookie);
      if (web?.url) return { url: web.url, playable: true, level: web.level, quality: web.quality, source: web.source, reason: null, message: null };
      if (web?.restricted) lastRestriction = web;
    } catch {}
    try {
      const gw = await playViaGateway(candidateHash, song.albumId, song.albumAudioId, cookie, level);
      if (gw?.url) return { url: gw.url, playable: true, level: gw.level, quality: gw.quality, source: gw.source, reason: null, message: null };
      if (gw?.restricted) lastRestriction = gw;
    } catch {}
  }

  const category = auth.playbackReady ? 'vip_required' : 'login_required';
  const message = auth.playbackReady ? '酷狗歌曲需要会员或付费权限' : '酷狗歌曲需要登录后再播放';
  return {
    url: null, playable: false, level: quality, quality, source: null,
    reason: (lastRestriction && lastRestriction.category) || category,
    message: (lastRestriction && lastRestriction.message) || message,
  };
}

// ============================================================
//  登录信息 (对照 login_info / fetch_kugou_web_vip_info / normalize_vip_payload)
// ============================================================
function firstPositiveKugouNumber(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const raw = obj[key];
      if (raw === undefined || raw === null) continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
      if (typeof raw === 'boolean' && raw) return 1;
      if (typeof raw === 'string') {
        const lower = raw.trim().toLowerCase();
        if (['true', 'yes', 'active', 'valid', 'enabled', 'vip', 'svip', 'premium', 'member'].includes(lower)) return 1;
      }
    }
  }
  return 0;
}

function collectVipObjects(value, out, depth) {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const it of value) collectVipObjects(it, out, depth + 1); return; }
  if (typeof value === 'object') {
    out.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') collectVipObjects(child, out, depth + 1);
    }
  }
}

function kugouTimeState(objects, keys) {
  const nowS = nowSecs(), nowM = nowMs();
  let present = false, future = false;
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const val = obj[key];
      if (val === undefined || val === null) continue;
      const v = Number(val);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (v > 100000000000) { present = true; if (v > nowM) future = true; }
      else if (v > 1000000000) { present = true; if (v > nowS) future = true; }
    }
  }
  return [present, future];
}

function normalizeVipPayload(payload, fallbackAuth) {
  const membershipOrigin = String(payload?.__kugouMembershipOrigin ?? '');
  const isWebRolePayload = membershipOrigin === 'kugou-web-roleinfo';
  const data = payload?.data ?? payload?.result ?? payload?.vip ?? payload;

  const expectedUserid = String(fallbackAuth.userid ?? '').replace(/\D/g, '');

  const allObjects = [];
  collectVipObjects(data, allObjects, 0);

  const payloadObjects = allObjects.filter(function (obj) {
    if (!expectedUserid) return true;
    const objUserid = String(obj.userid ?? obj.user_id ?? obj.userId ?? obj.uid ?? obj.KugooID ?? '').replace(/\D/g, '');
    return !objUserid || objUserid === expectedUserid;
  });
  if (!payloadObjects.length) {
    return { vipType: 0, svipType: 0, vipLevel: 'none', isVip: false, isSvip: false, membershipKnown: false, webRole: 0, webRoleKnown: false };
  }

  let webRole = 0;
  if (isWebRolePayload) webRole = firstPositiveKugouNumber(payloadObjects, KUGOU_WEB_ROLE_KEYS);
  const webRoleKnown = webRole > 0 && isWebRolePayload;
  if (webRoleKnown) {
    const role = Math.trunc(webRole);
    const roleIsVip = KUGOU_WEB_VIP_ROLES.includes(role);
    const roleIsSvip = KUGOU_WEB_SVIP_ROLES.includes(role);
    const ts = kugouTimeState(payloadObjects, ['rawVipEndTime', 'raw_vip_end_time', 'rawvipendtime', 'vip_end_time', 'vipEndTime', 'vip_expire_time', 'vipExpireTime']);
    const vipPresent = ts[0], vipFuture = ts[1];
    const roleExpiryCurrent = !vipPresent || vipFuture;
    const isSvip = roleIsSvip && roleExpiryCurrent;
    const isVip = (roleIsVip || roleIsSvip) && roleExpiryCurrent;
    const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
    return { vipType: isVip ? role : 0, svipType: isSvip ? role : 0, vipLevel, isVip, isSvip, membershipKnown: true, webRole: role, webRoleKnown: true };
  }

  const hasSignal = payloadObjects.some(function (obj) {
    return Object.keys(obj).some(function (k) {
      const nk = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      return /^isvip$|^issvip$|^viptype$|^sviptype$|^viplevel$|^sviplevel$|^svip/.test(nk);
    });
  });
  if (!hasSignal) {
    return { vipType: 0, svipType: 0, vipLevel: 'none', isVip: false, isSvip: false, membershipKnown: false, webRole: 0, webRoleKnown: false };
  }

  const vipType = firstPositiveKugouNumber(payloadObjects, ['vipType', 'vip_type', 'VIPType', 'isVIP', 'isVip', 'is_vip', 'vip_level', 'vipLevel', 'music_vip_level', 'musicVipLevel', 'm_type', 'p_type', 'vip_y_type', 'union_vip_type', 'user_vip_type', 'vip_status', 'member_type', 'member_level', 'vip']);
  const svipType = firstPositiveKugouNumber(payloadObjects, ['svipType', 'svip_type', 'SVIPType', 'isSVIP', 'isSvip', 'is_svip', 'superVip', 'super_vip', 'superVipLevel', 'super_vip_level', 'super_vip_type', 'luxury_vip_type', 'vip_luxury_type', 'svip_level', 'svip_status', 'svip']);
  const vipTs = kugouTimeState(payloadObjects, ['vip_end_time', 'vipEndTime', 'vip_expire_time', 'vipExpireTime', 'vip_expire', 'vipExpire', 'music_vip_end_time', 'musicVipEndTime']);
  const svipTs = kugouTimeState(payloadObjects, ['svip_end_time', 'svipEndTime', 'svip_expire_time', 'svipExpireTime', 'super_vip_end_time', 'superVipEndTime', 'luxury_vip_end_time', 'luxuryVipEndTime']);
  const vipPresent = vipTs[0], vipFuture = vipTs[1];
  const svipPresent = svipTs[0], svipFuture = svipTs[1];

  const isSvip = svipFuture || (svipType > 0 && !svipPresent) || payloadObjects.some(function (o) { return o.isSvip === true && !svipPresent; });
  const isVip = isSvip || vipFuture || (vipType > 0 && !vipPresent) || payloadObjects.some(function (o) { return o.isVip === true && !vipPresent; });
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
  return { vipType, svipType, vipLevel, isVip, isSvip, membershipKnown: true, webRole: 0, webRoleKnown: false };
}

async function fetchKugouWebVipInfo(cookie, auth) {
  if (!auth.loggedIn || !cookie) return null;
  const url = KUGOU_VIP_ROLEINFO_URL + '?n=' + nowMs();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer: 'https://vip.kugou.com/',
        'user-agent': KUGOU_H5_UA,
        'x-requested-with': 'XMLHttpRequest',
        cookie: buildRequestCookie(cookie),
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const data = body?.data ?? body;
    const errnoKeys = ['errno', 'error_code', 'errorCode', 'errcode'];
    const hasError = errnoKeys.some(function (k) { return Number(body?.[k] ?? data?.[k]) > 0; });
    const explicitlyFailed = body?.success === false
      || body?.status === 0 || body?.status === '0' || body?.status === '-1'
      || ['false', 'fail', 'failed', 'error'].includes(String(body?.status).toLowerCase())
      || (typeof body?.error === 'string' && body.error.trim());
    if (hasError || explicitlyFailed) return null;
    return { data: body?.data ?? body, __kugouMembershipOrigin: 'kugou-web-roleinfo' };
  } catch { return null; }
}

async function fetchProfileFromMobile(cookie, auth) {
  if (!auth.playbackReady) return { nickname: '', avatar: '', payload: null };
  try {
    const url = new URL('http://mobilecdn.kugou.com/api/v3/user/info');
    url.searchParams.set('userid', auth.userid);
    url.searchParams.set('token', auth.token);
    const json = await requestJson(url.toString(), 'GET', {
      'user-agent': KUGOU_H5_UA,
      referer: 'http://m.kugou.com/',
      cookie: buildRequestCookie(cookie),
    }, 6000);
    const data = json?.data ?? json?.info ?? {};
    return {
      nickname: decodeDisplayText(firstString(data, ['nickname', 'nickName', 'username', 'user_name', 'name'])),
      avatar: firstString(data, ['avatar', 'imgurl', 'sizable_avatar', 'pic']),
      payload: data,
    };
  } catch { return { nickname: '', avatar: '', payload: null }; }
}

// Gateway 会员探测（Android 签名 + x-router=kugouvip.kugou.com）
// 注：QR 扫码登录得到的移动端 token 走此路可正常返回会员信息；
//     而 web roleinfo(vip.kugou.com) 对该 token 会返回 errno=105，mobilecdn 返回 Access Deny。
async function fetchKugouGatewayVipInfo(cookie, auth) {
  if (!auth.playbackReady) return null;
  const clienttime = nowSecs();
  const mid = auth.mid || createKugouMid('gateway');
  const params = [
    ['dfid', auth.dfid || '-'],
    ['mid', mid],
    ['uuid', '-'],
    ['appid', String(KUGOU_APPID)],
    ['clientver', String(KUGOU_CLIENTVER)],
    ['clienttime', String(clienttime)],
    ['token', auth.token],
    ['userid', auth.userid || '0'],
    ['busi_type', 'concept'],
  ];
  const sig = signatureAndroid(params, '');
  params.push(['signature', sig]);
  const url = new URL(KUGOU_GATEWAY + '/v1/get_union_vip');
  for (const entry of params) url.searchParams.append(entry[0], entry[1]);
  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_GATEWAY_UA,
    referer: KUGOU_REFERER,
    dfid: auth.dfid || '-',
    mid: mid,
    clienttime: String(clienttime),
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    'x-router': 'kugouvip.kugou.com',
    cookie: buildRequestCookie(cookie),
  }, 6000);
  return json;
}

// 获取登录信息（对照 login_info）：并行探测 个人资料 + 会员状态（web roleinfo / gateway get_union_vip / mobilecdn）
export async function loginInfo(cookie) {
  const auth = extractKugouAuth(cookie);

  let nickname = auth.nickname;
  let avatar = auth.avatar;
  let mobilePayload = null;
  let webVip = null;
  let gatewayVip = null;

  if (auth.playbackReady) {
    const probes = await Promise.all([
      fetchProfileFromMobile(cookie, auth).catch(function () { return null; }),
      fetchKugouWebVipInfo(cookie, auth).catch(function () { return null; }),
      fetchKugouGatewayVipInfo(cookie, auth).catch(function () { return null; }),
    ]);
    const prof = probes[0];
    webVip = probes[1];
    gatewayVip = probes[2];
    if (prof) {
      if (!nickname) nickname = prof.nickname;
      if (!avatar) avatar = prof.avatar;
      mobilePayload = prof.payload;
    }
  }
  if (!nickname) nickname = auth.loggedIn ? ('酷狗 ' + (auth.userid || '用户')) : '酷狗音乐';

  let vip = { vipType: auth.vipType, svipType: auth.svipType, vipLevel: auth.vipLevel, isVip: auth.isVip, isSvip: auth.isSvip, membershipKnown: auth.isVip || auth.isSvip };
  if (auth.playbackReady) {
    if (webVip) {
      const normalized = normalizeVipPayload(webVip, auth);
      if (normalized.membershipKnown) vip = normalized;
    }
    if (!vip.membershipKnown && gatewayVip) {
      const normalized = normalizeVipPayload(gatewayVip, auth);
      if (normalized.membershipKnown) vip = normalized;
    }
    if (!vip.membershipKnown && mobilePayload) {
      try {
        const normalized = normalizeVipPayload({ data: mobilePayload }, auth);
        if (normalized.membershipKnown) vip = normalized;
      } catch {}
    }
  }

  return {
    provider: 'kugou',
    loggedIn: auth.playbackReady,
    userId: auth.userid,
    nickname,
    avatar,
    vipType: Math.trunc(vip.vipType),
    vipLevel: vip.vipLevel,
    isVip: !!vip.isVip,
    isSvip: !!vip.isSvip,
  };
}

// ============================================================
//  二维码一键登录 (对照 KuGouMusicApi login_qr_key / login_qr_check)
//  流程：GET /v2/qrcode 生成 key + 二维码图 → 用户 App 扫码 → 轮询 /v2/get_userinfo_qrcode
//  status：0 过期 / 1 等待扫码 / 2 待确认 / 4 成功（返回 token + userid）
// ============================================================
const KUGOU_LOGIN_BASE = 'https://login-user.kugou.com';

// 生成二维码登录（返回 { key, qrcodeImg, mid, dfid }）
export async function createQrLogin(cookie = '') {
  const auth = extractKugouAuth(cookie);
  const mid = auth.mid || createKugouMid('kugou-login');
  const dfid = auth.dfid || '-';
  const params = [
    ['appid', '1001'],
    ['type', '1'],
    ['plat', '4'],
    ['qrcode_txt', 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&'],
    ['srcappid', KUGOU_H5_SRC_APPID],
    ['dfid', dfid],
    ['mid', mid],
    ['uuid', '-'],
    ['clientver', String(KUGOU_CLIENTVER)],
    ['clienttime', String(nowSecs())],
  ];
  const sig = signatureH5(params, undefined);
  params.push(['signature', sig]);
  const url = new URL(KUGOU_LOGIN_BASE + '/v2/qrcode');
  for (const entry of params) url.searchParams.append(entry[0], entry[1]);
  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_GATEWAY_UA,
    referer: KUGOU_REFERER,
  });
  const data = json?.data ?? {};
  return {
    key: String(data.qrcode ?? data.key ?? ''),
    qrcodeImg: String(data.qrcode_img ?? ''),
    mid,
    dfid,
  };
}

// 轮询二维码登录状态（0 过期 / 1 等待扫码 / 2 待确认 / 4 成功）
export async function pollQrLogin(key, mid, cookie = '') {
  const auth = extractKugouAuth(cookie);
  const params = [
    ['plat', '4'],
    ['appid', String(KUGOU_APPID)],
    ['srcappid', KUGOU_H5_SRC_APPID],
    ['qrcode', String(key ?? '')],
    ['dfid', auth.dfid || '-'],
    ['mid', mid || auth.mid || createKugouMid('kugou-login')],
    ['uuid', '-'],
    ['clientver', String(KUGOU_CLIENTVER)],
    ['clienttime', String(nowSecs())],
  ];
  const sig = signatureH5(params, undefined);
  params.push(['signature', sig]);
  const url = new URL(KUGOU_LOGIN_BASE + '/v2/get_userinfo_qrcode');
  for (const entry of params) url.searchParams.append(entry[0], entry[1]);
  const json = await requestJson(url.toString(), 'GET', {
    'user-agent': KUGOU_GATEWAY_UA,
    referer: KUGOU_REFERER,
  });
  const data = json?.data ?? {};
  return {
    status: Number(data.status ?? 0),
    token: String(data.token ?? ''),
    userid: String(data.userid ?? ''),
    raw: data,
  };
}
