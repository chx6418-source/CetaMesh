# ADR — Plugin Composition Sidecar v1 与嵌套子插件（待批准）

- **状态**：PROPOSED；不改变现有 Manifest/Worker/Mesh 的线上协议。
- **背景**：现有 Extension Runtime 已有 `extension.invoke` 的委托链，但不具备受控递归包安装与复合依赖状态。17 类是产品分类而不是技术运行时。
- **决策提案**：引入独立 `composition.json` 侧车表示包内、外部依赖及绑定；旧 v1 解析保持稳定。先发布 Schema/Fixture/依赖图预览工具，再实现隔离安装与生命周期。
- **安全设计**：Component 独立 ID/版本/Hash/Host/Store、授权交集、精确 Capability、依赖 DAG、循环拒绝、最多5层包嵌套、最多8跳执行委托、父停用立即撤销有效路由。
- **替代方案**：① 直接升级 Manifest v2：语法覆盖过广、破坏旧版本风险高；② 把子插件直接 `import` 进父 JS：失去独立生命周期/授权；③ 新 Plugin Bus：重复 Broker 与审计。
- **后果**：新增解析器、Review UI、兼容锁、数据迁移、子包回归测试与双端兼容评审的维护成本；收益是可控插件套件、独立更新和未来 App/OS 融合。
- **开放问题**：嵌套包目录与签名/注册中心权威、同插件多实例共享状态策略、跨设备镜像分发策略、跨根外部依赖更新策略。未批准前不修改既有线上行为。
