//! UI v1 智能体页：DSH / Codex / ZCode 的真实注册状态卡。
//!
//! 数据来自 `agent.list`（Agent Broker 的 provider 目录：available / health /
//! version / capabilities / workspaceBoundary）。本模块只做解析与渲染，
//! 不伪造任何状态：Core 没给的字段就显示"未知"，不猜测。

use eframe::egui;
use serde_json::{json, Value};

/// 一个 Agent Provider 的展示卡数据。
#[derive(Clone, Debug, PartialEq)]
pub struct AgentProvider {
    pub id: String,
    pub display_name: String,
    pub available: Option<bool>,
    pub health: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub boundary: String,
    pub supports_resume: Option<bool>,
}

/// 智能体页的用户可见状态（方案 01 卡片上的四态）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentState {
    Ready,
    NeedsSetup,
    NotInstalled,
    Unavailable,
}

impl AgentState {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Ready => "就绪",
            Self::NeedsSetup => "需要设置",
            Self::NotInstalled => "未安装",
            Self::Unavailable => "暂不可用",
        }
    }
}

impl AgentProvider {
    /// 把 Core 的 available/health 归一成四态。未知值一律落到"暂不可用"并保留原文细节。
    pub fn state(&self) -> AgentState {
        let health = self.health.as_str();
        if health.contains("external-control") || health.contains("unsupported") {
            return AgentState::NotInstalled;
        }
        if health.contains("needs_auth") || health.contains("needs-setup") || health.contains("needs setup") {
            return AgentState::NeedsSetup;
        }
        if health.contains("ready") && self.available != Some(false) {
            return AgentState::Ready;
        }
        if self.available == Some(false) || health.contains("unavailable") {
            return AgentState::Unavailable;
        }
        AgentState::Unavailable
    }

    /// 就绪（或至少已安装）的 provider 才允许被设为对话 Agent。
    pub fn usable_in_chat(&self) -> bool {
        matches!(self.state(), AgentState::Ready | AgentState::NeedsSetup)
    }
}

#[derive(Clone, Debug)]
pub struct AgentAction {
    pub method: &'static str,
    pub params: Value,
}

#[derive(Clone, Debug, Default)]
pub struct AgentUi {
    pub loaded: bool,
    pub providers: Vec<AgentProvider>,
    pub expanded: Option<String>,
    pub error: Option<String>,
}

impl AgentUi {
    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    pub fn refresh_request(&self) -> AgentAction {
        AgentAction { method: "agent.list", params: json!({}) }
    }

    /// 渲染智能体页；返回需要发出的 IPC 动作。
    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<AgentAction> {
        let mut actions = Vec::new();
        let palette = crate::native_ui::native_palette();
        ui.heading("智能体");
        ui.label(
            egui::RichText::new("把要动手的事交给它们；这里显示的是 Agent Broker 的真实注册状态。")
                .color(palette.muted),
        );
        ui.add_space(10.0);

        ui.horizontal(|ui| {
            if ui.button("刷新状态").clicked() {
                actions.push(self.refresh_request());
            }
            if let Some(error) = &self.error {
                ui.label(egui::RichText::new(error.clone()).color(palette.error));
            }
        });
        ui.add_space(6.0);

        if !self.loaded {
            ui.weak("正在读取智能体目录…");
            return actions;
        }
        if self.providers.is_empty() {
            ui.weak("还没有注册任何 Agent Provider。");
            return actions;
        }

        for provider in self.providers.clone() {
            actions.extend(self.provider_card(ui, &provider));
            ui.add_space(8.0);
        }
        actions
    }

    fn provider_card(&mut self, ui: &mut egui::Ui, provider: &AgentProvider) -> Vec<AgentAction> {
        let mut actions = Vec::new();
        let palette = crate::native_ui::native_palette();
        let tokens = crate::theme::tokens();
        let state = provider.state();
        let (state_color, state_bg) = match state {
            AgentState::Ready => (palette.success, tokens.ok_bg.over(tokens.bg).to_color32()),
            AgentState::NeedsSetup => (palette.warning, tokens.warn_bg.over(tokens.bg).to_color32()),
            AgentState::NotInstalled | AgentState::Unavailable => (palette.muted, tokens.chip.over(tokens.bg).to_color32()),
        };
        let expanded = self.expanded.as_deref() == Some(provider.id.as_str());

        crate::theme::card(ui, |ui| {
            ui.horizontal(|ui| {
                // 头像块：首字母 + 主题 accent 底。
                let mark = egui::RichText::new(provider.display_name.chars().next().unwrap_or('?').to_string())
                    .strong()
                    .color(tokens.on_accent.to_color32());
                egui::Frame::new()
                    .fill(tokens.accent.to_color32())
                    .corner_radius(egui::CornerRadius::same(8))
                    .inner_margin(egui::Margin::symmetric(8, 5))
                    .show(ui, |ui| {
                        ui.label(mark);
                    });
                ui.vertical(|ui| {
                    ui.strong(provider.display_name.clone());
                    ui.small(format!("{} · {}", provider.id, if provider.version.is_empty() { "版本未知".to_owned() } else { format!("v{}", provider.version) }));
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    egui::Frame::new()
                        .fill(state_bg)
                        .corner_radius(egui::CornerRadius::same(6))
                        .inner_margin(egui::Margin::symmetric(8, 3))
                        .show(ui, |ui| {
                            ui.label(egui::RichText::new(state.label()).small().color(state_color));
                        });
                });
            });
            ui.add_space(6.0);

            let summary = if provider.capabilities.is_empty() {
                "能力清单未知".to_owned()
            } else {
                provider.capabilities.join(" · ")
            };
            ui.label(egui::RichText::new(summary).color(palette.muted));
            ui.add_space(6.0);

            ui.horizontal(|ui| {
                let expand_label = if expanded { "收起详情" } else { "查看详情" };
                if ui.small_button(expand_label).clicked() {
                    if expanded {
                        self.expanded = None;
                    } else {
                        self.expanded = Some(provider.id.clone());
                    }
                }
                if provider.usable_in_chat() {
                    if ui.small_button("设为对话 Agent").clicked() {
                        actions.push(AgentAction {
                            method: "__use_in_chat",
                            params: json!({ "agentProvider": provider.id }),
                        });
                    }
                } else {
                    ui.label(egui::RichText::new(state_hint(state)).small().color(palette.muted));
                }
            });

            if expanded {
                ui.separator();
                detail_row(ui, "健康", &if provider.health.is_empty() { "未知".to_owned() } else { provider.health.clone() });
                detail_row(ui, "可用", &match provider.available {
                    Some(true) => "是".to_owned(),
                    Some(false) => "否".to_owned(),
                    None => "未知".to_owned(),
                });
                detail_row(ui, "工作区边界", &if provider.boundary.is_empty() { "未知".to_owned() } else { provider.boundary.clone() });
                detail_row(ui, "续接会话", &match provider.supports_resume {
                    Some(true) => "支持".to_owned(),
                    Some(false) => "不支持".to_owned(),
                    None => "未知".to_owned(),
                });
                detail_row(ui, "能力", &if provider.capabilities.is_empty() {
                    "未知".to_owned()
                } else {
                    provider.capabilities.join("、")
                });
            }
        });
        actions
    }
}

