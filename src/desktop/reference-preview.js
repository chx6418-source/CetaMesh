import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { resolveInside } from '../workspace/boundary.js';

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const EXPIRES_MS = 120000;
const IMAGES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);
const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.sh', '.ps1', '.bat', '.c', '.h', '.cpp', '.java', '.go', '.sql', '.vue', '.svelte', '.gitignore']);
const SECRET = /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|config\.json|settings\.json|.*\.(?:pem|key|p12|pfx|kdbx))$/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function findMessageReference(text, href) {
  if (typeof text !== 'string' || text.length > 2_000_000 || typeof href !== 'string' || href.length > 4096) return false;
  const tree = fromMarkdown(text);
  const target = normalizeUri(href);
  const definitions = new Map();
  const visit = (node, fn) => { fn(node); for (const child of node.children ?? []) visit(child, fn); };
  visit(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier.toLowerCase())) definitions.set(node.identifier.toLowerCase(), node.url); });
  let found = false;
  visit(tree, node => {
    if ((node.type === 'link' || node.type === 'image') && normalizeUri(node.url) === target) found = true;
    if ((node.type === 'linkReference' || node.type === 'imageReference') && definitions.has(node.identifier.toLowerCase()) && normalizeUri(definitions.get(node.identifier.toLowerCase())) === target) found = true;
  });
  return found;
}

