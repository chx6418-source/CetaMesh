# CetaMesh Mobile UI Refactor

Current Phase: Phase 7 — regression and Standalone APK verification.

Completed:
- Phase 1 — design tokens, shared Header / Card / Button / Chip / BottomSheet, four-tab bottom navigation, and ChatHome tab routing.
- Completed screens: Chat landing and session list; primary navigation routes Tasks, Memory, and Workspace to their current feature screens.
- Phase 1 validation: `npm run check` PASS — TypeScript, ESLint, architecture checks, 57 test suites / 217 tests.
- Phase 2 — Chat message area, anchored Composer, model/mode/reasoning chips and options sheet, attachment sheet, session actions, Stop and Retry.
- Phase 2 validation: `npm run check` PASS — 58 test suites / 220 tests.
- Phase 3 — Tasks workspace with status filters, progress summaries, task details and a unified Action Center for approvals, questions, blocked work, security events, and completed tasks.
- Phase 3 validation: `npm run check` PASS — 58 test suites / 221 tests.
- Phase 4 — Memory search and existing-kind filters, source/scope/update/pin summaries, a separate provenance-rich detail view, focused edit flow, and an explicit Use in Chat draft picker. Memory text stays editable and unsent until the user sends it.
- Phase 4 validation: `npm run check` PASS — 58 test suites / 222 tests.
- Phase 5 Workspace — grouped AI, Devices, Extensions, Preferences, and Advanced sections; provider list/create/edit; persistent new-conversation provider/model/mode/reasoning defaults; device identity, pairing review, trust management, and details.
- Phase 5 Extensions — installed inventory, JSON manifest import, unsigned publisher disclosure, permission review, disabled-by-default installation, enable/disable, update, rollback, details, and removal. Unsafe executable payloads remain rejected by the existing validation runtime.
- Phase 5 validation: `npm run check` PASS — TypeScript, ESLint, architecture checks, 62 test suites / 231 tests.
- Phase 5 Workspace UI checkpoint pushed to `feature/mobile-ui-ux-v1`: `33858861427decfdcb67607c35aaaccb3dc8edd9`.
- Phase 6 — shared Empty / Loading / Error / Offline states; truthful loading and failure summaries across Chat, Tasks, Action Center, Memory, Providers, Devices, and Extensions; accessible progress indicators and navigation; Android touch targets and light-surface status bar polish.
- Phase 6 validation: `npm run check` PASS — TypeScript, ESLint, 5 architecture checks, 63 test suites / 244 tests.
- Phase 6 diff was limited to UI and tests; `src/runtime`, `src/domain`, `src/protocol`, `src/data`, and `android` were unchanged. Standalone APK baseline remains intact.
- Phase 6 code commit pushed and verified on `feature/mobile-ui-ux-v1`: `fef4b7c315e6e1342b84fcee051f9eaef53f53d8`.
- Phase 7 regression check: `npm run check` PASS locally and in GitHub Actions — TypeScript, ESLint, architecture checks, 63 test suites / 244 tests.
- Phase 7 Android CI run `36858043412` PASS — Standalone Release APK build, standalone APK verification, and artifact upload all succeeded.

Pending:
- Real-device visual/interaction verification by the user.

Known Issues:
- Appearance currently remains Light; Memory remains local to this device.
- Persistent Archive is unavailable: the existing Memory domain/runtime has no archive field or operation. No transient or misleading Archive control was added.
- Real-device visual verification is `NOT_RUN_ENVIRONMENT` in this Linux workspace.
- Phase 5 adds one SQLite migration for mobile preferences and exposes the existing validated extension lifecycle through a public runtime service. Protocol and Android files were not changed; the Standalone APK baseline remains intact for Phase 7 verification.
- Shell GitHub HTTPS authentication is unavailable here; the authenticated GitHub integration pushed the code commit and verified the remote tree.
- Phase 7 `npm run check` passes locally and in CI (63 suites / 244 tests). Local `./gradlew assembleRelease` is `NOT_RUN_ENVIRONMENT`: Gradle 9.4.1 is not cached, the wrapper download returned `Network is unreachable`, and sandbox policy disallows requesting network escalation. The cloud Android CI is running the same Release build and verifier.

Last Commit: `fef4b7c315e6e1342b84fcee051f9eaef53f53d8` — Phase 6 shared states and accessibility.

Next Action: Install the Phase 7 Standalone APK on a physical Android device and record visual/interaction feedback.

