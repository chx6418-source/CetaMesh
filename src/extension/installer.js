// CetaMesh Desktop Extension v1 —— 本地导入与生命周期安装（阶段 10）。
//
// 只做 Local Import：从**本地目录**读取扩展，复制进受管目录。不做任何下载，
// 因此"任意下载 JS 后执行"在数据流上就不存在。
//
// 安装顺序（任何一步失败都不落库）：
//   manifest 校验 -> 入口源码静态预检 -> Permission Review -> 批准 token 校验
//   -> （Update 时）版本与权限提升检查 -> 复制文件 -> 写注册表

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJsonText } from '../storage/json-file.js';
import { assertManifest, MANIFEST_FILENAMES } from './manifest.js';
import { scanEntrySource } from './scan.js';
import { buildReview, permissionDelta } from './review.js';
import { EXTENSION_LIMITS, compareVersions, extensionError } from './types.js';
import { validateMemoryPack, validateMemoryPackManifest } from './memory-pack.js';
import { fingerprintExtensionPackage } from './package-fingerprint.js';
import {isHttpDataManifest,validateHttpDefinition} from './http-host.js';
import {isEventDataManifest,validateEventDefinition} from './event-host.js';

function collectFiles(rootDir, relative = '', acc = { files: [], bytes: 0 }) {
  const dir = relative ? path.join(rootDir, relative) : rootDir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? relative + '/' + entry.name : entry.name;
    const abs = path.join(rootDir, rel);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      throw extensionError('SYMLINK_NOT_ALLOWED', '扩展目录不允许符号链接：' + rel);
    }
    if (stat.isDirectory()) {
      collectFiles(rootDir, rel, acc);
      continue;
    }
    if (!stat.isFile()) continue;
    acc.files.push(rel);
    acc.bytes += stat.size;
    if (acc.files.length > EXTENSION_LIMITS.sourceFiles) {
      throw extensionError('TOO_MANY_FILES', '扩展文件数超过 ' + EXTENSION_LIMITS.sourceFiles);
    }
    if (acc.bytes > EXTENSION_LIMITS.sourceBytes) {
      throw extensionError('TOO_LARGE', '扩展体积超过 ' + EXTENSION_LIMITS.sourceBytes + ' 字节');
    }
  }
  return acc;
}

function readManifestFile(rootDir) {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = path.join(rootDir, name);
    if (!fs.existsSync(candidate)) continue;
    let raw;
    try {
      raw = parseJsonText(fs.readFileSync(candidate, 'utf8'), { file: name });
    } catch (error) {
      const detail = error?.cause?.message ?? error?.message ?? error;
      throw extensionError('MANIFEST_CORRUPT', 'manifest 解析失败：' + name + '（' + detail + '）');
    }
    return { name, raw };
  }
  throw extensionError('MANIFEST_MISSING', '扩展目录缺少 ' + MANIFEST_FILENAMES.join(' 或 '));
}

