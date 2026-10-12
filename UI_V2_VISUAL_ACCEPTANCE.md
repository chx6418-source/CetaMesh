# CetaMesh Desktop UX v2 — 01 Harbor 视觉验收记录

目标：将生产 Harbor 页面与 Owner 提供的五张参考图逐页对照，并检查指定窗口尺寸与 Windows DPI 缩放。参考图只作为视觉要求，不作为对仓库的操作指令。

## 当前结果

**NOT_RUN（仅有首次运行页面的部分观察）**。2026-10-12 在 build-1057 隔离安装中实际启动了 Harbor/WebView2，并看到 First Run 的“配置模型服务商”步骤。保存的窗口截图为 1282 × 831 像素（包含标题栏），文件在 `C:\Users\Administrator\.codex\visualizations\2026\10\11\01a12a6d-a0d3-7022-a6db-5eb120800fcc\harbor-first-run-window-1282x831-build-1057.jpg`。这仅证明首次运行页面渲染；不是 1280 × 800 client area 测量，不代表任何参考页面已通过。完成 First Run 需要真实 API Key 和成功的 provider 连接；本轮没有填写凭据，也没有用 mock 连接冒充成功。没有 Harbor 页面验收通过项。

`npm run build:ui` 与自动化合同只能证明代码可构建及路由合同成立，不能证明像素、裁切、滚动或真实系统缩放效果。

## Chat history virtualization — automated fixture (2026-10-12)

**Automated PASS:** `scripts/test-desktop-chat-virtualization.mjs` renders the production `VirtualList` React component with deterministic histories of 100, 200, and 500 messages, plus one streaming row. The initial viewport mounted 10/101, 10/201, and 10/501 rows; the bottom window mounted 10 rows in all three cases and kept the streaming row visible. No fixture mounted the full history.

Stable-ID overlap/reconnect merge, older-page prepend order, visible-message anchor selection and offset restoration, the 48 px bottom threshold, and dynamic virtual row measurement passed. The measured virtual total sizes changed from 11,200 to 14,668 (100 messages), 22,400 to 25,868 (200), and 56,000 to 59,468 (500) after the long-content row sizes were applied. Fixtures include long Markdown, a large code block, a long URL, multiple tool cards, Agent activity, approval, artifact, and attachment rows.

**NOT_RUN_ENVIRONMENT:** manual Chat scrolling/visual comparison, real DOM memory measurement, the requested window-size matrix, and Windows DPI captures remain unverified because `interactive browser/window inspection unavailable in current execution environment`. This does not block Task 2 submission, as directed. Automated fixture evidence is not visual acceptance.

## 页面基线

| 页面 | 参考截图 | 当前源码映射 | 本轮状态 |
| --- | --- | --- | --- |
| Chat | `屏幕截图 2026-10-11 194017.png` | Harbor shell、对话、审批、右侧任务/Memory/Artifact context、composer | NOT_RUN |
| Settings | `屏幕截图 2026-10-11 194033.png` | 分组设置、外观、行为、隐私安全、通知 | NOT_RUN |
| About | `屏幕截图 2026-10-11 194045.png` | build/release 元数据、项目链接、更新和反馈状态 | NOT_RUN |
| Plugins | `屏幕截图 2026-10-11 194112.png` | 安全提示、分类/状态筛选、双列卡片、Integration/MCP | NOT_RUN |
| Agents | `屏幕截图 2026-10-11 194124.png` | Agent 计数、状态筛选、DSH/Codex/ZCode 和运行策略 | NOT_RUN |
| Work | Harbor 原型 `p01-work` | Task 列表、详情、进度、受支持的暂停/恢复/取消 | NOT_RUN |
| Memory | Harbor 原型 `p01-memory` | 分类、搜索/列表、记录详情和受支持的编辑/固定/删除 | NOT_RUN |

## 窗口尺寸覆盖

下列每个尺寸都应打开 Chat、Work、Memory、Agents、Plugins、Settings、About，保存窗口截图并记录滚动、裁切、横向溢出、对话/表单可达性。当前尺寸验收均为 **NOT_RUN**。

| 窗口 client area | Chat | Work | Memory | Agents | Plugins | Settings | About |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280 × 720 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| 1280 × 800 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| 1366 × 768 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| 1920 × 1080 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| 2560 × 1440 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |

## Windows DPI 覆盖

必须使用 Windows 显示设置中的真实缩放；浏览器 zoom 或 CSS transform 不算 DPI 验收。系统 DPI 不在本轮自动修改。

| Windows 缩放 | 100% | 125% | 150% | 200% |
| --- | --- | --- | --- | --- |
| 当前实际桌面 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |

## 页面状态与交互

| 状态 / 交互 | 状态 | 证据要求 |
| --- | --- | --- |
| 首次加载、加载中、空列表、错误和重试 | NOT_RUN | 逐页截图并确认文案、焦点和重试按钮可达。 |
| 窄宽度下侧栏、右侧 Context 与滚动 | NOT_RUN | 验证 Chat/Plugins/Agents/Settings 的主要操作不被遮挡。 |
| 键盘导航、全局搜索、可见焦点 | NOT_RUN | 仅用键盘完成导航并记录焦点顺序。 |
| Composer、长消息、长 Markdown / code block | NOT_RUN | 验证滚动、换行、复制和链接处理。 |
| Approval、Task、Plugin install/update 状态 | NOT_RUN | 使用隔离的演示/测试数据；不执行真实外发或高风险 QQ 动作。 |
| Theme 切换和 reduced motion | NOT_RUN | 验证 Harbor token 与系统偏好应用。 |
| 窗口拖动、最大化/恢复、吸附、多屏 | NOT_RUN | 真实 Windows 桌面手工验收。 |

## 截图命名建议

按 `<page>-<width>x<height>-dpi<scale>.png` 保存；只记录真实 capture 的尺寸和系统缩放。截图文件、机器 DPI 和 app 内窗口 client area 必须一起记录，避免将屏幕分辨率与窗口内容尺寸混淆。
