//! UI v1 插件页：接入任务 B 的统一集成面（plugins.* / tools.* / mcp.*）。
//!
//! 只做状态维护、解析与渲染；IPC 下发由 native_ui 完成（本模块不持有 worker）。
//! 数据全部来自 Core 真实回包：字段缺失显示"未知"，绝不本地编造。
//!
//! 信息架构（Owner 选择的方案 04 交互）：一级页只放几类入口（插件 / 工具 / MCP /
//! 扩展包），点开单个插件或 MCP 服务器进入二级详情页——二三十个工具不堆在一级页。
//! 管理动作走 Capability Broker：回包 pending 时不自动批准，提示用户去审批队列。

use eframe::egui;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IntegrationsTab {
    #[default]
    Marketplace,
    Plugins,
    Tools,
    Mcp,
    /// 原扩展包审查 / 安装流程（native_ui 承载渲染，模块不消费）。
    Extensions,
}

/// 一条待下发的 Core 调用意图。
#[derive(Clone, Debug)]
pub struct IntegrationsAction {
    pub method: &'static str,
    pub params: Value,
}

impl IntegrationsAction {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IntegrationPlugin {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub version: String,
    pub summary: String,
    pub enabled: Option<bool>,
    pub tool_count: u64,
    pub enabled_tool_count: u64,
    pub toggleable_tools: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IntegrationTool {
    pub id: String,
    pub label: String,
    pub description: String,
    pub plugin_id: String,
    pub server_id: String,
    pub group: String,
    pub enabled: Option<bool>,
    pub available: Option<bool>,
    pub risk: String,
    pub restore: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub status: String,
    pub enabled: Option<bool>,
    pub tool_count: u64,
    pub last_error: String,
}

#[derive(Clone, Default)]
pub struct IntegrationsUi {
    pub tab: IntegrationsTab,
    pub plugins: Vec<IntegrationPlugin>,
    pub tools: Vec<IntegrationTool>,
    pub mcps: Vec<McpServer>,
    pub plugins_loaded: bool,
    pub tools_loaded: bool,
    pub mcp_loaded: bool,
    pub overview: Option<Value>,
    pub selected_plugin: Option<String>,
    pub plugin_detail: Option<Value>,
    pub selected_mcp: Option<String>,
    pub mcp_detail: Option<Value>,
    pub mcp_tools: Option<Vec<String>>,
    /// mcp.tools 只在进入详情后请求一次；管理动作会复位。
    pub mcp_tools_requested: bool,
    pub notice: Option<String>,
    pub catalog: Vec<Value>,
    pub catalog_loaded: bool,
    pub catalog_available: bool,
    pub catalog_configured: bool,
    pub catalog_offline: bool,
    pub catalog_view: String,
    pub catalog_category: String,
    pub catalog_query: String,
    pub catalog_last_query: String,
    pub catalog_selected: Option<String>,
    pub catalog_stage: Option<Value>,
    pub pending_uninstall: Option<String>,
    pub catalog_screenshot: Option<Value>,
    pub catalog_icons: std::collections::HashMap<String, Value>,
    pub icon_textures: std::collections::HashMap<String, egui::TextureHandle>,
    pub developer_mode: bool,
    pub developer_mode_loaded: bool,
    pub screenshot_texture: Option<(String, egui::TextureHandle)>,
}

fn catalog_icon_texture(ui: &egui::Ui, id: &str, encoded: &str) -> Option<egui::TextureHandle> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let dimensions = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format().ok()?.into_dimensions().ok()?;
    let (width, height) = dimensions;
    if width > 256 || height > 256 || u64::from(width) * u64::from(height) > 65_536 { return None; }
    let rgba = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let color = egui::ColorImage::from_rgba_unmultiplied([width as usize, height as usize], rgba.as_raw());
    Some(ui.ctx().load_texture(format!("plugin-icon:{id}"), color, egui::TextureOptions::LINEAR))
}

fn is_manage_method(method: &str) -> bool {
    method.starts_with("plugin-center.package.install")
        || method.starts_with("plugin-center.package.rollback")
        || method.starts_with("plugin-center.developer.installLocal")
        || method.starts_with("plugin-center.developer.reload")
        || method.starts_with("plugin-center.plugin.enable")
        || method.starts_with("plugin-center.plugin.disable")
        || method.starts_with("plugin-center.plugin.uninstall")
        || method.starts_with("plugins.enable")
        || method.starts_with("plugins.disable")
        || method.starts_with("plugins.tool")
        || method.starts_with("mcp.enable")
        || method.starts_with("mcp.disable")
        || method.starts_with("mcp.start")
        || method.starts_with("mcp.stop")
        || method.starts_with("mcp.restart")
}

impl IntegrationsUi {
    /// 首次进入或数据被管理动作标记为脏后，按顺序补拉目录（Area 互斥保证一次一个）。
    pub fn next_load(&self) -> Option<IntegrationsAction> {
        if self.tab == IntegrationsTab::Marketplace && !self.developer_mode_loaded {
            return Some(IntegrationsAction::new("plugin-center.configure", json!({})));
        }
        if self.tab == IntegrationsTab::Marketplace && !self.catalog_loaded {
            return Some(IntegrationsAction::new("plugin-center.catalog.list", json!({ "view": "all" })));
        }
        if !self.plugins_loaded {
            return Some(IntegrationsAction::new("plugins.list", json!({})));
        }
        if !self.tools_loaded {
            return Some(IntegrationsAction::new("tools.list", json!({})));
        }
        if !self.mcp_loaded {
            return Some(IntegrationsAction::new("mcp.list", json!({})));
        }
        None
    }

