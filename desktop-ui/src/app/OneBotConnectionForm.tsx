import { type OneBotSettings, type OneBotMigrationPreview } from '../bridge/typed-client';
import { Button, Input } from '../components/primitives/inputs';
import { Badge, Surface } from '../components/primitives/surfaces';

export interface OneBotConnectionDraft {
  enabled: boolean; httpUrl: string; wsUrl: string; accessToken: string; httpAccessToken: string;
  clearAccessToken: boolean; clearHttpAccessToken: boolean;
}
type OneBotConnectionFormProps = {
  settings: OneBotSettings; draft: OneBotConnectionDraft; busy: boolean;
  migrationPreview: OneBotMigrationPreview | null;
  onDraftChange: (draft: OneBotConnectionDraft) => void; onSave: () => void;
  onAction: (action: 'health' | 'start' | 'stop' | 'reconnect') => void;
  onPreviewMigration: () => void; onApplyMigration: () => void; onCancelMigration: () => void;
};
export function OneBotConnectionForm({ settings, draft, busy, migrationPreview, onDraftChange, onSave, onAction, onPreviewMigration, onApplyMigration, onCancelMigration }: OneBotConnectionFormProps) {
  const { configuration, health } = settings;
  const ready = health.ready === true && health.connected === true && health.authenticated === true;
  const unavailable = Boolean(health.error) || ['error', 'unavailable', 'auth-failed'].includes(health.state);
  return <form onSubmit={event => { event.preventDefault(); if (!busy) onSave(); }}>
    <h3>OneBot 通道</h3>
    <p>这是可选的外部消息通道，默认关闭。请自行配置兼容 OneBot 的网关；CetaMesh 仅连接通道。</p>
    <div className="row detail-actions" role="status" aria-label="OneBot 连接证据">
      <Badge>{health.configured === true ? '已配置' : health.configured === false ? '未配置' : '配置未知'}</Badge>
      <Badge>{health.connected === true ? '已连接' : health.connected === false ? '未连接' : '连接未验证'}</Badge>
      <Badge>{health.authenticated === true ? '已认证' : health.authenticated === false ? '未认证' : '认证未验证'}</Badge>
      <Badge tone={unavailable ? 'danger' : ready ? 'success' : 'default'}>{unavailable ? '不可用' : ready ? '可用' : '可用性未验证'}</Badge>
    </div>
    {health.accountId && <small>当前账号 {health.accountId}</small>}
    {health.error && <p className="message-error" role="status">{typeof health.error==='string'?health.error:`[${health.error.code}] ${health.error.message}`}</p>}
    <p className="muted">{health.canSend === true ? '当前允许发送；每次操作仍受通道权限和白名单限制。' : health.canSend === false ? '当前不能发送消息。' : '发送权限尚未验证。'}</p>
    <details className="plugin-advanced-settings" open={!health.configured}>
      <summary>连接设置</summary>
      <div className="plugin-advanced-fields">
        <label><input type="checkbox" aria-label="允许 OneBot 连接" checked={draft.enabled} disabled={busy} onChange={event => onDraftChange({ ...draft, enabled: event.target.checked })} />允许连接（默认关闭）</label>
        <label>OneBot HTTP 地址<Input aria-label="OneBot HTTP 地址" value={draft.httpUrl} disabled={busy} onChange={event => onDraftChange({ ...draft, httpUrl: event.target.value })} maxLength={500} /></label>
        <label>OneBot WebSocket 地址<Input aria-label="OneBot WebSocket 地址" value={draft.wsUrl} disabled={busy} onChange={event => onDraftChange({ ...draft, wsUrl: event.target.value })} maxLength={500} /></label>
        <p className="muted">更改端点后请重新填写令牌。留空保留当前端点已保存的凭据；端点变化时旧凭据会清除。</p>
        <label>WebSocket Access Token<Input aria-label="OneBot WebSocket 令牌" type="password" autoComplete="new-password" value={draft.accessToken} disabled={busy} placeholder={configuration.accessTokenConfigured ? '已配置；留空保留' : '按网关要求填写'} onChange={event => onDraftChange({ ...draft, accessToken: event.target.value, clearAccessToken: false })} maxLength={512} /></label>
        {configuration.accessTokenConfigured && <label><input type="checkbox" checked={draft.clearAccessToken} disabled={busy} onChange={event => onDraftChange({ ...draft, clearAccessToken: event.target.checked, accessToken: '' })} />清除已保存的 WebSocket 令牌</label>}
        <label>HTTP Access Token<Input aria-label="OneBot HTTP 令牌" type="password" autoComplete="new-password" value={draft.httpAccessToken} disabled={busy} placeholder={configuration.httpAccessTokenConfigured ? '已配置；留空保留' : '按网关要求填写'} onChange={event => onDraftChange({ ...draft, httpAccessToken: event.target.value, clearHttpAccessToken: false })} maxLength={512} /></label>
        {configuration.httpAccessTokenConfigured && <label><input type="checkbox" checked={draft.clearHttpAccessToken} disabled={busy} onChange={event => onDraftChange({ ...draft, clearHttpAccessToken: event.target.checked, httpAccessToken: '' })} />清除已保存的 HTTP 令牌</label>}
        <Button compact variant="primary" type="submit" disabled={busy}>保存配置</Button>
      </div>
    </details>
    <p className="muted">编辑和保存设置不会建立连接。连接操作使用已保存的配置，并由 Core 检查授权。</p>
    <div className="row detail-actions">
      <Button compact type="button" disabled={busy} onClick={() => onAction('health')}>健康检查</Button>
      <Button compact type="button" variant="primary" disabled={busy || !configuration.enabled || health.configured !== true || health.connected === true} onClick={() => onAction('start')}>连接</Button>
      <Button compact type="button" disabled={busy || health.connected === false} onClick={() => onAction('stop')}>断开连接</Button>
      <Button compact type="button" disabled={busy || !configuration.enabled || health.configured !== true} onClick={() => onAction('reconnect')}>重新连接</Button>
    </div>
    {configuration.legacyPresent && !migrationPreview && <Button compact type="button" variant="ghost" disabled={busy} onClick={onPreviewMigration}>查看旧连接迁移</Button>}
    {migrationPreview && <Surface>
      <h4>确认迁移旧连接端点</h4>
      <p>仅复制下列端点，迁移后保持关闭。旧配置与角色数据保留；需要重新输入令牌后保存，再明确连接。</p>
      <p>HTTP：{migrationPreview.candidate.httpUrl || '未配置'}<br />WebSocket：{migrationPreview.candidate.wsUrl || '未配置'}</p>
      {migrationPreview.hasCurrentConfig && <p className="message-error">已有 OneBot 配置，不能覆盖迁移。</p>}
      {!migrationPreview.legacyPresent && <p>未发现可迁移的旧连接。</p>}
      <div className="row detail-actions"><Button compact type="button" disabled={busy} onClick={onCancelMigration}>取消</Button><Button compact type="button" disabled={busy || migrationPreview.hasCurrentConfig || !migrationPreview.legacyPresent} onClick={onApplyMigration}>确认迁移端点并保持关闭</Button></div>
    </Surface>}
  </form>;
}
