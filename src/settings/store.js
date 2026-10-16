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

  let values = defaultSettings();
  let revision = 0;
  let loaded = false;
  let lastError = null;
  let recoveryRequired = false;
  let backupPath = null;
  const changeListeners = new Set();
  function notifyChange() {
    for (const listener of changeListeners) listener(JSON.parse(JSON.stringify(values)));
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
    writeJsonAtomic(file, {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      revision: nextRevision,
      updatedAt: now(),
      settings: values
    });
    revision = nextRevision;
  }

  return {
    dir,
    file,
    load,
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
