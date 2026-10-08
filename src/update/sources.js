// CetaMesh Desktop —— 统一更新源（UpdateSource，分发运行时 v1）。
//
// 优先级（默认部署）：1) GitCode —— 中国区公开下载 / 更新优先源；2) GitHub —— 备用源。
// 之后官网 CDN 正式上线时只需再增加一个源，不需要改检查器逻辑（sources 数组可扩展）。
//
// GitCode 能力实测记录（2026-10-08，本机匿名访问，未使用任何凭据）：
//   - 仓库 https://gitcode.com/ygdnn/CetaMesh 存在，默认分支 main（1 个 Initial commit）。
//   - GET https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/releases        -> 200 application/json（当前为 []，尚无 release）
//   - GET https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/<path>      -> 200 原始文件字节（官方 raw API）
//   - GET https://raw.gitcode.com/ygdnn/CetaMesh/blobs/<blob>/<path>          -> 200 原始文件字节（contents API 的 download_url）
//   - GET https://gitcode.com/ygdnn/CetaMesh/releases/latest                  -> 400 {"error_code":400,"error_message":"未找到 release"}
//   - 网页端 /-/raw/ 与 /raw/ 路径返回的是 SPA HTML，**不是**原始文件，故不采用。
// 结论：发现入口采用仓库内版本化清单 `releases/stable.json`，经官方 raw API 拉取（小文件、可审计、
// 与 Release 解耦）；大体积安装包仍优先使用 Release Asset，由清单里的 url 字段指向。

export const UPDATE_SOURCE_IDS = Object.freeze(['gitcode', 'github']);

/** 每个发现源的连接/响应 deadline（毫秒）。2 个源合计 ≤ 12s，避免中国网络下长时间挂起。 */
export const DEFAULT_SOURCE_TIMEOUT_MS = 6000;

/** 主源：GitCode 仓库内版本化清单（官方 raw API，ref=main）。 */
export const DEFAULT_GITCODE_MANIFEST_URL =
  'https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/releases/stable.json?ref=main';

/** 备用源：GitHub 仓库内同名清单（raw.githubusercontent.com）。 */
export const DEFAULT_GITHUB_FALLBACK_MANIFEST_URL =
  'https://raw.githubusercontent.com/chx6418-source/whalebridge/main/releases/stable.json';

/**
 * 构造有序更新源列表。
 * - 显式传入 `sources`（[{id, manifestUrl}]）时按其顺序使用（未来官网 CDN 只需在这里追加）；
 * - 否则由 `manifestUrl`（主源，默认部署为 GitCode）+ `fallbackManifestUrl`（备用源，GitHub）构造。
 * id 会作为结构化结果里的 source 记录（gitcode / github），顺序即优先级。
 */
export function buildUpdateSources({ manifestUrl, fallbackManifestUrl, sources } = {}) {
  if (Array.isArray(sources) && sources.length) {
    return sources
      .filter((entry) => entry && entry.manifestUrl && String(entry.manifestUrl).trim())
      .map((entry, index) => ({
        id: String(entry.id || 'source-' + (index + 1)),
        manifestUrl: String(entry.manifestUrl).trim()
      }));
  }
  const list = [];
  if (manifestUrl && String(manifestUrl).trim()) {
    list.push({ id: 'gitcode', manifestUrl: String(manifestUrl).trim() });
  }
  if (fallbackManifestUrl && String(fallbackManifestUrl).trim()) {
    list.push({ id: 'github', manifestUrl: String(fallbackManifestUrl).trim() });
  }
  return list;
}
