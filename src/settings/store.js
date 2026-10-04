// CetaMesh Desktop —— 产品设置持久化（阶段 12）。
//
// 落库要求：Settings 重启后必须保持。写入沿用项目统一的原子写（临时文件 + rename，0600）。
// 损坏的 settings.json 不会让应用起不来：解析失败即回落到默认值，并把问题如实上报。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  normalizeSettings,
  settingsError,
  validateSectionPatch
} from './schema.js';

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

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
    loaded = true;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      lastError = '读取失败：' + (error && error.message);
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
      const raw = JSON.parse(text);
      values = normalizeSettings(raw.settings ? raw.settings : raw);
      revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
    } catch (error) {
      // 损坏：不阻断启动，回落默认值并记录，让用户可以从 UI 重新保存。
      lastError = '解析失败，已回落默认设置：' + (error && error.message);
      values = defaultSettings();
      revision = 0;
    }
  }

  function persist() {
    revision += 1;
    atomicWriteJson(file, {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      revision,
      updatedAt: now(),
      settings: values
    });
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
      values[section] = merge ? { ...values[section], ...clean } : { ...defaultSettings()[section], ...clean };
      persist();
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    },

    /** 整节恢复默认（锁定项恢复为默认即保持安全姿态）。 */
    reset(section) {
      load();
      if (!Object.hasOwn(values, section)) {
        throw settingsError('UNKNOWN_SECTION', '未知设置分区：' + String(section));
      }
      values[section] = { ...defaultSettings()[section] };
      persist();
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    },

    resetAll() {
      load();
      values = defaultSettings();
      lastError = null;
      persist();
      return { settings: JSON.parse(JSON.stringify(values)), revision };
    }
  };
}