    /// 接收一次 IPC 回包（成功或失败都算完成）。pending 回包绝不自动批准。
    pub fn observe(&mut self, method: &str, result: &Result<Value, String>) {
        match (method, result) {
            ("plugin-center.catalog.list", Ok(value)) => {
                self.catalog_icons.clear();
                self.icon_textures.clear();
                self.catalog = value.get("plugins").and_then(Value::as_array).cloned().unwrap_or_default();
                self.catalog_available = value.get("available").and_then(Value::as_bool).unwrap_or(false);
                self.catalog_configured = value.get("configured").and_then(Value::as_bool).unwrap_or(false);
                self.catalog_offline = value.get("offline").and_then(Value::as_bool).unwrap_or(false);
                self.catalog_loaded = true;
            }
            ("plugin-center.configure", Ok(value)) => {
                self.developer_mode = value.get("developerMode").and_then(Value::as_bool).unwrap_or(false);
                self.developer_mode_loaded = true;
            }
            ("plugin-center.catalog.refresh", Ok(_)) => {
                self.catalog_icons.clear();
                self.icon_textures.clear();
                self.catalog_loaded = false;
            }
            ("plugin-center.package.stage" | "plugin-center.developer.stageLocal", Ok(value)) => {
                self.catalog_stage = Some(value.clone());
                self.catalog_screenshot = None;
                self.screenshot_texture = None;
            }
            ("plugin-center.plugin.enable.review" | "plugin-center.package.rollback.review", Ok(value)) => {
                self.catalog_stage = Some(value.clone());
                self.catalog_screenshot = None;
                self.screenshot_texture = None;
            }
            ("plugin-center.screenshot.get", Ok(value)) => {
                self.catalog_screenshot = Some(value.clone());
                self.screenshot_texture = None;
            }
            ("plugin-center.icon.get", Ok(value)) => {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    self.catalog_icons.insert(id.to_owned(), value.clone());
                }
            }
            ("plugin-center.plugin.logs", Ok(value)) => {
                let lines = value.get("logs").and_then(Value::as_array)
                    .map(|logs| logs.iter().map(|line| line.get("message").and_then(Value::as_str).unwrap_or("")).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" · "))
                    .unwrap_or_default();
                self.notice = Some(if lines.is_empty() { "插件日志已读取（没有新日志）".to_owned() } else { format!("插件日志：{lines}") });
            }
            ("plugin-center.catalog.list", Err(_)) => self.catalog_loaded = true,
            ("plugin-center.configure", Err(_)) => self.developer_mode_loaded = true,
            ("plugins.list", Ok(value)) => {
                self.plugins = parse_plugins(value);
                self.plugins_loaded = true;
            }
            ("plugins.list", Err(_)) => self.plugins_loaded = true,
            ("tools.list", Ok(value)) => {
                self.tools = parse_tools(value);
                self.tools_loaded = true;
            }
            ("tools.list", Err(_)) => self.tools_loaded = true,
            ("mcp.list", Ok(value)) => {
                self.mcps = parse_mcp_servers(value);
                self.mcp_loaded = true;
            }
            ("mcp.list", Err(_)) => self.mcp_loaded = true,
            ("plugins.overview", Ok(value)) => self.overview = Some(value.clone()),
            ("plugins.overview", Err(_)) => {}
            ("plugins.get", Ok(value)) => {
                self.plugin_detail = Some(value.clone());
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    self.selected_plugin = Some(id.to_owned());
                }
            }
            ("plugins.get", Err(error)) => {
                self.selected_plugin = None;
                self.notice = Some(format!("打开插件详情失败：{error}"));
            }
            ("mcp.get", Ok(value)) => {
                self.mcp_detail = Some(value.clone());
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    self.selected_mcp = Some(id.to_owned());
                }
            }
            ("mcp.get", Err(error)) => {
                self.selected_mcp = None;
                self.notice = Some(format!("打开 MCP 服务器详情失败：{error}"));
            }
            ("mcp.tools", Ok(value)) => {
                let names = value
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| match entry {
                                Value::String(name) => Some(name.clone()),
                                other => other
                                    .get("name")
                                    .or_else(|| other.get("id"))
                                    .and_then(Value::as_str)
                                    .map(ToOwned::to_owned),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.mcp_tools = Some(names);
            }
            ("mcp.tools", Err(error)) => {
                self.notice = Some(format!("读取 MCP 工具失败：{error}"));
                self.mcp_tools = Some(Vec::new());
            }
            // Capability Broker 未放行：绝不自动批准，指路审批队列。
            (_, Ok(value)) if value.get("status").and_then(Value::as_str) == Some("pending") => {
                self.notice = Some("该操作需要 Owner 审批：请到 设置 → 高级 → 审批与问题 处理。".to_owned());
            }
            // 管理动作成功：标记目录为脏，下一帧重新拉取。
            (_, Ok(_)) if is_manage_method(method) => {
                self.catalog_loaded = false;
                self.catalog_stage = None;
                self.catalog_screenshot = None;
                self.screenshot_texture = None;
                self.plugins_loaded = false;
                self.tools_loaded = false;
                self.mcp_loaded = false;
                self.plugin_detail = None;
                self.mcp_detail = None;
                self.mcp_tools = None;
                self.mcp_tools_requested = false;
                self.notice = Some("操作已生效，目录已刷新。".to_owned());
            }
            (_, Ok(_)) => {}
            (_, Err(error)) => self.notice = Some(error.clone()),
        }
    }

    pub fn request_plugin_detail(&mut self, id: &str) -> IntegrationsAction {
        self.selected_plugin = Some(id.to_owned());
        self.plugin_detail = None;
        IntegrationsAction::new("plugins.get", json!({ "id": id }))
    }

    pub fn request_mcp_detail(&mut self, id: &str) -> IntegrationsAction {
        self.selected_mcp = Some(id.to_owned());
        self.mcp_detail = None;
        self.mcp_tools = None;
        self.mcp_tools_requested = false;
        IntegrationsAction::new("mcp.get", json!({ "id": id }))
    }

    pub fn request_mcp_tools(&mut self, id: &str) -> IntegrationsAction {
        self.mcp_tools_requested = true;
        IntegrationsAction::new("mcp.tools", json!({ "id": id }))
    }

    fn set_plugin_enabled(&mut self, id: &str, enabled: bool) -> IntegrationsAction {
        let method = if enabled { "plugins.enable" } else { "plugins.disable" };
        IntegrationsAction::new(method, json!({ "id": id, "approved": true }))
    }

    fn set_tool_enabled(&mut self, tool: &IntegrationTool, enabled: bool) -> Option<IntegrationsAction> {
        if tool.plugin_id.is_empty() {
            return None;
        }
        Some(IntegrationsAction::new(
            "plugins.tool.toggle",
            json!({ "pluginId": tool.plugin_id, "toolId": tool.id, "enabled": enabled, "approved": true }),
        ))
    }

    /// 渲染插件 / 工具 / MCP 三个一级 tab（扩展包 tab 由 native_ui 承载）。
    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        let palette = crate::native_ui::native_palette();
        ui.heading("插件");
        ui.label(
            egui::RichText::new("扩展 CetaMesh 的工具与连接；点开一个插件或 MCP 服务器管理它的工具。")
                .color(palette.muted),
        );
        ui.add_space(8.0);

        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.tab, IntegrationsTab::Marketplace, "插件中心");
            ui.selectable_value(&mut self.tab, IntegrationsTab::Plugins, "插件");
            ui.selectable_value(&mut self.tab, IntegrationsTab::Tools, "工具");
            ui.selectable_value(&mut self.tab, IntegrationsTab::Mcp, "MCP");
        });
        ui.add_space(6.0);
        if let Some(notice) = &self.notice {
            ui.label(egui::RichText::new(notice.clone()).small().color(palette.warning));
            ui.add_space(4.0);
        }

        match self.tab {
            IntegrationsTab::Marketplace => actions.extend(self.show_marketplace_tab(ui)),
            IntegrationsTab::Plugins => actions.extend(self.show_plugins_tab(ui)),
            IntegrationsTab::Tools => actions.extend(self.show_tools_tab(ui)),
            IntegrationsTab::Mcp => actions.extend(self.show_mcp_tab(ui)),
            // 扩展包 tab 由 native_ui 渲染（原 ext 审查流程），模块只占位。
            IntegrationsTab::Extensions => {}
        }
        actions
    }

    fn catalog_action(&mut self) -> IntegrationsAction {
        self.catalog_loaded = false;
        IntegrationsAction::new("plugin-center.catalog.list", json!({
            "view": if self.catalog_view.is_empty() { "all" } else { self.catalog_view.as_str() },
            "category": self.catalog_category,
            "query": self.catalog_query
        }))
    }

    fn show_marketplace_tab(&mut self, ui: &mut egui::Ui) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        let palette = crate::native_ui::native_palette();
        if let Some(stage) = self.catalog_stage.clone() {
            let review = stage.get("review").unwrap_or(&Value::Null);
            let manifest = review.get("manifest").unwrap_or(&Value::Null);
            let id = stage.get("id").and_then(Value::as_str)
                .or_else(|| manifest.get("id").and_then(Value::as_str)).unwrap_or("");
            let action = stage.get("action").and_then(Value::as_str).unwrap_or("install");
            ui.horizontal(|ui| {
                if ui.small_button("← 返回插件目录").clicked() {
                    self.catalog_stage = None;
                }
                ui.heading(manifest.get("name").and_then(Value::as_str).unwrap_or("权限审核"));
            });
            ui.label(egui::RichText::new("插件安装后保持禁用。请检查 Extension Runtime 扫描结果与申请的权限。")
                .small().color(palette.muted));
            let permissions = review.get("review").and_then(|value| value.get("permissions")).and_then(Value::as_array);
            if let Some(items) = permissions {
                if items.is_empty() { ui.weak("此插件未申请额外权限。"); }
                for permission in items {
                    ui.label(format!("• {}  | 风险 {} | {}",
                        permission.get("name").and_then(Value::as_str).unwrap_or("?"),
                        permission.get("risk").and_then(Value::as_str).unwrap_or("未知"),
                        permission.get("summary").and_then(Value::as_str).unwrap_or("")));
                }
            }
            if let Some(delta) = review.get("permissionDelta") {
                if let Some(added) = delta.get("added").and_then(Value::as_array) {
                    if !added.is_empty() {
                        ui.colored_label(palette.warning, format!("更新新增权限：{}", added.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("、")));
                    }
                }
            }
            let scan_ok = review.get("scan").and_then(|value| value.get("ok")).and_then(Value::as_bool).unwrap_or(false);
            ui.strong(match action {
                "enable-review" => "Owner Review: inspect these permissions before enabling this local plugin.",
                "rollback-review" => "Owner Review: inspect the retained version before rollback.",
                _ => "Review the requested permissions before installing. The plugin will remain disabled.",
            });
            ui.label(if scan_ok { "静态扫描通过" } else { "静态扫描未通过，安装会被 Extension Runtime 拒绝" });
            ui.horizontal(|ui| {
                if ui.button("取消").clicked() { self.catalog_stage = None; }
                if ui.add_enabled(scan_ok && !id.is_empty(), egui::Button::new("确认审核并安装（保持禁用）")).clicked() {
                    let stage_id = stage.get("stageId").and_then(Value::as_str).unwrap_or("");
                    let request = match action {
                        "enable-review" => IntegrationsAction::new("plugin-center.plugin.enable", json!({
                            "id": id,
                            "stageId": stage_id,
                            "reviewed": true,
                            "reviewToken": review.pointer("/review/token").and_then(Value::as_str).unwrap_or("")
                        })),
                        "rollback-review" => IntegrationsAction::new("plugin-center.package.rollback", json!({ "id": id, "reviewed": true })),
                        _ => {
                            let method = if stage.get("trust").and_then(|value| value.get("level")).and_then(Value::as_str) == Some("local-unverified") {
                                "plugin-center.developer.installLocal"
                            } else { "plugin-center.package.install" };
                            IntegrationsAction::new(method, json!({ "stageId": stage_id, "reviewed": true }))
                        }
                    };
                    actions.push(request);
                }
            });
            return actions;
        }

        ui.horizontal(|ui| {
            ui.label("搜索");
            let changed = ui.text_edit_singleline(&mut self.catalog_query).changed();
            if changed { self.catalog_last_query = self.catalog_query.clone(); }
            if ui.button("刷新目录").clicked() {
                self.catalog_loaded = false;
                actions.push(IntegrationsAction::new("plugin-center.catalog.refresh", json!({})));
            } else if changed {
                actions.push(self.catalog_action());
            }
        });
        ui.horizontal_wrapped(|ui| {
            for (view, label) in [("recommended", "推荐"), ("all", "全部"), ("installed", "已安装"), ("update-available", "可更新")] {
                let selected = if self.catalog_view.is_empty() { view == "all" } else { self.catalog_view == view };
                if ui.selectable_label(selected, label).clicked() && !selected {
                    self.catalog_view = view.to_owned();
                    actions.push(self.catalog_action());
                }
            }
            let mut category_changed = false;
            egui::ComboBox::from_id_salt("plugin-center-category")
                .selected_text(if self.catalog_category.is_empty() { "全部分类" } else { self.catalog_category.as_str() })
                .show_ui(ui, |ui| {
                    for category in ["", "Tools", "Integrations", "Agent", "Channel", "Workflow", "Memory Pack", "Other"] {
                        let label = if category.is_empty() { "全部分类" } else { category };
                        if ui.selectable_value(&mut self.catalog_category, category.to_owned(), label).changed() {
                            category_changed = true;
                        }
                    }
                });
            if category_changed { actions.push(self.catalog_action()); }
        });
        if self.catalog_offline {
            ui.colored_label(palette.warning, "离线模式：当前显示上次成功获取的目录缓存，安装与更新需要联网。");
        } else if !self.catalog_configured {
            ui.weak("Plugin Service 尚未配置。目录与包下载接口已预留，配置服务地址后即可加载。");
        }
        if !self.catalog_available && self.catalog_view != "installed" && ui.button("View Installed Local Plugins").clicked() {
            self.catalog_view = "installed".to_owned();
            actions.push(self.catalog_action());
        }
        if !self.catalog_available && self.catalog_view != "installed" {
            self.show_developer_mode_controls(ui, &mut actions);
        }
        if !self.catalog_loaded {
            ui.weak("正在读取 Plugin Catalog…");
            return actions;
        }
        if !self.catalog_available {
            ui.weak("目录暂不可用；CetaMesh 仍可使用本地已安装插件。");
            return actions;
        }
        let rows = self.catalog.clone();
        for plugin in rows {
            let id = plugin.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
            let status = plugin.get("status").and_then(Value::as_str).unwrap_or("Available");
            crate::theme::card_compact(ui, |ui| {
                ui.horizontal(|ui| {
                    if plugin.get("icon").and_then(Value::as_str).is_some() {
                        if let Some(image_data) = self.catalog_icons.get(&id) {
                            if !self.icon_textures.contains_key(&id) {
                                if let Some(encoded) = image_data.get("data").and_then(Value::as_str) {
                                    if let Some(texture) = catalog_icon_texture(ui, &id, encoded) {
                                        self.icon_textures.insert(id.clone(), texture);
                                    }
                                }
                            }
                            if let Some(texture) = self.icon_textures.get(&id) {
                                ui.add(egui::Image::new(texture).fit_to_exact_size(egui::vec2(42.0, 42.0)));
                            }
                        } else {
                            actions.push(IntegrationsAction::new("plugin-center.icon.get", json!({ "id": id })));
                        }
                    }
                    ui.vertical(|ui| {
                        ui.strong(plugin.get("name").and_then(Value::as_str).unwrap_or(&id));
                        ui.small(format!("{} · v{} · {}", plugin.get("category").and_then(Value::as_str).unwrap_or("Other"),
                            plugin.get("version").and_then(Value::as_str).unwrap_or("?"),
                            plugin.get("publisher").and_then(Value::as_str).unwrap_or("未知开发者")));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(status);
                        if plugin.get("verified").and_then(Value::as_bool) == Some(true) { ui.small("目录标记 Verified"); }
                    });
                });
                ui.label(egui::RichText::new(plugin.get("summary").and_then(Value::as_str).unwrap_or("")).small().color(palette.muted));
                ui.horizontal(|ui| {
                    if ui.small_button("详情").clicked() {
                        if self.catalog_selected.as_deref() != Some(id.as_str()) {
                            self.catalog_screenshot = None;
                            self.screenshot_texture = None;
                        }
                        self.catalog_selected = Some(id.clone());
                    }
                    if status == "Available" || status == "Update Available" {
                        let label = if status == "Available" { "安装" } else { "更新" };
                        if ui.small_button(label).clicked() {
                            self.catalog_selected = Some(id.clone());
                            self.catalog_stage = None;
                            actions.push(IntegrationsAction::new("plugin-center.package.stage", json!({ "id": id })));
                        }
                    }
                });
            });
            ui.add_space(5.0);
        }
        if let Some(id) = self.catalog_selected.clone() {
            actions.extend(self.show_marketplace_detail(ui, &id));
        }
        ui.separator();
        ui.horizontal(|ui| {
            ui.checkbox(&mut self.developer_mode, "开发者模式");
            if ui.button("保存").clicked() && self.developer_mode_loaded {
                actions.push(IntegrationsAction::new("plugin-center.configure", json!({ "developerMode": self.developer_mode })));
            }
            if self.developer_mode {
                if ui.button("加载本地插件目录").clicked() {
                    if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                        actions.push(IntegrationsAction::new("plugin-center.developer.stageLocal", json!({ "directory": folder.to_string_lossy() })));
                    }
                }
            }
        });
        actions
    }

    fn show_developer_mode_controls(&mut self, ui: &mut egui::Ui, actions: &mut Vec<IntegrationsAction>) {
        ui.separator();
        ui.horizontal(|ui| {
            ui.checkbox(&mut self.developer_mode, "Developer Mode");
            if ui.button("Save").clicked() && self.developer_mode_loaded {
                actions.push(IntegrationsAction::new("plugin-center.configure", json!({ "developerMode": self.developer_mode })));
            }
            if self.developer_mode && ui.button("Load Local Plugin").clicked() {
                if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                    actions.push(IntegrationsAction::new("plugin-center.developer.stageLocal", json!({ "directory": folder.to_string_lossy() })));
                }
            }
        });
    }

    fn show_marketplace_detail(&mut self, ui: &mut egui::Ui, id: &str) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        let Some(plugin) = self.catalog.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(id)).cloned() else { return actions; };
        ui.separator();
        ui.horizontal(|ui| {
            if ui.small_button("收起详情").clicked() { self.catalog_selected = None; self.catalog_screenshot = None; self.screenshot_texture = None; }
            ui.heading(plugin.get("name").and_then(Value::as_str).unwrap_or(id));
            ui.label(format!("v{}", plugin.get("version").and_then(Value::as_str).unwrap_or("?")));
        });
        ui.label(plugin.get("description").and_then(Value::as_str).unwrap_or(""));
        ui.small(format!("开发者：{} · 分类：{} · 状态：{}", plugin.get("publisher").and_then(Value::as_str).unwrap_or("未知"),
            plugin.get("category").and_then(Value::as_str).unwrap_or("Other"), plugin.get("status").and_then(Value::as_str).unwrap_or("Available")));
        for label in ["permissions", "capabilities"] {
            let values = plugin.get(label).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("、")).unwrap_or_default();
            ui.small(format!("{}：{}", if label == "permissions" { "申请权限" } else { "能力" }, if values.is_empty() { "无".to_owned() } else { values }));
        }
        if let Some(shots) = plugin.get("screenshots").and_then(Value::as_array) {
            if !shots.is_empty() {
                if self.catalog_screenshot.is_none() {
                    actions.push(IntegrationsAction::new("plugin-center.screenshot.get", json!({ "id": id, "index": 0 })));
                }
            }
        }
        if let Some(image_data) = self.catalog_screenshot.clone() {
            if let Some(encoded) = image_data.get("data").and_then(Value::as_str) {
                let texture_key = format!("{id}:0");
                if self.screenshot_texture.as_ref().map(|(key, _)| key.as_str()) != Some(texture_key.as_str()) {
                    use base64::Engine as _;
                    let decoded = base64::engine::general_purpose::STANDARD.decode(encoded);
                    if let Ok(bytes) = decoded {
                        let dimensions = image::ImageReader::new(std::io::Cursor::new(&bytes))
                            .with_guessed_format()
                            .ok()
                            .and_then(|reader| reader.into_dimensions().ok());
                        if let Some((width, height)) = dimensions {
                            if width <= 4096 && height <= 4096 && u64::from(width) * u64::from(height) <= 16_777_216 {
                                if let Ok(decoded_image) = image::load_from_memory(&bytes) {
                                    let rgba = decoded_image.to_rgba8();
                                    let color = egui::ColorImage::from_rgba_unmultiplied([width as usize, height as usize], rgba.as_raw());
                                    let texture = ui.ctx().load_texture("plugin-catalog-screenshot", color, egui::TextureOptions::LINEAR);
                                    self.screenshot_texture = Some((texture_key, texture));
                                }
                            }
                        }
                    }
                }
                if let Some((_, texture)) = &self.screenshot_texture {
                    ui.add(egui::Image::new(texture).max_height(320.0));
                }
            }
        }
        if let Some(installed) = plugin.get("installedEntry") {
            let installed_status = installed.get("status").and_then(Value::as_str).unwrap_or("disabled");
            let local_unverified = plugin.get("trust").and_then(Value::as_str) == Some("local-unverified");
            let first_enable_reviewed = plugin.get("firstEnableReviewed").and_then(Value::as_bool).unwrap_or(false);
            ui.separator();
            ui.horizontal_wrapped(|ui| {
                if installed_status == "enabled" {
                    if ui.button("Disable").clicked() {
                        actions.push(IntegrationsAction::new("plugin-center.plugin.disable", json!({ "id": id })));
                    }
                } else if installed_status != "disabled_due_to_crash" {
                    let label = if local_unverified && !first_enable_reviewed { "Owner Review and Enable" } else { "Enable" };
                    if ui.button(label).clicked() {
                        let method = if local_unverified && !first_enable_reviewed {
                            "plugin-center.plugin.enable.review"
                        } else {
                            "plugin-center.plugin.enable"
                        };
                        actions.push(IntegrationsAction::new(method, json!({ "id": id })));
                    }
                }
                if installed.get("previousVersion").and_then(Value::as_str).is_some() {
                    if ui.button("Rollback").clicked() {
                        actions.push(IntegrationsAction::new("plugin-center.package.rollback.review", json!({ "id": id })));
                    }
                }
                if self.developer_mode {
                    if ui.button("Reload Plugin").clicked() {
                        actions.push(IntegrationsAction::new("plugin-center.developer.reload", json!({ "id": id })));
                    }
                    if ui.button("Open Plugin Logs").clicked() {
                        actions.push(IntegrationsAction::new("plugin-center.plugin.logs", json!({ "id": id })));
                    }
                }
                if self.pending_uninstall.as_deref() == Some(id) {
                    ui.label("Uninstall this plugin?");
                    if ui.button("Confirm Uninstall").clicked() {
                        actions.push(IntegrationsAction::new("plugin-center.plugin.uninstall", json!({ "id": id })));
                        self.pending_uninstall = None;
                    }
                    if ui.button("Cancel").clicked() { self.pending_uninstall = None; }
                } else if ui.button("Uninstall").clicked() {
                    self.pending_uninstall = Some(id.to_owned());
                }
            });
        }
        if let Some(warning) = plugin.get("warning").and_then(Value::as_str) { ui.colored_label(crate::native_ui::native_palette().warning, warning); }
        actions
    }

    fn show_plugins_tab(&mut self, ui: &mut egui::Ui) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        if let Some(id) = self.selected_plugin.clone() {
            actions.extend(self.show_plugin_detail(ui, &id));
            return actions;
        }
        if !self.plugins_loaded {
            ui.weak("正在读取插件目录…");
            return actions;
        }
        if self.plugins.is_empty() {
            ui.weak("还没有注册任何插件。");
            return actions;
        }
        let plugins = self.plugins.clone();
        ui.spacing_mut().item_spacing.y = 8.0;
        for plugin in &plugins {
            let name = plugin.name.clone();
            let kind = kind_label(&plugin.kind);
            let summary = plugin.summary.clone();
            let meta = format!("工具 {} · 启用 {}", plugin.tool_count, plugin.enabled_tool_count);
            let mut open = false;
            let mut toggle_to: Option<bool> = None;
            crate::theme::card_compact(ui, |ui| {
                let palette = crate::native_ui::native_palette();
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.strong(name);
                        ui.small(kind);
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        state_chip(ui, plugin.enabled);
                    });
                });
                if !summary.is_empty() {
                    ui.label(egui::RichText::new(summary).small().color(palette.muted));
                }
                ui.small(meta);
                ui.horizontal(|ui| {
                    if ui.small_button("打开详情").clicked() {
                        open = true;
                    }
                    let (toggle_label, next) = match plugin.enabled {
                        Some(true) => ("停用", Some(false)),
                        Some(false) => ("启用", Some(true)),
                        None => ("状态未知", None),
                    };
                    if toggle_to.is_none() && ui.small_button(toggle_label).clicked() {
                        toggle_to = next;
                    }
                });
            });
            if let Some(next) = toggle_to {
                actions.push(self.set_plugin_enabled(&plugin.id, next));
            }
            if open {
                actions.push(self.request_plugin_detail(&plugin.id));
            }
        }
        actions
    }

    fn show_plugin_detail(&mut self, ui: &mut egui::Ui, id: &str) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        let Some(detail) = self.plugin_detail.clone() else {
            ui.weak("正在打开插件详情…");
            return actions;
        };
        if detail.get("id").and_then(Value::as_str) != Some(id) {
            ui.weak("正在打开插件详情…");
            return actions;
        }
        let palette = crate::native_ui::native_palette();
        if ui.small_button("← 返回插件列表").clicked() {
            self.selected_plugin = None;
            self.plugin_detail = None;
            return actions;
        }
        ui.add_space(4.0);
        let name = detail.get("name").and_then(Value::as_str).unwrap_or(id);
        let kind = detail.get("kind").and_then(Value::as_str).unwrap_or("");
        ui.horizontal(|ui| {
            ui.heading(name);
            ui.small(kind_label(kind));
        });
        if let Some(summary) = detail.get("summary").and_then(Value::as_str) {
            ui.label(egui::RichText::new(summary).color(palette.muted));
        }
        ui.add_space(6.0);
        let enabled = detail.get("enabled").and_then(Value::as_bool);
        if let Some(enabled) = enabled {
            let (label, next) = if enabled { ("停用插件", false) } else { ("启用插件", true) };
            if ui.button(label).clicked() {
                actions.push(self.set_plugin_enabled(id, next));
            }
        }
        if detail.get("toggleableTools").and_then(Value::as_bool) == Some(true) {
            if ui.button("全部启用工具").clicked() {
                actions.push(IntegrationsAction::new(
                    "plugins.tool.toggleAll",
                    json!({ "pluginId": id, "enabled": true, "approved": true }),
                ));
            }
            if ui.button("全部停用工具").clicked() {
                actions.push(IntegrationsAction::new(
                    "plugins.tool.toggleAll",
                    json!({ "pluginId": id, "enabled": false, "approved": true }),
                ));
            }
        }
        ui.add_space(8.0);

        let tools = detail
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if tools.is_empty() {
            ui.weak("这个插件没有可单独开关的工具。");
            return actions;
        }
        ui.strong(format!("工具（{}）", tools.len()));
        for tool in &tools {
            let tool_view = parse_tool(tool);
            let title = if tool_view.label.is_empty() { tool_view.id.clone() } else { tool_view.label.clone() };
            let description = tool_view.description.clone();
            let available_text = match tool_view.available {
                Some(true) => "是",
                Some(false) => "否",
                None => "未知",
            };
            let risk_text = risk_label(&tool_view.risk);
            let known = tool_view.enabled.is_some();
            let mut toggle_to: Option<bool> = None;
            crate::theme::card_compact(ui, |ui| {
                let palette = crate::native_ui::native_palette();
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.strong(title);
                        if !description.is_empty() {
                            ui.label(egui::RichText::new(description).small().color(palette.muted));
                        }
                        ui.small(format!("权限 {risk_text} · 可用 {available_text}"));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if known {
                            if toggle_switch(ui, tool_view.enabled) {
                                toggle_to = Some(!tool_view.enabled.unwrap_or(false));
                            }
                        } else {
                            ui.label(egui::RichText::new("状态未知").small().color(palette.muted));
                        }
                    });
                });
            });
            if let Some(next) = toggle_to {
                if let Some(action) = self.set_tool_enabled(&tool_view, next) {
                    actions.push(action);
                }
            }
        }
        actions
    }

    fn show_tools_tab(&mut self, ui: &mut egui::Ui) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        if !self.tools_loaded {
            ui.weak("正在读取工具目录…");
            return actions;
        }
        if self.tools.is_empty() {
            ui.weak("工具目录为空。");
            return actions;
        }
        ui.label(
            egui::RichText::new(format!("共 {} 个工具；带插件来源的工具可以在这里直接开关。", self.tools.len())).small(),
        );
        ui.add_space(6.0);
        let tools = self.tools.clone();
        for tool in &tools {
            let title = if tool.label.is_empty() { tool.id.clone() } else { tool.label.clone() };
            let description = tool.description.clone();
            let meta = format!("{} · 权限 {}", source_label(tool), risk_label(&tool.risk));
            let known = tool.enabled.is_some() && !tool.plugin_id.is_empty();
            let unknown_state = tool.enabled.is_none();
            let mut toggle_to: Option<bool> = None;
            crate::theme::card_compact(ui, |ui| {
                let palette = crate::native_ui::native_palette();
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.strong(title);
                        if !description.is_empty() {
                            ui.label(egui::RichText::new(description).small().color(palette.muted));
                        }
                        ui.small(meta);
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if known {
                            if toggle_switch(ui, tool.enabled) {
                                toggle_to = Some(!tool.enabled.unwrap_or(false));
                            }
                        } else {
                            ui.label(
                                egui::RichText::new(if unknown_state { "状态未知" } else { "由 MCP 管理" })
                                    .small()
                                    .color(palette.muted),
                            );
                        }
                    });
                });
            });
            if let Some(next) = toggle_to {
                if let Some(action) = self.set_tool_enabled(tool, next) {
                    actions.push(action);
                }
            }
        }
        actions
    }

    fn show_mcp_tab(&mut self, ui: &mut egui::Ui) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        if let Some(id) = self.selected_mcp.clone() {
            actions.extend(self.show_mcp_detail(ui, &id));
            return actions;
        }
        if !self.mcp_loaded {
            ui.weak("正在读取 MCP 服务器目录…");
            return actions;
        }
        if self.mcps.is_empty() {
            ui.weak("还没有注册 MCP 服务器。");
            return actions;
        }
        let servers = self.mcps.clone();
        for server in &servers {
            let title = if server.name.is_empty() { server.id.clone() } else { server.name.clone() };
            let meta = format!(
                "状态 {} · 工具 {}",
                if server.status.is_empty() { "未知" } else { server.status.as_str() },
                server.tool_count
            );
            let last_error = server.last_error.clone();
            let mut open = false;
            let mut toggle_to: Option<bool> = None;
            crate::theme::card_compact(ui, |ui| {
                let palette = crate::native_ui::native_palette();
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.strong(title);
                        ui.small(meta);
                        if !last_error.is_empty() {
                            ui.label(egui::RichText::new(last_error).small().color(palette.error));
                        }
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.small_button("详情").clicked() {
                            open = true;
                        }
                        if server.enabled.is_some() {
                            if toggle_switch(ui, server.enabled) {
                                toggle_to = Some(!server.enabled.unwrap_or(false));
                            }
                        }
                    });
                });
            });
            if let Some(next) = toggle_to {
                let method = if next { "mcp.enable" } else { "mcp.disable" };
                actions.push(IntegrationsAction::new(method, json!({ "id": server.id, "approved": true })));
            }
            if open {
                actions.push(self.request_mcp_detail(&server.id));
            }
        }
        actions
    }

    fn show_mcp_detail(&mut self, ui: &mut egui::Ui, id: &str) -> Vec<IntegrationsAction> {
        let mut actions = Vec::new();
        let Some(detail) = self.mcp_detail.clone() else {
            ui.weak("正在打开 MCP 服务器详情…");
            return actions;
        };
        if detail.get("id").and_then(Value::as_str) != Some(id) {
            ui.weak("正在打开 MCP 服务器详情…");
            return actions;
        }
        let palette = crate::native_ui::native_palette();
        if ui.small_button("← 返回 MCP 列表").clicked() {
            self.selected_mcp = None;
            self.mcp_detail = None;
            self.mcp_tools = None;
            self.mcp_tools_requested = false;
            return actions;
        }
        ui.add_space(4.0);
        ui.heading(detail.get("name").and_then(Value::as_str).unwrap_or(id));
        let status = detail.get("status").and_then(Value::as_str).unwrap_or("unknown");
        ui.label(egui::RichText::new(format!("运行状态：{status}")).color(match status {
            "running" => palette.success,
            "crashed" | "failed" => palette.error,
            _ => palette.muted,
        }));
        if let Some(error) = detail.get("lastError").and_then(Value::as_str) {
            ui.label(egui::RichText::new(error).small().color(palette.error));
        }
        ui.add_space(6.0);
        let enabled = detail.get("enabled").and_then(Value::as_bool);
        if let Some(enabled) = enabled {
            let (label, method) = if enabled { ("停用", "mcp.disable") } else { ("启用", "mcp.enable") };
            if ui.button(label).clicked() {
                actions.push(IntegrationsAction::new(method, json!({ "id": id, "approved": true })));
            }
        }
        if status == "running" {
            if ui.button("重启").clicked() {
                actions.push(IntegrationsAction::new("mcp.restart", json!({ "id": id, "approved": true })));
            }
            if ui.button("停止").clicked() {
                actions.push(IntegrationsAction::new("mcp.stop", json!({ "id": id, "approved": true })));
            }
        } else if enabled == Some(true) && ui.button("启动").clicked() {
            actions.push(IntegrationsAction::new("mcp.start", json!({ "id": id, "approved": true })));
        }
        if self.mcp_tools.is_none() && !self.mcp_tools_requested {
            actions.push(self.request_mcp_tools(id));
        }
        ui.add_space(8.0);
        match &self.mcp_tools {
            Some(tools) => {
                ui.strong(format!("已发现工具（{}）", tools.len()));
                if tools.is_empty() {
                    ui.weak("该服务器没有报告任何工具。");
                }
                egui::Grid::new("mcp_tool_grid").num_columns(2).striped(true).show(ui, |ui| {
                    for name in tools {
                        ui.monospace(name.clone());
                        ui.label("由 MCP 运行时发现");
                        ui.end_row();
                    }
                });
            }
            None => {
                ui.weak("正在发现工具…");
            }
        }
        actions
    }
}