## 第二轮真机修正（进行中）
- 基线：远端 `feature/mobile-ui-ux-v1` 的 `42a746111c357ef06bcafb71ab64abfb70670246`；本地 `npm run check`：63 套件 / 244 项通过。
- A：底栏改用同一 Lucide 矢量图标体系；默认中文和轻量词典已接入主要页面；Chat 首页营销文案收起。`npm run check`：63 套件 / 244 项通过。
- 待办：插件导入、真实 Token 用量与缓存、键盘、Markdown 与工具状态、Android CI 及真机验收。
- B：插件导入简化为选文件、确认安装；权限摘要与风险提示默认可见，内部字段放在详细信息；列表操作移入插件详情。安全验证、权限差异、回滚和默认停用仍由原 Runtime 执行。`npm run check`：63 套件 / 244 项通过。
- C：OpenAI-compatible/DeepSeek 流式 usage 归一化；SQLite v12 新增逐轮用量表并按会话聚合；真实缓存字段才显示命中率，历史缺项标为部分数据。加入固定 Prompt 前缀，动态历史放后；当前 Chat 路径没有工具 Schema 或 Memory 注入，不能声称已经优化这两项，也不保证 90% 命中。`npm run check`：65 套件 / 249 项通过。
- D：Android 保留 manifest 的 `adjustResize`，去掉 Android 上额外的 `KeyboardAvoidingView` 高度行为；键盘弹出时隐藏底栏，消息仅在接近底部时跟随；Composer 最多 132dp、超出内部滚动。`npm run check`：65 套件 / 250 项通过。真机中文输入法验证仍待安装 APK。
- D 远端 Android CI `36958237025` PASS：TypeScript、ESLint、Architecture、Jest、assembleRelease、Standalone APK Verification、Artifact Upload 全部通过；产物 `11207512177`。
- E：已完成 Assistant Markdown（标题、段落、列表、引用、行内代码、代码块复制/横向滚动、链接、表格与分隔线）；Streaming 保持纯文本以减少重排。模型生成的前置过程文本折叠为“过程说明 · 模型文本”，不假称实际工具已执行。继续补充主要页面动态文案中文化。`npm run check`：66 套件 / 252 项通过。
- E 远端 Android CI `36966675868` PASS：TypeScript、ESLint、Architecture、Jest、assembleRelease、Standalone APK Verification、Artifact Upload 全部通过。
- F：补齐聊天中的推理强度、会话模式、归档与消息状态中文标签；`npm run check`：66 套件 / 252 项通过。代码提交 `817d55f15c3fa0b10e3b338aa415562585a1a648` 已推送。最终 Android CI `36973025748` PASS：TypeScript、ESLint、Architecture、Jest、assembleRelease、Standalone APK Verification 和 Artifact Upload 全部成功；APK 产物 `11213511861`。
- 待验证：当前 Chat Runtime 没有实际 Tool/Search 执行事件，本轮不能显示真实来源数量与耗时；真机中文输入法与 Markdown 视觉仍待测试。

## 第三轮真机修正（进行中）
- A：Chat 模型/模式/推理/用量状态移至 Composer；输入提示为“输入消息…”；附件弹层使用透明背景、无 X 按钮，保留内容和透明区域/Android Back/拖拽横条关闭。`npm run check`：66 套件 / 252 项通过。真机键盘及手势效果待 APK 验证。
- 待办：长输出超时与持久化、用量 pending 状态、工具过程边界、关于应用和更新入口、最终 Standalone APK。
- B：Chat 改用首响应 45 秒、活跃流空闲 75 秒与 10 分钟安全上限；XHR 对 Chat 流关闭总请求超时，响应上限放宽到 32 MB。增量实时发往 UI，SQLite 约 350ms 或 2KB checkpoint，终态立即保存；中断内容可继续或重新生成。当前轮用量区分统计中/有报告/无数据；未知缓存不显示 0%。错误正文显示中文而非原始代码。`npm run check`：66 套件 / 255 项通过。
- C：已完成的回答继续使用 Markdown 阅读组件，扩充模型文本中 `Agent → web_search(...)` 等前置过程行的折叠识别。当前 Chat Provider 接口仍无真实 Tool/Search 执行事件，UI 明确标记为“模型文本”，不伪造执行状态、来源或耗时。`npm run check`：66 套件 / 255 项通过。
- D：插件原有“选文件 → 自动检查 → 一次确认”流程保留；确认卡片加入按插件类型生成的简短用途说明，敏感权限仍通过“允许并安装”明确授权，内部安全字段在详情中。`npm run check`：67 套件 / 257 项通过。
- E：工作区加入“关于应用”入口；Android Native Module 读取已安装 APK 的 versionName，展示作者、版本；检查更新、应用更新和更新公告均有设置行与 UpdateService 契约。私有更新源尚未提供，明确显示未配置/暂无公告，不内置 GitHub Token 或虚构新版本。`npm run check`：67 套件 / 257 项通过。最终 Android CI 待验证。
- F：补齐工作区模型服务数量中文和更新下载状态说明。`npm run check`：67 套件 / 257 项通过。远端最新代码 `b9b15895035935ec085f0a0e11d69b7eac4b2e93`；草稿 PR #2 用于触发 CI，但尚无新运行。上一成功运行 `36987032197` 只覆盖 C 提交，不能作为最终 APK 验证。
- 未完成验收：最新提交的 assembleRelease、Standalone APK Verification 和 Artifact Upload；真机键盘/附件手势/长输出验证；实际 Tool/Search 事件仍缺少上游 Runtime 数据，当前只折叠模型文本中的过程行。
