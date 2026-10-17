// CetaMesh Desktop Extension v1 —— Permission Review（阶段 10）。
//
// 安装前必须先把"这个扩展要什么"摊开给用户看。review 是确定性的：
// 同样的 manifest 一定得到同样的 fingerprint / token，因此安装时可以用 token
// 证明"我批准的就是你将要装的那一份"，避免批准 A 却装了 B。

import crypto from 'node:crypto';
import { manifestFingerprint } from './manifest.js';
import { PERMISSIONS, maxRisk, permissionRisk, requiresExplicitApproval, riskRank } from './types.js';

export function reviewToken(fingerprint, permissionNames, riskLevel, packageFingerprint = '') {
  return crypto
    .createHash('sha256')
    .update('cetamesh-extension-review-v2:' + fingerprint + ':' + String(packageFingerprint)
      + ':' + permissionNames.slice().sort().join(',') + ':' + riskLevel)
    .digest('hex');
}

/**
 * 生成 Permission Review 文档。
 * blockers 非空 => 不允许安装（禁止权限 / 能力声明了未声明权限 / scope 与权限不匹配）。
 */
/**
 * 运行期**真正会被注入**的权限（host.js 实现了对应能力）。
 * 其余权限目前只是「声明 + 审查」面：用户可以批准，但宿主还不会给出对应能力 —— 
 * review 里如实标 enforced=false，避免让用户以为批准了就真的放开了磁盘或记忆。
 */
export const ENFORCED_PERMISSIONS = Object.freeze(['log', 'storage', 'network', 'memory.read', 'memory.write', 'filesystem.read', 'filesystem.write']);

export function isEnforced(name) {
  return ENFORCED_PERMISSIONS.includes(name);
}

export function buildReview(manifest, { packageFingerprint = '' } = {}) {
  const declared = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const permissions = declared.map((name) => ({
    name,
    risk: permissionRisk(name),
    summary: PERMISSIONS[name] ? PERMISSIONS[name].summary : '未知权限',
    requiresExplicitApproval: requiresExplicitApproval(name),
    enforced: isEnforced(name)
  }));

  const blockers = [];
  for (const permission of permissions) {
    if (permission.risk === 'forbidden') {
      blockers.push({
        code: 'FORBIDDEN_PERMISSION',
        message: '权限 ' + permission.name + ' 在本产品中被永久禁止（' + permission.summary + '）'
      });
    }
  }

  // 能力不得声明未在 permissions 里出现过的权限，否则等于绕过 Review 偷偷拿能力。
  const granted = new Set(declared);
  for (const capability of manifest.capabilities || []) {
    for (const required of capability.requires || []) {
      if (!granted.has(required)) {
        blockers.push({
          code: 'UNDECLARED_CAPABILITY_PERMISSION',
          message: '能力 ' + capability.id + ' 需要权限 ' + required + '，但 manifest 未声明它'
        });
      }
    }
  }

  // filesystem.* 必须给出 scope.paths，network 必须给出 hosts（manifest 层已校验，这里再确认）。
  const paths = manifest.scope?.paths || [];
  const hosts = manifest.network?.hosts || [];
  if (declared.some((name) => name.startsWith('filesystem.')) && paths.length === 0) {
    blockers.push({ code: 'MISSING_SCOPE', message: '声明了 filesystem 权限但没有 scope.paths' });
  }
  if (declared.includes('network') && hosts.length === 0) {
    blockers.push({ code: 'MISSING_NETWORK_HOSTS', message: '声明了 network 权限但没有 network.hosts' });
  }

  const riskLevel = maxRisk(permissions.map((p) => p.risk));
  const fingerprint = manifestFingerprint(manifest);
  const needsApproval = permissions.some((p) => p.requiresExplicitApproval) || riskRank(riskLevel) >= riskRank('high');

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    publisher: manifest.publisher || (manifest.source?.publisher ?? ''),
    riskLevel,
    requiresExplicitApproval: needsApproval,
    permissions,
    capabilities: (manifest.capabilities || []).map((c) => ({
      id: c.id, kind: c.kind, title: c.title, requires: c.requires || []
    })),
    network: { hosts },
    scope: { workspace: manifest.scope?.workspace ?? null, paths },
    source: manifest.source,
    executionBoundary: { osSandbox: false, codeExecution: manifest.type !== 'memory-pack', permissionEnforcement: 'capability-broker' },
    fingerprint,
    packageFingerprint,
    token: reviewToken(fingerprint, declared, riskLevel, packageFingerprint),
    blockers,
    installable: blockers.length === 0
  };
}

/** 人读摘要：Permission Review 在 UI 上展示的正文。 */
export function reviewSummaryLines(review) {
  const lines = [];
  lines.push(review.name + ' ' + review.version + '（' + review.type + '）');
  if (review.publisher) lines.push('发布者：' + review.publisher);
  if (review.type !== 'memory-pack') lines.push('执行边界：Worker 进程隔离与 VM/API 限制不提供 OS 沙箱或 Windows AppContainer；仅安装经过人工审查且来源可信的代码扩展。');
  lines.push('风险等级：' + review.riskLevel);
  lines.push('声明能力：' + (review.capabilities.length ? review.capabilities.map((c) => c.id).join('、') : '无'));
  if (review.permissions.length) {
    for (const permission of review.permissions) {
      lines.push('- ' + permission.name + '（' + permission.risk + '）：' + permission.summary + (permission.enforced ? '' : '［本阶段仅声明与审查，宿主尚未提供该能力］'));
    }
  } else {
    lines.push('- 无需任何敏感权限');
  }
  if (review.network.hosts.length) lines.push('网络白名单：' + review.network.hosts.join('、'));
  if (review.scope.paths.length) lines.push('文件范围：' + review.scope.paths.join('、'));
  return lines;
}

/** 对比两次 review 的权限差异（用于 Update 的权限提升检测）。 */
export function permissionDelta(previousNames, nextNames) {
  const before = new Set(previousNames || []);
  const after = new Set(nextNames || []);
  return {
    added: [...after].filter((name) => !before.has(name)).sort(),
    removed: [...before].filter((name) => !after.has(name)).sort()
  };
}
