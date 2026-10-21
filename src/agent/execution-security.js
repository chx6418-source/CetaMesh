import crypto from 'node:crypto';
import { agentProviderError } from './agent-provider.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Descriptions are Adapter-owned; platform authority never derives from these fields. */
export function describeAgentExecutionSecurity(provider, workspaceId, workspaceIdentity = null) {
  const declared = provider.capabilities()?.security;
  if (!declared) return { required: false, authorized: true, security: null, fingerprint: null, disclosure: '' };
  if (!['native', 'isolated'].includes(declared.mode)) {
    throw agentProviderError('AGENT_SECURITY_DESCRIPTOR_INVALID', 'Agent declares an unknown execution security mode');
  }
  const security = structuredClone(declared);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical({ provider: provider.id, workspaceId, workspaceIdentity, security }))).digest('hex');
  const limitations = Array.isArray(security.securityLimitations) ? security.securityLimitations.map(String).join('\n') : '';
  return { required: true, authorized: false, fingerprint, security,
    disclosure: `${provider.label} — ${security.mode === 'native' ? 'Native Security' : 'Isolated Workspace'}\n`
      + `原生沙箱：${security.nativeSandboxMode ?? 'UNVERIFIED'}；审批策略：${security.nativeApprovalPolicy ?? 'UNVERIFIED'}。\n`
      + (workspaceIdentity ? '工作区：' + String(workspaceIdentity) + '\n' : '')
      + '确认范围：本 Core 进程内，此工作区使用同一 Agent 和安全策略的任务；不授予新的平台工具权限。\n'
      + '工作目录和 Staging 不是宿主文件隔离。原生命令可能读取工作区外文件；写入及网络访问由 Agent 原生策略决定。\n'
      + 'CetaMesh Broker 不能拦截直接 OS 文件操作。只有经 CetaMesh 导入的成果需要平台审批；直接 OS 修改不经过导入审批。\n'
      + limitations };
}
