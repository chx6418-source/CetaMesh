# Native Theme Fidelity 迁移报告（Task D）

> **分支：** `feature/native-theme-fidelity-v1`（从 `main` @ `e8a122a` 起）
> **日期：** 2026-10-08
> **结论：** 十套 Native 主题从「扁平 palette」升级为完整 Theme Engine（背景配方 / 玻璃表面 / 阴影层次 / 圆角体系 / 按键层次 / 动效），Soda 以旧 Web 为事实源高保真还原；Rust 测试 138 项全过；1280×800 截图验收完成。**未合并 main，等待 Owner 确认。**

## 1. 范围与事实源

| 项 | 内容 |
| --- | --- |
| 视觉事实源 | `design-demos/CetaMesh-ten-themes/public/console.html`（十主题定版 token + `.bg-decor` / `article.card` / `.btn` / input 配方，派生自 `design-demos/fusion-4-soda.html` 已选型方案） |
| 动效事实源 | `design-demos/bg-ripple/ripple-bg.js`（涟漪定版 V1：起波点 uv(1.02,1.02)、`once` 扩散、环列 11、alpha 衰减） |
| 旧产品对照 | `public/console.html`（旧 Web 控制台，结构与玻璃语言一致） |
| 约束 | 绝不恢复 WebView / HTML 产品 UI；一切用 egui `Painter` / `Mesh` / 贴片纹理实现 |

## 2. Theme Engine 架构（新增 `desktop-shell/src/theme/`）

```
theme/
  mod.rs     运行时：主题过渡状态机、每帧 begin_frame、背景层绘制、
             全局 egui::Style 工厂、玻璃卡片 / gummy 按钮 / 内嵌 well 组件、系统 Reduce Motion 探测
  spec.rs    ThemeSpec / Background / Blob / Fog / Tokens / ShadowProfile /
             ButtonStyle / MotionSpec；颜色插值、WCAG 亮度与对比度工具
  themes.rs  十套主题的完整配方（逐值转写自 Web token 块），readable_* 文本可读色派生
  painter.rs Mesh 渐变条带、柔光 radial 贴片、玻璃卡片（阴影+描边+顶部高光弧线）、
             gummy 按钮（hover/press/primary/danger/armed/ghost）、井状输入、涟漪环
  motion.rs  cubic-bezier 弹簧（--spring）、入场缓动、Timed 计时器、ReduceMotion、漂移与涟漪纯函数
  qa.rs      【仅 debug 构建】截图验收驱动 + 零依赖 PNG 编码器（stored deflate）
```

- 主题不再是颜色数组：`ThemeSpec` 至少包含 background（三段渐变 + 三组 ambient blob + 顶部雾）、surface / surfaceSecondary / surfaceAlpha（panel / panel-solid / glass-weak）、border / borderHighlight（border / edge-hi / edge-lo）、shadow（暗部 + 亮部双阴影 recipe）、innerHighlight（顶部 1.5px 玻璃边）、accent / accentSoft、text / mutedText、radius 体系、elevation（gummy / matte 两档 profile）、buttonStyle、motion。
- 主题切换为**连续插值**：`ThemeSpec::lerp` 混合所有颜色/圆角/阴影/模糊参数（identity 字段吸附目标），700 ms 平滑过渡。
- 页面零改动读取颜色：`native_palette()` 现在从当前插值 spec 派生（旧字段名全部保留），页面的 `Frame::new()` 旧灰卡片统一替换为主题卡片组件。

## 3. 十套主题（不是 hue shift）

每套主题有独立 背景 recipe / 表面材质 / 圆角 / 阴影 profile / accent 渐变：

| 主题 | 背景三段渐变（130°） | blob | 雾 | 半径 | 表面档位 | 阴影档 |
| --- | --- | --- | --- | --- | --- | --- |
| Soda | `#d5e3ff→#ded7ff→#ccf1ef` | 3 组（.45/.36/.32） | .32 | 26/16 | glass .55 | gummy |
| Deep | `#182347→#1c1d42→#12262e` | 3 组（.18/.15/.11） | .08 | 26/16 | glass .55 | gummy |
| Warm | `#eaeddd→#e7ebe4→#e4eee8` | 3 组（.30/.24/.22） | .32 | 26/16 | glass .62 | gummy |
| Ink | `#f4f3ef→#f1f0ec→#ecebe7` | 无 | 无 | 10/8 | solid .86 | matte |
| Forest | `#e3eae0→#eff2e8→#dce9df` | 3 组（.15/.14/.13） | .32 | 18/11 | .85 | gummy |
| Rose | `#fce9ec→#fff4f1→#f6e9f2` | 3 组（.20/.22/.17） | .32 | 26/16 | glass .69 | gummy |
| Sand | `#f3ecde→#f8f2e9→#eae3d3` | blob1/blob3 only | 无 | 8/6 | solid .90 | matte |
| Ice | `#e9f4f8→#f5fbfc→#e7f2fa` | blob1/blob2 only | .32 | 12/9 | glass .77 | matte |
| Dusk | `#1b222b→#222b34→#19232a` | 无 | 无 | 10/8 | solid .84 | matte |
| Violet | `#221d3d→#292047→#1c2445` | 3 组（.19/.15/.10） | .07 | 20/12 | glass .69 | gummy |

