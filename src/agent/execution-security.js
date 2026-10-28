import crypto from 'node:crypto';
import { agentProviderError } from './agent-provider.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Explicit negative readiness is authoritative; absence is not proof of readiness. */
export function hasNegativeAgentReadiness(health) {
  return ['launchable', 'versionCompatible', 'sessionCreatable', 'toolCallingCapable',
    'workspaceCapable', 'quotaAvailable'].some(field => health?.[field] === false);
}
/** Permission approval is an explicit mode and never establishes an OS sandbox. */
export function isNativePermissionSecurity(security) {
  return security?.mode === 'native-permissions'
    && security.nativeSandboxSupported === false
    && security.strictIsolationVerified === false
    && security.nativeApprovalSupported === true
    && security.nativePermissionPolicyVerified === true
    && security.allToolsRequireApproval === true
    && security.nativeSandboxMode === 'none';
}

/** Explicit Owner dispatch may verify a configured API key on its first request. */
export function canDispatchConfiguredNativeAgent(health, security) {
  return security?.verified === true && isNativePermissionSecurity(security)
    && health?.available === true && health?.installed === true && health?.compatible === true
    && health?.taskEligible === true && health?.sessionCapable === true
    && health?.disabled !== true && health?.enabled !== false && health?.ready !== false && health?.reachable !== false
    && health?.authenticated !== false && health?.authConfigured === true && health?.authVerified === false
    && health?.authentication === 'configured-unverified' && health?.reason == null;
}

/** Descriptions are Adapter-owned; platform authority never derives from these fields. */
export function describeAgentExecutionSecurity(provider, workspaceId, workspaceIdentity = null) {
  const declared = provider.capabilities()?.security;
  if (declared === undefined || declared === null) return { required: false, authorized: true, security: null, fingerprint: null, disclosure: '' };
  if (typeof declared !== 'object' || Array.isArray(declared) || !['native', 'isolated', 'native-permissions'].includes(declared.mode)) {
    throw agentProviderError('AGENT_SECURITY_DESCRIPTOR_INVALID', 'Agent declares an unknown execution security mode');
  }
  const security = structuredClone(declared);
  const nativePermissions = security.mode === 'native-permissions';
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical({ provider: provider.id, workspaceId, workspaceIdentity, security }))).digest('hex');
  const limitations = Array.isArray(security.securityLimitations) ? security.securityLimitations.map(String).join('\n') : '';
  return { required: true, authorized: false, fingerprint, security,
    disclosure: `${provider.label} — ${nativePermissions ? 'Native Permission Approvals（原生逐次审批）' : security.mode === 'native' ? 'Native Security' : 'Isolated Workspace'}\n`
      + `原生沙箱：${security.nativeSandboxMode ?? 'UNVERIFIED'}；审批策略：${security.nativeApprovalPolicy ?? 'UNVERIFIED'}。\n`
      + (workspaceIdentity ? '工作区：' + String(workspaceIdentity) + '\n' : '')
      + '确认范围：本 Core 进程内，此工作区使用同一 Agent 和安全策略的任务；不授予新的平台工具权限。\n'
      + (nativePermissions
        ? '此模式使用当前 Windows，不提供 OS 级沙箱或严格工作区隔离。原生工具由已验证的运行时策略逐次审批；批准的命令仍可能访问宿主文件与网络。\n'
          + '原生工具审批与成果导入的平台审批相互独立；成果导入仍需平台审批，直接 OS 修改不经过导入审批。\n'
          + '使用前仍需单独配置编码运行时和认证。CetaMesh Broker 不能拦截直接 OS 文件操作。\n'
        : '工作目录和 Staging 不是宿主文件隔离。原生命令可能读取工作区外文件；写入及网络访问由 Agent 原生策略决定。\n'
          + 'CetaMesh Broker 不能拦截直接 OS 文件操作。只有经 CetaMesh 导入的成果需要平台审批；直接 OS 修改不经过导入审批。\n')
      + limitations };
}