function copyTree(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isSymbolicLink()) throw extensionError('SYMLINK_NOT_ALLOWED', '扩展目录不允许符号链接：' + entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

export function createExtensionInstaller({ store, now = () => Date.now() } = {}) {
  if (!store) throw new Error('createExtensionInstaller 需要 store');

  /** 只读审查：读 manifest + 入口源码，产出 review，不落盘。 */
  function reviewFromDirectory({ sourceDir } = {}) {
    const dir = String(sourceDir === null || sourceDir === undefined ? '' : sourceDir).trim();
    if (!dir) throw extensionError('INVALID_PARAMS', 'sourceDir 不能为空');
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw extensionError('SOURCE_NOT_FOUND', '扩展目录不存在：' + dir);
    }
    if (!stat.isDirectory()) throw extensionError('SOURCE_NOT_DIRECTORY', '扩展来源必须是目录：' + dir);

    const collected = collectFiles(dir);
    const packageFingerprintBeforeReview = fingerprintExtensionPackage(dir);
    const { name, raw } = readManifestFile(dir);
    const manifest = assertManifest(raw);
    const entryPath = path.join(dir, manifest.entry);
    if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
      throw extensionError('ENTRY_MISSING', 'manifest.entry 指向的文件不存在：' + manifest.entry);
    }
    const source = fs.readFileSync(entryPath, 'utf8');
    let scan;
    if (manifest.type === 'memory-pack') {
      validateMemoryPackManifest(manifest);
      validateMemoryPack(source);
      if (collected.files.some(p => !/\.(json|md|txt)$/i.test(p))) {
        throw extensionError('MEMORY_PACK_INVALID', 'Memory Pack contains executable or undeclared content');
      }
      scan = { ok: true, findings: [] };
    } else if(isEventDataManifest(manifest)){validateEventDefinition(manifest,source);scan={ok:true,findings:[]};}
    else if(isHttpDataManifest(manifest)){validateHttpDefinition(manifest,source);scan={ok:true,findings:[]};}
    else scan = scanEntrySource(source);
    const packageFingerprint = fingerprintExtensionPackage(dir);
    if (packageFingerprint !== packageFingerprintBeforeReview) {
      throw extensionError('SOURCE_CHANGED_DURING_REVIEW', 'Extension package changed while it was being reviewed');
    }
    const review = buildReview(manifest, { packageFingerprint });
    return { manifest, review, scan, source, sourceDir: dir, manifestFile: name,
      packageFingerprint, files: collected.files, bytes: collected.bytes };
  }

  function assertInstallable(reviewed, { approval, previousEntry, isUpdate }) {
    if (!reviewed.scan.ok) {
      throw extensionError('SOURCE_SCAN_FAILED',
        '入口源码未通过安全预检：' + reviewed.scan.findings.map((f) => f.reason + '（第 ' + f.line + ' 行）').join('；'));
    }
    if (reviewed.review.blockers.length) {
      throw extensionError(reviewed.review.blockers[0].code, reviewed.review.blockers.map((b) => b.message).join('；'));
    }
    const delta = isUpdate && previousEntry
      ? permissionDelta(previousEntry.permissions || [], reviewed.manifest.permissions)
      : { added: [], removed: [] };

    const needsApproval = reviewed.review.requiresExplicitApproval || delta.added.length > 0;
    if (needsApproval) {
      if (!approval || approval.approved !== true) {
        throw extensionError('APPROVAL_REQUIRED',
          '该扩展需要显式批准（风险等级 ' + reviewed.review.riskLevel + '）' + (delta.added.length ? '，且本次新增权限：' + delta.added.join('、') : ''));
      }
      if (String(approval.token || '') !== reviewed.review.token) {
        throw extensionError('REVIEW_MISMATCH', '批准凭据与当前 manifest 不一致（manifest 已变化，请重新审查）');
      }
    }
    if (isUpdate && previousEntry && delta.added.length > 0 && !approval) {
      throw extensionError('PERMISSION_ESCALATION_REQUIRES_APPROVAL', '更新新增了权限：' + delta.added.join('、'));
    }
    return delta;
  }

  function preparePackage(reviewed) {
    const manifest = reviewed.manifest;
    const target = path.join(store.packagesDir, manifest.id, manifest.version);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const staging = `${target}.staging-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const expectedFingerprint = reviewed.packageFingerprint;
    try {
      copyTree(reviewed.sourceDir, staging);
      const stagedReview = reviewFromDirectory({ sourceDir: staging });
      if (!stagedReview.scan.ok || stagedReview.review.token !== reviewed.review.token
        || stagedReview.packageFingerprint !== expectedFingerprint) {
        throw extensionError('SOURCE_CHANGED_DURING_STAGE', 'Extension source changed while it was being staged');
      }
      return { staging, target, expectedFingerprint };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  function finalizePackage(prepared) {
    if (fs.existsSync(prepared.target)) {
      if (fingerprintExtensionPackage(prepared.target) !== prepared.expectedFingerprint) {
        throw extensionError('IMMUTABLE_VERSION_COLLISION', 'This Extension version already contains different package files');
      }
      fs.rmSync(prepared.staging, { recursive: true, force: true });
      return { target: prepared.target, created: false };
    }
    fs.renameSync(prepared.staging, prepared.target);
    return { target: prepared.target, created: true };
  }

  function commit({ reviewed, approval, isUpdate }) {
    const manifest = reviewed.manifest;
    const previous = store.get(manifest.id);
    const delta = assertInstallable(reviewed, { approval, previousEntry: previous, isUpdate });

    const prepared = preparePackage(reviewed);
    let finalized;
    try { finalized = finalizePackage(prepared); }
    catch (error) {
      fs.rmSync(prepared.staging, { recursive: true, force: true });
      throw error;
    }
    const timestamp = now();
    const entry = {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      type: manifest.type,
      publisher: manifest.publisher || reviewed.review.publisher || '',
      status: previous?.status || 'installed',
      permissions: manifest.permissions,
      fingerprint: reviewed.review.fingerprint,
      packageFingerprint: reviewed.packageFingerprint,
      reviewToken: reviewed.review.token,
      riskLevel: reviewed.review.riskLevel,
      manifest,
      manifestFile: reviewed.manifestFile,
      sourceRoot: finalized.target,
      importedFrom: reviewed.sourceDir,
      fileCount: reviewed.files.length,
      bytes: reviewed.bytes,
      installedAt: previous ? previous.installedAt : timestamp,
      updatedAt: timestamp,
      enabledAt: previous?.enabledAt || null,
      disabledAt: previous?.disabledAt || null,
      previousVersion: previous ? previous.version : null,
      permissionDelta: delta
    };

    // 新版本先在同一文件系统暂存并原子落位；旧版本保留供回滚。
    try { store.put(entry); }
    catch (error) {
      if (finalized.created) fs.rmSync(finalized.target, { recursive: true, force: true });
      fs.rmSync(prepared.staging, { recursive: true, force: true });
      throw error;
    }
    return { entry, previousEntry: previous, review: reviewed.review, permissionDelta: delta };
  }

  return {
    reviewFromDirectory,

    /** 首次安装。 */
    install({ sourceDir, approval } = {}) {
      const reviewed = reviewFromDirectory({ sourceDir });
      if (store.has(reviewed.manifest.id)) {
        throw extensionError('ALREADY_INSTALLED',
          '扩展已安装：' + reviewed.manifest.id + '（如需升级请使用 update）');
      }
      return commit({ reviewed, approval, isUpdate: false });
    },

    /** 覆盖安装新版本；版本必须更高。 */
    async update({ sourceDir, approval, expectedReviewToken, beforeSwitch } = {}) {
      const reviewed = reviewFromDirectory({ sourceDir });
      if (expectedReviewToken && String(expectedReviewToken) !== reviewed.review.token) {
        throw extensionError('REVIEW_MISMATCH', 'Extension package changed after Owner Review; review it again');
      }
      const previous = store.get(reviewed.manifest.id);
      if (!previous) {
        throw extensionError('NOT_INSTALLED', '扩展尚未安装：' + reviewed.manifest.id);
      }
      if (compareVersions(reviewed.manifest.version, previous.version) <= 0) {
        throw extensionError('VERSION_NOT_NEWER',
          '更新版本必须高于已安装版本（已装 ' + previous.version + '，来源 ' + reviewed.manifest.version + '）');
      }
      const delta = assertInstallable(reviewed, { approval, previousEntry: previous, isUpdate: true });
      const prepared = preparePackage(reviewed);
      try {
        if (typeof beforeSwitch === 'function') await beforeSwitch({ id: previous.id, previousEntry: previous });
        const finalized = finalizePackage(prepared);
        const timestamp = now();
        const entry = {
          id: reviewed.manifest.id, version: reviewed.manifest.version, name: reviewed.manifest.name,
          type: reviewed.manifest.type, publisher: reviewed.manifest.publisher || reviewed.review.publisher || '',
          status: previous.status, permissions: reviewed.manifest.permissions,
          fingerprint: reviewed.review.fingerprint, packageFingerprint: reviewed.packageFingerprint,
          reviewToken: reviewed.review.token,
          riskLevel: reviewed.review.riskLevel, manifest: reviewed.manifest, manifestFile: reviewed.manifestFile,
          sourceRoot: finalized.target, importedFrom: reviewed.sourceDir, fileCount: reviewed.files.length,
          bytes: reviewed.bytes, installedAt: previous.installedAt, updatedAt: timestamp,
          enabledAt: previous.enabledAt || null, disabledAt: previous.disabledAt || null,
          previousVersion: previous.version, permissionDelta: delta
        };
        try { store.put(entry); }
        catch (error) {
          if (finalized.created) fs.rmSync(finalized.target, { recursive: true, force: true });
          throw error;
        }
        return { entry, previousEntry: previous, review: reviewed.review, permissionDelta: delta };
      } finally {
        fs.rmSync(prepared.staging, { recursive: true, force: true });
      }
    },

    async rollback({ id, approval, expectedReviewToken, beforeSwitch } = {}) {
      const previous = store.get(id);
      if (!previous) throw extensionError('NOT_INSTALLED', 'Extension is not installed: ' + String(id));
      if (!previous.previousVersion) throw extensionError('ROLLBACK_UNAVAILABLE', 'No previous Extension version is retained');
      const priorRoot = path.join(store.packagesDir, previous.id, previous.previousVersion);
      const reviewed = reviewFromDirectory({ sourceDir: priorRoot });
      if (expectedReviewToken && String(expectedReviewToken) !== reviewed.review.token) {
        throw extensionError('REVIEW_MISMATCH', 'Retained package changed after Owner Review; review it again');
      }
      if (reviewed.manifest.id !== previous.id || reviewed.manifest.version !== previous.previousVersion) {
        throw extensionError('ROLLBACK_PACKAGE_MISMATCH', 'Retained rollback package does not match the registry version');
      }
      const delta = assertInstallable(reviewed, { approval, previousEntry: previous, isUpdate: true });
      const prepared = preparePackage(reviewed);
      try {
        if (typeof beforeSwitch === 'function') await beforeSwitch({ id: previous.id, previousEntry: previous });
        const finalized = finalizePackage(prepared);
        const timestamp = now();
        const entry = {
          id: reviewed.manifest.id, version: reviewed.manifest.version, name: reviewed.manifest.name,
          type: reviewed.manifest.type, publisher: reviewed.manifest.publisher || reviewed.review.publisher || '',
          status: previous.status, permissions: reviewed.manifest.permissions,
          fingerprint: reviewed.review.fingerprint, packageFingerprint: reviewed.packageFingerprint,
          reviewToken: reviewed.review.token,
          riskLevel: reviewed.review.riskLevel, manifest: reviewed.manifest, manifestFile: reviewed.manifestFile,
          sourceRoot: finalized.target, importedFrom: reviewed.sourceDir, fileCount: reviewed.files.length,
          bytes: reviewed.bytes, installedAt: previous.installedAt, updatedAt: timestamp,
          enabledAt: previous.enabledAt || null, disabledAt: previous.disabledAt || null,
          previousVersion: previous.version, permissionDelta: delta
        };
        try { store.put(entry); }
        catch (error) {
          if (finalized.created) fs.rmSync(finalized.target, { recursive: true, force: true });
          throw error;
        }
        return { entry, previousEntry: previous, review: reviewed.review, permissionDelta: delta };
      } finally {
        fs.rmSync(prepared.staging, { recursive: true, force: true });
      }
    },

    /** 卸载：移除注册表条目，并删除受管包目录（不触碰用户的来源目录）。 */
    uninstall({ id, keepFiles = false } = {}) {
      const entry = store.get(id);
      if (!entry) throw extensionError('NOT_INSTALLED', '扩展未安装：' + String(id));
      store.remove(entry.id);
      let removedFiles = false;
      if (!keepFiles && entry.sourceRoot) {
        const root = path.resolve(store.packagesDir);
        const target = path.resolve(root, entry.id);
        if (target !== root && target.startsWith(root + path.sep)) {
          fs.rmSync(target, { recursive: true, force: true });
          removedFiles = true;
        }
      }
      return { id: entry.id, version: entry.version, removedFiles };
    }
  };
}
