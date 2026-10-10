// Capability Broker —— Channel / Mesh 有限 Adapter（v2 hardening / Phase D）。
//
// 定位：把 Channel / Mesh 的**只读状态面**与 message.send 的校验面纳入统一
// Capability Registry（未知能力 fail-closed 的覆盖范围），但不把任何通道 SDK
// 逻辑搬进 Broker：
//   - 只读能力（channel.status / channel.declarations / mesh.status /
//     mesh.capabilities）包装现有服务的只读方法，risk=low；
//   - channel.send 只做 actor / scope / channel / target / risk 的**校验与裁决**，
//     实际发送经注入的 sendImpl（本阶段默认 null → PROVIDER_UNAVAILABLE 如实报告；
//     QQ 发送仍走其既有 MCP/白名单边界，见 RULES.md——后续把真实传输绑入时，
//     走这里已经就位的同一能力面）。
// 对齐三会话计划的边界：本轮只建 Adapter 与迁移最关键路径，不做全量目录迁移。

import { capabilityError } from './types.js';

const TARGET_KINDS = Object.freeze(['group', 'private']);
const TEXT_MAX_CHARS = 8000;
const emptyInput = { type: 'object', properties: {}, required: [], additionalProperties: false };
const channelSendInput = {
  type: 'object',
  properties: {
    channelId: { type: 'string', description: 'Registered Channel Adapter id.' },
    kind: { type: 'string', enum: ['group', 'private'], description: 'Allowed target kind.' },
    id: { type: 'string', description: 'Target id from the configured allowlist.' },
    text: { type: 'string', description: 'Message text to send.' }
  },
  required: ['kind', 'id', 'text'],
  additionalProperties: false
};

function isAllowedTarget(config, kind, id) {
  const allow = config?.allow;
  if (!allow || typeof allow !== 'object') return false;
  const list = kind === 'group' ? allow.groups : allow.private;
  if (!Array.isArray(list)) return false;
  return list.map((item) => String(item)).includes(String(id));
}

/**
 * 注册 Channel / Mesh 能力。全部为只读包装或显式校验面：
 *   channel.status        只读：通道清单与独立性
 *   channel.declarations  只读：适配器声明（provides / coreDependency）
 *   channel.send          高风险：actor/channel/target/allowlist 校验 + 注入发送器
 *   mesh.status           只读：本节点状态
 *   mesh.capabilities     只读：能力清单（manifest）
 */
export function registerChannelMeshCapabilities({
  broker,
  channelService = null,
  meshService = null,
  isTargetAllowed = null,
  sendImpl = null
} = {}) {
  if (!broker || typeof broker.register !== 'function') {
    throw capabilityError('INVALID_PARAMS', 'registerChannelMeshCapabilities 需要 Capability Broker');
  }

  if (channelService) {
    broker.register({
      id: 'channel.status', permission: 'log', provider: 'channel', risk: 'low',
      description: 'List registered communication Channels and their status.',
      inputSchema: emptyInput,
      execute: () => channelService.execute({ method: 'channel.list' })
    });
    broker.register({
      id: 'channel.declarations', permission: 'log', provider: 'channel', risk: 'low',
      description: 'Read the registered Channel capability declarations.',
      inputSchema: emptyInput,
      execute: () => ({ declarations: channelService.declarations, independence: channelService.registry.independence() })
    });
    broker.register({
      id: 'channel.send', permission: 'message.send', provider: 'channel', risk: 'high',
      available: typeof sendImpl === 'function' && typeof isTargetAllowed === 'function',
      description: 'Send a message to an explicitly allowlisted Channel target. Owner approval is required.',
      inputSchema: channelSendInput,
      validate(request) {
        const input = request.input ?? {};
        const channelId = String(input.channelId ?? 'qq').trim();
        if (!channelId || !channelService.declarations.some((adapter) => adapter.id === channelId)) {
          throw capabilityError('INVALID_PARAMS', `未知 Channel：${channelId}`);
        }
        const kind = String(input.kind ?? '').trim();
        if (!TARGET_KINDS.includes(kind)) {
          throw capabilityError('INVALID_PARAMS', 'target.kind 必须是 group / private');
        }
        const id = String(input.id ?? '').trim();
        if (!id || id.length > 64 || !/^[0-9A-Za-z._-]+$/.test(id)) {
          throw capabilityError('INVALID_PARAMS', 'target.id 必须是有界的目标标识');
        }
        const text = String(input.text ?? '');
        if (!text.trim() || text.length > TEXT_MAX_CHARS) {
          throw capabilityError('INVALID_PARAMS', `text 必须是 1..${TEXT_MAX_CHARS} 字符`);
        }
        // Target allowlist 是发送硬边界：无论 actor 是谁都必须命中（与 QQ 适配器
        // 的发送白名单同一语义），未配置 allowlist 时一律拒绝（fail-closed）。
        if (typeof isTargetAllowed !== 'function' || !isTargetAllowed(kind, id, channelId)) {
          throw capabilityError('TARGET_NOT_ALLOWED', `发送目标不在白名单内：${kind}:${id}`);
        }
      },
      execute: async (request) => {
        if (typeof sendImpl !== 'function') {
          throw capabilityError('PROVIDER_UNAVAILABLE', 'channel.send 尚未绑定真实传输（QQ 发送仍走既有适配器边界）');
        }
        const input = request.input;
        const result = await sendImpl({
          channelId: String(input.channelId ?? 'qq'),
          kind: String(input.kind),
          id: String(input.id),
          text: String(input.text),
          actor: request.actor
        });
        return { sent: true, channelId: String(input.channelId ?? 'qq'), kind: String(input.kind), id: String(input.id), ...(result ?? {}) };
      }
    });
  }

  if (meshService) {
    broker.register({
      id: 'mesh.status', permission: 'log', provider: 'mesh', risk: 'low',
      description: 'Read the current CetaMesh Device Mesh status.',
      inputSchema: emptyInput,
      execute: () => meshService.execute({ method: 'mesh.status' })
    });
    broker.register({
      id: 'mesh.capabilities', permission: 'log', provider: 'mesh', risk: 'low',
      description: 'Read the current Device Mesh capability manifest.',
      inputSchema: emptyInput,
      execute: () => meshService.execute({ method: 'mesh.manifest' })
    });
  }

  return { registered: ['channel.status', 'channel.declarations', 'channel.send', 'mesh.status', 'mesh.capabilities']
    .filter((id) => broker.registry.has(id)) };
}

export { isAllowedTarget };