matte 档 = `box-shadow: 0 8px 22px` 单层暗影、无内高光、无 key light；gummy 档 = 16/18/42 暗影 + −10/−13/32 亮影 + 顶部玻璃高光弧线 + 底部内发光。Ink/Sand/Dusk 的装饰层（blob+雾）按 Web CSS 整体隐藏。

## 4. Soda 基准保真（对 `fusion-4-soda.html` / 十主题 console）

- **背景**：`linear-gradient(130deg, 苏打蓝 0%, 薰衣草 48%, 冰薄荷 100%)` 用 32 段条带 Mesh 绘制（中点 stop 精确）；三组 ambient blob 以「软圆盘贴片 + 主题色 tint」按 44vw/40vw/46vw ÷ 0.62 fade 还原（等效 blur 72px 的柔边）；顶部白雾 `radial-gradient(130vw 92vh at 50% -12%, #fff .32, transparent 56%)` 用线性衰减贴片还原。
- **软糖玻璃卡片**：`--panel` 半透明填充 + 1px 白边 + 26px 大圆角 + 双层软阴影 + 顶部 1.5px 高光弧（沿圆角精确描边）+ 底部内发光。
- **按钮层次**：gummy 白渐变（dark 档 `rgba(255,255,255,.14)` 起步）、主按钮 accent→accent-2 140° 渐变 + `on-accent` 文字、危险 / 警戒色、按下态整体下沉 2px 缩放 96% 并翻转为内阴影（贴合 `--spring` 弹簧曲线）。
- **导航**：未选中透明、hover 抬升 1px + `--hover` 填充；选中为 accent 渐变胶囊 + accent 阴影 + 文字转 `--on-accent`——与 Web `.nav-btn.active::before` 同构。
- **输入**：聊天输入框为井状内阴影 well（`inset 3px 4px 10px` + `inset -3px -4px 9px`），聚焦态由全局 style 保证 accent 焦点环。
- **主题选择器**：设置页每个主题卡片的缩略图直接调用 `painter::paint_background` + `paint_card` 渲染**真实配方**——所见即切换后的样子。

## 5. 动效

| 项 | 实现 |
| --- | --- |
| 主题切换 | 所有颜色/圆角/阴影 700 ms 连续插值（`cross_fade` 缓动）；Reduce Motion 下 150 ms 短淡变 |
| Ripple | 主题切换时自右下 (1.02, 1.02) 扩散 11 条同心环，半径随波前推进、alpha 距离衰减，环色为「旧主题→新主题」渐变插值；1.3 s 结束即停，Reduce Motion 下完全不播 |
| Ambient blob 漂移 | 三组 blob 以 48 s 周期正弦缓慢漂移（幅度 ≤2vw），30 fps 限帧 |
| 卡片 / 按钮 | hover 抬升 1px + brightness 1.045、press 下沉 2px × 96%，均由 `--spring` cubic-bezier(.3,1.6,.5,1) 塑形 |
| 页面入场 | 页面切换 340 ms 淡入 + 12px 上浮（等效 `moduleIn`），Reduce Motion 下仅 120 ms 淡入 |
| Reduce Motion | 偏好持久化（auto/on/off，auto 读 Windows `SPI_GETCLIENTAREAANIMATION`），设置页可切换；开启后关闭漂移与 ripple、压缩过渡与入场 |

## 6. 性能

- 背景/卡片/阴影全部为**当帧几何绘制**（条带 Mesh + 贴片 quad），无全屏逐像素重算、无持续高耗动画。
- 漂移与过渡用 `request_repaint_after` 限帧：过渡 16 ms、漂移 30 fps；两者都停止时**不再请求额外帧**（仅保留既有 500 ms 状态轮询），窗口失焦或 45 s 无输入后背景冻结。
- 贴片纹理（radial 渐变）每进程只创建一次并缓存在 egui 数据层。

## 7. 可访问性

- 全主题正文/次级文字对画布、面板、次级表面 ≥ 4.5:1（测试锁定）。
- 文本用 accent / 语义色（success / warning / error）走 `readable_*` 派生：沿 Web 色相向黑/白微调，直到在**卡片表面**与**软色 chip**（`--accent-soft`、`--err-bg` 等）上都 ≥ 4.5–5.5:1；填充渐变仍用 Web 原色（图形元素）。
- Dark 主题输入底色、边框、placeholder 全部可读（输入文字对比 ≥ 4.5:1，测试锁定）；焦点环 `1.5px accent` 在全局 style 中固定，不随主题消失。
- 已知偏差（如实记录）：Web 事实源的 `--text-3` 提示层级在 Warm 主题为 2.40:1（源设计如此，测试下限 2.3:1 记录在案）；Soda 的「accent 文本直接叠 accent-soft」在源设计中约 2.9:1，Native 通过 readable_accent 提升到 ≥4.5:1。

## 8. 测试与验证