function sourceParams(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('PREVIEW_SOURCE_INVALID', '查看来源无效。');
  const keys = source.kind === 'message' ? ['kind', 'sessionId', 'messageId', 'href'] : source.kind === 'artifact' ? ['kind', 'taskId', 'artifactId'] : [];
  if (!keys.length || Object.keys(source).length !== keys.length || keys.some(key => typeof source[key] !== 'string' || !source[key] || source[key].length > (key === 'href' ? 4096 : 200))) fail('PREVIEW_SOURCE_INVALID', '查看来源无效。');
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function checkPath(relative) {
  if (relative.split(/[\\/]/).some(segment => SECRET.test(segment))) fail('PREVIEW_PATH_DENIED', '此路径不允许预览。');
}
function imageValid(extension, bytes) {
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}

export function createReferencePreview({ resolveMessage, resolveArtifact, describeWorkspace, now = Date.now }) {
  const handles = new Map();
  let opening = 0;
  function prune() { for (const [id, item] of handles) if (now() - item.touched > EXPIRES_MS) handles.delete(id); }
  async function locate(source) {
    if (source.kind === 'artifact') {
      const item = await resolveArtifact(source);
      checkPath(item.canonicalPath);
      return { real: item.canonicalPath, name: path.basename(item.canonicalPath), line: null };
    }
    const origin = await resolveMessage(source);
    if (/^https:\/\//i.test(source.href)) {
      let url;
      try { url = new URL(source.href); } catch { fail('PREVIEW_URL_DENIED', '网页地址无效。'); }
      if (url.protocol !== 'https:' || url.username || url.password || /[\x00-\x20\\]/.test(source.href)) fail('PREVIEW_URL_DENIED', '网页地址不允许打开。');
      return { kind: 'web', url: url.href, name: url.hostname };
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(source.href) || source.href.includes('?')) fail('PREVIEW_URL_DENIED', '不支持此引用类型。');
    const match = source.href.match(/^(.*?)(?:#L([1-9]\d{0,6}))?$/);
    let relative;
    try { relative = decodeURIComponent(match[1]); } catch { fail('PREVIEW_SOURCE_INVALID', '引用路径编码无效。'); }
    checkPath(relative);
    const workspace = describeWorkspace(origin.workspaceId);
    if (!workspace || workspace.id !== origin.workspaceId) fail('PREVIEW_WORKSPACE_UNAVAILABLE', '此引用原属的工作区当前不可用。');
    const { real } = resolveInside(workspace.root, relative);
    checkPath(path.relative(workspace.root, real));
    return { real, name: relative.replace(/\\/g, '/'), line: match[2] ? Number(match[2]) : null };
  }
  async function openInternal({ source } = {}) {
    prune();
    source = sourceParams(source);
    const location = await locate(source);
    if (location.kind === 'web') return location;
    let stat;
    try { stat = fs.statSync(location.real); } catch { fail('PREVIEW_FILE_NOT_FOUND', '引用文件不存在或无法访问。'); }
    if (!stat.isFile()) fail('PREVIEW_PATH_DENIED', '此引用不是可预览文件。');
    const extension = path.extname(location.real).toLowerCase();
    const image = IMAGES.has(extension);
    if (!image && !TEXT.has(extension)) return { kind: 'unsupported', name: location.name, message: '此类型暂不支持内置预览。' };
    if (stat.size > (image ? IMAGE_LIMIT : TEXT_LIMIT)) fail('PREVIEW_TOO_LARGE', image ? '图片超过 10 MiB 预览上限。' : '文本超过 2 MiB 预览上限。');
    if (handles.size >= 8) fail('PREVIEW_LIMIT', '查看资源已达上限，请关闭已有标签。');
    const fd = fs.openSync(location.real, 'r');
    let bytes;
    try {
      if (!sameFile(stat, fs.fstatSync(fd)) || (await locate(source)).real !== location.real) fail('PREVIEW_FILE_CHANGED', '引用文件已变化，请重新打开。');
      bytes = Buffer.alloc(stat.size);
      let consumed = 0;
      while (consumed < bytes.length) {
        const amount = fs.readSync(fd, bytes, consumed, bytes.length - consumed, consumed);
        if (!amount) fail('PREVIEW_FILE_CHANGED', '读取过程中引用文件已变化。');
        consumed += amount;
      }
      if (!sameFile(stat, fs.fstatSync(fd))) fail('PREVIEW_FILE_CHANGED', '读取过程中引用文件已变化。');
    } finally { fs.closeSync(fd); }
    if (image && !imageValid(extension, bytes)) fail('PREVIEW_IMAGE_INVALID', '图片内容与文件类型不匹配。');
    if (!image) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('PREVIEW_ENCODING_UNSUPPORTED', '此文件不是可预览的 UTF-8 文本。'); }
      if (bytes.includes(0)) fail('PREVIEW_ENCODING_UNSUPPORTED', '此文件包含二进制内容。');
    }
    const handle = crypto.randomUUID();
    handles.set(handle, { source, location, stat, bytes, touched: now() });
    return { handle, name: location.name, kind: image ? 'image' : ['.md', '.markdown'].includes(extension) ? 'markdown' : ['.txt', '.csv'].includes(extension) ? 'text' : 'code', mimeType: IMAGES.get(extension) ?? 'text/plain', size: bytes.length, line: location.line };
  }
  async function read({ handle, offset } = {}) {
    prune();
    const item = handles.get(handle);
    if (!item) fail('PREVIEW_EXPIRED', '预览已关闭或过期，请重新打开。');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.bytes.length) fail('PREVIEW_OFFSET_INVALID', '预览读取位置无效。');
    const current = await locate(item.source);
    let unchanged = false;
    try { unchanged = current.real === item.location.real && sameFile(item.stat, fs.statSync(current.real)); } catch { unchanged = false; /* Missing files invalidate the snapshot. */ }
    if (!unchanged) { handles.delete(handle); fail('PREVIEW_FILE_CHANGED', '引用文件已变化，请重新打开。'); }
    item.touched = now();
    const end = Math.min(offset + CHUNK_BYTES, item.bytes.length);
    return { offset, nextOffset: end < item.bytes.length ? end : null, encoding: 'base64', data: item.bytes.subarray(offset, end).toString('base64') };
  }
  function close({ handle } = {}) { handles.delete(handle); return { closed: true }; }
  async function open(params) {
    prune();
    if (handles.size + opening >= 8) fail('PREVIEW_LIMIT', '查看资源已达上限，请关闭已有标签。');
    opening++;
    try { return await openInternal(params); } finally { opening--; }
  }
  return { open, read, close };
}
