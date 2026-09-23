# 桌面版验收清单（人工部分）

**本清单早期内容对应已验收的 Tauri/WebView 版本，不代表当前原生迁移已完成全部人工验收。** 当前代码已有原生管理功能，
并已在仓库外临时目录生成 no-web release candidate；先看 [DESKTOP_APP.md §13](DESKTOP_APP.md#13-去网页化迁移当前状态)。
下方与网页登录、WebView、托盘相关的历史勾选项已由本次原生清单替换；旧 `dist/app` 不能用于新架构验收。

> 约定：
> - `ROOT` = 仓库根目录（`D:\GIT-QQ-BRIDGE`）。
> - `APP` = `%LOCALAPPDATA%\Programs\WhaleBridge`（普通用户可写；用管理员安装则可省掉 `--install-dir`）。
> - 全程不要同时运行两份桥接指向同一个数据目录（会互相抢锁，属预期行为）。

---

## 0. 准备：构建发布候选

> ⚠️ 所有 `npm run` 命令**必须在仓库根目录执行**。`npm run` 不会向上层目录查找脚本；
> 如果在别处运行（例如用户主目录），会看到 `npm error Missing script: "build:core"`。

```bat
:: cmd.exe
cd /d D:\GIT-QQ-BRIDGE
npm run build:core
npm run desktop:build
npm run build:release
npm run test-release-candidate    :: 预期：🎉 发布候选在真实配置下通过
```

```powershell
# PowerShell
cd D:\GIT-QQ-BRIDGE
npm run build:core
npm run desktop:build
npm run build:release
npm run test-release-candidate
```

> `npm warn Unknown user config "store-dir"` 是 npm 读取本机 `.npmrc` 时的**无害警告**，
> 不影响任何命令；它会在后续 npm 大版本里自动消失。

- [ ] `dist\app\` 生成并在目标机器验收；当前已在临时隔离目录跑通 `test-release-candidate`，不覆盖旧 `dist\app\`。

---

## 1. 真实安装 / 升级 / 卸载

```powershell
$APP = "$env:LOCALAPPDATA\Programs\WhaleBridge"

# 1.1 先看计划，确认目标路径正确
.\dist\app\WhaleBridge.exe --install --dry-run --install-dir $APP

# 1.2 正式安装（会写开始菜单、桌面快捷方式与 HKCU 卸载项）
.\dist\app\WhaleBridge.exe --install --install-dir $APP
```

预期：
- [ ] 计划里所有路径都指向 `$APP` 与 `%LOCALAPPDATA%\WhaleBridge`
- [ ] 安装结束输出「完成：N 项改动」，`$APP\WhaleBridge.exe`、`$APP\WhaleBridgeCore.exe`、
      `$APP\resources\`、`$APP\install-manifest.json` 都在
- [ ] 开始菜单出现「鲸桥 WhaleBridge」与「卸载鲸桥」，桌面出现快捷方式
- [ ] 「设置 → 应用」里能看到「鲸桥 WhaleBridge」条目

```powershell
# 1.3 维护操作
.\dist\app\WhaleBridge.exe --repair  --install-dir $APP    # 预期：无需修复 或 补齐缺失文件
.\dist\app\WhaleBridge.exe --install --install-dir $APP    # 预期：识别已安装版本并升级
```

- [ ] 「修复」不会覆盖你自己改过的资源（选一个普通文本/角色资源副本测试；不要修改产品页面，因为新包不应包含页面）
- [ ] 重复安装不会碰 `%LOCALAPPDATA%\WhaleBridge\config.json`

卸载见第 6 节（建议放在最后做）。

---

## 2. 原生桌面窗口（当前范围）

从开始菜单启动「鲸桥 WhaleBridge」。

- [ ] 无需安装/启用 WebView2 Runtime；默认浏览器不可用时 WhaleBridge 的窗口、安装器仍可运行
- [ ] 首次启动无黑框；窗口标题为「鲸桥 WhaleBridge」
- [ ] 概览显示 Supervisor 状态、Core PID/IPC 状态；“重启桥接”能经 Supervisor 重启子进程
- [ ] 角色、安全通知、黑话配置、会话、审批/提问与诊断页通过本机命名管道工作
- [ ] 诊断只接受 `runtime/config/paths/services` 固定项，不提供任意命令或 shell 输入
- [ ] 输入法、系统缩放、键盘导航、复制粘贴可用
- [ ] 关闭窗口会停止桌面壳及其管理的 Core；当前版本没有系统托盘，不能勾选旧托盘要求
- [ ] 管道权限审计确认仅当前用户可连接；过时版本/错误协议/超大帧/超时被拒绝

> 尚未迁移的发送参数、实时事件、reserved/reserved2 完整记忆、贴纸、文件/音频/Kugou 等 UI 必须在全功能原生版本完成后重新加入验收；服务管理、模型/Preset 与审批/提问基础页已具备，不能以本切片代替完整验收。

---

## 3. 四种模式与 DSH 集成

```powershell
# 3.1 迁移本机 DSH 集成（把 MCP 从 node + src/mcp-*.js 改到统一入口）
cd $ROOT
npm run setup:dsh -- --dry-run     # 先看计划（预期：只更新 cordis.patch.yml 的 MCP 块）
npm run setup:dsh                  # 正式执行
```

- [ ] 预演输出里只有 MCP 块更新与 DSH 集成注册相关条目
- [ ] 正式执行后 `~\.dsh\profiles\web\cordis.patch.yml` 里五个 `mcp-*` 的 `args` 变成
      `<仓库>\src\core-entry.js --mcp <模式>`
- [ ] **重启 DSH**（关掉再启动，或用 DSH 的重启功能）
- [ ] DSH 会话里能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*`、
      `mcp__qq-file-send__*`、`mcp__bilibili__*` 工具

四种模式（在 DSH 设置页的 `whale-mode` 卡片切换，或改 `state\mode.json` 后重启桥接）：

- [ ] `chat`：文本自动转发，agent 回复回到 QQ
- [ ] `closed-agent`：不自动转发，agent 用工具自主看/发
- [ ] `reserved`：保留模式行为正常
- [ ] `reserved2`（二代仿真）：文本不自动转发，agent 通过 `qq_get_unread_messages` / `qq_send_message`
      自主收发，`/api/restart` 后仍保持

---

## 4. 真实 QQ 链路

在测试群/私聊里逐项确认：

- [ ] 私聊收到消息 → agent 回复（含「正在思考」提示）
- [ ] 群聊 @ 或按配置触发 → agent 回复
- [ ] 引用回复：回复能带上引用消息
- [ ] 图片：agent 能「看到」图片内容（模型声明 image 输入时）
- [ ] 表情/贴纸：触发与发送正常
- [ ] 合并转发：能读取转发内容
- [ ] QQ 官方卡片：能查看卡片内容（`qq_get_card_msg`）
- [ ] 文件/音频：`qq_send_file` 能发出文件；TTS/FFmpeg 路径可用（若配置了）
- [ ] 风险按钮审批：需要审批的操作会提示，拒绝与通过都生效
- [ ] 断线重连：断开 SnowLuma 或 QQ 后，恢复时桥接自动重连（`worker.log` / 控制台能看到）

---

## 5. 子服务与恢复

- [ ] 本地服务面板能检测到 SnowLuma（Lite/Full）与 DSH 的安装状态
- [ ] 「启动/停止」SnowLuma 生效，日志能看
- [ ] 重启 DSH：桥接自动探活恢复；**DSH 重启期间收到的 QQ 消息不丢**（恢复后补投，最多 50 条/会话）
- [ ] 重启 SnowLuma：桥接自动重连
- [ ] 关闭 DSH 时控制台/桥接的提示合理，不崩

---

## 6. 卸载与数据保留

```powershell
# 6.1 默认卸载：保留用户数据
.\dist\app\WhaleBridge.exe --uninstall --install-dir $APP
```

- [ ] 程序文件、开始菜单与桌面快捷方式、「设置 → 应用」条目都被清除
- [ ] `%LOCALAPPDATA%\WhaleBridge\`（配置、state、日志、令牌）**完整保留**
- [ ] 没有残留进程

```powershell
# 6.2 重装后会沿用已有配置与数据
.\dist\app\WhaleBridge.exe --install --install-dir $APP
```

- [ ] 重装后仍是原来的模式/角色/会话，`config.json` 未被覆盖

```powershell
# 6.3 彻底卸载（可选，会永久删除数据与令牌；DSH 集成也一并移除）
.\dist\app\WhaleBridge.exe --uninstall --install-dir $APP --remove-data --remove-dsh-integration
```

- [ ] 数据目录被删除；`~\.dsh\profiles\web\cordis.patch.yml` 里本项目生成的 MCP 块被移除，
      **用户自己写的其它配置与自建 preset 保持不变**

> 注意：6.3 之后 DSH 里不再有 `qq_*` 工具；需要时重新 `npm run setup:dsh` 并重启 DSH。

---

## 7. 旧数据迁移（如需要）

```powershell
# 从旧仓库目录迁移配置与状态（默认不覆盖已存在的目标文件）
.\dist\app\WhaleBridge.exe --migrate --from "D:\GIT-QQ-BRIDGE" --dry-run
.\dist\app\WhaleBridge.exe --migrate --from "D:\GIT-QQ-BRIDGE"
```

- [ ] 预演列出要迁移的文件、外部工具路径告警，且**不打印任何令牌内容**
- [ ] 正式迁移后新数据目录里有 `config.json`/`state/`/`roles/`，旧目录**原样保留**
- [ ] 迁移后用迁移来的配置启动，四种模式与工具仍可用

---

## 8. 其他平台 / 权限（无法在当前机器验证）

- [ ] **Windows 10 x64**：在 Win10 机器上跑 `npm run test-release-candidate` 与第 1、2 节
- [ ] **中文用户名**：在用户名含中文的账号下安装并运行
- [ ] **非管理员账号**：确认安装（指到 `%LOCALAPPDATA%`）与运行都不需要提权

---

## 9. 发行前遗留（需要决策，不需要验收）

- [ ] 确定正式 **Windows App ID**（当前 `local.whalebridge.prototype`）与**签名主体**
- [ ] 替换 `build.rs` 生成的 32×32 占位图标为正式图标，补版本资源
- [ ] 启用 NSIS 产出 `WhaleBridge-Setup-x64.exe` 并做 Authenticode 签名与时间戳
- [ ] 补齐 `dist\app\licenses\` 下的 Node.js 运行时许可证文本与各依赖许可证
- [ ] 处理 `release-manifest.json` 里记录的 `knownDeviations`（`WhaleBridge.exe` 内含构建机路径；
      建议改到 CI 的干净工作目录构建）
- [ ] 验证 Windows Defender 对 SEA 注入产物与安装包的处理

---

## 10. 全部通过后：文档收口

1. 把本节结论（哪一项通过/失败、失败的现象与日志）并入 [DESKTOP_APP.md](DESKTOP_APP.md) §11；
2. 删除临时工作文档：`git rm DESKTOP_APP_WORKPLAN.tmp.md`，提交信息写明
   「桌面化临时工作文档收口」；
3. 确认 `DESKTOP_APP.md` §11 不再有未验证表述。

完成后整个桌面化项目才算真正交付。