// -- 渲染小件 ----------------------------------------------------------------

fn toggle_switch(ui: &mut egui::Ui, enabled: Option<bool>) -> bool {
    let mut on = enabled.unwrap_or(false);
    ui.add(egui::Checkbox::without_text(&mut on)).clicked()
}

fn state_chip(ui: &mut egui::Ui, enabled: Option<bool>) {
    let palette = crate::native_ui::native_palette();
    let (label, color) = match enabled {
        Some(true) => ("已启用", palette.success),
        Some(false) => ("已关闭", palette.muted),
        None => ("状态未知", palette.warning),
    };
    ui.label(egui::RichText::new(label).small().color(color));
}

fn kind_label(kind: &str) -> String {
    match kind {
        "tool-pack" => "工具集".to_owned(),
        "channel-integration" => "频道集成".to_owned(),
        "agent-integration" => "Agent 集成".to_owned(),
        "mcp-server" => "MCP 服务器".to_owned(),
        "extension" => "扩展包".to_owned(),
        "" => "未知类型".to_owned(),
        other => other.to_owned(),
    }
}

fn risk_label(risk: &str) -> String {
    match risk {
        "low" => "低".to_owned(),
        "medium" => "中".to_owned(),
        "high" => "高".to_owned(),
        "" => "未知".to_owned(),
        other => other.to_owned(),
    }
}

