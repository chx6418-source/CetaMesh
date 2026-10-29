// CetaMesh Desktop Extension v1 —— 领域契约（阶段 10）。
//
// 本文件只定义词表与纯函数：扩展类型、权限表（含风险等级）、版本比较、ID 校验。
// 不做 IO，不依赖 UI / DSH。
//
// 安全立场（对应阶段要求「禁止默认」）：
// - 任意下载 JS 后执行、任意 Shell、任意磁盘访问、任意 Native DLL 加载
//   在本表里被登记为 risk: 'forbidden' —— 不是「默认关闭」，而是**根本不可授予**，
//   review/install 阶段会直接拒绝，运行期也不存在对应能力。
// - 其余权限必须由 manifest 显式声明，并在安装前经过 Permission Review。

export const EXTENSION_TYPES = Object.freeze([
  'tool', 'external-api', 'workflow', 'memory-pack', 'channel-adapter', 'agent-adapter', 'ui'
]);

// UI Extension 本阶段只保留接口（允许声明 type=ui 与 capability kind=ui），不实现复杂插件 UI。

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical', 'forbidden']);
const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3, forbidden: 99 });

export function riskRank(risk) {
  return Object.hasOwn(RISK_RANK, risk) ? RISK_RANK[risk] : 99;
}

export function maxRisk(levels) {
  let worst = 'low';
  for (const level of levels) {
    if (riskRank(level) > riskRank(worst)) worst = level;
  }
  return worst;
}

/**
 * 权限表。
 * requires: 声明该权限时必须同时提供哪些附加信息（例如 network 必须列 hosts）。
 */
export const PERMISSIONS = Object.freeze({
  'extension.invoke': { risk: 'high', summary: 'Call only reviewed plugin capabilities within their declared input schema' },
  log: { risk: 'low', summary: '写入扩展自己的运行日志' },
  storage: { risk: 'low', summary: '使用按扩展 id 隔离的私有键值存储' },
  'memory.read': { risk: 'medium', summary: '读取已授权范围内的 CetaMesh Memory' },
  'memory.write': { risk: 'high', summary: '写入 CetaMesh Memory（长期记忆仍需用户确认）' },
  network: { risk: 'high', summary: '访问 manifest 声明的外部主机', requires: ['hosts'] },
  'filesystem.read': { risk: 'high', summary: '读取 manifest 声明范围内的工作区文件', requires: ['paths'] },
  'filesystem.write': { risk: 'critical', summary: '写入 manifest 声明范围内的工作区文件', requires: ['paths'] },
  // ── 以下四项对应「禁止默认」清单，永远不可授予 ──────────────────────────
  shell: { risk: 'forbidden', summary: '执行任意 Shell 命令（不可授予）' },
  native: { risk: 'forbidden', summary: '加载 Native DLL / .node 模块（不可授予）' },
  download: { risk: 'forbidden', summary: '从网络下载并执行代码（不可授予）' },
  process: { risk: 'forbidden', summary: '访问宿主进程与任意磁盘（不可授予）' }
});

export const PERMISSION_NAMES = Object.freeze(Object.keys(PERMISSIONS));

export function isKnownPermission(name) {
  return Object.hasOwn(PERMISSIONS, name);
}

export function permissionRisk(name) {
  const entry = PERMISSIONS[name];
  return entry ? entry.risk : 'forbidden';
}

/** 需要用户显式批准的风险等级（安装前 Permission Review）。 */
export function requiresExplicitApproval(name) {
  return riskRank(permissionRisk(name)) >= riskRank('high');
}

export const EXTENSION_STATUSES = Object.freeze(['installed', 'enabled', 'disabled', 'disabled_due_to_crash']);

export const EXTENSION_LIMITS = Object.freeze({
  idChars: 64,
  nameChars: 120,
  descriptionChars: 1000,
  versionChars: 32,
  capabilities: 50,
  permissions: 24,
  hosts: 20,
  paths: 20,
  entryChars: 200,
  sourceFiles: 200,
  sourceBytes: 2 * 1024 * 1024,
  invokeTimeoutMs: 5000
});

export function extensionError(code, message) {
  return Object.assign(new Error(message), { code });
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function normalizeExtensionId(value) {
  const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!ID_RE.test(text)) {
    throw extensionError('INVALID_EXTENSION_ID', '非法扩展 id：' + text.slice(0, 40) + '（要求小写字母/数字/._-，2..64 字符）');
  }
  return text;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function normalizeVersion(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!VERSION_RE.test(text) || text.length > EXTENSION_LIMITS.versionChars) {
    throw extensionError('INVALID_VERSION', '非法版本号：' + text.slice(0, 40) + '（要求 semver，如 1.2.3）');
  }
  return text;
}

/** semver 主次修订比较（忽略预发布标识，够用且不引入依赖）。 */
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function normalizeType(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!EXTENSION_TYPES.includes(text)) {
    throw extensionError('INVALID_EXTENSION_TYPE', '未知扩展类型：' + text.slice(0, 40));
  }
  return text;
}

export function normalizeEntry(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) throw extensionError('INVALID_ENTRY', 'manifest 必须声明 entry');
  if (text.length > EXTENSION_LIMITS.entryChars) throw extensionError('INVALID_ENTRY', 'entry 过长');
  // 入口必须是扩展目录内的相对路径，禁止绝对路径与目录穿越。
  if (text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:/.test(text)) {
    throw extensionError('INVALID_ENTRY', 'entry 必须是扩展目录内的相对路径');
  }
  if (text.split(/[\\/]/).some((seg) => seg === '..')) {
    throw extensionError('INVALID_ENTRY', 'entry 不允许目录穿越');
  }
  return text;
}

/** scope.paths：相对路径、无穿越；用于 filesystem.* 的声明范围。 */
export function normalizeScopePaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw extensionError('INVALID_SCOPE', 'scope.paths 必须是数组');
  const out = [];
  for (const raw of value) {
    const text = String(raw === null || raw === undefined ? '' : raw).trim().replace(/\\/g, '/');
    if (!text) continue;
    if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
      throw extensionError('INVALID_SCOPE', 'scope.paths 必须是工作区内的相对路径：' + text.slice(0, 40));
    }
    if (text.split('/').some((seg) => seg === '..')) {
      throw extensionError('INVALID_SCOPE', 'scope.paths 不允许目录穿越：' + text.slice(0, 40));
    }
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > EXTENSION_LIMITS.paths) throw extensionError('INVALID_SCOPE', 'scope.paths 最多 ' + EXTENSION_LIMITS.paths + ' 条');
  return out;
}

/** network.hosts：仅允许主机名（可选端口），禁止协议/路径/通配符泛化到任意域。 */
export function normalizeHosts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw extensionError('INVALID_NETWORK', 'network.hosts 必须是数组');
  const out = [];
  for (const raw of value) {
    const text = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
    if (!text) continue;
    if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(text)) {
      throw extensionError('INVALID_NETWORK', '非法主机声明：' + text.slice(0, 40));
    }
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > EXTENSION_LIMITS.hosts) throw extensionError('INVALID_NETWORK', 'network.hosts 最多 ' + EXTENSION_LIMITS.hosts + ' 条');
  return out;
}

/** 主机是否命中声明白名单（精确或子域匹配）。 */
export function hostAllowed(host, allowed) {
  const target = String(host).toLowerCase();
  return allowed.some((entry) => {
    const [hostPart] = entry.split(':');
    return target === hostPart || target.endsWith('.' + hostPart);
  });
}
