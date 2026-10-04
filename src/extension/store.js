// CetaMesh Desktop Extension v1 —— 已安装扩展注册表与扩展私有存储（阶段 10）。
//
// registry.json 是"装了什么、什么状态、批准了哪一份"的唯一事实源；
// 应用重启后必须仍然存在。写入沿用项目统一的原子写（临时文件 + rename，0600）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extensionError } from './types.js';

export const EXTENSION_REGISTRY_VERSION = 1;

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw extensionError('REGISTRY_UNREADABLE', '扩展注册表读取失败：' + file);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw extensionError('REGISTRY_CORRUPT', '扩展注册表解析失败：' + file);
  }
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

export function createExtensionStore({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createExtensionStore 需要 stateDir');
  const root = path.join(stateDir, 'extensions');
  const file = path.join(root, 'registry.json');
  const packagesDir = path.join(root, 'packages');
  const dataDir = path.join(root, 'data');

  const entries = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    const raw = readJson(file, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const list = Array.isArray(raw.extensions) ? raw.extensions : [];
    for (const item of list) {
      if (item && typeof item.id === 'string' && item.id) entries.set(item.id, item);
    }
  }

  function persist() {
    atomicWriteJson(file, {
      schemaVersion: EXTENSION_REGISTRY_VERSION,
      updatedAt: now(),
      extensions: [...entries.values()]
    });
  }

  return {
    root,
    file,
    packagesDir,
    dataDir,
    load,
    list: () => { load(); return [...entries.values()].map((e) => JSON.parse(JSON.stringify(e))); },
    get: (id) => { load(); const entry = entries.get(String(id)); return entry ? JSON.parse(JSON.stringify(entry)) : null; },
    has: (id) => { load(); return entries.has(String(id)); },
    put(entry) {
      load();
      entries.set(entry.id, entry);
      persist();
      return JSON.parse(JSON.stringify(entry));
    },
    remove(id) {
      load();
      const existed = entries.delete(String(id));
      if (existed) persist();
      return existed;
    },
    /** 扩展私有存储：按扩展 id 命名空间隔离，互不可见。 */
    storage(extensionId) {
      const filePath = path.join(dataDir, String(extensionId) + '.json');
      let cache = readJson(filePath, null);
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
      return {
        file: filePath,
        get(key) {
          const name = String(key);
          return Object.hasOwn(cache, name) ? cache[name] : null;
        },
        set(key, value) {
          cache[String(key)] = value === undefined ? null : value;
          atomicWriteJson(filePath, cache);
          return true;
        },
        delete(key) {
          const name = String(key);
          const existed = Object.hasOwn(cache, name);
          if (existed) { delete cache[name]; atomicWriteJson(filePath, cache); }
          return existed;
        },
        keys() { return Object.keys(cache); }
      };
    }
  };
}
