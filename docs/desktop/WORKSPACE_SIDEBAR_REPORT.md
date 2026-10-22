# 图标导航与工作区列表验收

日期：2026-10-22。Owner确认效果图后实施。工作树为`D:\GIT- CetaMesh\comm-repair`，分支`codex/app-icon-refresh`，基线`ee88b21`。本轮不自动提交、打包、安装、合并或推送。

## 实现

- 左侧56px导航栏只显示图标，保留title悬停说明、aria-label、aria-current及任务角标；设置/关于/用户头像固定底部。
- 根据Owner指出的遗漏，补充Work下方独立“记忆”图标入口；点击沿用既有memory路由，选中状态及折叠后的入口已纳入回归。导航分组使用明确页面ID，不再依赖数组切片位置。
- 260px工作区列表采用紧凑名称下拉、新会话、项目文件夹和会话行；项目根据session.config.workspaceId真实分组，未知工作区会话保留在最近列表。每条会话只进入一个分组；全部会话入口保留。
- 工作区列表可收起，收起后卸载列表避免隐藏控件保留焦点入口；不写入真实用户持久化偏好。900px以下使用覆盖层并保留图标栏折叠入口。
- 会话选择导航到Chat，工作区切换继续走workspaceClient.open。新建、重命名、归档、删除和全部会话复用原有回调、确认及Core接口；没有新增Host或Core权限。
- 保留深浅主题、项目展开动效、按钮反馈和既有减少动态效果规则。

## 实际验证

先新增并登记test-sidebar-layout，经统一npm test入口确认缺少生产模块而失败，再实现组件。

- `npm run build:ui`：TypeScript及Vite生产构建PASS。
- `npm test -- --suite test-sidebar-layout --suite test-desktop-ui-v2-production --suite test-window-chrome --suite test-chat-composer-layout --suite test-chat-context-card --suite test-ui-motion --suite test-error-hygiene`：7 PASS / 0 FAIL / 0 NOT_RUN_ENVIRONMENT。
- 侧栏测试覆盖真实分组函数、未知工作区会话可达、不重复分组、图标可访问名称、折叠后的DOM边界。
- 既有host措辞测试迁至WorkspaceSidebar实际模块，验证ready对应“已连接”、不称原生程序为浏览器预览；不再要求移除前的长文案留在HarborApp。
- 浏览器用真实WorkspaceSidebar及合成数据验收：Work导航、会话选择后返回Chat、新会话回调、工作区菜单选择并关闭、深浅主题、项目展开和整体折叠均通过。25条项目会话展开后滚动区content1178/client415，scrollTop762.4；图标栏底部top459.2/bottom624前后不变（484×636视口）。
- 预览入口和截图保留在仓库外证据目录`D:\GIT- CetaMesh\comm-evidence`，截图`sidebar-implemented-light.png`。这是真实生产组件的合成数据验收，不等于连接真实Core或安装后的原生WebView2验收。

## 变更文件与边界

HarborApp.tsx接入新组件；WorkspaceSidebar.tsx实现分组及展示；workspace-sidebar.css实现布局；icons.tsx增加既有图标库Folder映射；test-sidebar-layout.mjs及聚合登记增加回归；test-desktop-ui-v2-production.mjs迁移措辞断言；PROJECT_STATE.md记录状态。

Core/Agent/Workspace授权、用户数据及RC1116正式产物未改动。UI构建仅更新本地生成目录。签名、真实外部服务及其他发布门禁没有因本次界面修改而通过，RELEASE_BLOCKED保持不变。
