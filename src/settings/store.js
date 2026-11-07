// CetaMesh Desktop —— 产品设置持久化（阶段 12）。
//
// 落库要求：Settings 重启后必须保持。写入走统一 Storage Primitive（原子写、0600、BOM 容错）。
// 损坏的 settings.json 不会阻断启动：原文件先备份，默认设置只读展示，需显式恢复或全部重置。

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import {
  SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  normalizeSettings,
  settingsError,
  validateSectionPatch
} from './schema.js';

export function createSettingsStore({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createSettingsStore 需要 stateDir');
  const dir = path.join(stateDir, 'settings');
  const file = path.join(dir, 'settings.json');
  const baselineFile = path.join(dir, 'settings.pre-features-v1.json');

  let values = defaultSettings();
  let revision = 0;
  let loaded = false;
  let lastError = null;
  let recoveryRequired = false;
  let backupPath = null;
  let persisted = null;
  const changeListeners = new Set();
  function notifyChange() {
    for (const listener of changeListeners) listener(JSON.parse(JSON.stringify(values)));
  }

  // Optional fields are supplied by the current reader. Persisting their inactive
  // defaults would make an ordinary theme change unreadable by earlier v1 readers.
  function serializedSettings(settings) {
    const result = JSON.parse(JSON.stringify(settings));
    if (result.models.connections === null) delete result.models.connections;
    if (result.models.modelPreferences.length === 0) delete result.models.modelPreferences;
    if (result.extensions.skillSources.length === 0) delete result.extensions.skillSources;
    return result;
  }

  function featureKinds(settings) {
    const kinds = [];
    if (settings?.models?.connections != null) kinds.push('model-connections');
    if (settings?.models?.modelPreferences?.length) kinds.push('model-preferences');
    if (settings?.extensions?.skillSources?.length) kinds.push('skill-sources');
    return kinds;
  }

  function readBaseline() {
    try {
      const stat = fs.lstatSync(baselineFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('配置快照不是有效的有界普通文件');
      const raw = readJsonFile(baselineFile, { maxBytes: 512 * 1024 });
      if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('配置快照版本无效');
      normalizeSettings(raw.settings, { strict: true });
      if (featureKinds(raw.settings).length || ['connections', 'modelPreferences'].some(key => Object.hasOwn(raw.settings.models, key)) || Object.hasOwn(raw.settings.extensions, 'skillSources')) throw new Error('配置快照需要新版本读取器');
      return { path: baselineFile, available: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(baselineFile)).digest('hex'), revision: raw.revision };
    } catch (error) {
      return { path: baselineFile, available: false, sha256: null, revision: null, reason: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
  }

  function preservePreFeatureConfiguration() {
    const existing = readBaseline();
    if (existing.available) return;
    if (existing.reason !== 'missing') throw settingsError('SETTINGS_COMPATIBILITY_UNAVAILABLE', '无法保留启用新功能前的配置，请检查设置目录中的配置快照');
    const previous = persisted ?? { schemaVersion: SETTINGS_SCHEMA_VERSION, revision: 1, updatedAt: now(), settings: defaultSettings() };
    const candidate = path.join(dir, `settings.pre-features.${process.pid}.${crypto.randomBytes(8).toString('hex')}.json`);
    try {
      writeJsonAtomic(candidate, { ...previous, settings: serializedSettings(normalizeSettings(previous.settings, { strict: true })) });
      try { fs.copyFileSync(candidate, baselineFile, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!readBaseline().available) throw new Error('配置快照未能完整保存');
    } catch (error) {
      throw settingsError('SETTINGS_COMPATIBILITY_UNAVAILABLE', '无法保留启用新功能前的配置：' + error.message);
    } finally {
      try { fs.unlinkSync(candidate); } catch { /* An owned leftover never replaces the active settings or the first snapshot. */ }
    }
  }

  function backupCorruptSource() {
    const backup = path.join(dir, `settings.corrupt.${now()}.${crypto.randomBytes(4).toString('hex')}.json`);
    try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { throw settingsError('SETTINGS_RECOVERY_FAILED', '设置损坏且无法备份原文件：' + error.message); }
    backupPath = backup;
    recoveryRequired = true;
  }

  function load() {
    if (loaded) return;
    let raw;
    try {
      raw = readJsonFile(file);
    } catch (error) {
      if (error instanceof StorageError) {
        if (error.code === 'MISSING') { loaded = true; return; }
        if (error.code !== 'CORRUPT') {
          throw settingsError('SETTINGS_UNREADABLE', '设置读取失败：' + error.message);
        }
        backupCorruptSource();
        // 损坏：不阻断启动；只读展示默认值，阻止普通保存覆盖原文件。
        lastError = error.code === 'CORRUPT'
          ? '解析失败，已回落默认设置：' + (error?.cause?.message ?? error.message)
          : '读取失败：' + (error?.cause?.message ?? error.message);
        values = defaultSettings();
        revision = 0;
        loaded = true;
        return;
      }
      throw error;
    }
    try {
      if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
        throw settingsError('SETTINGS_INVALID', '设置文件版本或修订号无效');
      }
      values = normalizeSettings(raw.settings, { strict: true });
      persisted = raw;
      revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
      loaded = true;
    } catch (error) {
      backupCorruptSource();
      // 损坏：不阻断启动；只读展示默认值，阻止普通保存覆盖原文件。
      lastError = '解析失败，已回落默认设置：' + (error && error.message);
      values = defaultSettings();
      revision = 0;
      loaded = true;
    }
  }

  function persist() {
    const nextRevision = revision + 1;
    if (featureKinds(values).length && !featureKinds(persisted?.settings).length) preservePreFeatureConfiguration();
    const next = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      revision: nextRevision,
      updatedAt: now(),
      settings: serializedSettings(values)
    };
    writeJsonAtomic(file, next);
    persisted = next;
    revision = nextRevision;
  }

  return {
    dir,
    file,
    load,
    compatibility() {
      load();
      const features = featureKinds(values);
      return { requiresUpgradeReader: features.length > 0, features, baseline: readBaseline() };
    },
    onChange(listener) {
      if (typeof listener !== 'function') throw settingsError('SETTINGS_INVALID', 'change listener must be a function');
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    get() {
      load();
      return { settings: JSON.parse(JSON.stringify(values)), revision, lastError, recoveryRequired, backupPath };
    },

    /** 分区补丁：{ merge: true } 合并（默认），false 则用补丁整节替换。 */
    update(section, patch, { merge = true, expectedRev } = {}) {
      load();
      if (recoveryRequired) throw settingsError('SETTINGS_RECOVERY_REQUIRED', '请先从备份恢复设置，或明确执行全部重置');
      if (expectedRev !== undefined && expectedRev !== null && expectedRev !== revision) {
        throw settingsError('SETTINGS_CONFLICT', '设置已被其它操作修改（期望 rev ' + expectedRev + '，当前 rev ' + revision + '）');
      }
      const clean = validateSectionPatch(section, patch);
      const previous = values[section];
      values[section] = merge ? { ...values[section], ...clean } : { ...defaultSettings()[section], ...clean };
      try { persist(); } catch (error) { values[section] = previous; throw error; }
      notifyChange();
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    },

    /** 整节恢复默认（锁定项恢复为默认即保持安全姿态）。 */
    reset(section) {
      load();
      if (recoveryRequired) throw settingsError('SETTINGS_RECOVERY_REQUIRED', '请先从备份恢复设置，或明确执行全部重置');
      if (!Object.hasOwn(values, section)) {
        throw settingsError('UNKNOWN_SECTION', '未知设置分区：' + String(section));
      }
      const previous = values[section];
      values[section] = { ...defaultSettings()[section] };
      try { persist(); } catch (error) { values[section] = previous; throw error; }
      notifyChange();
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    },

    resetAll() {
      load();
      const previous = values;
      const previousError = lastError;
      values = defaultSettings();
      lastError = null;
      try { persist(); } catch (error) { values = previous; lastError = previousError; throw error; }
      recoveryRequired = false;
      notifyChange();
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    }
  };
}
