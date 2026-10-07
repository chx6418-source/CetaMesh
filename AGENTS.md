# AGENTS.md — Agent 阅读契约

目的：让任何 Agent 在本仓库开始工作时，默认只消耗**当前事实**，不吞历史文档。

## 开始工作只读（按序）

1. `RULES.md` —— 权限/安全红线（不可协商）。
2. `PROJECT_STATE.md` —— 当前状态、活跃工作、下一步入口。
3. 与任务直接相关的架构文档（如 `docs/desktop/ARCHITECTURE.md`、`docs/desktop/BUILD_AND_RELEASE.md`）。

## 默认不读

- `docs/archive/**` —— 历史阶段快照、旧 handoff/report、旧控制台事实源（AGENT_CONTEXT）。
  只有在**调查历史行为 / 追溯决策**时才按需读取其中具体文件。
- 任何 `*.log`、`output/`、构建产物。

## 硬性约定

- 测试只用 `npm test`（统一入口）；新增 `scripts/test-*.mjs` 必须登记进 `scripts/run-all-tests.mjs`，否则聚合器 FAIL。
- 持久化 JSON 的读/写必须经 `src/storage/json-file.js`（Storage Primitive），错误码映射放在各自 Domain 内。
- 新增空 `catch` 必须带说明注释（`scripts/test-error-hygiene.mjs` 锁基线，裸 catch 只许减不许增）。
- 修改后在分支上交付：完成 → Owner 确认 → 合并 main → 删除工作分支（不要直接 push main）。
- 当前工作分支与活跃任务见 `PROJECT_STATE.md` 的 Active Work 一节。
