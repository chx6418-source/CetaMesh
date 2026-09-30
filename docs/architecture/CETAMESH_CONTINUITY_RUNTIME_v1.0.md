# CetaMesh Continuity Runtime 规范 v1.0

> **目的**：定义 CetaMesh 如何在 Agent 上下文接近上限、Agent 额度耗尽、Provider 切换、进程重启或设备变化时保持复杂任务连续。
>
> **核心原则**：**Sessions are disposable; progress is persistent.**

---

## 1. 问题

复杂 Coding / Project Agent 的 Session 会持续膨胀。

传统方案：

```text
compress
→ continue same session
```

不同 Agent 的压缩质量差异很大，容易：

- 丢失关键决定；
- 遗漏未完成步骤；
- 忘记测试失败；
- 混淆旧架构与新架构；
- 重复修改；
- 让长期任务越来越不稳定。

CetaMesh 对复杂任务的默认主路径：

```text
checkpoint
→ archive old session
→ create fresh session
→ restore real task state
→ reconcile workspace
→ continue
```

---

## 2. Continuity 所有权

Continuity 由 CetaMesh 持有，不由具体 Agent 持有。

属于 CetaMesh：

```text
Task
Workspace
Memory
Checkpoint
Artifacts
Tests
Decisions
```

可替换执行资源：

```text
DSH Session
Codex Session
Other Agent Session
```

---

## 3. 四种连续性

```text
1. Session Rollover
   same provider, fresh session

2. Agent Handoff
   Agent A → Agent B

3. Provider Handoff
   DSH → Codex / other

4. Runtime Recovery
   process restart / crash / device reconnect
```

四者共享：

```text
Task State
Checkpoint
Workspace Reconciliation
Memory Reference
Artifact State
```

---

## 4. Context Monitor

每个 Agent Session：

```ts
type ContextUsage = {
  providerId: string;
  sessionId: string;
  modelId?: string;

  windowTokens?: number;
  usedTokens?: number;
  ratio?: number;

  estimated: boolean;
  updatedAt: string;
};
```

Provider 不返回准确 Token 数据时允许估算，但必须：

```text
estimated = true
```

不能伪装为精确值。

---

## 5. 默认阈值

推荐：

```text
0–70%     normal
70–78%    prepare checkpoint
78–85%    checkpoint ready
85–90%    preferred rollover
90–92%    forced safe rollover
92%+      emergency
```

Provider Profile 可覆盖。

---

## 6. Context Strategy

支持：

```text
automatic
new-session
compression
hybrid
manual
```

复杂 Coding / Project 默认：

```text
new-session
```

普通 Chat 可以：

```text
hybrid
```

---

## 7. Provider Context Profile

示例：

```yaml
provider: dsh

context:
  window_tokens: auto
  compression_quality: low

  prepare_checkpoint: 0.72
  checkpoint_ready: 0.78
  preferred_rollover: 0.84
  hard_rollover: 0.92

  strategy: new-session
```

---

## 8. Safe Rollover Point

优先等待：

```text
file write complete
tool call complete
test command complete
atomic edit complete
git operation complete
current plan step complete
```

禁止在：

```text
partial write
migration halfway
package install mutation halfway
git rebase conflict unresolved
```

等状态直接 Rollover。

---

## 9. Checkpoint Schema

```yaml
checkpoint:
  id: cp_xxx
  version: 1
  created_at: ...

task:
  id: task_xxx
  goal: ...
  acceptance:
    - ...

phase:
  current: ...
  completed:
    - ...

progress:
  percent: ...
  summary: ...

current_work:
  objective: ...
  file: ...
  symbol: ...
  next_action: ...

workspace:
  id: ...
  root: ...
  git_head: ...
  branch: ...
  dirty_files:
    - ...
  untracked_files:
    - ...

tests:
  passed:
    - ...
  failed:
    - ...
  not_run:
    - ...

decisions:
  - id: dec_...
    statement: ...
    reason: ...

blockers:
  - ...

artifacts:
  - ...

memory_refs:
  - mem://...

pending_questions:
  - ...

provider:
  id: dsh
  session_id: ...
  model: ...

rollover:
  reason: context_pressure
  context_ratio: 0.86
```

---

## 10. Checkpoint Builder 数据来源

不能只依赖 Agent 自述。

必须综合：

```text
Task Runtime
Workspace
Git State
Test Results
Artifact Registry
Memory Runtime
Agent Session Summary
```

Agent Summary 只是一个输入。

---

## 11. Workspace Reconciliation

Coding Task 最低检查：

```text
git status
git diff
critical files
package / build config
test logs
```

如果 Workspace 与 Checkpoint 不一致：

```text
Workspace is source of truth for file state
```

原则：

> Checkpoint 说明“上一班认为发生了什么”；Workspace 说明“实际发生了什么”。

---

## 12. Archive Old Session

旧 Session 不删除。

保存：

```text
sessionId
provider
startedAt
endedAt
contextUsage
checkpointId
rolloverReason
status=archived
```

旧 Session 不再作为主上下文。

---

## 13. Fresh Session Bootstrap

新 Session 输入层：

```text
L0 System / Security
L1 Task Goal + Acceptance
L2 Checkpoint
L3 Workspace Facts
L4 Memory References
L5 Small Recent Context
```

不复制完整旧 Session。

---

## 14. Bootstrap 流程

新 Session 必须：

1. 读取 Task。
2. 读取 Checkpoint。
3. 检查 Workspace。
4. 检查测试。
5. 对账差异。
6. 确认下一步。
7. 然后继续工作。

不能收到 Checkpoint 后立即盲目写代码。

---

## 15. Same Provider Rollover

第一阶段最重要：

```text
DSH Session #1
↓
Checkpoint
↓
DSH Session #2
```

