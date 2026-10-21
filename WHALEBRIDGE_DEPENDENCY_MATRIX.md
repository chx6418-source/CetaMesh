# WhaleBridge / CetaMesh 依赖矩阵（M0）

审查起点 `f6586c323b41bb55872fac1d96e2a783ceeb7592`；日期 2026-10-18。`CONFIRMED` 为本轮源码调用链，`FIXTURE` 为统一入口测试，`SCAN_ONLY` 表示已纳入 103 文件库存但没有逐方法认证，`UNVERIFIED` 不能升级成运行故障。接口方法参照 [AGENT_INTERFACE_METHOD_LEDGER.csv](AGENT_INTERFACE_METHOD_LEDGER.csv)；该表有 363 行，不能只按 IPC 前缀计数。

| 发起方 → 依赖方 | 实际源文件/入口 | 加载、所有权及失败影响 | 证据/下一步 |
| --- | --- | --- | --- |
| Rust Shell → Core worker | `desktop-shell/src/core_launch.rs`、`supervisor.rs` → `src/core-entry.js` / `WhaleBridgeCore.exe --worker` | Shell 创建并监督进程，注入 Owner pipe/token 和 DataDir；旧 exe 名是发行兼容接口 | `CONFIRMED`；M2 保持 CLI 兼容 |
| CLI/SEA → Bridge | `src/core-dispatch.js:7,128` → `src/bridge.js` | 静态 import；正式 worker 只能从旧 Bridge 入口启动 | `CONFIRMED` 反向依赖；M2 最小新入口 |
| Bridge → Core | `src/bridge.js:1983-2005` → `src/app/bootstrap.js`、`ipc-runtime.js`、数据 IPC | Bridge 持有 Core 初始化和 UI/data IPC；旧退出与 Core 生命周期混合 | `CONFIRMED`；M2 转移组合根/IPC owner，避免第二 Core |
| Bridge → QQ/SnowLuma | `src/bridge.js:9737-9778` → `src/channel/qq/runtime.js` / `local-services.js` | 同进程构造 QQ Runtime，后台尝试启动 SnowLuma；失败记录并降级 | `CONFIRMED`；无网关 worker `FIXTURE` 可上线，M4 再隔离 |
| Bridge → DSH | `src/bridge.js` → `src/dsh-client.js`、`local-services.js`、`dsh-integration.js` | 旧社交会话/控制动作仍访问 DSH；Core Model Runtime 可单独运行 | `CONFIRMED`；M3 定义用途/版本/preset |
| Core 组合根 → Agent Provider | `src/app/service-container.js` → `src/agent/{service,broker,managed-agent-provider,codex-agent-provider,dsh-agent-provider}.js` | Core 持有 Task/Workspace/审批，Provider 只执行；DSH API 缺省时 unavailable | `CONFIRMED` / `FIXTURE`；不替换 Broker |
| Broker → DSH Follow | `src/agent/broker.js:160-163` → `src/agent/dsh-agent-provider.js:217-219` | 每个调用新开原生 `session/follow`，Adapter 不接 `sinceSequence`；不能证明单上游/独立 replay | `CONFIRMED` 代码行为；实际网关后果 `UNVERIFIED`，M3 契约优先 |
| Core 组合根 → QQ Memory adapter | `src/memory/service.js` → `src/memory/adapters/qq.js` | 构造只保存社交文件路径，读取在调用时；非 Core Memory 的唯一事实源 | `CONFIRMED`；M4 改为可选只读端口，保持历史读取 |
| Core 组合根 → MCP/插件 | `service-container.js` → `src/integrations/{service,mcp-runtime,store}.js` | 插件状态可损坏并明确失败；本轮夹具证明 Task/Memory 继续可用；MCP 按调用启动子进程 | `CONFIRMED` / `FIXTURE`；M2/M4 保留按需加载 |
| Core 组合根 → Extension 宿主 | `service-container.js` → `src/extension/{service,runtime,process-host,process-transport}.js` | Extension 有进程宿主与 Broker 权限；崩溃应只撤销其 capability | `CONFIRMED`；原有宿主测试，正式安装 E2E `UNVERIFIED` |
| Core → Task/Memory/Workspace/Continuity | `src/{task,memory,workspace,continuity}/` | Core 持有领域数据、写者仲裁与审批；Bridge 不应创建第二套 | `CONFIRMED`；M2-M5 固定唯一写者 |
| Owner UI → Core IPC → Legacy fallback | `src/app/ipc-runtime.js:10-96` → `controlService.execute` | 前缀路由由 Core 服务处理，未知方法回退旧控制服务；只在 token+role 校验的 native Owner pipe 上可达 | `CONFIRMED`；M2 需逐方法白名单与错误语义，不得绕过审批 |
| Core → Device Mesh/Channel | `service-container.js` → `src/mesh/service.js`、`src/channel/service.js` | Mesh 与 Channel 契约可装配；QQ transport 不是 Core 必需依赖 | `CONFIRMED` / `FIXTURE`；真实设备与 OneBot 未验 |
| SEA/安装器 → 旧资产 | `scripts/build-core.mjs`、`scripts/build-release.mjs`、`desktop-shell/src/installer.rs` | 固定 `WhaleBridgeCore.exe`、`resources/dsh` 等与 `%LOCALAPPDATA%\WhaleBridge`，正式包禁旧 HTTP | `CONFIRMED`；M6 双路径兼容与回滚 |

