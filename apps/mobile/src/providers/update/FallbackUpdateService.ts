import type {UpdateAnnouncement, UpdateCheck, UpdateService} from '../../domain/update/UpdateService';

// CetaMesh Mobile —— 统一更新源编排（分发运行时 v1）。
//
// 拓扑：GitCode（中国区优先源）→ GitHub（备用源）。
//   - 主源返回合法结果（available / current）→ 直接采用；
//     合法「无更新」（current）**不**访问备用源（避免无谓的 GitHub 请求与漂移判定）；
//   - 主源失败（网络 / 超时 / 清单损坏 / 缺 APK）→ 降级访问备用源；
//   - 备用源也失败 → 返回 unavailable（诚实语义：无法判定 —— 绝不当作「已是最新」）。
//
// 两个源都保持「只有真正含 APK 安装包才算 installable update」的安全逻辑。
export class FallbackUpdateService implements UpdateService {
  constructor(
    private readonly primary: UpdateService,
    private readonly fallback: UpdateService,
  ) {}

  async checkForUpdate(): Promise<UpdateCheck> {
    try {
      return await this.primary.checkForUpdate();
    } catch {
      // 主源不可用 → 尝试备用源。
    }
    try {
      const result = await this.fallback.checkForUpdate();
      return result.status === 'available' || result.status === 'current' ? {...result, source: 'github'} : result;
    } catch {
      // 两个源都失败：如实报告无法判定，而不是「无更新」。
      return {status: 'unavailable'};
    }
  }

  async getLatestVersion(): Promise<string | undefined> {
    try {
      return await this.primary.getLatestVersion();
    } catch {
      // 主源不可用 → 尝试备用源。
    }
    try {
      return await this.fallback.getLatestVersion();
    } catch {
      return undefined;
    }
  }

  async getReleaseNotes(): Promise<UpdateAnnouncement[]> {
    try {
      return await this.primary.getReleaseNotes();
    } catch {
      // 主源不可用 → 尝试备用源。
    }
    try {
      return await this.fallback.getReleaseNotes();
    } catch {
      return [];
    }
  }

  async downloadUpdate(): Promise<string | undefined> {
    try {
      return await this.primary.downloadUpdate();
    } catch {
      // 主源不可用 → 尝试备用源。
    }
    try {
      return await this.fallback.downloadUpdate();
    } catch {
      return undefined;
    }
  }
}
