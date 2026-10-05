//! CetaMesh Desktop —— Workshop（工作坊）Owner 审阅页（v2 hardening / Phase C）。
//!
//! Workshop 产品流程（Runtime 已存在，见 src/workshop/service.js）：
//!   外部 submitter 提交 proposal → Owner 审阅（显式确认 Workspace / Provider /
//!   Capability 授予 / 模型 / 推理强度）→ 批准后 provision（Workspace → Task →
//!   Managed Agent 会话）→ Task 完成 → Owner 批准交付（Artifact 才对外可见）。
//!
//! 本页职责与其它 *_ui 模块一致：只维护状态 + 返回 Core 调用意图（WorkshopAction），
//! 由 native_ui 统一经命名管道下发（workshop.* 方法族，bridge 侧绑定 Owner 身份）。
//!
//! 安全约束在页面上的体现：
//! - 批准前必须勾选显式确认；默认能力集只有 read/write/git.status/git.diff；
//!   test.run、git.commit、memory.write 等高影响能力需要用户主动勾选；
//! - 页面展示"派生风险"（由能力集推导）供 Owner 判断，不伪造运行时没有的风险字段；
//! - 交付必须 Task 完成 + 显式确认；拒绝必须填写理由（提交者可读）。
//! - 提交内容（description/requirements/supplements）一律按不可信数据显示（纯文本）。

use std::collections::HashMap;

use eframe::egui;
use serde_json::{json, Map, Value};

use crate::task_ui::continuity_action_hint;

const SURFACE_ALT: egui::Color32 = egui::Color32::from_rgb(246, 249, 248);
const BORDER: egui::Color32 = egui::Color32::from_rgb(220, 228, 226);
const ACCENT: egui::Color32 = egui::Color32::from_rgb(23, 126, 115);
const MUTED: egui::Color32 = egui::Color32::from_rgb(103, 119, 117);
const ERROR: egui::Color32 = egui::Color32::from_rgb(174, 54, 49);
const WARNING: egui::Color32 = egui::Color32::from_rgb(151, 102, 21);
const SUCCESS: egui::Color32 = egui::Color32::from_rgb(35, 125, 83);

/// 与 src/workshop/service.js 的 WORKSHOP_GRANT_CAPABILITIES 保持一致。
pub const WORKSHOP_CAPABILITIES: [&str; 11] = [
    "filesystem.read",
    "filesystem.write",
    "filesystem.search",
    "git.status",
    "git.diff",
    "git.commit",
    "test.run",
    "memory.read",
    "memory.write",
    "memory.link",
    "workspace.create",
];

pub const WORKSHOP_STATUSES: [&str; 8] = [
    "submitted", "approved", "provisioning", "provision_failed", "active", "rejected", "delivered", "reviewed",
];

/// 一条待下发的 Core 调用意图。
pub struct WorkshopAction {
    pub method: &'static str,
    pub params: Value,
}

impl WorkshopAction {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArtifactRow {
    pub id: String,
    pub label: String,
    pub media_type: String,
    pub delivered_at: u64,
    pub content_preview: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProposalRow {
    pub id: String,
    pub title: String,
    pub description: String,
    pub requirements: Vec<String>,
    pub supplements: Vec<String>,
    pub status: String,
    pub submitter: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub review_decision: String,
    pub review_reason: String,
    pub plan_workspace_name: String,
    pub plan_workspace_root: String,
    pub plan_create_missing: bool,
    pub plan_provider: String,
    pub plan_capabilities: Vec<String>,
    pub plan_model: String,
    pub plan_reasoning: String,
    pub task_id: String,
    pub workspace_id: String,
    pub provision_step: String,
    pub provision_error: String,
    pub artifacts: Vec<ArtifactRow>,
}

impl ProposalRow {
    /// 派生风险（页面展示用；由能力集推导，非运行时字段）。
    pub fn derived_risk(&self) -> (&'static str, egui::Color32) {
        if self.plan_capabilities.is_empty() {
            return ("未授予", MUTED);
        }
        if self.plan_capabilities.iter().any(|cap| cap == "git.commit" || cap == "test.run" || cap == "workspace.create") {
            return ("高（含 commit / test.run / workspace.create）", ERROR);
        }
        if self.plan_capabilities.iter().any(|cap| cap == "filesystem.write" || cap == "memory.write") {
            return ("中（含写权限）", WARNING);
        }
        ("低（只读）", SUCCESS)
    }

