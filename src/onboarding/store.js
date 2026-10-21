// CetaMesh Desktop —— 首次运行引导进度持久化。
//
// 唯一持久化原语：src/storage/json-file.js（原子写 / 0600 / BOM 容错 / 大小上限）。
// Domain 责任（本文件）：把 StorageError 映射为 ONBOARDING_* 错误码、做文档形状归一、
// 决定「损坏时怎么办」。
//
// 损坏策略（WHY）：引导进度不是安全边界数据，损坏时**不能**阻断用户进入 CetaMesh ——
// 回落到全新进度让用户重走一遍即可。但「回落到全新」不等于「假装什么都没发生」：
//   - 读失败/解析失败：返回全新状态并把原因放进 lastError（UI 应展示）；
//   - 损坏之后拒绝静默覆写：否则用户永不知道自己的进度曾经丢失（也丢失了取证线索）。
//     真要重来，走 onboarding.reset()（它会重建一份干净文档，这是用户显式意图）。

import path from 'node:path';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

export const ONBOARDING_STORE_VERSION = 1;

export const ONBOARDING_STATUSES = Object.freeze(['not_started', 'in_progress', 'completed']);

/** Domain 错误码（外部/UI 只会看到这些，不会看到 StorageError）。 */
export const ONBOARDING_ERROR_CODES = Object.freeze({
  STEP_NOT_FOUND: 'ONBOARDING_STEP_NOT_FOUND',
  STEP_ORDER: 'ONBOARDING_STEP_ORDER',
  STEP_REQUIRED: 'ONBOARDING_STEP_REQUIRED',
  INCOMPLETE: 'ONBOARDING_INCOMPLETE',
  INVALID_PARAMS: 'ONBOARDING_INVALID_PARAMS',
  STORE_CORRUPT: 'ONBOARDING_STORE_CORRUPT',
  STORE_READ_FAILED: 'ONBOARDING_STORE_READ_FAILED',
  STORE_TOO_LARGE: 'ONBOARDING_STORE_TOO_LARGE',
  STORE_WRITE_FAILED: 'ONBOARDING_STORE_WRITE_FAILED'
});

/** StorageError -> Domain 错误码：Domain 边界之外不泄漏存储层语义。 */
const STORAGE_CODE_MAP = Object.freeze({
  MISSING: ONBOARDING_ERROR_CODES.STORE_READ_FAILED,
  CORRUPT: ONBOARDING_ERROR_CODES.STORE_CORRUPT,
  READ_FAILED: ONBOARDING_ERROR_CODES.STORE_READ_FAILED,
  TOO_LARGE: ONBOARDING_ERROR_CODES.STORE_TOO_LARGE,
  WRITE_FAILED: ONBOARDING_ERROR_CODES.STORE_WRITE_FAILED
});

export function onboardingStoreError(code, message, extra = {}) {
  return Object.assign(new Error(message), { name: 'OnboardingStoreError', code, ...extra });
}

/** 全新进度：status=not_started，没有任何完成/跳过记录。 */
export function freshState(now = () => Date.now()) {
  return {
    schemaVersion: ONBOARDING_STORE_VERSION,
    status: 'not_started',
    currentStepId: null,
    completed: [],
    skipped: [],
    startedAt: null,
    completedAt: null,
    updatedAt: now()
  };
}

function asStringArray(values) {
  if (!Array.isArray(values)) return [];
  // 去重且保序：completed 的顺序本身是有意义的（完成时间线 / 顺序校验证据）。
  return [...new Set(values.filter((value) => typeof value === 'string' && value).map(String))];
}

