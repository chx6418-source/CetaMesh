import { agentClient, approvalClient } from '../bridge/typed-client';

export async function confirmAgentExecution(provider: string, workspaceId: string) {
  if (!provider || provider === 'none' || !workspaceId) return;
  const scope = await agentClient.security(provider, workspaceId);
  if (!scope.required || scope.authorized) return;
  if (!window.confirm(scope.disclosure + '\n\n是否确认此原生执行范围？')) throw new Error('已取消 Agent 原生安全范围确认');
  const pending = await agentClient.authorize(provider, workspaceId, scope.fingerprint);
  if (pending.status !== 'pending' || !pending.approvalId) throw new Error('未取得有效的 Owner 审批请求');
  const decision = await approvalClient.decide(pending.approvalId, true);
  if (decision.operationId) {
    for (let n=0;n<100;n++) {
      const current = await approvalClient.operation(decision.operationId);
      if (current.status === 'completed') break;
      if (!['accepted','running'].includes(current.status)) throw new Error(current.code || '授权操作未完成');
      await new Promise(resolve => window.setTimeout(resolve,100));
    }
  }
  if (!(await agentClient.security(provider, workspaceId)).authorized) throw new Error('原生执行范围尚未确认');
}
