// 插件/工具开关状态持久化（唯一经 src/storage/json-file.js，见 AGENTS.md 硬约定）。
//
// 只存"用户决定"：插件总开关、逐工具开关、MCP Server 开关与配置覆盖。
// 运行态（running/crashed/lastError）不落盘，避免把运行时误判固化成事实。

import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { integrationError } from './types.js';

export const INTEGRATION_STORE_VERSION = 1;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normalize(raw) {
  const base = { version: INTEGRATION_STORE_VERSION, updatedAt: null, plugins: {}, mcp: {} };
  if (!isPlainObject(raw)) return base;
  return {
    version: INTEGRATION_STORE_VERSION,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    plugins: isPlainObject(raw.plugins) ? raw.plugins : {},
    mcp: isPlainObject(raw.mcp) ? raw.mcp : {}
  };
}

export function createIntegrationStore({ stateDir, fileName = path.join('integrations', 'plugins.json'), now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createIntegrationStore 需要 stateDir');
  const file = path.join(stateDir, fileName);
  let cache = null;

  function read() {
    if (cache) return cache;
    let raw;
    try {
      raw = readJsonFile(file, { missing: null });
    } catch (error) {
      // 持久真相 fail-closed：损坏时绝不静默降级成 {}。
      throw integrationError('INTEGRATION_STORE_CORRUPT',
        '插件状态文件不可用（' + String(error?.code ?? 'READ_FAILED') + '）：' + file);
    }
    cache = normalize(raw);
    return cache;
  }

  function write(value) {
    const next = { ...normalize(value), version: INTEGRATION_STORE_VERSION, updatedAt: now() };
    try {
      writeJsonAtomic(file, next);
    } catch (error) {
      throw integrationError('INTEGRATION_STORE_WRITE_FAILED',
        '插件状态写入失败（' + String(error?.code ?? 'WRITE_FAILED') + '）：' + file);
    }
    cache = next;
    return next;
  }

  return {
    file,
    read,
    write,
    update(mutate) { return write(mutate(read())); },
    reset() { return write({ version: INTEGRATION_STORE_VERSION, updatedAt: now(), plugins: {}, mcp: {} }); },
    snapshot() { return structuredClone(read()); }
  };
}
