// CetaMesh Desktop Extension v1 —— Manifest 解析与校验（阶段 10）。
//
// 一个扩展目录至少包含 extension.json（兼容 manifest.json）+ entry 指向的实现文件。
// 校验是**诊断式**的：validateManifest 返回 issues 列表；assertManifest 抛第一个错误。
// 损坏 / 缺字段 / 非法权限名一律 fail-closed，绝不"猜一个默认值"安装。

import crypto from 'node:crypto';
import {
  EXTENSION_LIMITS,
  PERMISSIONS,
  extensionError,
  isKnownPermission,
  normalizeEntry,
  normalizeExtensionId,
  normalizeHosts,
  normalizeScopePaths,
  normalizeType,
  normalizeVersion
} from './types.js';

export const MANIFEST_FILENAMES = Object.freeze(['extension.json', 'manifest.json']);
export const MANIFEST_VERSION = 1;

function text(value, label, maxChars, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw extensionError('INVALID_MANIFEST', label + '不能为空');
    return '';
  }
  if (typeof value !== 'string') throw extensionError('INVALID_MANIFEST', label + '必须是字符串');
  const trimmed = value.trim();
  if (required && !trimmed) throw extensionError('INVALID_MANIFEST', label + '不能为空');
  if (trimmed.length > maxChars) throw extensionError('INVALID_MANIFEST', label + '超过 ' + maxChars + ' 字符');
  return trimmed;
}

function normalizeCapabilities(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw extensionError('INVALID_MANIFEST', 'capabilities 必须是数组');
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw extensionError('INVALID_MANIFEST', 'capability 必须是对象');
    }
    const id = text(raw.id, 'capability.id', 80, { required: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
      throw extensionError('INVALID_MANIFEST', '非法 capability.id：' + id.slice(0, 40));
    }
    if (seen.has(id)) throw extensionError('INVALID_MANIFEST', 'capability.id 重复：' + id);
    seen.add(id);
    const kind = text(raw.kind, 'capability.kind', 40) || 'tool';
    const requires = Array.isArray(raw.requires) ? raw.requires.map(String) : [];
    for (const name of requires) {
      if (!isKnownPermission(name)) throw extensionError('INVALID_MANIFEST', 'capability 声明了未知权限：' + name);
    }
    out.push({
      id,
      kind,
      title: text(raw.title, 'capability.title', EXTENSION_LIMITS.nameChars) || id,
      description: text(raw.description, 'capability.description', EXTENSION_LIMITS.descriptionChars),
      requires,
      inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? raw.inputSchema : null
    });
  }
  if (out.length > EXTENSION_LIMITS.capabilities) {
    throw extensionError('INVALID_MANIFEST', 'capabilities 最多 ' + EXTENSION_LIMITS.capabilities + ' 个');
  }
  return out;
}

function normalizePermissions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw extensionError('INVALID_MANIFEST', 'permissions 必须是数组');
  const out = [];
  for (const raw of value) {
    const name = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!name) continue;
    if (!isKnownPermission(name)) {
      throw extensionError('UNKNOWN_PERMISSION', '未知权限：' + name.slice(0, 40));
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > EXTENSION_LIMITS.permissions) {
    throw extensionError('INVALID_MANIFEST', 'permissions 最多 ' + EXTENSION_LIMITS.permissions + ' 个');
  }
  return out;
}

function normalizeSource(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    kind: text(raw.kind, 'source.kind', 40) || 'local',
    reference: text(raw.reference, 'source.reference', 400),
    // 未来市场所需的元数据先留字段，本阶段不开发服务器市场。
    publisher: text(raw.publisher, 'source.publisher', EXTENSION_LIMITS.nameChars),
    homepage: text(raw.homepage, 'source.homepage', 400)
  };
}

function normalizeCompatibilityVersion(value, label) {
  const version = text(value, label, EXTENSION_LIMITS.versionChars);
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw extensionError('INVALID_MANIFEST', label + ' must be SemVer');
  }
  return version || null;
}

/** 纯校验：返回 { ok, issues, manifest }，不抛错（assertManifest 才抛）。 */
export function validateManifest(raw) {
  try {
    return { ok: true, issues: [], manifest: buildManifest(raw) };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: error && error.code ? error.code : 'INVALID_MANIFEST', message: String(error && error.message) }],
      manifest: null
    };
  }
}

export function assertManifest(raw) {
  return buildManifest(raw);
}

function buildManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw extensionError('INVALID_MANIFEST', 'manifest 根节点必须是对象');
  }
  const manifestVersion = Number(raw.manifestVersion ?? MANIFEST_VERSION);
  if (!Number.isSafeInteger(manifestVersion) || manifestVersion < 1 || manifestVersion > MANIFEST_VERSION) {
    throw extensionError('UNSUPPORTED_MANIFEST_VERSION', '不支持的 manifestVersion：' + String(raw.manifestVersion));
  }

  const permissions = normalizePermissions(raw.permissions);
  const network = raw.network && typeof raw.network === 'object' && !Array.isArray(raw.network) ? raw.network : {};
  const scope = raw.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? raw.scope : {};
  const hosts = normalizeHosts(network.hosts);
  const paths = normalizeScopePaths(scope.paths);
  const workspace = scope.workspace === undefined || scope.workspace === null || String(scope.workspace).trim() === ''
    ? null
    : String(scope.workspace).trim();

  // 声明了带 requires 的权限，就必须提供对应信息 —— 否则权限无从约束。
  for (const name of permissions) {
    const entry = PERMISSIONS[name];
    if (!entry || !entry.requires) continue;
    for (const requirement of entry.requires) {
      const provided = requirement === 'hosts' ? hosts.length > 0 : requirement === 'paths' ? paths.length > 0 : true;
      if (!provided) {
        throw extensionError('INCOMPLETE_PERMISSION_DECLARATION',
          '权限 ' + name + ' 必须同时声明 ' + requirement);
      }
    }
  }

  const capabilities = normalizeCapabilities(raw.capabilities);

  return {
    manifestVersion,
    id: normalizeExtensionId(raw.id),
    name: text(raw.name, 'name', EXTENSION_LIMITS.nameChars, { required: true }),
    version: normalizeVersion(raw.version),
    type: normalizeType(raw.type),
    entry: normalizeEntry(raw.entry),
    publisher: text(raw.publisher, 'publisher', EXTENSION_LIMITS.nameChars),
    description: text(raw.description, 'description', EXTENSION_LIMITS.descriptionChars),
    homepage: text(raw.homepage, 'homepage', 400),
    minCetaMeshVersion: normalizeCompatibilityVersion(raw.minCetaMeshVersion, 'minCetaMeshVersion'),
    maxCetaMeshVersion: normalizeCompatibilityVersion(raw.maxCetaMeshVersion, 'maxCetaMeshVersion'),
    capabilities,
    permissions,
    network: { hosts },
    scope: { workspace, paths },
    source: normalizeSource(raw.source)
  };
}

/** 规范化 JSON 的 sha256：作为 manifest 指纹，供 Permission Review 与安装一致性校验。 */
export function canonicalManifestHash(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest, Object.keys(manifest).sort())).digest('hex');
}

/** 完整指纹：对规范化后的完整内容做哈希（含 capabilities，避免"换实现不换权限"绕过复核）。 */
export function manifestFingerprint(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  copy.capabilities = (copy.capabilities || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  copy.permissions = (copy.permissions || []).slice().sort();
  copy.network = { hosts: (copy.network?.hosts || []).slice().sort() };
  copy.scope = { workspace: copy.scope?.workspace ?? null, paths: (copy.scope?.paths || []).slice().sort() };
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}
