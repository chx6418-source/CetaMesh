# 迁移记录：项目已迁至 D:\GIT-QQ-BRIDGE

日期：2026-09-10

## 变更内容
- **项目位置**：`F:\Administrator\Documents\qq-bridge\qq-bridge-main` → **`D:\GIT-QQ-BRIDGE`**（旧目录保留为 `F:\Administrator\Documents\qq-bridge\qq-bridge-main.BAK-20260910`，确认无误后可删除）
- **代码零改动迁移**：4313 个文件逐字节一致（仅排除可再生的 `state/file-send-cache` 音频缓存，运行时会自动重建）
- **DSH MCP 路径已更新**：`C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` 中 5 个 MCP server 脚本路径全部指向 `D:\GIT-QQ-BRIDGE\src\*`（snowluma / snowluma-host / web-search-safe / qq-file-send / bilibili）
- **修复失效配置**：`config.json` 的 `fileSend.ffmpegPath` 原指向不存在的路径，已改为实际存在的 `D:\ghfhuyguyh\GPT-SoVITS-v2pro-20250604\runtime\ffmpeg.exe`
- **已纳入 Git 管理**：本地仓库已初始化并完成首次提交（分支 `main`，提交 `906f919bde`）

## 运行方式（不变）
1. 先启动 SnowLuma（`config.json snowluma.launcherPath`）——桥接启动时会连接 `ws://127.0.0.1:3000`，未启动会以 `SnowLumaConnectionError` 退出（新旧目录行为一致，已实测）
2. 再运行 `start.bat`（脚本使用 `%~dp0`，与目录无关）
3. 控制台：http://127.0.0.1:3100

## Git 状态
- 仓库位置：`D:\GIT-QQ-BRIDGE\.git`（标准格式，可用任意 git 客户端）
- 忽略项：`node_modules/`、`state/`、`config.json`（含 accessToken / 酷狗 Cookie 等密钥，**不入库**）、`*.log`、`tools/`、以及若干本地调研文档
- 本机尚未安装 Git for Windows（且尝试下载便携版因 TLS 证书校验失败而中止）。安装后即可直接使用：`git -C D:\GIT-QQ-BRIDGE log --oneline`
- 仓库内已写入 `user.name=qq-bridge` / `user.email=qq-bridge@localhost`，可按需修改
