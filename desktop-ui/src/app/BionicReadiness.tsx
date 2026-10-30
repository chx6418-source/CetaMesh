export interface BionicReadinessData {
  ready: boolean;
  canStart: boolean;
  checkedAt?: string | null;
  code?: string | null;
  dsh?: { ready?: boolean; sessionApi?: boolean; state?: string; code?: string | null } | null;
  preset?: { id?: string; compatible?: boolean; discovered?: boolean | null; ready?: boolean; reason?: string | null } | null;
  mcp?: { state?: string; verified?: boolean; tool?: string | null; checkedAt?: string | null } | null;
  qq?: { ready?: boolean; accountId?: string | null } | null;
}
export interface BionicActivityData {
  receive?: { state?: string; total?: number | null; acknowledged?: number | null; outcomeUnknown?: number | null; lastAt?: string | null } | null;
  send?: { state?: string; sent?: number | null; acknowledged?: number | null; outcomeUnknown?: number | null; lastAt?: string | null } | null;
}
const count = (value?: number | null) => typeof value === 'number' ? String(value) : '未核验';

export function BionicReadiness({ readiness, activity }: { readiness?: BionicReadinessData | null; activity?: BionicActivityData | null }) {
  if (!readiness) return <p>尚未检查 Bionic 环境。请运行健康检查以核对 QQ、会话和社交预设。</p>;
  const status = readiness.ready ? '链路已就绪' : readiness.canStart ? '可启动 · 等待工具链路验证' : '依赖尚未就绪';
  return <section className="bionic-readiness" aria-label="Bionic 环境检查">
    <p><strong>{status}</strong></p>
    <ul>
      <li>QQ Connector：{readiness.qq?.ready ? '账号已验证' : '连接或账号尚未验证'}</li>
      <li>DSH 会话：{readiness.dsh?.ready && readiness.dsh?.sessionApi ? '接口已连接' : '尚未连接或认证未通过'}</li>
      <li>社交人格 {readiness.preset?.id || '未选择'}：{readiness.preset?.ready ? '本地格式与原生目录已核对' : '预设需检查或升级'}</li>
      <li>MCP 工具链路：{readiness.mcp?.verified ? '当前运行已有成功工具回执' : readiness.mcp?.state === 'failed' ? '最新工具调用失败，请重新检查' : '尚无当前运行的成功工具回执'}</li>
    </ul>
    {!readiness.ready && <p>启用插件只保存开关。QQ 连接、策略进程和工具回执分别检查；首次启动可等待工具链路验证。</p>}
    {activity && <p>当前 QQ 账号记录：接收 {count(activity.receive?.total)}，Bionic 确认接收 {count(activity.receive?.acknowledged)}，接收结果待核对 {count(activity.receive?.outcomeUnknown)}；发送有消息回执 {count(activity.send?.sent)}，仅网关确认 {count(activity.send?.acknowledged)}，发送结果待核对 {count(activity.send?.outcomeUnknown)}。</p>}
    {readiness.code && <details><summary>检查详情</summary><small>{readiness.code}{readiness.preset?.reason ? ` · ${readiness.preset.reason}` : ''}{readiness.checkedAt ? ` · ${readiness.checkedAt}` : ''}</small></details>}
  </section>;
}