## 静态/动态加载与进程库存

- 指定范围 103 个受 Git 跟踪文件，静态 `import` / 动态 `import()` 搜索命中约 201 行；计数是文本线索，不代表 201 条唯一依赖。`core-dispatch` 静态引入 Bridge、五个旧 MCP runner、DSH setup、Extension worker；`service-container` 静态引入领域和可选 Adapter 实现。需在 M2 使用依赖图/SEA metafile 与运行探针共同锁定禁止边。
- `src/agent/cli-agent-process.js` 负责 Codex 等原生 CLI 的 spawn/终止；`src/integrations/mcp-runtime.js` 管 MCP stdio 客户端；`src/extension/process-transport.js` 管 Extension 子进程；`src/local-services.js` 管 SnowLuma/DSH 本机进程；Rust Shell 管 Core worker。这些进程不能因目录改名而改变 Owner。
- `WHALEBRIDGE_DATA_DIR`、`WHALEBRIDGE_RESOURCE_DIR`、`WHALEBRIDGE_SUPERVISED`、`WHALEBRIDGE_UI_PIPE`、`WHALEBRIDGE_UI_AUTH_TOKEN` 仍是实际部署接口；Rust 还接受 `WHALEBRIDGE_CORE_EXE`、`WHALEBRIDGE_CORE_MODE`、`WHALEBRIDGE_REPO_ROOT`。Codex 读取受限的 `CODEX_HOME`，DSH Desktop 发现用本机程序目录。旧环境变量在 M2-M6 保留别名，不批量替换。
- `dsh/agent-presets/` 的 6 个跟踪文件属于打包模板；实际用户 DSH preset 不在仓库，未读取/覆盖。`desktop-shell/` 44 个文件全部列入清单，关键启动/安装链已查；其余为 `SCAN_ONLY`，不能据此宣布整个 Rust Shell 已逐方法审计。

## 拆分优先级

**可以直接沿用/独立装配：** Task、Memory、Workspace、Capability Broker、Managed Agent、Model Runtime、Continuity、Device Mesh 的现有 Core 服务；Extension 受限宿主和 MCP 客户端的已有公开能力边界；普通模型 Chat 的非 DSH 路径。无需移动这些模块。

**先调整契约再拆：** Core worker bootstrap/Owner IPC 与 Bridge 的控制权；`ui.events.next` 与 Agent Native Follow 的持久身份/重放缺口；Legacy fallback 方法白名单；DSH purpose/preset/version；QQ Channel 的唯一消费者/回执；Bionic 社交状态只读适配；StateDir/Workspace/Task/Memory 的唯一写者与迁移 journal。详见 [WHALEBRIDGE_MIGRATION_PLAN.md](WHALEBRIDGE_MIGRATION_PLAN.md)。

