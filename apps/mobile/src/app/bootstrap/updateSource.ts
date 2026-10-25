import {unconfiguredUpdateService, type UpdateService} from '../../domain/update/UpdateService';
import type {HttpTransport} from '../../providers/network/HttpTransport';
import {FallbackUpdateService} from '../../providers/update/FallbackUpdateService';
import {GitCodeManifestUpdateService, defaultGitCodeManifestUrl} from '../../providers/update/GitCodeManifestUpdateService';
import {GitHubReleaseUpdateService} from '../../providers/update/GitHubReleaseUpdateService';

// Official development targets CetaMesh; anonymous APKs keep reading releases
// from this public repository. Repository migration does not change this endpoint.
export const publicUpdateRepository: string | undefined = 'chx6418-source/CetaMesh';

// 更新拓扑（分发运行时 v1）：GitCode 中国区优先源 → GitHub 备用源。
// GitCode 返回合法「无更新」时不会访问 GitHub；GitCode 失败（网络/超时/清单损坏/缺 APK）
// 才降级到 GitHub。两个源都保持「只有真正含 APK 安装包才算 installable update」。
export function createUpdateService(
  transport: HttpTransport,
  currentVersion: string,
  repository: string | undefined = publicUpdateRepository,
): UpdateService {
  if (!repository) {
    return unconfiguredUpdateService;
  }
  return new FallbackUpdateService(
    new GitCodeManifestUpdateService(transport, currentVersion, defaultGitCodeManifestUrl),
    new GitHubReleaseUpdateService(transport, currentVersion, repository),
  );
}