| 检查 | 结果 |
| --- | --- |
| `cargo test`（desktop-shell） | **138 passed / 0 failed**，新增：ThemeSpec 完整性、10 主题 resolve、颜色范围、动画 finite、reduce-motion 折叠、主题偏好持久化、对比度矩阵、过渡插值/结算、ripple/漂移有界、PNG 编码、QA 计划 |
| `npm run desktop:check`（cargo check） | PASS（13 条 warning，均为既有 unused/仅在测试使用的诊断 API） |
| `node scripts/test-desktop-architecture.mjs` | PASS（8 组红线） |
| `node scripts/test-desktop-platform-integration.mjs` | PASS（72 断言） |
| `node scripts/test-desktop-chat-product.mjs` | PASS（17 组） |

## 9. 截图验收（1280×800）

路径：`output/theme-qa/shots/`（缩略图 `output/theme-qa/thumbs/`，均在 .gitignore 内，不提交）

| 文件 | 内容 |
| --- | --- |
| `ref-web-ten-themes-soda.png` | 旧 Web 参考（十主题 console light/Soda，无头 Edge 1280×800） |
| `01-soda-home.png` … `10-violet-home.png` | Native 十主题（Home/Chat 页） |
| `11-soda-settings.png` | Native 设置页（十主题实时预览网格 + 警示横幅按钮层次） |

对照结论：Soda 的背景三段渐变 + 三组柔光 + 顶部白雾、玻璃卡片大圆角、按钮/导航层次与旧 Web 同源；Ink/Sand 为哑光纸感、Dusk/Violet 为夜色糖果，十套之间是**背景 recipe + 表面材质 + 阴影档位**的差异而非色相平移。截图环境说明：QA 运行使用临时数据目录，页面显示「Core 不可用」状态横幅（同时用于演示 Armed/Normal 按钮层次）；这是环境事实，不影响设计系统判定。

截图生成方式（可复现）：
```bash
cargo build --manifest-path desktop-shell/Cargo.toml
WHALEBRIDGE_INSTANCE_SUFFIX=themeqa \
  desktop-shell/target/debug/whalebridge-desktop.exe \
  --data-dir output/theme-qa/data \
  --screenshot-dir output/theme-qa/shots
# 旧 Web 参考：
msedge --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 \
  --screenshot=output/theme-qa/shots/ref-web-ten-themes-soda.png \
  file:///<repo>/design-demos/CetaMesh-ten-themes/public/console.html
```
`--screenshot-dir` 是 **debug-only** 能力：整个 `theme::qa` 模块 `#[cfg(debug_assertions)]`，release 二进制不含任何截图代码。

## 10. Definition of Done

- [x] 10 套不是单纯 palette（独立背景 recipe / 表面 / accent / border-shadow profile / 半径）
- [x] Soda 高保真（三段渐变 + 三光斑 + 白雾 + 软糖玻璃 + 内高光 + 大圆角）
- [x] Theme Engine 独立（`desktop-shell/src/theme/`）
- [x] Native background recipe（Mesh 渐变 + tinted radial 贴片，无 WebView）
- [x] glass / surface / elevation（gummy 与 matte 两档 elevation recipe）
- [x] hover / press（弹簧曲线 + 内外阴影翻转）
- [x] theme transition（700 ms 全量插值 + ripple）
- [x] reduce motion（偏好持久化 + 系统探测；150 ms 淡变、无 ripple、无漂移）
- [x] 全主页面使用 token（页面旧灰 Frame 全部改为主题卡片；`native_palette()` 全部来自插值 spec）
- [x] Rust tests PASS（138/138 + desktop:check + 3 个 node 套件）
- [x] 不存在 WebView 回退（仅 egui Painter/Mesh/纹理；QA 截图能力 debug-only）

## 11. 已知限制（如实记录）

1. **无真 backdrop-blur**：egui 无法模糊「形状背后」的画布，`--glass-blur` 作为数据保留（16–22px），玻璃拟真由半透明面板 + 顶部高光 + 双层软阴影表达；这是原生绘制的物理边界，非缺项。
2. **软阴影为分层近似**：12 层圆角矩形叠加拟合高斯投影；大尺寸下与 CSS 观感一致，不追求逐像素。
3. **截图来自 debug 构建**（windowed dev shell + 临时数据目录），不代替 `desktop:build` 发行产物的视觉验证；发行构建的视觉效果一致（同一份绘制代码）。
4. **焦点环**：egui 的 `focus-visible` 语义是「键盘聚焦」，鼠标点击不显示焦点环（与浏览器默认行为一致，但弱于 Web 的 `:focus-visible` 强制样式）。
5. 主题过渡期间新页面切换不会打断过渡（插值自当前中间态继续），这是有意行为；如观感需要可再调。

## 12. 分支与后续

- 分支：`feature/native-theme-fidelity-v1`（本地，未推送、未合并）。
- 按仓库工作流：**等待 Owner 确认 → 合并 main → 验证 → 删除分支**。
- 若后续要把 QA 截图纳入 CI，可另开任务（当前执行成本高：需真实窗口 + ~25 s）。
