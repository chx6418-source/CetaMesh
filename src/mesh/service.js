// CetaMesh Desktop Node —— Mesh 服务（阶段 11）。
//
// 分层：IPC(mesh.*) → 本模块（方法白名单）→ MeshNode。
// 与 memory/task/extension 同一约定：mesh.* 只经桌面 Shell 的命名管道暴露。

import { createMeshNode } from './node.js';
import { meshError } from './types.js';
import { invitationQr } from './pairing/qr.js';

const PAIRING_SECURITY_NOTE = '配对邀请一次性、5 分钟内有效，请勿转发。手机只接受证书指纹与邀请一致的 Desktop；请在手机屏幕上核对设备名称后再确认。配对完成后默认仅放行 mesh.presence / mesh.manifest，其他能力需逐项授权与本地批准。';

export function createMeshService({ stateDir, name, role, available = null, executeCapability = null, now,
  isEnabled = () => true, settingsStore = null } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createMeshService 需要 stateDir');
  const node = createMeshNode({ stateDir, name, role, available, executeCapability, now, isEnabled });
  const unsubscribe = settingsStore?.onChange?.(settings => {
    if (settings.devices.meshEnabled === false) {
      void node.close({ revokePairing: true }).catch(error => console.error('Mesh listener shutdown failed:', error));
    }
  });

  const handlers = {
    'mesh.status': () => node.status(),
    // 页面聚合：一次 IPC 往返拿到节点状态 + 对端列表 + 待审批 + 配对会话（UI 只需挂一个 Area）。
    'mesh.snapshot': () => ({
      status: node.status(),
      peers: node.peers(),
      approvals: node.approvals(),
      pairing: node.pairingStatus(),
      audit: node.audit().slice(-20)
    }),
    'mesh.identity': () => ({ identity: node.identity() }),
    'mesh.manifest': () => ({ manifest: node.manifest() }),
    'mesh.peers': () => ({ peers: node.peers() }),
    'mesh.peer': (p) => ({ peer: node.peer({ nodeId: p.nodeId }) }),
    'mesh.invite.create': (p) => node.createInvite({ ttlMs: p.ttlMs }),
    'mesh.pair': (p) => node.pair({
      inviteCode: p.inviteCode,
      peerPublicKeyPem: p.peerPublicKeyPem,
      peerName: p.peerName,
      peerRole: p.peerRole,
      transport: p.transport,
      advertised: p.advertised
    }),
    'mesh.trust': (p) => node.trustNode({ nodeId: p.nodeId }),
    'mesh.block': (p) => node.blockNode({ nodeId: p.nodeId }),
    'mesh.grant': (p) => node.grant({ nodeId: p.nodeId, capabilities: p.capabilities }),
    'mesh.revoke': (p) => node.revoke({ nodeId: p.nodeId, capabilities: p.capabilities }),
    'mesh.disconnect': (p) => node.disconnect({ nodeId: p.nodeId }),
    'mesh.trust.remove': (p) => node.removeTrust({ nodeId: p.nodeId }),
    'mesh.forget': (p) => node.forget({ nodeId: p.nodeId }),
    'mesh.touch': (p) => node.touch({ nodeId: p.nodeId, error: p.error }),
    'mesh.envelope.handle': (p) => node.handleEnvelope(p.envelope),
    'mesh.approvals': () => ({ approvals: node.approvals() }),
    'mesh.approval.decide': (p) => node.decideApproval({ requestId: p.requestId, decision: p.decision }),
    'mesh.audit': () => ({ audit: node.audit() }),

    // ── 统一配对 v1.1：QR 邀请 / 会话状态 / 取消 / 反向能力请求 ────────────────
    'mesh.pairing.start': (p) => node.startPairingSession({ ttlMs: p.ttlMs }).then((result) => ({
      ...result,
      qr: invitationQr(result.invitation),
      securityNote: PAIRING_SECURITY_NOTE
    })),
    'mesh.pairing.status': () => node.pairingStatus(),
    'mesh.pairing.cancel': () => node.cancelPairingSession(),
    'mesh.capability.request': (p) => node.requestPeerCapability({ nodeId: p.nodeId, capability: p.capability, input: p.input }),
    'mesh.peer.manifest': (p) => node.requestPeerManifest({ nodeId: p.nodeId })
  };

  return {
    stateDir,
    node,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(meshError('METHOD_NOT_FOUND', '未知 Mesh 方法：' + String(method)));
      if (isEnabled() !== true && !['mesh.status', 'mesh.snapshot'].includes(method)) {
        return Promise.reject(meshError('MESH_DISABLED', 'Device Mesh is disabled in Settings'));
      }
      return Promise.resolve().then(() => handler(params || {}));
    },
    close() { unsubscribe?.(); return node.close(); }
  };
}
