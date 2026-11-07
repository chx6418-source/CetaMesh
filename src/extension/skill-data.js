// Desktop-only workflow content profile. This module never evaluates package text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { compareProductVersions } from '../release/version.js';
import { extensionError } from './types.js';

export const SKILL_CONTENT_PROFILE = 'skill-reference-v1';
export const SKILL_CONTENT_MIN_VERSION = '1.0.0-rc.2';
export const SKILL_LIMITS = Object.freeze({ entries: 128, fileBytes: 65536, pageBytes: 8192,
  sourceFiles: 128, sourceBytes: 2 * 1024 * 1024, indexChars: 3000, alwaysChars: 4000, totalChars: 12000 });
const DATA_EXTENSION = /\.(?:md|txt|json|ya?ml|csv|tsv)$/i;
const SENSITIVE = /^(?:\.git|\.codex|\.ssh|\.aws|\.azure|\.gnupg|node_modules|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|private_keys|authorized_keys|known_hosts)$/i;
const fail = (message, code = 'SKILL_CONTENT_INVALID') => { throw extensionError(code, message); };
export const skillHash = value => crypto.createHash('sha256').update(value).digest('hex');

/** A near-match is also content intent, so a malformed profile can never reach a JS host. */
export function hasSkillContentIntent(manifest) {
  return manifest?.contentProfile !== undefined || manifest?.capabilities?.some(cap => cap.kind === 'skill-reference')
    || (manifest?.type === 'workflow' && /(?:^|[\\/])SKILL\.md$/i.test(manifest.entry ?? ''));
}
export const isSkillDataManifest = manifest => manifest?.contentProfile === SKILL_CONTENT_PROFILE;

export function validateSkillDataManifest(manifest) {
  if (manifest.contentProfile !== SKILL_CONTENT_PROFILE || manifest.type !== 'workflow' || manifest.entry !== 'SKILL.md'
    || manifest.permissions?.length !== 1 || manifest.permissions[0] !== 'skill.read'
    || manifest.network?.hosts?.length || manifest.scope?.paths?.length || manifest.scope?.workspace
    || manifest.delegates || manifest.settingsSchema !== undefined
    || manifest.capabilities?.length !== 1 || manifest.capabilities[0].kind !== 'skill-reference'
    || manifest.capabilities[0].requires?.length !== 1 || manifest.capabilities[0].requires[0] !== 'skill.read'
    || manifest.capabilities[0].inputSchema !== null
    || !manifest.minCetaMeshVersion || compareProductVersions(manifest.minCetaMeshVersion, SKILL_CONTENT_MIN_VERSION) < 0) {
    fail('Skill content requires workflow, SKILL.md, skill-reference-v1, sole skill.read permission and a compatible minimum version');
  }
  return manifest;
}

export function assertSkillResource(resource = 'SKILL.md') {
  if (typeof resource !== 'string' || resource.length > 240 || resource.includes('\\') || resource.includes(':')
    || resource.startsWith('/') || resource.includes('\0') || resource.split('/').some(part => !part || part === '.' || part === '..' || SENSITIVE.test(part))
    || !DATA_EXTENSION.test(resource)) fail('Skill resource is outside the allowed content scope', 'SKILL_RESOURCE_DENIED');
  return resource;
}

/** Check both lexical and physical identity; no symlink or junction is an authorized source. */
export function safeSkillPath(root, relative = '') {
  const absoluteRoot = path.resolve(root);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(absoluteRoot, fs.realpathSync(absoluteRoot)) || fs.lstatSync(absoluteRoot).isSymbolicLink())
    fail('Skill source root is a link', 'SKILL_PATH_DENIED');
  if (relative && (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.includes(':'))))
    fail('Invalid Skill relative path', 'SKILL_PATH_DENIED');
  let current = absoluteRoot;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('Skill paths must not contain links', 'SKILL_PATH_DENIED');
  }
  const rel = path.relative(absoluteRoot, fs.realpathSync(current));
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('Skill path escapes its source', 'SKILL_PATH_DENIED');
  return current;
}