    pub fn is_pending(&self) -> bool {
        self.status == "submitted" || self.status == "rejected" || self.status == "reviewed"
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    if let Some(text) = row.as_str() {
                        Some(text.to_owned())
                    } else {
                        row.get("text").and_then(Value::as_str).map(ToOwned::to_owned)
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_proposals(value: &Value) -> Vec<ProposalRow> {
    let rows = match value.get("proposals").and_then(Value::as_array) {
        Some(rows) => rows,
        None => return Vec::new(),
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_str)?;
            let submitter = row.get("submitter").unwrap_or(&Value::Null);
            let plan = row.get("plan").unwrap_or(&Value::Null);
            let workspace = plan.get("workspace").unwrap_or(&Value::Null);
            let review = row.get("review").unwrap_or(&Value::Null);
            let provision = row.get("provision").unwrap_or(&Value::Null);
            let artifacts = row
                .get("artifacts")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|artifact| {
                            Some(ArtifactRow {
                                id: artifact.get("id").and_then(Value::as_str)?.to_owned(),
                                label: artifact.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                                media_type: artifact.get("mediaType").and_then(Value::as_str).unwrap_or("").to_owned(),
                                delivered_at: artifact.get("deliveredAt").and_then(Value::as_u64).unwrap_or(0),
                                content_preview: {
                                    let content = artifact.get("content").and_then(Value::as_str).unwrap_or("");
                                    let preview: String = content.chars().take(200).collect();
                                    preview
                                },
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(ProposalRow {
                id: id.to_owned(),
                title: row.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
                description: row.get("description").and_then(Value::as_str).unwrap_or("").to_owned(),
                requirements: string_list(row.get("requirements")),
                supplements: row
                    .get("supplements")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|item| item.get("text").and_then(Value::as_str).map(ToOwned::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                status: row.get("status").and_then(Value::as_str).unwrap_or("").to_owned(),
                submitter: format!(
                    "{}:{}",
                    submitter.get("kind").and_then(Value::as_str).unwrap_or("?"),
                    submitter.get("id").and_then(Value::as_str).unwrap_or("?")
                ),
                created_at: row.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
                updated_at: row.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
                review_decision: review.get("decision").and_then(Value::as_str).unwrap_or("").to_owned(),
                review_reason: review.get("reason").and_then(Value::as_str).unwrap_or("").to_owned(),
                plan_workspace_name: workspace.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
                plan_workspace_root: workspace.get("root").and_then(Value::as_str).unwrap_or("").to_owned(),
                plan_create_missing: workspace.get("createIfMissing").and_then(Value::as_bool).unwrap_or(false),
                plan_provider: plan.get("provider").and_then(Value::as_str).unwrap_or("").to_owned(),
                plan_capabilities: string_list(plan.get("capabilities")),
                plan_model: plan.get("model").and_then(Value::as_str).unwrap_or("").to_owned(),
                plan_reasoning: plan.get("reasoningEffort").and_then(Value::as_str).unwrap_or("").to_owned(),
                task_id: row.get("taskId").and_then(Value::as_str).unwrap_or("").to_owned(),
                workspace_id: row.get("workspaceId").and_then(Value::as_str).unwrap_or("").to_owned(),
                provision_step: provision.get("step").and_then(Value::as_str).unwrap_or("").to_owned(),
                provision_error: provision
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                artifacts,
            })
        })
        .collect()
}

#[derive(Default)]
pub struct WorkshopUi {
    pub loaded: bool,
    requested: bool,
    pub proposals: Vec<ProposalRow>,
    pub selected: Option<String>,
    pub status_filter: String,
    pub error: Option<String>,
    pub notice: Option<String>,
    // 审阅表单（批准前必须显式确认）。
    pub plan_workspace_name: String,
    pub plan_workspace_root: String,
    pub plan_create_missing: bool,
    pub plan_provider: String,
    pub plan_capabilities: Vec<(String, bool)>,
    pub plan_model: String,
    pub plan_reasoning: String,
    pub plan_confirmed: bool,
    pub reject_reason: String,
    /// 已经为哪个 proposal 初始化过审阅表单（切换选中时重置）。
    form_for: Option<String>,
    // 交付表单。
    pub delivery_label: String,
    pub delivery_media_type: String,
    pub delivery_content: String,
    pub delivery_confirmed: bool,
    // 任务状态 / Continuity 缓存（key = proposalId / taskId）。
    pub task_status: HashMap<String, Value>,
    pub task_context: HashMap<String, Value>,
    issued_task_status: Vec<String>,
    issued_context: Vec<String>,
}

impl WorkshopUi {
    pub fn apply(&mut self, value: &Value) -> bool {
        self.error = None;
        if value.get("proposals").is_some() {
            self.proposals = parse_proposals(value);
            self.loaded = true;
            if let Some(selected) = &self.selected {
                if !self.proposals.iter().any(|row| &row.id == selected) {
                    self.selected = None;
                }
            }
            return false;
        }
        if let Some(proposal) = value.get("proposal") {
            // 单条更新（review / retry / supplement 的返回）：合并进列表。
            let wrapper = json!({ "proposals": [proposal.clone()] });
            if let Some(updated) = parse_proposals(&wrapper).into_iter().next() {
                match self.proposals.iter().position(|row| row.id == updated.id) {
                    Some(index) => self.proposals[index] = updated,
                    None => self.proposals.push(updated),
                }
                self.notice = Some("已更新，正在刷新列表…".to_owned());
                return true;
            }
            return false;
        }
        if let Some(proposal_id) = value.get("proposalId").and_then(Value::as_str) {
            self.task_status.insert(proposal_id.to_owned(), value.clone());
            return false;
        }
        if let Some(task_id) = value.get("taskId").and_then(Value::as_str) {
            if value.get("attached").is_some() {
                self.task_context.insert(task_id.to_owned(), value.clone());
            }
            return false;
        }
        if value.get("artifact").is_some() {
            self.notice = Some("交付已登记。".to_owned());
            return true;
        }
        false
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    /// 审阅表单初始化（选中 proposal 或切换时调用一次）。
    fn ensure_form(&mut self, proposal: &ProposalRow) {
        if self.form_for.as_deref() == Some(proposal.id.as_str()) {
            return;
        }
        self.form_for = Some(proposal.id.clone());
        self.plan_workspace_name = if proposal.plan_workspace_name.is_empty() {
            format!("workshop-{}", proposal.id.chars().take(12).collect::<String>())
        } else {
            proposal.plan_workspace_name.clone()
        };
        self.plan_workspace_root = proposal.plan_workspace_root.clone();
        self.plan_create_missing = proposal.plan_create_missing;
        self.plan_provider = if proposal.plan_provider.is_empty() { "cetamesh".to_owned() } else { proposal.plan_provider.clone() };
        self.plan_capabilities = WORKSHOP_CAPABILITIES
            .iter()
            .map(|cap| {
                let on = if proposal.plan_capabilities.is_empty() {
                    // 默认最小集：只读 + 写文件 + git 只读；不默认授予 test.run / commit。
                    matches!(*cap, "filesystem.read" | "filesystem.write" | "git.status" | "git.diff")
                } else {
                    proposal.plan_capabilities.iter().any(|item| item == cap)
                };
                ((*cap).to_owned(), on)
            })
            .collect();
        self.plan_model = proposal.plan_model.clone();
        self.plan_reasoning = proposal.plan_reasoning.clone();
        self.plan_confirmed = false;
        self.reject_reason.clear();
        self.delivery_label.clear();
        self.delivery_media_type = "text/plain".to_owned();
        self.delivery_content.clear();
        self.delivery_confirmed = false;
    }

    pub fn plan_params(&self, id: &str) -> Value {
        let capabilities: Vec<String> = self
            .plan_capabilities
            .iter()
            .filter(|(_, on)| *on)
            .map(|(cap, _)| cap.clone())
            .collect();
        let mut workspace = Map::new();
        workspace.insert("name".to_owned(), Value::String(self.plan_workspace_name.trim().to_owned()));
        workspace.insert("root".to_owned(), Value::String(self.plan_workspace_root.trim().to_owned()));
        workspace.insert("createIfMissing".to_owned(), Value::Bool(self.plan_create_missing));
        json!({
            "id": id,
            "approve": true,
            "plan": {
                "workspace": workspace,
                "provider": self.plan_provider.trim(),
                "capabilities": capabilities,
                "model": self.plan_model.trim(),
                "reasoningEffort": self.plan_reasoning.trim(),
            }
        })
    }

    pub fn can_approve(&self) -> bool {
        self.plan_confirmed
            && !self.plan_workspace_root.trim().is_empty()
            && !self.plan_workspace_name.trim().is_empty()
            && !self.plan_provider.trim().is_empty()
            && self.plan_capabilities.iter().any(|(_, on)| *on)
    }

    pub fn can_deliver(&self, task_completed: bool) -> bool {
        task_completed && self.delivery_confirmed && !self.delivery_label.trim().is_empty()
    }

    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<WorkshopAction> {
        let mut actions: Vec<WorkshopAction> = Vec::new();
        ui.label(
            egui::RichText::new("外部提交经 Owner 审阅后才会获得 Workspace / Task / Agent；提交本身不授予任何文件或执行权限。")
                .color(MUTED),
        );
        ui.add_space(4.0);

        if !self.requested {
            self.requested = true;
            actions.push(WorkshopAction::new("workshop.proposal.list", json!({ "limit": 200 })));
        }
        if let Some(error) = &self.error {
            ui.colored_label(ERROR, error.as_str());
        }
        if let Some(notice) = &self.notice {
            ui.weak(notice.as_str());
        }

        // ── 状态概览 + 过滤 ────────────────────────────────────────────────
        ui.horizontal_wrapped(|ui| {
            for status in WORKSHOP_STATUSES {
                let count = self.proposals.iter().filter(|row| row.status == status).count();
                if count > 0 {
                    ui.label(egui::RichText::new(format!("{status} {count}")).color(status_color(status)).strong());
                }
            }
            ui.add_space(8.0);
            egui::ComboBox::from_id_salt("workshop_status_filter")
                .selected_text(if self.status_filter.is_empty() { "全部".to_owned() } else { self.status_filter.clone() })
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut self.status_filter, String::new(), "全部");
                    for status in WORKSHOP_STATUSES {
                        ui.selectable_value(&mut self.status_filter, status.to_owned(), status);
                    }
                });
            if ui.button("刷新").clicked() {
                actions.push(WorkshopAction::new("workshop.proposal.list", json!({ "limit": 200 })));
            }
        });

        // ── 列表 ──────────────────────────────────────────────────────────
        ui.add_space(8.0);
        let visible: Vec<ProposalRow> = self
            .proposals
            .iter()
            .filter(|row| self.status_filter.is_empty() || row.status == self.status_filter)
            .cloned()
            .collect();
        ui.label(egui::RichText::new(format!("Proposals（{}）", visible.len())).strong());
        if visible.is_empty() {
            ui.weak(if self.loaded { "没有符合条件的提案。" } else { "正在读取提案…" });
        }
        let mut want_select: Option<String> = None;
        for row in &visible {
            egui::Frame::new()
                .fill(SURFACE_ALT)
                .stroke(egui::Stroke::new(1.0, BORDER))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(12, 10))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(format!("[{}]", row.status)).color(status_color(&row.status)).strong());
                        ui.label(egui::RichText::new(row.title.as_str()).strong());
                        let (risk, color) = row.derived_risk();
                        ui.colored_label(color, format!("风险：{risk}"));
                    });
                    ui.horizontal_wrapped(|ui| {
                        ui.weak(format!("提交者 {}", row.submitter));
                        ui.weak(format!("创建 {}", row.created_at));
                        if !row.task_id.is_empty() {
                            ui.weak(format!("Task {}", row.task_id));
                        }
                        if !row.workspace_id.is_empty() {
                            ui.weak(format!("Workspace {}", row.workspace_id));
                        }
                        if row.is_pending() && ui.button("审阅").clicked() {
                            want_select = Some(row.id.clone());
                        }
                        if !row.task_id.is_empty() && ui.button("查看 Task").clicked() {
                            want_select = Some(row.id.clone());
                        }
                    });
                });
        }
        if let Some(id) = want_select {
            self.selected = Some(id);
        }

