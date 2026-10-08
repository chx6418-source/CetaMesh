// CetaMesh Desktop —— Update 服务（阶段 12 / 分发运行时 v1）。
//
// 配置（清单地址 / 备用清单地址 / 固定公钥 / 通道 / 允许主机）来自产品设置，UI 改设置即生效。
// 构造时不发起网络请求；只有显式调用 update.check / update.download 才会联网。
//
// 分发拓扑（默认部署）：update.check 先访问 `manifestUrl`（GitCode 中国区优先源），
// 失败（超时 / 5xx / 清单损坏 / 验签失败 / 缺 windows-x64 安装包）再降级到
// `fallbackManifestUrl`（GitHub）；合法「无更新」不会触发备用源请求。
// update.download 只下载 + SHA256 校验 + 原子落盘；安装始终由用户手动确认（handoff 语义不变）。

import path from 'node:path';
import { createUpdateChecker } from './checker.js';
import { DOWNLOAD_MAX_BYTES_DEFAULT, createArtifactDownloader } from './download.js';

export function createUpdateService({ currentVersion, settingsStore = null, fetchImpl = null, downloader = null } = {}) {
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

  const handlers = {
    'update.capabilities': () => ({
      ...checker.capabilities(),
      // 分发运行时新增：可下载并校验安装包（下载在独立模块，checker 本体仍无下载入口）；
      // 安装仍然永远需要用户确认，download 从不执行下载物。
      canDownloadVerifiedArtifact: true,
      canExecuteInstaller: false,
      sourcePriority: ['gitcode', 'github']
    }),
    'update.config': () => {
      const config = effectiveConfig();
      return { config: { ...config, pinnedPublicKey: config.pinnedPublicKey ? '[configured]' : '' } };
    },
    'update.check': (p) => {
      const config = effectiveConfig();
      return checker.check({
        manifestUrl: p.manifestUrl === undefined ? config.manifestUrl : p.manifestUrl,
        fallbackManifestUrl: p.fallbackManifestUrl === undefined ? config.fallbackManifestUrl : p.fallbackManifestUrl,
        pinnedPublicKey: p.pinnedPublicKey === undefined ? config.pinnedPublicKey : p.pinnedPublicKey,
        channel: p.channel === undefined ? config.channel : p.channel,
        allowedHosts: config.allowedHosts
      });
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
    maxDownloadBytes: DOWNLOAD_MAX_BYTES_DEFAULT,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(Object.assign(new Error('未知 Update 方法：' + String(method)), { code: 'METHOD_NOT_FOUND' }));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
