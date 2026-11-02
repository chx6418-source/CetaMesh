import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons';
import { Button } from '../components/primitives/inputs';
import { Badge } from '../components/primitives/surfaces';
import { DiagnosticsEntry, FeedbackDeveloperButton } from './StartupDiagnostics';

export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作暂时无法完成，请稍后重试。';

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="harbor-error" role="alert"><Icon name="help" size={17} /><span>{error}</span>{onRetry && <Button compact variant="ghost" onClick={onRetry}>重试</Button>}<DiagnosticsEntry label="诊断"/><FeedbackDeveloperButton/></div>;
}

export function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}

export function EmptyNotice({ icon = 'sparkles', title, detail, action }: { icon?: IconName; title: string; detail: string; action?: ReactNode }) {
  return <div className="harbor-empty"><Icon name={icon} size={26} /><strong>{title}</strong><p>{detail}</p>{action}</div>;
}
export function StatusBadge({ value, available }: { value: string; available?: boolean | null }) {
  if (['clean', 'dirty', 'directory', 'recovery-required'].includes(value)) return <Badge tone={value === 'recovery-required' ? 'danger' : value === 'dirty' ? 'warning' : 'default'}>{({ clean: '工作区干净', dirty: '有未提交修改', directory: '普通目录', 'recovery-required': '待恢复' } as Record<string, string>)[value]}</Badge>;
  const tone = available === true || ['ready', 'running', 'enabled', 'completed', 'current', 'installed'].includes(value) ? 'success'
    : ['needs-setup', 'connection-pending', 'descriptor-incomplete', 'pending', 'awaiting-review', 'waiting-approval', 'starting', 'start-timeout', 'checking', 'update'].includes(value) ? 'warning'
      : ['unavailable', 'error', 'failed', 'stopped', 'disabled'].includes(value) ? 'danger' : 'default';
  const label = ({ 'awaiting-review': '待验收', ready: '已就绪', running: '运行中', enabled: '已启用', installed: '已安装', update: '可更新', completed: '已完成', current: '当前步骤', 'needs-setup': '需要设置', 'descriptor-incomplete': '配置不完整', 'not-installed': '未安装', 'not-supported': '不支持', 'not-checked': '未检查', 'connection-pending': '已安装 · 待接入', checking: '检查中', 'start-timeout': '等待网关就绪', invalid: '安装需修复', unavailable: '暂不可用', disabled: '已停用', stopped: '已停止', pending: '等待处理', 'waiting-approval': '等待审批', starting: '启动中', error: '异常', failed: '失败', cancelled: '已取消', blocked: '待核对', queued: '待开始', paused: '已暂停' } as Record<string, string>)[value] ?? value;
  return <Badge tone={tone}>{label}</Badge>;
}
export function availabilityReasonLabel(reason: string | null) {
  if (!reason) return '';
  const labels: Record<string, string> = {
    check_failed: '连接检查失败，请检查连接后重试。',
    provider_login_execution_unverified: '账号模式尚未通过原生执行验证；可切回 API 配置。',
    windows_auth_contract_unverified: '官方登录需先完成 Windows 原生验证。',
    agent_model_required: '尚未选择模型，请在连接设置中填写模型。',
    agent_credential_required: '尚未配置此 Agent 的 API Key，请在连接设置中保存凭据。',
    credential_missing: '尚未配置此 Agent 的 API Key，请在连接设置中保存凭据。',
    runtime_missing: '未检测到编码运行时，请按官方文档安装并配置路径。',
    runtime_not_installed: '未检测到编码运行时，请按官方文档安装并配置路径。',
    runtime_not_checked: '编码运行时尚未检查，请点击检查连接。',
    runtime_verification_required: '编码运行时需要重新验证，请点击检查连接。',
    runtime_changed: '编码运行时或配置已变化，请关闭原会话后重新检查连接。',
    provider_disabled: '此 Agent 连接已停用，可在连接设置中启用。',
    disabled: '此 Agent 连接已停用，可在连接设置中启用。',
    runtime_disabled: '此 Agent 连接已停用，可在连接设置中启用。',
    sdk_resource_missing: '当前应用缺少已验证的 SDK 资源，请更新或修复 CetaMesh。',
    sdk_missing: '当前应用缺少已验证的 SDK 资源，请更新或修复 CetaMesh。',
    claude_sdk_resource_unverified: 'Claude SDK 资源缺失或未通过校验，请更新或修复 CetaMesh。',
    native_input_unverified: '此版本的 Agent 未提供完整工具参数，无法安全审批，暂不开放任务执行。',
    native_approval_unavailable: '原生工具逐次审批尚未就绪，请重启 Core 或检查应用配置。',
    agent_runtime_config_corrupt: '运行时配置已损坏或无法读取；原数据已保留，请核对数据目录后恢复配置。',
    agent_runtime_credential_scope_mismatch: 'API Key 的端点范围已变化，请核对端点并重新保存 API Key。',
    claude_code_not_found: '未检测到 Claude Code 编码运行时，请按官方文档安装并配置路径。',
    claude_code_path_unsupported: '此路径不是受支持的 Claude Code 编码运行时，请重新选择。',
    claude_code_binary_invalid: 'Claude Code 编码运行时文件无效，请检查安装与路径。',
    claude_code_unreadable: '无法读取 Claude Code 编码运行时，请检查路径与文件权限。',
    claude_code_binary_changed: 'Claude Code 编码运行时已变化，请关闭原会话后重新检查连接。',
    claude_code_identity_unverified: 'Claude Code 版本身份尚未验证，请检查安装后重新检查连接。',
    claude_code_protocol_unverified: 'Claude Code 控制协议尚未验证，请检查兼容版本后重新检查连接。',
    claude_code_probe_failed: 'Claude Code 运行时检查失败，请检查安装后重试。',
    claude_code_exit_unconfirmed: 'Claude Code 检查进程尚未确认退出，请先核对运行状态。',
    acp_initialize_failed: '编码运行时连接握手失败，请检查安装与运行时路径后重试。',
    desktop_cli_missing: '桌面客户端已安装；尚未检测到用于连接的 CLI', acp_runtime_unverified: 'CLI 已检测到；本机连接协议与权限策略尚未验证',
    not_installed: '未安装', acp_version_unverified: '本机 ACP 版本尚未验证',
    acp_launch_unverified: '本机 ACP 启动方式尚未验证', native_policy_unverified: '原生权限与执行范围尚未验证',
    task_binding_unavailable: '工作区任务绑定尚未就绪', runtime_detection_failed: '运行时检查失败，请重新检查',
    sdk_runtime_unverified: 'Claude SDK 与本机运行时尚未验证', runtime_security_unverified: 'Claude 本机运行时与权限策略尚未验证',
    external_protocol_unverified: '外部控制协议尚未验证',
    developer_configuration_missing: '需要开发者应用配置', oauth_exchange_unconfigured: '账号授权交换尚未配置',
    'not-installed': '未安装', 'needs-setup': '需要配置', stopped: '已停止', 'start-timeout': '等待网关就绪',
    'provider-unavailable': '服务未连接', 'server-stopped': '已停止', 'task-required': '创建任务后使用',
    'workspace-required': '需要工作区', 'scope-unavailable': '需要工作区', 'descriptor-incomplete': '能力描述不完整',
    'not-supported': '暂不支持', 'not-checked': '尚未检查', unavailable: '服务未连接'
  };
  return labels[reason] ?? labels[reason.trim().toLowerCase()] ?? '当前能力尚未验证，请检查连接与配置';
}