**风险未证实为事故：** 静态 import 不等于网络连接或可选组件缺失时崩溃；本轮隔离 worker 和损坏可选状态夹具通过。真正的正式安装版无外部组件、真实 QQ 消费者切换、跨 Core 重启的事件回放仍 `NOT_RUN_ENVIRONMENT`。

## HEAD 文件级库存（103 个路径）

下表 blob SHA 取自审查起点 HEAD；MANUAL_ENTRY 表示本轮阅读关键入口/调用链，SCAN_ONLY 表示路径与静态线索扫描，均不等于完整方法级或真实运行认证。
另一个直接相关的 SEA 构建入口 `scripts/build-core.mjs` 位于用户重点目录之外，本轮已核查，HEAD blob SHA-1 为 `d1e1b19aaa51a842ad416311d70e1b734841c680`。

| HEAD 路径 | Blob SHA-1 | 检查深度 |
| --- | --- | --- |
| `desktop-shell/Cargo.lock` | `c5f54ba05ea7e249f1c1a6cb8787d68208cf8058` | SCAN_ONLY |
| `desktop-shell/Cargo.toml` | `27d4c55703e1e78841d51c9d1b9238aa4eb1f62d` | SCAN_ONLY |
| `desktop-shell/README.md` | `f7ab2614631e49c983c1f3d3a6c0d17f7529ad11` | SCAN_ONLY |
| `desktop-shell/build.rs` | `e1aafa6e8a93e5e77063a1e42eec6786c28f6e2f` | SCAN_ONLY |
| `desktop-shell/icons/128x128.png` | `66c15d5231ace4e5d69a8f5a61d563a7b53f4aa3` | SCAN_ONLY |
| `desktop-shell/icons/128x128@2x.png` | `f2b7735c44571497fc962a0f6ccbee68a344e3a8` | SCAN_ONLY |
| `desktop-shell/icons/32x32.png` | `4b0b39703999488ea089d1f05a6ce1bcdacdf4bc` | SCAN_ONLY |
| `desktop-shell/icons/README.md` | `a050f557cf69963ec24d5c03810bcbf81e98659c` | SCAN_ONLY |
| `desktop-shell/icons/icon.ico` | `dd6e3d4402466cb6cdab8e3ea59e219354377d89` | SCAN_ONLY |
| `desktop-shell/icons/icon.png` | `20809b02862e46ea74b867f85c6e18deef09df6a` | SCAN_ONLY |
| `desktop-shell/icons/source-c4.png` | `84edefe3a8a53ebfaf0a909e06e7d6960cb12753` | SCAN_ONLY |
| `desktop-shell/icons/source-logo-05.png` | `fcf66cf3af09038addd6a157db420339bd772b7b` | SCAN_ONLY |
| `desktop-shell/src/agent_ui.rs` | `ed41151b0cce4408fa297cc0165236d3496d1e90` | SCAN_ONLY |
| `desktop-shell/src/app_shell.rs` | `18c6e335a23ea1efef1a0bad94bbedfed0c8b20f` | SCAN_ONLY |
| `desktop-shell/src/chat_ui.rs` | `196bbfb55ad9f39a2944101e63e466a727c5e3af` | SCAN_ONLY |
| `desktop-shell/src/core_launch.rs` | `b402ab7df22b406ef77008a6990f518d165bb005` | MANUAL_ENTRY |
| `desktop-shell/src/desktop_paths.rs` | `fde5914c73057a77e2b03f72cdb36f1320062add` | SCAN_ONLY |
| `desktop-shell/src/external_link.rs` | `23a5ebef908da31668a55e8db8f9c78f127b3cb1` | SCAN_ONLY |
| `desktop-shell/src/install_cli.rs` | `b6fd7224c2cee7b27eea0f0b970bd91185c35d30` | SCAN_ONLY |
| `desktop-shell/src/installer.rs` | `7b5e54cca3d98a2b75374e83ed2f411f6467866a` | MANUAL_ENTRY |
| `desktop-shell/src/integrations_ui.rs` | `0416d3a6c0d190f33691eeca1a488aac2ab6bc08` | SCAN_ONLY |
| `desktop-shell/src/ipc_client.rs` | `ee9603c655653efe8a58b92fbeebb43c0d616063` | SCAN_ONLY |
| `desktop-shell/src/memory_ui.rs` | `2e92433ef2eff062f6f0e461b929416e37343dcb` | SCAN_ONLY |
| `desktop-shell/src/mesh_ui.rs` | `826b0e01aeb16979c2b1398a5a22cab244764dac` | SCAN_ONLY |
| `desktop-shell/src/migrate.rs` | `47427d34f800a34514023006bfdee381d69fbe71` | SCAN_ONLY |
| `desktop-shell/src/native_installer_ui.rs` | `0a8a78cb912b3c5b4f398055e05e826a64487535` | SCAN_ONLY |
| `desktop-shell/src/native_main.rs` | `e0399712e142c8da6150189f37bed8ec8bbc0806` | SCAN_ONLY |
| `desktop-shell/src/native_ui.rs` | `3b4bdfbc60b99bf4206066f84d82296409a4727c` | SCAN_ONLY |
| `desktop-shell/src/product_ui.rs` | `bad09c33fd3bfbeee4c6ade0911fe8cef52b1028` | SCAN_ONLY |
| `desktop-shell/src/supervisor.rs` | `cabc577b09be827463499dc43b6e6cca5fe23075` | MANUAL_ENTRY |
| `desktop-shell/src/task_ui.rs` | `e58dfd8b0c258a279194111373904ca0070eaf26` | SCAN_ONLY |
| `desktop-shell/src/theme/mod.rs` | `52fa342b2532168a7b4d625638306f179c01c94e` | SCAN_ONLY |
| `desktop-shell/src/theme/motion.rs` | `ff1193bf5338fdda435f4c24572347b9e31154ad` | SCAN_ONLY |
| `desktop-shell/src/theme/painter.rs` | `e64efd01d650e5cb72ae23f4670e2c2411438bc7` | SCAN_ONLY |
| `desktop-shell/src/theme/qa.rs` | `6eeac22294109e747ace49d817930f27fb66376e` | SCAN_ONLY |
| `desktop-shell/src/theme/spec.rs` | `ec037260e4ba5f133709522ce9752c018feb0d52` | SCAN_ONLY |
| `desktop-shell/src/theme/themes.rs` | `0df44137312cdfe9ba2ea6a1ec33bd700e0cb3a9` | SCAN_ONLY |
| `desktop-shell/src/tray.rs` | `18d6bfdc35fe75d2f624b738e40182bfd036157c` | SCAN_ONLY |
| `desktop-shell/src/ui_prefs.rs` | `cac15fd15b382f78c2e34938bc817111819f503e` | SCAN_ONLY |
| `desktop-shell/src/webview_policy.rs` | `3c2f038b7920e8b0e6c33f08a25bc044ee3019d1` | SCAN_ONLY |
| `desktop-shell/src/webview_ui.rs` | `ec453b90473b09ded44244608f9112a6ee424f3f` | SCAN_ONLY |
| `desktop-shell/src/workshop_ui.rs` | `dbabfd7d6bb2c2b9147a762b7efe78b8d5646158` | SCAN_ONLY |
| `desktop-shell/src/workspace_ui.rs` | `5619f7fbf22d6a409c5c7c4452bc63f1d6bc4fe3` | SCAN_ONLY |
| `desktop-shell/whalebridge.rc` | `0e85f238d4ca9e6bde44fd312e9cf2b220246aa2` | SCAN_ONLY |
| `dsh/agent-presets/whale-chat-v2/agent.cordis.yml` | `90e45229424cab887f4381d7ec9faf7b00384b30` | SCAN_ONLY |
| `dsh/agent-presets/whale-chat-v2/preset.yml` | `50fb4334405e906a95d81a18b6a3ac834120fa19` | SCAN_ONLY |
| `dsh/agent-presets/whale-chat-v2/qq-tool-restrict.mjs` | `590852eb4501a14f09748d7622d65cedb693f9de` | SCAN_ONLY |
| `dsh/agent-presets/whale-chat/agent.cordis.yml` | `d0d5d6c9018b57a719fab5b7796208955a4b7a85` | SCAN_ONLY |
| `dsh/agent-presets/whale-chat/preset.yml` | `1ff64d8b15b51a917a5f7dc1282a144a9a40eab8` | SCAN_ONLY |
| `dsh/agent-presets/whale-chat/qq-tool-restrict.mjs` | `590852eb4501a14f09748d7622d65cedb693f9de` | SCAN_ONLY |
| `scripts/build-release.mjs` | `d03a20dad618ff5f9e1d7eeea96d625e457fc92b` | MANUAL_ENTRY |
| `src/agent/agent-provider.js` | `4f53d65348fb14049c8755b93211113ead6bd58b` | MANUAL_ENTRY |
| `src/agent/broker.js` | `ed2cbf74c69b609eda14c0a62e125441880b65b2` | MANUAL_ENTRY |
| `src/agent/cli-agent-process.js` | `51bee354d049011ae506720dd02ec18cdb578257` | MANUAL_ENTRY |
| `src/agent/codex-agent-provider.js` | `5e949ca31dcd6660d11e8e7fb169833e5c08694f` | MANUAL_ENTRY |
| `src/agent/dsh-agent-provider.js` | `37d028212acf424e9470ad59fbc9d70eba82d7f2` | MANUAL_ENTRY |
| `src/agent/index.js` | `72204d57b32522f84b8c513e6ffc5d96088622e2` | SCAN_ONLY |
| `src/agent/managed-agent-provider.js` | `3c8d5bca6daa30a2c3867b7cfc9b8098a4ee90d0` | SCAN_ONLY |
| `src/agent/registry.js` | `36fcbd95d2958ee314277f40ad1846f60c803a56` | SCAN_ONLY |
| `src/agent/service.js` | `d1bce9e16a67c1dc501d9c87dce206b757c42e70` | MANUAL_ENTRY |
| `src/agent/staged-dsh-agent-provider.js` | `629f824c67c0c3b0f9f5f5d0043d52f828d63aaa` | SCAN_ONLY |
| `src/agent/zcode-agent-provider.js` | `21b0d4279d054bf8223afe0ba20778346777b779` | SCAN_ONLY |
| `src/app/bootstrap.js` | `361c92144a71d55db1daa4e9f00e233aff6f8c00` | MANUAL_ENTRY |
| `src/app/ipc-runtime.js` | `fb4755e194fb783b20d2016e46239a372eeb095a` | MANUAL_ENTRY |
| `src/app/lifecycle.js` | `37bd63353572ac66a75cd97dba2e7ae5e2f7287b` | SCAN_ONLY |
| `src/app/service-container.js` | `719a68d48d5f906ecb07d10d6e6503225f7c0560` | MANUAL_ENTRY |
| `src/app/state-owner.js` | `a9e2cacc61e6d0c8a158efa46ac656f20fd5c40d` | MANUAL_ENTRY |
| `src/bridge.js` | `0f27aa20e25a4627720df333d1c13d051cc74a48` | MANUAL_ENTRY |
| `src/channel/index.js` | `8d2573220674127a0f2498cac018d594512eab15` | SCAN_ONLY |
| `src/channel/qq/runtime.js` | `e00e4c03e8b7dc341908795ef5fdd6025832a324` | MANUAL_ENTRY |
| `src/channel/qq/tool-policy.js` | `6aa3f42cf757d923e7a6790d441e74d3b3f14f97` | SCAN_ONLY |
| `src/channel/qq/transport.js` | `7dff9a092e2d2d5ae7a4fb8427cb4355c0830d90` | MANUAL_ENTRY |
| `src/channel/registry.js` | `9029bf39c087b69107e2e84dee0cf15c57aa15b7` | SCAN_ONLY |
| `src/channel/service.js` | `6ab34179fa047052c0eea38c297ac570c4ce1d40` | SCAN_ONLY |
| `src/core-dispatch.js` | `19849b82d3fa81d337c9a37dd43383147930cb3b` | MANUAL_ENTRY |
| `src/extension/host.js` | `b869940f0a8c21281edb970eba3d993c73e634aa` | SCAN_ONLY |
| `src/extension/index.js` | `397a9da90515132cccac0cdc6ae201cc62059c55` | SCAN_ONLY |
| `src/extension/installer.js` | `300725e90f537f5495e70aef6d8739b8e5e404ec` | SCAN_ONLY |
| `src/extension/manifest.js` | `6a8e0b36168ff414f5559546db492cb72de9331a` | SCAN_ONLY |
| `src/extension/memory-pack.js` | `48b0d0421cb1e8ab3d45675f03610c5f2ba0091a` | SCAN_ONLY |
| `src/extension/package-fingerprint.js` | `1e2b920f42716cb84f1fd2f15472bfb1ddbb1c68` | SCAN_ONLY |
| `src/extension/private-storage.js` | `2d5a8f10fd08c36db8b5c028fec2d2a98d71bf7c` | SCAN_ONLY |
| `src/extension/process-host.js` | `5202b435ab95c6e6f5c59c6a846680da0428c549` | MANUAL_ENTRY |
| `src/extension/process-transport.js` | `d1e7dcb7e9fd14ac73ed0caaf2f734181ce66329` | MANUAL_ENTRY |
| `src/extension/process-tree.js` | `48563f4ee358b1e1cbb640f90553db3a6e7b121c` | SCAN_ONLY |
| `src/extension/process-worker.js` | `74fd75ddd64c15081b155e90ffd1314c54b2716c` | SCAN_ONLY |
| `src/extension/review.js` | `278929e4674215090ed0b6a1ac85865074da0d04` | SCAN_ONLY |
| `src/extension/runtime.js` | `2ea758ed1a716df2f5caf0a14ddc0de56f8277fa` | MANUAL_ENTRY |
| `src/extension/scan.js` | `b7474d4b662ffdc546f21b1bd78f3aa16863b824` | SCAN_ONLY |
| `src/extension/service.js` | `f979777348d4b9d1d0b94fcb4598e6746491e4fe` | MANUAL_ENTRY |
| `src/extension/settings.js` | `a3333842c8aeff8d80b90dca27a449bda36d0192` | SCAN_ONLY |
| `src/extension/store.js` | `24b2f43e96de4c3499fe4c45bcf48629463f7c4c` | MANUAL_ENTRY |
| `src/extension/types.js` | `7ba3dff17f9a91cdbddadf153fdae640a6769b35` | SCAN_ONLY |
| `src/extension/worker-env.js` | `2d7a739ea968b973627e6816c1838226a331eb6c` | SCAN_ONLY |
| `src/integrations/catalog.js` | `d24853fd258a94442cd5abae9b43375052186cda` | SCAN_ONLY |
| `src/integrations/dsh-desktop.js` | `74521842cf9f6883f8f259a2394565571d0e1ffc` | MANUAL_ENTRY |
| `src/integrations/index.js` | `7c54897ced8956bd5edc17e585d92e0e5957cf12` | SCAN_ONLY |
| `src/integrations/mcp-runtime.js` | `9b3c6d65ec404910ae6d9e5fc58b6f6deaad633f` | MANUAL_ENTRY |
| `src/integrations/registry.js` | `62aa98f84362d958ec983772e0d5619bdf0678f4` | SCAN_ONLY |
| `src/integrations/service.js` | `d3252dfbe84cb733ed7702e6557865b7fecbcd4b` | MANUAL_ENTRY |
| `src/integrations/store.js` | `3176b3b065fd21792ecaa0c056af13fa7786cb94` | MANUAL_ENTRY |
| `src/integrations/tool-policy.js` | `9ca216ee7f180225071d8640b44887cf5368a147` | SCAN_ONLY |
| `src/integrations/types.js` | `76446d6e378bdbcef9035f8752f813e8f3984fcf` | SCAN_ONLY |
