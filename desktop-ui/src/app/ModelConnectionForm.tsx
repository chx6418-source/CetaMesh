import { useRef, useState } from 'react';
import type { ModelConfigurationConnection, ModelConfigurationState, ModelConnectionCommitInput, ModelProtocolProfile } from '../bridge/typed-client';
import { Button, Input } from '../components/primitives/inputs';

export interface ModelConnectionFormProps {
  connection?: ModelConfigurationConnection | null; expectedRevision: number; busy?: boolean;
  onCommit: (input: ModelConnectionCommitInput) => Promise<ModelConfigurationState>;
  onSaved?: (state: ModelConfigurationState) => void; onCancel?: () => void;
}

export function modelConfigurationError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : '';
  if (['SETTINGS_CONFLICT', 'MODEL_CONFIGURATION_CHANGED'].includes(code)) return '配置已变化。请刷新模型配置，核对当前内容后重新保存。';
  if (code === 'MODEL_CREDENTIAL_ORIGIN_MISMATCH') return '服务地址已改变。请重新输入该服务的 API Key 后再测试。';
  if (code === 'MODEL_CONFIGURATION_COMMIT_FAILED') return '保存结果需要核对。凭据已保留，请刷新当前配置后重新测试此连接。';
  if (code === 'SETTINGS_INVALID' || code === 'INVALID_PARAMS') return '请检查连接标识、模型 ID、能力数值与思考设置后重试。';
  return `${code ? `[${code}] ` : ''}模型操作未成功。请检查服务地址、凭据和网络后重试。`;
}

// The same form is mounted by Settings and Onboarding. A saved endpoint/key is
// never read into it. The password exists only in its DOM ref and one request.
export function ModelConnectionForm({ connection, expectedRevision, busy = false, onCommit, onSaved, onCancel }: ModelConnectionFormProps) {
  const [id, setId] = useState(connection?.id ?? `model-${Math.random().toString(36).slice(2, 10)}`);
  const [label, setLabel] = useState(connection?.label ?? '');
  const [profile, setProfile] = useState<ModelProtocolProfile>(connection?.protocolProfile ?? 'openai-chat-v1');
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [baseUrl, setBaseUrl] = useState('');
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState('');
  const password = useRef<HTMLInputElement>(null), inFlight = useRef(false);
  const locked = busy || submitting;
  async function save() {
    if (locked || inFlight.current) return;
    const input = password.current;
    inFlight.current = true; setSubmitting(true); setError('');
    try {
      const apiKey = input?.value.trim();
      const endpoint = baseUrl.trim() || (!connection ? profile === 'openai-chat-v1' ? 'https://api.openai.com/v1' : profile === 'deepseek-chat-v1' ? 'https://api.deepseek.com' : '' : '');
      const candidate = { ...(apiKey ? { apiKey } : {}), ...(endpoint ? { baseUrl: endpoint } : {}) };
      const result = await onCommit({ expectedRevision,
        connection: { id: id.trim(), label: label.trim(), protocolProfile: profile, enabled },
        ...(Object.keys(candidate).length ? { candidate } : {}) });
      setBaseUrl(''); onSaved?.(result);
    } catch (reason) { setError(modelConfigurationError(reason)); }
    finally { if (input) input.value = ''; inFlight.current = false; setSubmitting(false); }
  }
  return <form aria-label="模型连接表单" className="stack" style={{ minWidth: 0, overflowWrap: 'anywhere' }} onSubmit={event => { event.preventDefault(); void save(); }}>
    <h3>{connection ? '编辑模型连接' : '添加模型连接'}</h3>
    <label>连接名称<Input aria-label="连接名称" value={label} maxLength={120} required disabled={locked} placeholder="例如：工作用模型" onChange={event => setLabel(event.target.value)} /></label>
    <label>模型服务<select className="cm-input" aria-label="模型服务类型" value={profile} disabled={locked} onChange={event => setProfile(event.target.value as ModelProtocolProfile)}>
      <option value="openai-chat-v1">OpenAI / Chat Completions</option><option value="deepseek-chat-v1">DeepSeek</option><option value="openai-compatible-v1">其他兼容服务</option>
    </select></label>
    <label>API Key<Input ref={password} aria-label="模型 API Key" type="password" autoComplete="new-password" maxLength={4096} disabled={locked} placeholder={connection?.configured ? '已保存；留空保留原凭据' : '输入服务提供的 API Key'} /></label>
    <details data-model-connection-advanced>
      <summary>高级连接设置</summary>
      <div className="stack" style={{ paddingTop: 12 }}>
        <label>连接标识<Input aria-label="连接标识" value={id} required pattern="[a-z0-9][a-z0-9._-]{0,63}" maxLength={64} disabled={locked || !!connection} onChange={event => setId(event.target.value)} /></label>
        <label>服务地址（可选）<Input aria-label="模型服务地址" type="url" value={baseUrl} maxLength={2048} disabled={locked} placeholder={connection ? '留空沿用已保存地址' : profile === 'openai-compatible-v1' ? 'https://服务地址/v1' : '留空使用服务默认地址'} onChange={event => setBaseUrl(event.target.value)} /></label>
        <label><input type="checkbox" aria-label="允许使用此模型连接" checked={enabled} disabled={locked} onChange={event => setEnabled(event.target.checked)} />允许使用此连接</label>
      </div>
    </details>
    <p className="muted">测试会向所选服务读取模型目录。新发现的模型保持停用，请审核后启用。手动填写的能力仅是声明。</p>
    {error && <p className="message-error" role="alert">{error}</p>}
    <div className="row detail-actions" style={{ flexWrap: 'wrap' }}>
      <Button type="submit" variant="primary" disabled={locked || !label.trim() || !id.trim()}>{submitting ? '正在测试连接…' : '测试并保存连接'}</Button>
      {onCancel && <Button type="button" disabled={locked} onClick={() => { if (password.current) password.current.value = ''; onCancel(); }}>取消编辑连接</Button>}
    </div>
  </form>;
}