function asTimestamp(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * 文档形状归一：字段缺失/类型不对时收敛到合法形状。
 * 这里不校验 stepId 是否已知 —— 已知性由 steps.js + service 判定，store 只保形状。
 */
export function normalizeState(raw, now = () => Date.now()) {
  const base = freshState(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: base, normalized: false };
  }
  const status = ONBOARDING_STATUSES.includes(raw.status) ? raw.status : 'not_started';
  const completed = asStringArray(raw.completed);
  const skipped = asStringArray(raw.skipped);
  const state = {
    schemaVersion: ONBOARDING_STORE_VERSION,
    status,
    currentStepId: typeof raw.currentStepId === 'string' && raw.currentStepId ? raw.currentStepId : null,
    completed,
    skipped: skipped.filter((id) => !completed.includes(id)),
    startedAt: asTimestamp(raw.startedAt),
    completedAt: asTimestamp(raw.completedAt),
    updatedAt: asTimestamp(raw.updatedAt) ?? base.updatedAt
  };
  if (raw.stepData && typeof raw.stepData === 'object' && !Array.isArray(raw.stepData)) {
    state.stepData = raw.stepData;
  }
  // 归一后与原文不一致 => 文件字段异常；用于如实上报（不阻断继续使用）。
  const changed = JSON.stringify({ ...state, updatedAt: undefined }) !== JSON.stringify({ ...raw, updatedAt: undefined });
  return { state, normalized: changed };
}

/**
 * 创建引导进度 store。
 * - stateDir：状态根目录（生产为数据目录下的 state/），文件固定为 <stateDir>/onboarding.json。
 * - now：可注入时钟，便于测试确定性。
 */
export function createOnboardingStore({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createOnboardingStore 需要 stateDir');
  const file = path.join(stateDir, 'onboarding.json');

  let state = null;
  let lastError = null;
  let loaded = false;
  let corrupt = false;

  function load() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = readJsonFile(file, { missing: undefined });
    } catch (error) {
      if (error instanceof StorageError) {
        if (error.code === 'MISSING') return; // 首次运行：全新状态，不是错误。
        corrupt = true;
        lastError = error.code === 'CORRUPT'
          ? '引导进度文件解析失败，已按全新进度继续：' + String(error?.cause?.message ?? error.message)
          : '引导进度文件读取失败，已按全新进度继续：' + String(error?.cause?.message ?? error.message);
        return;
      }
      throw error;
    }
    const { state: normalized, normalized: wasNormalized } = normalizeState(raw, now);
    state = normalized;
    if (wasNormalized) lastError = '引导进度文件字段异常，已按可识别部分继续（未知字段已忽略）';
  }

  function current() {
    load();
    if (!state) state = freshState(now);
    return state;
  }

  function read() {
    const value = current();
    // 深拷贝 + lastError：调用方拿到的是快照，改它不会污染内存态。
    return { ...JSON.parse(JSON.stringify(value)), lastError };
  }

  function write(nextState) {
    const { state: normalized } = normalizeState(nextState, now);
    if (corrupt) {
      // 不静默覆写损坏文件：用户必须先知道进度丢了（reset() 是显式的重建入口）。
      throw onboardingStoreError(
        ONBOARDING_ERROR_CODES.STORE_CORRUPT,
        '引导进度文件已损坏，拒绝覆盖；请调用 onboarding.reset 重建进度文件。lastError=' + String(lastError)
      );
    }
    const document = { ...normalized, updatedAt: now() };
    try {
      writeJsonAtomic(file, document);
    } catch (error) {
      if (error instanceof StorageError) {
        throw onboardingStoreError(
          STORAGE_CODE_MAP[error.code] ?? 'STORE_WRITE_FAILED',
          `引导进度写入失败（${error.code}）：${String(error?.cause?.message ?? error.message)}`
        );
      }
      throw error;
    }
    state = document;
    return { ...JSON.parse(JSON.stringify(document)), lastError };
  }

  /** 读-改-写：mutator 收到的是深拷贝快照，返回新状态（或就地改快照后返回 undefined）。 */
  function update(mutator) {
    if (typeof mutator !== 'function') throw new Error('createOnboardingStore.update 需要 mutator 函数');
    const snapshot = JSON.parse(JSON.stringify(current()));
    const produced = mutator(snapshot);
    const next = produced === undefined ? snapshot : produced;
    return write({ ...next, schemaVersion: ONBOARDING_STORE_VERSION });
  }

  /** reset 是唯一允许在损坏后重建文件的路径（用户显式放弃旧进度）。 */
  function reset() {
    loaded = true;
    corrupt = false; // 用户显式重来：允许重建文件，并清掉「拒绝覆写」的闸门。
    lastError = null;
    return write(freshState(now));
  }

  return {
    stateDir,
    file,
    read,
    write,
    update,
    reset,
    lastError: () => lastError,
    isCorrupt: () => {
      load();
      return corrupt;
    },
    clearError() {
      lastError = null;
    }
  };
}
