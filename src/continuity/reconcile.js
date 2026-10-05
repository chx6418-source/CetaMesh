// CetaMesh Continuity —— Workspace Reconciliation（会话 2 / TASK-S2-007）。
//
// Fresh Session 启动后不能直接相信旧 Agent 的摘要：必须对照真实 Workspace
// （git status / diff / HEAD / 关键文件 / 登记的测试状态）核验 Checkpoint。
// 规则：真实 Workspace > 旧 Agent 摘要；发现不一致时记录 discrepancy，
// 绝不静默篡改 Task State。事实收集不到时如实标记（available:false / null /
// unknown）——不编造任何 git 或文件事实。
//
// 依赖注入：本模块不 import workspace 服务，bridge 用 workspaceService 的
// 只读入口 + tools.js 的 git 只读动词组装适配器（保持 Continuity 的依赖面最小）。

const MAX_DISCREPANCIES = 50;

export function createWorkspaceReconciler({
  resolveWorkspace,   // async (workspaceId) => { id, name, root } | null
  gitStatus,          // async (root) => { isRepo, branch, dirty, entries? }（tools.gitStatus）
  gitHead,            // async (root) => { isRepo, headSha|null }（tools.gitHead）
  gitDiffSummary,     // async (root) => string|null（tools.gitDiff { statOnly:true } → output）
  fileExists,         // (root, relPath) => boolean
  now = () => Date.now()
} = {}) {
  for (const [name, fn] of Object.entries({ resolveWorkspace, gitStatus, gitHead, fileExists })) {
    if (typeof fn !== 'function') {
      throw new Error(`createWorkspaceReconciler 需要 ${name}（适配器函数）`);
    }
  }

  /**
   * 收集真实 Workspace 事实。任何收集失败都收敛为 available:false + reason，
   * 绝不让单个 git/文件错误炸掉 rollover。
   */
  async function collectFacts({ workspaceId, relevantFiles = [] } = {}) {
    const id = String(workspaceId ?? '').trim();
    if (!id) return { available: false, reason: 'no-workspace-bound', workspaceId: null };
    let entry;
    try {
      entry = await resolveWorkspace(id);
    } catch (error) {
      return { available: false, reason: `resolve-failed:${String(error?.message ?? error).slice(0, 200)}`, workspaceId: id };
    }
    if (!entry?.root) return { available: false, reason: 'workspace-not-found', workspaceId: id };

    const files = [];
    for (const rel of Array.isArray(relevantFiles) ? relevantFiles.slice(0, 100) : []) {
      const relPath = String(rel ?? '').trim();
      if (!relPath) continue;
      let exists = false;
      try {
        exists = fileExists(entry.root, relPath) === true;
      } catch {
        exists = false; // 检查本身失败按"不存在"记录，但 discrepancy note 会注明来源
      }
      files.push({ path: relPath, exists });
    }

    const [status, head, diffSummary] = await Promise.all([
      gitStatus(entry.root).then(
        (value) => ({
          isRepo: value?.isRepo === true,
          branch: typeof value?.branch === 'string' && value.branch ? value.branch : null,
          dirty: value?.dirty === true
        }),
        (error) => ({ error: String(error?.message ?? error).slice(0, 200) })
      ),
      gitHead(entry.root).then(
        (value) => ({ isRepo: value?.isRepo === true, headSha: value?.headSha ?? null }),
        (error) => ({ error: String(error?.message ?? error).slice(0, 200) })
      ),
      gitDiffSummary
        ? gitDiffSummary(entry.root).then(
            (value) => (typeof value === 'string' && value.trim() ? value : null),
            () => null
          )
        : Promise.resolve(null)
    ]);

    const git = {
      isRepo: status?.isRepo === true && head?.isRepo !== false,
      branch: status?.branch ?? null,
      headSha: head?.headSha ?? null,
      dirty: status?.dirty === true,
      diffSummary
    };
    if (status?.error) git.statusError = status.error;
    if (head?.error) git.headError = head.error;

    return {
      available: true,
      workspaceId: id,
      workspaceName: entry.name ?? null,
      git,
      files,
      collectedAt: now()
    };
  }

  /**
   * 对照 Checkpoint（Handoff Packet）与 Workspace 事实。
   * 返回 { checkedAt, consistent, discrepancies, note }：
   *   consistent: true 一致 / false 有不一致 / null 无法核验（事实不可得）。
   * discrepancy 形状：{ kind, checkpoint, workspace, note }——kind ∈
   *   branch / headSha / missing-file / no-git-repo。
   */
  function reconcile({ packet, facts } = {}) {
    const checkedAt = now();
    if (!facts?.available) {
      return {
        checkedAt,
        consistent: null,
        discrepancies: [],
        note: `workspace facts unavailable（${facts?.reason ?? 'unknown'}）——无法核验，不判定真伪`
      };
    }
    const discrepancies = [];
    const coding = packet?.coding ?? {};
    if (facts.git.isRepo) {
      if (coding.branch && facts.git.branch && coding.branch !== facts.git.branch) {
        discrepancies.push({
          kind: 'branch',
          checkpoint: coding.branch,
          workspace: facts.git.branch,
          note: 'checkpoint 记录分支与工作区当前分支不一致'
        });
      }
      if (coding.headSha && facts.git.headSha && coding.headSha.toLowerCase() !== facts.git.headSha.toLowerCase()) {
        discrepancies.push({
          kind: 'headSha',
          checkpoint: coding.headSha,
          workspace: facts.git.headSha,
          note: 'checkpoint 记录 HEAD 与工作区 HEAD 不一致（工作区可能已前进或被改动）'
        });
      }
    } else {
      discrepancies.push({
        kind: 'no-git-repo',
        checkpoint: coding.branch ?? null,
        workspace: null,
        note: '工作区当前不是 git 仓库，无法核验分支/HEAD'
      });
    }
    for (const file of facts.files) {
      if (!file.exists) {
        discrepancies.push({
          kind: 'missing-file',
          checkpoint: file.path,
          workspace: null,
          note: 'checkpoint 声明的相关文件在工作区中不存在'
        });
      }
    }
    return {
      checkedAt,
      consistent: discrepancies.length === 0,
      discrepancies: discrepancies.slice(0, MAX_DISCREPANCIES),
      note: discrepancies.length
        ? `${discrepancies.length} 处不一致（真实 Workspace 优先，已记录，未修改 Task State）`
        : 'checkpoint 与 workspace 事实一致'
    };
  }

  return { collectFacts, reconcile };
}
