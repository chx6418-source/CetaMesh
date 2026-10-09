// CetaMesh Desktop —— 更新公告缓存（产品化任务 D）。
//
// About 页要能**离线**显示「最近一次更新公告」。公告本身来自远程验签清单，
// 所以这里只缓存"已经验签通过"的结果摘要，落盘在 state/update-notes.json。
//
// 边界：
//   - 只缓存渲染后的纯文本 + 结构化元数据，不缓存原始清单字节（原始清单没有展示价值，
//     留着只会扩大可读面）；
//   - 文件损坏 → 如实报 lastError 并返回 null；下次成功检查会覆盖它（缓存语义明确），
//     但绝不静默把损坏文件当空对象；
//   - 读写一律走 Storage Primitive（src/storage/json-file.js）。

import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { buildReleaseAnnouncement } from './notes.js';

export const NOTES_CACHE_VERSION = 1;
export const NOTES_CACHE_FILENAME = 'update-notes.json';

function safeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 6).map((entry) => ({
    id: typeof entry?.id === 'string' ? entry.id.slice(0, 40) : null,
    manifestUrl: typeof entry?.manifestUrl === 'string' ? entry.manifestUrl.slice(0, 600) : null
  }));
}

export function createNotesCache({ stateDir, file = null } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createNotesCache 需要 stateDir');
  const target = file || path.join(stateDir, 'state', NOTES_CACHE_FILENAME);

  function read() {
    let raw = null;
    try {
      raw = readJsonFile(target, { missing: null });
    } catch (error) {
      return { record: null, lastError: String(error?.code || error?.message || error) };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { record: null, lastError: null };
    const announcement = raw.announcement
      ? buildReleaseAnnouncement({
          version: raw.announcement.version,
          title: raw.announcement.title,
          publishedAt: raw.announcement.publishedAt,
          notes: raw.announcement.notes,
          source: raw.announcement.source
        })
      : null;
    return {
      record: {
        schemaVersion: NOTES_CACHE_VERSION,
        currentVersion: typeof raw.currentVersion === 'string' ? raw.currentVersion.slice(0, 40) : null,
        latest: typeof raw.latest === 'string' ? raw.latest.slice(0, 40) : null,
        status: typeof raw.status === 'string' ? raw.status.slice(0, 40) : 'unknown',
        checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt.slice(0, 40) : null,
        source: typeof raw.source === 'string' ? raw.source.slice(0, 40) : null,
        sources: safeSources(raw.sources),
        announcement,
        // 失败态也缓存：About 才能如实显示「上次检查失败了」，而不是假装从没检查过。
        failureCode: typeof raw.failureCode === 'string' ? raw.failureCode.slice(0, 64) : null,
        failureMessage: typeof raw.failureMessage === 'string' ? raw.failureMessage.slice(0, 200) : null
      },
      lastError: null
    };
  }

  function write(record) {
    const payload = {
      schemaVersion: NOTES_CACHE_VERSION,
      currentVersion: record?.currentVersion ?? null,
      latest: record?.latest ?? null,
      status: record?.status ?? 'unknown',
      checkedAt: record?.checkedAt ?? null,
      source: record?.source ?? null,
      sources: safeSources(record?.sources),
      announcement: record?.announcement ?? null,
      failureCode: record?.failureCode ?? null,
      failureMessage: record?.failureMessage ?? null
    };
    try {
      writeJsonAtomic(target, payload);
      return { ok: true, file: target };
    } catch (error) {
      // 缓存写失败不能影响更新检查本身：如实返回失败，由调用方决定是否上报。
      return { ok: false, code: String(error?.code || 'WRITE_FAILED'), file: target };
    }
  }

  return { file: target, read, write };
}