export const dateLabel = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
};

export function dshSetupReasonLabel(reason: string | null | undefined) {
  const messages: Record<string, string> = {
    'preset-not-configured': '尚未选择编程预设，请配置 DSH 编程预设后重新检查。',
    'preset-file-not-found': '找不到预设文件，请检查 DSH 目录和预设名称。',
    'preset-file-unreadable': '无法读取预设文件，请检查本地文件权限。',
    'preset-file-too-large': '预设文件过大，请缩小文件后重新检查。',
    'path-outside-root': '预设路径超出 DSH 预设目录，请检查名称和目录。',
    'preset-yaml-invalid': '预设 YAML 格式无效，请修正文件后重新检查。',
    'preset-yaml-limits-exceeded': '预设 YAML 超出安全读取限制，请简化文件。',
    'preset-schema-unverified': '无法验证此预设格式，请使用兼容的 DSH persona 预设。',
    'persona-missing': '预设缺少 persona 内容，请补全预设。',
    'persona-prefix-required': '预设 persona 格式不兼容，请检查 persona 前缀。',
    'preset-not-loaded': '预设未被 DSH 原生加载，请在 DSH 中加载该预设后检查连接。',
    'preset-load-unknown': '无法确认 DSH 原生加载状态，请检查 DSH 服务后重新检查连接。',
    'authentication-required': 'DSH 需要本地登录，请在 DSH 中登录后检查连接。',
    'authentication-material-missing': '缺少 DSH 本地认证信息，请先完成 DSH 登录。',
    'not_connected': '无法连接 DSH，请检查服务地址和运行状态。',
    'host-origin-rejected': 'DSH 拒绝了本机来源，请检查 DSH 的来源访问设置。',
    'session-api-unavailable': 'DSH 会话接口不可用，请检查 DSH 版本与服务状态。',
    'DSH_CONFIG_INVALID': 'DSH 连接配置无效，请检查并重新保存配置。'
  };
  return reason ? messages[reason] ?? availabilityReasonLabel(reason) : '';
}

export const relativeLabel = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - date) / 60_000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
};
