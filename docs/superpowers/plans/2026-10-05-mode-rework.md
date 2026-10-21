# 模式重构实施计划（2026-10-05，已获用户批准）

## 目标模式集

| 模式 | 规格 |
| --- | --- |
| `chat` | 不变 |
| `closed-agent` | 不变（owner 私聊 + 完整工具） |
| `social` | 由 `reserved2` 改名，行为不变；`reserved2` 为旧别名，自动迁移 |
| `workshop` | 新增独立模式：以 closed-agent 为基（owner 私聊 + 完整工具），独立 `cetamesh-workshop` preset，无 social 社交回合/睡眠/发言工具 |
| `reserved` | 弃用：从 UI/选择移除；旧配置迁移到 `chat` 并记警告；一代仿真分支代码随后清理 |

## 迁移规则

- `config.json` / `state/mode.json` / Preset 绑定中出现 `reserved` → 迁移为 `chat`。
- 出现 `reserved2` → 迁移为 `social`。
- 迁移只在显式写入路径执行（配置服务 update / 模式变更 / preset 绑定），读取旧值不重写用户文件。

## 改动文件（预计）

- `src/bridge.js`：`VALID_MODES`、模式分支/定时器/prompt、`presetForMode`、preset 绑定目标、社交 V2 gating（`reserved2` → `social`）、reserved 分支移除或转 legacy 警告。
- `src/config/migrate.js`、`src/config/schema.js`：模式相关默认/校验（如含）。
- `desktop-shell/src/native_ui.rs`：运行策略下拉 4 项（chat / closed-agent / social / workshop）、`PolicyForm` 校验、Preset 目标（`reserved2` → `social`，新增 `workshop`）。
- `dsh/agent-presets/cetamesh-workshop/`：新增 preset（agent.cordis.yml / preset.yml）。
- `src/dsh-integration.js`：preset 释放/迁移清单加入 workshop。
- 测试：模式迁移、social 回归、workshop 权限与工具面、UI 校验。

## 验收

1. 旧 mode.json `reserved2` 启动后按 social 运行；`reserved` 迁移为 chat 且有警告。
2. `social` 与旧 reserved2 行为一致（社交 V2 工具、睡眠/唤醒、卡片审批）。
3. `workshop` 仅 owner 私聊可用完整工具，不触发 social 回合/唤醒/发言工具；绑定 workshop preset。
4. UI 下拉不再出现 reserved/reserved2；workshop preset 可绑定。
5. `cargo test`、`test-system`、`test-core-entry`、`test-privilege`、`test-dsh-integration`、模式相关测试全部 PASS，重建安装包并升级本机安装。

## 队列中未完成项（用户已提出，另行实现）

- 模型 / reasoning 切换 UI 修复（ChatConfigSave 后回写会话配置；catalog 为空时给可读错误并允许手输模型 ID）。
- 工作区“浏览…”原生文件夹选择器（rfd 0.15/0.16 本地已缓存）。
- per-provider API Key（等待用户确认 Provider 与用途）。