fn state_hint(state: AgentState) -> &'static str {
    match state {
        AgentState::Ready => "",
        AgentState::NeedsSetup => "需要完成接入设置后才能接任务",
        AgentState::NotInstalled => "本机未安装或无法外部控制",
        AgentState::Unavailable => "运行时离线；恢复后自动回到就绪",
    }
}

fn detail_row(ui: &mut egui::Ui, key: &str, value: &str) {
    ui.horizontal(|ui| {
        let palette = crate::native_ui::native_palette();
        ui.monospace(egui::RichText::new(key).small().color(palette.muted));
        ui.label(egui::RichText::new(value).small());
    });
}

/// 解析 `agent.list`。兼容 providers / agents / 顶层数组三种历史形状；
/// 字段缺失时保留空串与 None，由渲染层显示"未知"。
pub fn parse_agent_list(value: &Value) -> Result<Vec<AgentProvider>, String> {
    let list = value
        .get("providers")
        .or_else(|| value.get("agents"))
        .or_else(|| value.get("list"))
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .ok_or_else(|| "Core 返回的智能体目录缺失或无效。".to_owned())?;
    let mut providers = Vec::new();
    for item in list {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "智能体目录项缺少 id。".to_owned())?
            .to_owned();
        let display_name = item
            .get("displayName")
            .or_else(|| item.get("label"))
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(id.as_str())
            .to_owned();
        let capabilities = item
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::String(text) => Some(text.clone()),
                        other => other.get("id").and_then(Value::as_str).map(ToOwned::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default();
        providers.push(AgentProvider {
            id,
            display_name,
            available: item.get("available").and_then(Value::as_bool),
            health: item
                .get("health")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            version: item
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            capabilities,
            boundary: item
                .get("workspaceBoundary")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            supports_resume: item.get("supportsResume").and_then(Value::as_bool),
        });
    }
    Ok(providers)
}

#[cfg(test)]
mod tests {
    use super::{parse_agent_list, AgentState};
    use serde_json::json;

    #[test]
    fn parses_provider_catalog_with_four_states() {
        let providers = parse_agent_list(&json!({
            "providers": [
                {"id": "dsh", "displayName": "DSH", "available": true, "health": "ready", "version": "1.4",
                 "capabilities": ["chat", "tools"], "workspaceBoundary": "staged", "supportsResume": true},
                {"id": "codex", "displayName": "Codex", "available": false, "health": "needs_auth"},
                {"id": "zcode", "displayName": "ZCode", "available": false, "health": "external-control-not-supported"},
                {"id": "legacy", "health": "unavailable"}
            ]
        }))
        .expect("agent list parse");
        assert_eq!(providers.len(), 4);
        assert_eq!(providers[0].state(), AgentState::Ready);
        assert!(providers[0].usable_in_chat());
        assert_eq!(providers[0].capabilities, vec!["chat".to_owned(), "tools".to_owned()]);
        assert_eq!(providers[1].state(), AgentState::NeedsSetup);
        assert_eq!(providers[2].state(), AgentState::NotInstalled);
        assert!(!providers[2].usable_in_chat());
        assert_eq!(providers[3].state(), AgentState::Unavailable);
        assert_eq!(providers[3].display_name, "legacy");
    }

    #[test]
    fn accepts_top_level_array_shape() {
        let providers = parse_agent_list(&json!([
            {"id": "dsh", "health": "ready", "available": true}
        ]))
        .expect("array parse");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].state(), AgentState::Ready);
    }

    #[test]
    fn rejects_directory_without_ids() {
        assert!(parse_agent_list(&json!({"providers": [{"health": "ready"}]})).is_err());
        assert!(parse_agent_list(&json!({"unrelated": true})).is_err());
    }
}