fn source_label(tool: &IntegrationTool) -> String {
    if !tool.plugin_id.is_empty() {
        format!("插件 {}", tool.plugin_id)
    } else if !tool.server_id.is_empty() {
        format!("MCP {}", tool.server_id)
    } else {
        "来源未知".to_owned()
    }
}

// -- 解析 --------------------------------------------------------------------

fn parse_plugins(value: &Value) -> Vec<IntegrationPlugin> {
    value
        .get("plugins")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().map(parse_plugin).collect())
        .unwrap_or_default()
}

fn parse_plugin(item: &Value) -> IntegrationPlugin {
    IntegrationPlugin {
        id: string_field(item, "id"),
        name: item.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
        kind: item.get("kind").and_then(Value::as_str).unwrap_or("").to_owned(),
        version: item.get("version").and_then(Value::as_str).unwrap_or("").to_owned(),
        summary: item.get("summary").and_then(Value::as_str).unwrap_or("").to_owned(),
        enabled: item.get("enabled").and_then(Value::as_bool),
        tool_count: item.get("toolCount").and_then(Value::as_u64).unwrap_or(0),
        enabled_tool_count: item.get("enabledToolCount").and_then(Value::as_u64).unwrap_or(0),
        toggleable_tools: item.get("toggleableTools").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn parse_tools(value: &Value) -> Vec<IntegrationTool> {
    value
        .get("tools")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().map(parse_tool).collect())
        .unwrap_or_default()
}

fn parse_tool(item: &Value) -> IntegrationTool {
    IntegrationTool {
        id: string_field(item, "id"),
        label: item
            .get("label")
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        description: item.get("description").and_then(Value::as_str).unwrap_or("").to_owned(),
        plugin_id: item.get("pluginId").and_then(Value::as_str).unwrap_or("").to_owned(),
        server_id: item.get("serverId").and_then(Value::as_str).unwrap_or("").to_owned(),
        group: item.get("group").and_then(Value::as_str).unwrap_or("").to_owned(),
        enabled: item.get("enabled").and_then(Value::as_bool),
        available: item.get("available").and_then(Value::as_bool),
        risk: item.get("risk").and_then(Value::as_str).unwrap_or("").to_owned(),
        restore: item.get("restore").and_then(Value::as_str).unwrap_or("").to_owned(),
    }
}

fn parse_mcp_servers(value: &Value) -> Vec<McpServer> {
    value
        .get("servers")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|item| McpServer {
                    id: string_field(item, "id"),
                    name: item
                        .get("name")
                        .or_else(|| item.get("label"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    status: item.get("status").and_then(Value::as_str).unwrap_or("").to_owned(),
                    enabled: item.get("enabled").and_then(Value::as_bool),
                    tool_count: item.get("toolCount").and_then(Value::as_u64).unwrap_or(0),
                    last_error: item.get("lastError").and_then(Value::as_str).unwrap_or("").to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn string_field(item: &Value, field: &str) -> String {
    item.get(field).and_then(Value::as_str).unwrap_or_default().to_owned()
}

#[cfg(test)]
mod tests {
    use super::{parse_mcp_servers, parse_plugins, parse_tools, IntegrationsTab, IntegrationsUi};
    use serde_json::json;

    #[test]
    fn parses_plugins_tools_and_servers() {
        let plugins = parse_plugins(&json!({
            "plugins": [
                {"id": "cetamesh-bionic-chat", "name": "Bionic Chat Tools", "kind": "tool-pack", "version": "1.0",
                 "summary": "日程、提醒", "enabled": true, "toolCount": 7, "enabledToolCount": 7, "toggleableTools": true}
            ]
        }));
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].name, "Bionic Chat Tools");
        assert_eq!(plugins[0].enabled_tool_count, 7);
        assert!(plugins[0].toggleable_tools);

        let tools = parse_tools(&json!({
            "tools": [
                {"id": "bionic.schedule.create", "label": "创建日程", "description": "新建日程", "pluginId": "cetamesh-bionic-chat",
                 "enabled": true, "available": true, "risk": "low"},
                {"id": "mcp__snowluma__qq_send_group_message", "serverId": "snowluma", "enabled": true, "risk": "medium"}
            ]
        }));
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].plugin_id, "cetamesh-bionic-chat");
        assert!(tools[1].plugin_id.is_empty());
        assert_eq!(tools[1].server_id, "snowluma");

        let servers = parse_mcp_servers(&json!({
            "servers": [
                {"id": "snowluma", "name": "SnowLuma", "status": "running", "enabled": true, "toolCount": 39},
                {"id": "bilibili", "status": "stopped", "enabled": false, "lastError": "连接被拒"}
            ]
        }));
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].status, "running");
        assert_eq!(servers[1].last_error, "连接被拒");
    }

    #[test]
    fn marketplace_loads_configuration_then_catalog_and_survives_unconfigured_service() {
        let mut state = IntegrationsUi::default();
        assert_eq!(state.tab, IntegrationsTab::Marketplace);
        assert_eq!(state.next_load().unwrap().method, "plugin-center.configure");
        state.observe("plugin-center.configure", &Ok(json!({ "developerMode": false })));
        assert_eq!(state.next_load().unwrap().method, "plugin-center.catalog.list");
        state.observe("plugin-center.catalog.list", &Ok(json!({
            "available": false, "configured": false, "offline": false, "plugins": []
        })));
        assert!(!state.catalog_available);
        assert!(state.catalog_loaded);
    }

    #[test]
    fn loads_directories_in_order_and_reloads_after_manage() {
        let mut state = IntegrationsUi::default();
        state.tab = IntegrationsTab::Plugins;
        assert_eq!(state.next_load().unwrap().method, "plugins.list");
        state.observe("plugins.list", &Ok(json!({"plugins": []})));
        assert_eq!(state.next_load().unwrap().method, "tools.list");
        state.observe("tools.list", &Ok(json!({"tools": []})));
        assert_eq!(state.next_load().unwrap().method, "mcp.list");
        state.observe("mcp.list", &Ok(json!({"servers": []})));
        assert!(state.next_load().is_none());

        state.observe("plugins.enable", &Ok(json!({"id": "x"})));
        assert_eq!(state.next_load().unwrap().method, "plugins.list");
        assert!(state.notice.as_deref().unwrap().contains("刷新"));
    }

    #[test]
    fn pending_approval_is_never_auto_approved() {
        let mut state = IntegrationsUi::default();
        state.observe("mcp.enable", &Ok(json!({"status": "pending", "approvalId": "cap-1"})));
        assert!(state.notice.as_deref().unwrap().contains("审批"));
        // pending 不触发目录重载。
        assert!(!state.mcp_loaded);
    }

    #[test]
    fn errors_surface_as_notice_and_complete_the_load() {
        let mut state = IntegrationsUi::default();
        state.tab = IntegrationsTab::Plugins;
        state.observe("plugins.list", &Err("传输失败".to_owned()));
        assert!(state.plugins_loaded);
        assert_eq!(state.next_load().unwrap().method, "tools.list");
        state.observe("mcp.tools", &Err("发现失败".to_owned()));
        assert!(state.mcp_tools.is_some());
        assert!(state.notice.as_deref().unwrap().contains("发现失败"));
    }
}
