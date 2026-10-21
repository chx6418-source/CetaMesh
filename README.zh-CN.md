# CetaMesh

CetaMesh 是本地优先的 Desktop + Mobile 项目，正式开发目标仓库为
[chx6418-source/CetaMesh](https://github.com/chx6418-source/CetaMesh)。

桌面端保留根目录工程，移动端完整位于 `apps/mobile/`。两端独立安装依赖、运行、
管理版本和构建发布；共享协议不会自动授予设备权限或同步私人数据。

**公开迁移审查分支：**只导入审查后的源码快照，不导入私有 Git 历史。SnowLuma SDK/MCP 不集成。见 [迁移验收报告](docs/migration/PUBLIC_MIGRATION_ACCEPTANCE.md)。

- [统一开发与构建说明](docs/MONOREPO.md)
- [移动端说明](apps/mobile/README.md)
- [原公开中文项目介绍（完整保留）](apps/mobile/README.zh-CN.md)
- [贡献指南](CONTRIBUTING.md)
- [中文开源说明](OPEN_SOURCE.zh-CN.md)
- [安全说明](SECURITY.md)

根目录运行 `npm ci`、`npm --prefix desktop-ui ci` 和 `npm test`。
移动端运行 `npm --prefix apps/mobile ci` 和 `npm --prefix apps/mobile test`。
Windows 安装包与 Android Standalone APK 分别构建。GitCode 现有正式更新入口保留。
