// CetaMesh Desktop —— 产品设置持久化（阶段 12）。
//
// 落库要求：Settings 重启后必须保持。写入走统一 Storage Primitive（原子写、0600、BOM 容错）。
// 损坏的 settings.json 不会让应用起不来：解析失败即回落到默认值，并把问题如实上报。

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
        const backup = path.join(dir, `settings.corrupt.${now()}.${crypto.randomBytes(4).toString('hex')}.json`);
        try {
          fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
        } catch (backupError) {
          throw settingsError('SETTINGS_RECOVERY_FAILED', '设置损坏且无法备份原文件：' + backupError.message);
        }
        // 损坏：不阻断启动，回落默认值并记录，让用户可以从 UI 重新保存。
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
      values = normalizeSettings(raw.settings ? raw.settings : raw);
      revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
      loaded = true;
    } catch (error) {
      // 损坏：不阻断启动，回落默认值并记录，让用户可以从 UI 重新保存。
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

    get() {
      load();
      return { settings: JSON.parse(JSON.stringify(values)), revision, lastError };
    },

    /** 分区补丁：{ merge: true } 合并（默认），false 则用补丁整节替换。 */
    update(section, patch, { merge = true, expectedRev } = {}) {
      load();
      if (expectedRev !== undefined && expectedRev !== null && expectedRev !== revision) {
        throw settingsError('SETTINGS_CONFLICT', '设置已被其它操作修改（期望 rev ' + expectedRev + '，当前 rev ' + revision + '）');
      }
      const clean = validateSectionPatch(section, patch);
      const previous = values[section];
      values[section] = merge ? { ...values[section], ...clean } : { ...defaultSettings()[section], ...clean };
      try { persist(); } catch (error) { values[section] = previous; throw error; }
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    },

    /** 整节恢复默认（锁定项恢复为默认即保持安全姿态）。 */
    reset(section) {
      load();
      if (!Object.hasOwn(values, section)) {
        throw settingsError('UNKNOWN_SECTION', '未知设置分区：' + String(section));
      }
      const previous = values[section];
      values[section] = { ...defaultSettings()[section] };
      try { persist(); } catch (error) { values[section] = previous; throw error; }
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    },

    resetAll() {
      load();
      const previous = values;
      const previousError = lastError;
      values = defaultSettings();
      lastError = null;
      try { persist(); } catch (error) { values = previous; lastError = previousError; throw error; }
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    }
  };
}