        // ── 详情 ──────────────────────────────────────────────────────────
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| self.proposals.iter().find(|row| &row.id == id).cloned());
        if let Some(proposal) = selected {
            ui.add_space(12.0);
            ui.separator();
            self.ensure_form(&proposal);
            ui.horizontal_wrapped(|ui| {
                ui.label(egui::RichText::new(format!("Proposal {}", proposal.id)).strong());
                ui.label(egui::RichText::new(format!("[{}]", proposal.status)).color(status_color(&proposal.status)).strong());
                if ui.button("关闭详情").clicked() {
                    self.selected = None;
                }
            });
            ui.label(egui::RichText::new(proposal.title.as_str()).strong());
            // 提交内容按不可信数据显示：纯文本、不渲染、无链接。
            ui.label(egui::RichText::new(proposal.description.as_str()));
            if !proposal.requirements.is_empty() {
                egui::CollapsingHeader::new(format!("需求（{}）", proposal.requirements.len())).default_open(true).show(ui, |ui| {
                    for item in &proposal.requirements {
                        ui.label(format!("• {item}"));
                    }
                });
            }
            if !proposal.supplements.is_empty() {
                egui::CollapsingHeader::new(format!("补充（{}）", proposal.supplements.len())).show(ui, |ui| {
                    for item in &proposal.supplements {
                        ui.label(format!("• {item}"));
                    }
                });
            }

            // ── 审阅 / 已批准计划 ──────────────────────────────────────────
            if proposal.is_pending() {
                ui.add_space(6.0);
                ui.label(egui::RichText::new("授权计划（批准前逐项确认）").strong());
                egui::Grid::new(format!("workshop_plan_{}", proposal.id)).num_columns(2).show(ui, |ui| {
                    ui.label("Workspace 名称");
                    ui.add(egui::TextEdit::singleline(&mut self.plan_workspace_name).desired_width(260.0));
                    ui.end_row();
                    ui.label("Workspace 根目录");
                    ui.add(egui::TextEdit::singleline(&mut self.plan_workspace_root).desired_width(420.0).hint_text("绝对路径；Core 侧仍会拒绝危险 root"));
                    ui.end_row();
                    ui.label("目录不存在时创建");
                    ui.checkbox(&mut self.plan_create_missing, "允许创建");
                    ui.end_row();
                    ui.label("Agent Provider");
                    ui.add(egui::TextEdit::singleline(&mut self.plan_provider).desired_width(160.0).hint_text("cetamesh"));
                    ui.end_row();
                    ui.label("模型 / 推理");
                    ui.horizontal(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut self.plan_model).desired_width(180.0).hint_text("模型（可留空）"));
                        ui.add(egui::TextEdit::singleline(&mut self.plan_reasoning).desired_width(100.0).hint_text("推理"));
                    });
                    ui.end_row();
                });
                ui.label("能力授予");
                ui.horizontal_wrapped(|ui| {
                    for (cap, on) in self.plan_capabilities.iter_mut() {
                        ui.checkbox(on, cap.as_str());
                    }
                });
                ui.checkbox(&mut self.plan_confirmed, "我确认以上 Workspace、Provider、能力授予与模型范围（不默认授予全盘 / 任意 shell / 任意网络）");
                ui.horizontal_wrapped(|ui| {
                    if ui.add_enabled(self.can_approve(), egui::Button::new("批准并开始")).clicked() {
                        actions.push(WorkshopAction::new("workshop.proposal.review", self.plan_params(&proposal.id)));
                    }
                    ui.label("拒绝理由");
                    ui.add(egui::TextEdit::singleline(&mut self.reject_reason).desired_width(300.0).hint_text("必填（提交者可见）"));
                    if ui.add_enabled(!self.reject_reason.trim().is_empty(), egui::Button::new("拒绝")).clicked() {
                        actions.push(WorkshopAction::new(
                            "workshop.proposal.review",
                            json!({ "id": proposal.id, "approve": false, "reason": self.reject_reason.trim() }),
                        ));
                    }
                });
            } else if !proposal.plan_provider.is_empty() || !proposal.plan_workspace_root.is_empty() {
                ui.add_space(6.0);
                ui.label(egui::RichText::new("已批准计划").strong());
                ui.horizontal_wrapped(|ui| {
                    ui.weak(format!("Workspace：{}（{}）", proposal.plan_workspace_name, proposal.plan_workspace_root));
                    ui.weak(format!("Provider：{}", proposal.plan_provider));
                    if !proposal.plan_model.is_empty() {
                        ui.weak(format!("模型：{}", proposal.plan_model));
                    }
                    let (risk, color) = proposal.derived_risk();
                    ui.colored_label(color, format!("授权风险：{risk}"));
                });
                ui.horizontal_wrapped(|ui| {
                    for cap in &proposal.plan_capabilities {
                        ui.weak(cap.as_str());
                    }
                });
                if !proposal.review_reason.is_empty() {
                    ui.weak(format!("审阅理由：{}", proposal.review_reason));
                }
                if proposal.status == "provision_failed" {
                    ui.colored_label(ERROR, format!("Provision 失败（{}）：{}", proposal.provision_step, proposal.provision_error));
                    if ui.button("重试 Provision").clicked() {
                        actions.push(WorkshopAction::new("workshop.proposal.retry", json!({ "id": proposal.id })));
                    }
                } else {
                    ui.weak(format!("Provision 步骤：{}", proposal.provision_step));
                }
            }

            // ── Task / Continuity ─────────────────────────────────────────
            if !proposal.task_id.is_empty() {
                if !self.issued_task_status.iter().any(|id| id == &proposal.id) {
                    self.issued_task_status.push(proposal.id.clone());
                    actions.push(WorkshopAction::new("workshop.task.status", json!({ "id": proposal.id })));
                }
                if !self.issued_context.iter().any(|id| id == &proposal.task_id) {
                    self.issued_context.push(proposal.task_id.clone());
                    actions.push(WorkshopAction::new("continuity.status", json!({ "taskId": proposal.task_id })));
                }
                ui.add_space(6.0);
                ui.label(egui::RichText::new("Task（同一 Task 不因 Session 更换而重建）").strong());
                let task_completed = match self.task_status.get(&proposal.id) {
                    Some(status) => {
                        let task = status.get("task").unwrap_or(&Value::Null);
                        let current_agent = task.get("currentAgent").unwrap_or(&Value::Null);
                        ui.horizontal_wrapped(|ui| {
                            ui.weak(format!("Task ID：{}", task.get("id").and_then(Value::as_str).unwrap_or(proposal.task_id.as_str())));
                            ui.weak(format!("状态：{}", task.get("status").and_then(Value::as_str).unwrap_or("?")));
                            ui.weak(format!("阶段：{}", task.get("currentPhase").and_then(Value::as_str).unwrap_or("—")));
                            let percent = task.get("progress").and_then(|progress| progress.get("percent")).and_then(Value::as_u64).unwrap_or(0);
                            ui.weak(format!("进度：{percent}%"));
                        });
                        ui.horizontal_wrapped(|ui| {
                            ui.weak(format!("Workspace：{}", task.get("workspaceId").and_then(Value::as_str).unwrap_or("未绑定")));
                            let provider = current_agent.get("provider").and_then(Value::as_str).unwrap_or("未绑定");
                            let session = current_agent.get("sessionId").and_then(Value::as_str).unwrap_or("未绑定");
                            ui.weak(format!("Agent：{provider}"));
                            ui.weak(format!("Session：{session}"));
                        });
                        if let Some(checkpoint) = task.get("checkpoint").filter(|value| value.is_object()) {
                            let summary = checkpoint.get("summary").and_then(Value::as_str).unwrap_or("");
                            if !summary.is_empty() {
                                ui.weak(format!("Checkpoint：{summary}"));
                            }
                        }
                        task.get("status").and_then(Value::as_str) == Some("completed")
                    }
                    None => {
                        ui.weak("正在读取 Task 状态…");
                        false
                    }
                };
                if let Some(context) = self.task_context.get(&proposal.task_id) {
                    let level = context.get("level").unwrap_or(&Value::Null);
                    let percent = level.get("percent").and_then(Value::as_u64);
                    let source = level.get("source").and_then(Value::as_str).unwrap_or("");
                    let source_text = if source == "usage" { "真实 usage" } else if source == "estimated" { "字符估算" } else { source };
                    let hint = continuity_action_hint(context.get("action").and_then(Value::as_str).unwrap_or(""));
                    ui.horizontal_wrapped(|ui| {
                        match percent {
                            Some(percent) => ui.weak(format!("Context：{percent}%（{source_text}）")),
                            None => ui.weak("Context：未知"),
                        };
                        ui.weak(format!("Continuity：{hint}"));
                        if ui.button("重新读取").clicked() {
                            self.issued_context.retain(|id| id != &proposal.task_id);
                        }
                    });
                }

                // ── Artifact 交付 ─────────────────────────────────────────
                ui.add_space(6.0);
                ui.label(egui::RichText::new(format!("Artifacts（{}，仅 Owner 可见全部内容）", proposal.artifacts.len())).strong());
                for artifact in &proposal.artifacts {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(format!("[{}]", artifact.media_type)).color(ACCENT).strong());
                        ui.label(artifact.label.as_str());
                        ui.weak(format!("交付于 {}", artifact.delivered_at));
                    });
                    if !artifact.content_preview.is_empty() {
                        ui.weak(artifact.content_preview.as_str());
                    }
                }
                if proposal.artifacts.is_empty() {
                    ui.weak("尚未交付。");
                }
                egui::CollapsingHeader::new("交付 Artifact（需 Task 完成 + 显式确认）")
                    .default_open(false)
                    .show(ui, |ui| {
                        if !task_completed {
                            ui.weak("Task 尚未完成：交付在 Runtime 侧同样会被拒绝。");
                        }
                        egui::Grid::new(format!("workshop_delivery_{}", proposal.id)).num_columns(2).show(ui, |ui| {
                            ui.label("标题");
                            ui.add(egui::TextEdit::singleline(&mut self.delivery_label).desired_width(260.0));
                            ui.end_row();
                            ui.label("媒体类型");
                            ui.add(egui::TextEdit::singleline(&mut self.delivery_media_type).desired_width(160.0));
                            ui.end_row();
                        });
                        ui.label("内容");
                        ui.add(egui::TextEdit::multiline(&mut self.delivery_content).desired_rows(3).desired_width(520.0));
                        ui.checkbox(&mut self.delivery_confirmed, "我确认批准该交付（提交者将看到此内容）");
                        let can_deliver = task_completed
                            && self.delivery_confirmed
                            && !self.delivery_label.trim().is_empty();
                        if ui.add_enabled(can_deliver, egui::Button::new("批准交付")).clicked() {
                            actions.push(WorkshopAction::new(
                                "workshop.artifact.deliver",
                                json!({
                                    "id": proposal.id,
                                    "approve": true,
                                    "label": self.delivery_label.trim(),
                                    "mediaType": if self.delivery_media_type.trim().is_empty() { "text/plain" } else { self.delivery_media_type.trim() },
                                    "content": self.delivery_content,
                                }),
                            ));
                        }
                    });
            }
        }
        actions
    }
}

