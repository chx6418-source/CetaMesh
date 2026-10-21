// CetaMesh Desktop —— 页面树与工程页面归位（阶段 12）。
//
// 阶段要求：把原来散落的工程页面（Core status / DSH service / SnowLuma / IPC / Logs /
// Whitelists / Runtime policy）**移到高级/诊断区域**。
//
// 这份声明让"归位"变成可断言的数据，而不是靠 UI 代码里分散的判断：
//   - PRIMARY 只有四个产品页；
//   - ENGINEERING_PAGES 明确标注每个工程页归属 diagnostics 还是 advanced；
//   - engineeringPlacement() 供 UI 与测试直接检查"没有工程页残留在产品主区"。

export const PRIMARY_PAGES = Object.freeze(['home', 'chat', 'work', 'social', 'agents', 'plugins', 'memory', 'workspaces', 'devices', 'connections', 'security', 'settings']);

export const ENGINEERING_PAGES = Object.freeze([
  { id: 'core.status', label: 'Core status', area: 'diagnostics', source: 'legacy:Overview' },
  { id: 'service.dsh', label: 'DSH service', area: 'diagnostics', source: 'legacy:Services' },
  { id: 'service.snowluma', label: 'SnowLuma（Channel Adapter）', area: 'diagnostics', source: 'legacy:Services' },
  { id: 'ipc.status', label: 'IPC', area: 'diagnostics', source: 'legacy:Diagnostics' },
  { id: 'logs', label: 'Logs', area: 'diagnostics', source: 'legacy:Logs' },
  { id: 'security.whitelists', label: 'Whitelists', area: 'advanced', source: 'legacy:Policy' },
  { id: 'policy.runtime', label: 'Runtime policy', area: 'advanced', source: 'legacy:Policy' }
]);

export const ENGINEERING_AREAS = Object.freeze(['diagnostics', 'advanced']);

export function engineeringPlacement() {
  const misplaced = ENGINEERING_PAGES.filter((page) => !ENGINEERING_AREAS.includes(page.area)).map((page) => page.id);
  const leakedIntoPrimary = ENGINEERING_PAGES
    .filter((page) => PRIMARY_PAGES.includes(page.id))
    .map((page) => page.id);
  return {
    invariant: 'engineering-pages-must-live-under-advanced-or-diagnostics',
    misplaced,
    leakedIntoPrimary,
    ok: misplaced.length === 0 && leakedIntoPrimary.length === 0,
    diagnostics: ENGINEERING_PAGES.filter((page) => page.area === 'diagnostics').map((page) => page.id),
    advanced: ENGINEERING_PAGES.filter((page) => page.area === 'advanced').map((page) => page.id)
  };
}