export function parseSkillDocument(value, { fallbackName = '', maxBytes = SKILL_LIMITS.fileBytes } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (bytes.length > maxBytes) fail('Skill document exceeds its byte limit', 'SKILL_TOO_LARGE');
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes) || source.includes('\0')) fail('Skill content must be UTF-8 text');
  const normalized = source.replace(/^\uFEFF/, '');
  const values = {};
  let body = normalized;
  if (/^---\r?\n/.test(normalized)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
    if (!match || match[1].length > 4096) fail('Skill frontmatter is malformed', 'SKILL_FRONTMATTER_INVALID');
    for (const line of match[1].split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const pair = /^([a-z][a-z-]{0,39}):\s*(.*?)\s*$/.exec(line);
      if (!pair || Object.hasOwn(values, pair[1]) || pair[2].length > 1000 || /^[\[\]{|>&*!]/.test(pair[2]))
        fail('Skill frontmatter accepts unique bounded scalar fields', 'SKILL_FRONTMATTER_INVALID');
      let scalar = pair[2];
      if (scalar.startsWith('"')) {
        try { scalar = JSON.parse(scalar); } catch { fail('Invalid quoted Skill metadata', 'SKILL_FRONTMATTER_INVALID'); }
        if (typeof scalar !== 'string') fail('Invalid Skill scalar', 'SKILL_FRONTMATTER_INVALID');
      } else if (scalar.startsWith("'")) {
        if (!scalar.endsWith("'")) fail('Invalid quoted Skill metadata', 'SKILL_FRONTMATTER_INVALID');
        scalar = scalar.slice(1, -1).replaceAll("''", "'");
      }
      values[pair[1]] = scalar;
    }
    body = normalized.slice(match[0].length);
  }
  const name = (values.name || fallbackName).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) fail('Skill needs a bounded simple name', 'SKILL_FRONTMATTER_INVALID');
  if (values.always !== undefined && !['true', 'false'].includes(values.always)) fail('Skill always must be a boolean', 'SKILL_FRONTMATTER_INVALID');
  // allowed-tools and all unknown scalar metadata have no authorization effect.
  return { metadata: { name, description: (values.description ?? '').trim().slice(0, 500), always: values.always === 'true' },
    body, source, sha256: skillHash(bytes), bytes: bytes.length };
}

export function validateSkillPackageFiles(files, { rootDir } = {}) {
  if (files.length > SKILL_LIMITS.sourceFiles) fail('Skill package has too many reference files', 'SKILL_SOURCE_LIMIT');
  for (const relative of files) {
    if (rootDir && fs.lstatSync(safeSkillPath(rootDir, relative)).size > SKILL_LIMITS.fileBytes)
      fail('Skill package reference file exceeds 64 KiB', 'SKILL_TOO_LARGE');
    if (relative === 'extension.json' || relative === 'manifest.json') continue;
    try { assertSkillResource(relative); }
    catch { fail('Skill packages may contain only non-sensitive reference data'); }
  }
}

export function skillContentPage(bytes, { offset = 0, maxBytes = SKILL_LIMITS.pageBytes } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) fail('Invalid Skill byte offset', 'INVALID_PARAMS');
  const limit = Math.max(1, Math.min(SKILL_LIMITS.pageBytes, Number(maxBytes) || SKILL_LIMITS.pageBytes));
  if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) fail('Skill offset must align with UTF-8', 'INVALID_PARAMS');
  let end = Math.min(bytes.length, offset + Math.floor(limit));
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  if (end === offset && offset < bytes.length) fail('Page byte budget cannot contain the next UTF-8 character', 'INVALID_PARAMS');
  return { content: bytes.subarray(offset, end).toString('utf8'), nextOffset: end < bytes.length ? end : null, truncated: end < bytes.length };
}

export function createSkillDataHost({ manifest, source, packageRoot, sourceRevision, validateCurrent = () => {} } = {}) {
  validateSkillDataManifest(manifest);
  const parsed = parseSkillDocument(source, { fallbackName: manifest.id });
  let closed = false;
  const assertCurrent = () => { if (closed) fail('Skill content is disabled', 'EXTENSION_DISABLED'); validateCurrent(); };
  return { logs: [], available: () => !closed, loadError: () => null,
    health: () => ({ provider: SKILL_CONTENT_PROFILE, inflight: 0, closed }),
    describe() { assertCurrent(); return { ...parsed.metadata, sha256: parsed.sha256, bytes: parsed.bytes, sourceRevision }; },
    read({ resource = 'SKILL.md', sourceRevision: expected, offset, maxBytes } = {}) {
      assertCurrent(); if (expected !== sourceRevision) fail('Skill source revision changed', 'SKILL_SOURCE_STALE');
      assertSkillResource(resource);
      const file = safeSkillPath(packageRoot, resource);
      const stat = fs.statSync(file); if (!stat.isFile() || stat.size > SKILL_LIMITS.fileBytes) fail('Skill resource exceeds its limit', 'SKILL_TOO_LARGE');
      const bytes = fs.readFileSync(file);
      parseSkillDocument(resource === 'SKILL.md' ? bytes : source, { fallbackName: manifest.id });
      if (!Buffer.from(bytes.toString('utf8')).equals(bytes) || bytes.includes(0)) fail('Skill resources must be UTF-8 text');
      assertCurrent();
      return { ...skillContentPage(bytes, { offset, maxBytes }), sha256: skillHash(bytes), sourceRevision,
        trust: 'untrusted-reference', resource };
    },
    async invoke(capability, input = {}) {
      if (capability !== manifest.capabilities[0].id) fail('Unknown Skill reference capability', 'CAPABILITY_NOT_DECLARED');
      return this.read(input ?? {});
    },
    shutdown() { closed = true; }
  };
}