pub fn status_color(status: &str) -> egui::Color32 {
    match status {
        "submitted" => WARNING,
        "approved" | "active" => ACCENT,
        "provisioning" => MUTED,
        "provision_failed" => ERROR,
        "rejected" => ERROR,
        "delivered" => SUCCESS,
        _ => MUTED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_proposal() -> Value {
        json!({
            "id": "proposal_1",
            "title": "整理导出器",
            "description": "把导出逻辑整理成模块",
            "requirements": ["保持 CLI 兼容", "输出 JSON"],
            "supplements": [{ "id": "s1", "text": "补充：也支持 CSV", "createdAt": 1 }],
            "status": "submitted",
            "submitter": { "kind": "external", "id": "user-42" },
            "createdAt": 1759651200000u64,
            "updatedAt": 1759651300000u64,
            "review": null,
            "plan": null,
            "taskId": null,
            "workspaceId": null,
            "provision": { "step": "unapproved", "attempts": 0, "error": null },
            "artifacts": []
        })
    }

    #[test]
    fn parses_proposal_list_projection() {
        let ui_value = json!({ "proposals": [sample_proposal()], "total": 1 });
        let rows = parse_proposals(&ui_value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "整理导出器");
        assert_eq!(rows[0].submitter, "external:user-42");
        assert_eq!(rows[0].requirements.len(), 2);
        assert_eq!(rows[0].supplements, vec!["补充：也支持 CSV".to_owned()]);
        assert!(rows[0].is_pending());
        assert_eq!(rows[0].derived_risk().0, "未授予");
    }

    #[test]
    fn parses_approved_plan_and_derives_risk() {
        let mut proposal = sample_proposal();
        proposal["status"] = json!("active");
        proposal["plan"] = json!({
            "workspace": { "name": "ws-1", "root": "D:/work/ws-1", "createIfMissing": true },
            "provider": "cetamesh",
            "capabilities": ["filesystem.read", "git.commit"],
            "model": "deepseek-chat",
            "reasoningEffort": "high"
        });
        proposal["taskId"] = json!("task_1");
        proposal["workspaceId"] = json!("ws-1");
        proposal["provision"] = json!({ "step": "assigned", "attempts": 1, "error": null });
        let rows = parse_proposals(&json!({ "proposals": [proposal] }));
        let row = &rows[0];
        assert_eq!(row.plan_workspace_root, "D:/work/ws-1");
        assert!(row.plan_create_missing);
        assert_eq!(row.plan_capabilities.len(), 2);
        assert_eq!(row.plan_reasoning, "high");
        assert_eq!(row.task_id, "task_1");
        assert!(!row.is_pending());
        assert!(row.derived_risk().0.starts_with("高"), "include git.commit → high risk");
    }

    #[test]
    fn review_form_defaults_to_minimal_capabilities_and_requires_confirmation() {
        let rows = parse_proposals(&json!({ "proposals": [sample_proposal()] }));
        let mut ui = WorkshopUi::default();
        ui.ensure_form(&rows[0]);
        let granted: Vec<&str> = ui
            .plan_capabilities
            .iter()
            .filter(|(_, on)| *on)
            .map(|(cap, _)| cap.as_str())
            .collect();
        assert_eq!(granted, vec!["filesystem.read", "filesystem.write", "git.status", "git.diff"]);
        assert!(
            ui.plan_capabilities.iter().any(|(cap, on)| cap == "test.run" && !on),
            "test.run must not be granted by default"
        );
        ui.plan_workspace_root = "D:/work/ws-1".to_owned();
        assert!(!ui.can_approve(), "未确认时不能批准");
        ui.plan_confirmed = true;
        assert!(ui.can_approve(), "填写 root + 确认后可以批准");
        let params = ui.plan_params("proposal_1");
        assert_eq!(params["approve"], json!(true));
        assert_eq!(params["plan"]["provider"], json!("cetamesh"));
        assert_eq!(params["plan"]["capabilities"].as_array().unwrap().len(), 4);
        assert_eq!(params["plan"]["workspace"]["createIfMissing"], json!(false));
    }

    #[test]
    fn delivery_requires_completed_task_and_confirmation() {
        let mut ui = WorkshopUi::default();
        ui.delivery_label = "报告".to_owned();
        ui.delivery_confirmed = true;
        assert!(!ui.can_deliver(false), "Task 未完成不能交付");
        assert!(ui.can_deliver(true));
        ui.delivery_confirmed = false;
        assert!(!ui.can_deliver(true), "未确认不能交付");
        ui.delivery_confirmed = true;
        ui.delivery_label.clear();
        assert!(!ui.can_deliver(true), "缺标题不能交付");
    }

    #[test]
    fn apply_merges_single_proposal_and_routes_task_status_and_context() {
        let mut ui = WorkshopUi::default();
        assert!(!ui.apply(&json!({ "proposals": [sample_proposal()], "total": 1 })));
        assert!(ui.loaded);
        // 单条更新（review 返回）：合并进列表并要求刷新。
        let mut updated = sample_proposal();
        updated["status"] = json!("approved");
        assert!(ui.apply(&json!({ "proposal": updated })));
        assert_eq!(ui.proposals[0].status, "approved");
        // workshop.task.status：按 proposalId 缓存。
        assert!(!ui.apply(&json!({ "proposalId": "proposal_1", "status": "active",
            "task": { "id": "task_1", "status": "completed", "progress": { "percent": 100 } } })));
        assert_eq!(ui.task_status["proposal_1"]["task"]["status"], "completed");
        // continuity.status：按 taskId 缓存。
        assert!(!ui.apply(&json!({ "taskId": "task_1", "attached": true,
            "level": { "percent": 42, "source": "usage" }, "action": "none" })));
        assert_eq!(ui.task_context["task_1"]["level"]["percent"], 42);
        // 交付返回：要求刷新。
        assert!(ui.apply(&json!({ "artifact": { "id": "delivery_1" }, "proposal": updated })));
    }

    #[test]
    fn list_refresh_drops_stale_selection() {
        let mut ui = WorkshopUi::default();
        ui.apply(&json!({ "proposals": [sample_proposal()], "total": 1 }));
        ui.selected = Some("proposal_1".to_owned());
        ui.apply(&json!({ "proposals": [], "total": 0 }));
        assert_eq!(ui.selected, None, "提案消失后选中态清空");
    }

    #[test]
    fn status_filter_is_applied_in_show_and_status_colors_are_stable() {
        assert_ne!(status_color("submitted"), status_color("rejected"));
        assert_eq!(status_color("delivered"), SUCCESS);
        let mut ui = WorkshopUi::default();
        ui.apply(&json!({ "proposals": [sample_proposal()], "total": 1 }));
        ui.status_filter = "approved".to_owned();
        let visible = ui
            .proposals
            .iter()
            .filter(|row| ui.status_filter.is_empty() || row.status == ui.status_filter)
            .count();
        assert_eq!(visible, 0, "过滤后 submitted 提案不可见");
    }
}
