// CetaMesh Desktop —— Update 服务（阶段 12 / 分发运行时 v1 / 产品化任务 D）。
//
// 配置（清单地址 / 备用清单地址 / 固定公钥 / 通道 / 允许主机）来自产品设置，UI 改设置即生效。
// 构造时不发起网络请求；只有显式调用 update.check / update.download 才会联网。
//
// 分发拓扑（默认部署）：update.check 先访问 `manifestUrl`（GitCode 中国区优先源），
// 失败（超时 / 5xx / 清单损坏 / 验签失败 / 缺 windows-x64 安装包）再降级到
// `fallbackManifestUrl`（GitHub）；合法「无更新」不会触发备用源请求。
// update.download 只下载 + SHA256 校验 + 原子落盘；安装始终由用户手动确认（handoff 语义不变）。
//
// 产品化任务 D 新增：把**已验签通过**的更新公告落到本地缓存（notesCache），
// 使 About 页在没有网络时也能显示「最近一次更新公告」；缓存只存渲染后的纯文本。

import path from 'node:path';
import { createUpdateChecker } from './checker.js';
import { DOWNLOAD_MAX_BYTES_DEFAULT, createArtifactDownloader } from './download.js';
import { buildReleaseAnnouncement } from './notes.js';
import { buildUpdateSources } from './sources.js';

export function createUpdateService({
  currentVersion,
  settingsStore = null,
  fetchImpl = null,
  downloader = null,
  notesCache = null,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  const checker = createUpdateChecker({ currentVersion, fetchImpl });
  const artifactDownloader = downloader || createArtifactDownloader({ fetchImpl });

  function effectiveConfig() {
    if (!settingsStore) {
      return { channel: 'stable', manifestUrl: '', fallbackManifestUrl: '', pinnedPublicKey: '', allowedHosts: [] };
    }
    const { settings } = settingsStore.get();
    return {
      channel: settings.updates.channel,
      manifestUrl: settings.updates.manifestUrl,
      fallbackManifestUrl: settings.updates.fallbackManifestUrl || '',
      pinnedPublicKey: settings.updates.pinnedPublicKey,
      allowedHosts: String(settings.security.allowedUpdateHosts || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    };
  }

  /** 公告只有在"清单已验签通过且确实带了内容"时才写入缓存；空公告不写，避免 About 显示空壳。 */
  function announcementFor(result) {
    const hasContent = Boolean(result?.latest || result?.title || (Array.isArray(result?.notes) && result.notes.length));
    if (!hasContent) return null;
    return buildReleaseAnnouncement({
      version: result.latest,
      title: result.title,
      publishedAt: result.publishedAt ?? result.releasedAt,
      notes: result.notes,
      source: result.source
    });
  }

  /** 每次检查后落一次缓存（成功与失败都落：About 要能如实显示「上次检查失败」）。 */
  function recordCheck(result, config) {
    if (!notesCache) return;
    const sources = buildUpdateSources({ manifestUrl: config.manifestUrl, fallbackManifestUrl: config.fallbackManifestUrl });
    const checkedAt = new Date(now()).toISOString();
    const written = result?.ok
      ? notesCache.write({
          currentVersion,
          latest: result.latest ?? null,
          status: result.updateAvailable ? 'update_available' : (result.reason === 'UP_TO_DATE' ? 'up_to_date' : 'unknown'),
          checkedAt,
          source: result.source ?? null,
          sources,
          announcement: announcementFor(result)
        })
      : notesCache.write({
          currentVersion,
          latest: null,
          status: 'error',
          checkedAt,
          source: null,
          sources,
          failureCode: result?.code ?? 'UNKNOWN',
          failureMessage: result?.message ?? null
        });
    if (written?.ok === false) log('更新公告缓存写入失败：' + String(written.code));
  }

  const handlers = {
    'update.capabilities': () => ({
      ...checker.capabilities(),
      // 分发运行时新增：可下载并校验安装包（下载在独立模块，checker 本体仍无下载入口）；
      // 安装仍然永远需要用户确认，download 从不执行下载物。
      canDownloadVerifiedArtifact: true,
      canExecuteInstaller: false,
      sourcePriority: ['gitcode', 'github'],
      // 产品化任务 D：最近一次公告可离线读取（来自本地缓存，不联网）。
      canShowAnnouncementOffline: true
    }),
    'update.config': () => {
      const config = effectiveConfig();
      return { config: { ...config, pinnedPublicKey: config.pinnedPublicKey ? '[configured]' : '' } };
    },
    'update.check': async (p) => {
      const config = effectiveConfig();
      const result = await checker.check({
        manifestUrl: p.manifestUrl === undefined ? config.manifestUrl : p.manifestUrl,
        fallbackManifestUrl: p.fallbackManifestUrl === undefined ? config.fallbackManifestUrl : p.fallbackManifestUrl,
        pinnedPublicKey: p.pinnedPublicKey === undefined ? config.pinnedPublicKey : p.pinnedPublicKey,
        channel: p.channel === undefined ? config.channel : p.channel,
        allowedHosts: config.allowedHosts
      });
      recordCheck(result, config);
      return result;
    },
    /** 离线读取最近一次更新公告（不联网）：About 页用它显示「最近一次更新公告 / 更新状态」。 */
    'update.notes': () => {
      if (!notesCache) return { available: false, record: null, lastError: null };
      const cached = notesCache.read();
      return { available: cached.record !== null, record: cached.record, lastError: cached.lastError };
    },
    'update.download': (p) => {
      const config = effectiveConfig();
      const targetDir = typeof p.targetDir === 'string' ? p.targetDir.trim() : '';
      if (!targetDir || !path.isAbsolute(targetDir)) {
        return { ok: false, code: 'TARGET_REQUIRED', message: '必须提供绝对路径 targetDir（下载目标目录）' };
      }
      const filename = typeof p.filename === 'string' ? p.filename.trim() : '';
      if (!filename || filename !== path.basename(filename) || filename.length > 200) {
        return { ok: false, code: 'INVALID_FILENAME', message: '文件名非法（必须是纯文件名，不允许路径分隔符）' };
      }
      const targetPath = path.join(path.resolve(targetDir), filename);
      return artifactDownloader.download({
        url: p.url,
        sha256: p.sha256,
        bytes: p.bytes,
        targetPath,
        allowedHosts: config.allowedHosts
      });
    }
  };

  return {
    checker,
    downloader: artifactDownloader,
    notesCache,
    maxDownloadBytes: DOWNLOAD_MAX_BYTES_DEFAULT,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(Object.assign(new Error('未知 Update 方法：' + String(method)), { code: 'METHOD_NOT_FOUND' }));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