同 Provider 也必须走标准 Checkpoint。

---

## 16. Cross Provider Handoff

```text
DSH
↓
Checkpoint
↓
Codex
```

新 Provider 不需要理解旧 Provider 私有 Session 格式。

共享的是 CetaMesh 标准状态。

---

## 17. Provider Adapter 能力

```ts
type AgentProviderCapabilities = {
  reportsContextUsage: boolean;
  supportsPause: boolean;
  supportsResume: boolean;
  supportsNativeCheckpoint: boolean;
  supportsSessionCreate: boolean;
  supportsSessionArchive: boolean;
};
```

CetaMesh 根据能力选择实现。

---

## 18. Memory 在 Continuity 中的作用

不要把大量历史重新塞入新 Session。

Checkpoint 保存：

```text
memory_refs
```

需要时：

```text
Memory Runtime
↓
Context Package
```

重新获取。

---

## 19. Task Memory

Continuity 写入：

```text
major decisions
phase transitions
test failures
rollover
provider switch
important artifacts
```

未来新 Session 可快速理解任务历史。

---

## 20. Artifact Tracking

Checkpoint 保存引用：

```text
build output
documents
packages
screenshots
logs
generated files
```

不要把大二进制塞入 Checkpoint。

---

## 21. Failure Modes

### Checkpoint Build Failed

```text
retry
↓
fallback minimal checkpoint
↓
needs_attention if still failed
```

不得销毁旧 Session。

### New Session Create Failed

旧 Session 保持可追溯，允许换 Provider。

### Bootstrap Failed

Task 标记：

```text
blocked
```

### Workspace Mismatch

暂停自动继续，先 Reconcile。

### Provider Unavailable

进入 Provider Handoff。

---

## 22. Emergency Rollover

当超过 hard threshold：

1. 禁止接收新的非必要子任务。
2. 完成当前可安全结束的原子操作。
3. 保存最小 Workspace State。
4. 创建 Emergency Checkpoint。
5. 切换 Fresh Session。
6. Fresh Session 强制执行 Reconciliation。

---

## 23. Compression 的定位

Compression 仍可用于：

```text
ordinary chat
low-risk short task
recent-context reduction
```

复杂 Project/Coding 默认：

```text
new-session preferred
```

---

## 24. 用户控制

Work 页面：

```text
Context Strategy

Automatic
Prefer New Session
Prefer Compression
Manual
```

并提供：

```text
Create Checkpoint Now
Start Fresh Session
Switch Agent
```

---

## 25. Quota 与 Context 分离

分别跟踪：

```text
Context Pressure
Quota Pressure
Rate Limit
Provider Availability
```

任一都可能触发 Continuity。

---

## 26. Work UI

目标：

```text
Task
Provider
Session
Context Usage
Quota
Checkpoint
Workspace
Tests
Progress
```

用户要能明确看出：

```text
Task 没变
Session 已经换了
```

---

## 27. Event 类型

推荐：

```text
continuity.checkpoint.started
continuity.checkpoint.completed
continuity.checkpoint.failed

continuity.rollover.scheduled
continuity.rollover.started
continuity.rollover.completed
continuity.rollover.failed

continuity.handoff.started
continuity.handoff.completed
continuity.handoff.failed

continuity.reconcile.started
continuity.reconcile.completed
continuity.reconcile.conflict
```

---

## 28. Persistence

Continuity 状态必须持久化。

进程重启后必须知道：

```text
哪个 Task
当前 Session
上一个 Session
Checkpoint
Rollover 是否进行到一半
```

---

## 29. Idempotency

以下操作必须重复调用安全：

```text
archive session
save checkpoint
apply handoff state
ack rollover event
```

避免断线重试产生重复 Session。

---

## 30. Security

Checkpoint 不得保存：

```text
raw API keys
auth cookies
private keys
unredacted secrets
```

如果旧 Agent 输出含 Secret：

```text
redact before persist
```

Memory References 仍受 Memory Policy。

换 Provider 不代表新 Provider自动获得旧 Provider 的全部权限。

---

## 31. Permission Re-evaluation

Agent Handoff 后：

```text
new provider
↓
Permission Evaluation
```

重新确定：

```text
allowed capabilities
workspace access
network
shell
```

---

## 32. Test Plan

最少：

```text
context threshold
checkpoint schema
checkpoint persistence
session archive
fresh session bootstrap
workspace reconcile
same-provider rollover
cross-provider handoff
provider unavailable
checkpoint corrupted
process restart
idempotent retry
secret redaction
permission reevaluation
```

---

## 33. Acceptance Scenario A

```text
Task starts
↓
DSH Session #1 reaches 85%
↓
Checkpoint generated
↓
Session #1 archived
↓
DSH Session #2 created
↓
Workspace reconciled
↓
Task continues
↓
Tests pass
```

成功标准：

- Task ID 不变。
- Workspace 不变。
- Progress 不丢。
- 已完成步骤不重复。
- 新 Session 知道下一步。
- 旧 Session 可追溯。

---

## 34. Acceptance Scenario B

```text
DSH quota exhausted
↓
Checkpoint
↓
Codex
↓
Reconcile
↓
Continue
```

成功标准同上。

---

## 35. Acceptance Scenario C

```text
Desktop crashes during rollover
↓
restart
↓
detect incomplete continuity transaction
↓
recover
```

不能出现：

```text
two active sessions
```

或：

```text
lost task
```

---

## 36. 设计结论

CetaMesh 不追求让一个 Session 无限延长。

目标是：

```text
short clean sessions
+
persistent task state
+
real workspace facts
+
structured checkpoint
+
memory references
+
safe handoff
```

> **Session 是一次工作班次。Task 才是项目本体。**
