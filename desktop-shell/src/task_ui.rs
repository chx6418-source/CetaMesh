//! CetaMesh Desktop —— Tasks 产品页（阶段 07）。
//!
//! Task 是 CetaMesh 自己持有的长期工作对象，不随 Agent Session 结束而消失。
//! 本页支持：Task list / Create / Open / Pause / Resume / Cancel / Status / Progress /
//! Needs Attention / Artifacts / History。
//!
//! 与 memory_ui.rs 同一约定：只维护状态并返回 Core 调用意图（TaskAction），
//! 真正下发 IPC 的是 native_ui（唯一持有 CoreApi 的地方）。
//! 一次 task.overview 就返回全量任务记录 + 计数 + Needs Attention，因此任何变更后
//! 只需一次往返即可刷新列表与详情（避免同一 Area 的并发 issue 互斥）。

use eframe::egui;
use crate::native_ui::native_palette;
use std::collections::HashMap;
use serde_json::{Map, Value, json};


const TASK_STATUSES: [&str; 8] = [
    "queued", "running", "waiting", "blocked", "paused", "completed", "failed", "cancelled",
];

/// 一条待下发的 Core 调用意图。
pub struct TaskAction {
    pub method: &'static str,
    pub params: Value,
}

impl TaskAction {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TaskDetail {
    pub id: String,
    pub goal: String,
    pub status: String,
    pub current_phase: String,
    pub progress_percent: u64,
    pub progress_note: String,
    pub requirements: Vec<String>,
    pub completed_work: Vec<String>,
    pub pending_work: Vec<String>,
    pub workspace_id: String,
    pub artifacts: Vec<String>,
    pub decisions: Vec<String>,
    pub memory_refs: Vec<String>,
    pub checkpoint_summary: String,
    pub checkpoint_next: String,
    pub acceptance: Vec<(String, bool)>,
    pub agent_history: Vec<String>,
    pub current_agent: String,
    pub agent_provider: String,
    pub agent_session: String,
    pub rev: u64,
    pub updated_at: u64,
}

fn string_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
        .unwrap_or_default()
}

pub fn parse_details(value: &Value) -> Vec<TaskDetail> {
    let Some(items) = value.get("tasks").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            let progress = item.get("progress").cloned().unwrap_or(Value::Null);
            let checkpoint = item.get("checkpoint").cloned().unwrap_or(Value::Null);
            let agent = item.get("currentAgent").cloned().unwrap_or(Value::Null);
            let current_agent = if agent.is_null() {
                String::new()
            } else {
                format!(
                    "{} / {}",
                    string_field(&agent, "provider"),
                    string_field(&agent, "sessionId")
                )
            };
            TaskDetail {
                id: string_field(item, "id"),
                goal: string_field(item, "goal"),
                status: string_field(item, "status"),
                current_phase: string_field(item, "currentPhase"),
                progress_percent: u64_field(&progress, "percent"),
                progress_note: string_field(&progress, "note"),
                requirements: string_list(item, "requirements"),
                completed_work: item
                    .get("completedWork")
                    .and_then(Value::as_array)
                    .map(|rows| rows.iter().map(|row| string_field(row, "text")).collect())
                    .unwrap_or_default(),
                pending_work: item
                    .get("pendingWork")
                    .and_then(Value::as_array)
                    .map(|rows| rows.iter().map(|row| string_field(row, "text")).collect())
                    .unwrap_or_default(),
                workspace_id: item.get("workspaceId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                artifacts: item
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .map(|row| {
                                let label = string_field(row, "label");
                                let reference = string_field(row, "ref");
                                if reference.is_empty() { label } else { format!("{label}  ({reference})") }
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                decisions: item
                    .get("decisions")
                    .and_then(Value::as_array)
                    .map(|rows| rows.iter().map(|row| string_field(row, "decision")).collect())
                    .unwrap_or_default(),
                memory_refs: item
                    .get("memoryRefs")
                    .and_then(Value::as_array)
                    .map(|rows| rows.iter().map(|row| string_field(row, "memoryId")).collect())
                    .unwrap_or_default(),
                checkpoint_summary: string_field(&checkpoint, "summary"),
                checkpoint_next: string_field(&checkpoint, "nextAction"),
                acceptance: item
                    .get("acceptance")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .map(|row| (string_field(row, "text"), row.get("met").and_then(Value::as_bool).unwrap_or(false)))
                            .collect()
                    })
                    .unwrap_or_default(),
                agent_history: item
                    .get("agentHistory")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .map(|row| {
                                let detached = row.get("detachedAt").and_then(Value::as_u64).unwrap_or(0);
                                format!(
                                    "{} / {} {}",
                                    string_field(row, "provider"),
                                    string_field(row, "sessionId"),
                                    if detached > 0 { "(已结束)" } else { "(进行中)" }
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                current_agent,
                agent_provider: string_field(&agent, "provider"),
                agent_session: string_field(&agent, "sessionId"),
                rev: u64_field(item, "rev"),
                updated_at: u64_field(item, "updatedAt"),
            }
        })
        .collect()
}

pub fn parse_counts(value: &Value) -> Vec<(String, u64)> {
    let Some(counts) = value.get("counts").and_then(Value::as_object) else {
        return Vec::new();
    };
    TASK_STATUSES
        .iter()
        .map(|name| (name.to_string(), counts.get(*name).and_then(Value::as_u64).unwrap_or(0)))
        .collect()
}

pub fn parse_attention(value: &Value) -> Vec<String> {
    value
        .get("needsAttention")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
        .unwrap_or_default()
}

fn status_color(status: &str) -> egui::Color32 {
    match status {
        "running" => native_palette().accent,
        "completed" => native_palette().success,
        "failed" | "cancelled" => native_palette().error,
        "blocked" | "waiting" => native_palette().warning,
        _ => native_palette().muted,
    }
}

pub struct TaskUi {
    pub loaded: bool,
    pub requested: bool,
    pub details: Vec<TaskDetail>,
    pub counts: Vec<(String, u64)>,
    pub attention: Vec<String>,
    pub selected: Option<String>,
    pub status_filter: String,
    pub query: String,
    pub workspace_filter: String,
    pub only_attention: bool,
    pub notice: Option<String>,
    pub error: Option<String>,
    pub new_goal: String,
    pub new_workspace: String,
    pub new_phase: String,
    pub new_requirements: String,
    pub new_acceptance: String,
    pub checkpoint_summary: String,
    pub checkpoint_next: String,
    pub work_text: String,
    pub artifact_label: String,
    pub agent_provider: String,
    pub agent_session: String,
    pub context: Map<String, Value>,
    /// 等待 continuity.history 响应的 taskId 队列（apply 时按序关联）。
    pending_history: Vec<String>,
    /// 已自动发起过 Continuity 读取的选中任务，避免每帧重复下发。
    context_issued: Vec<String>,
    /// Rollover 历史（key = taskId）。
    pub rollovers: HashMap<String, Vec<RolloverEntry>>,
}

impl Default for TaskUi {
    fn default() -> Self {
        Self {
            loaded: false,
            requested: false,
            details: Vec::new(),
            counts: Vec::new(),
            attention: Vec::new(),
            selected: None,
            status_filter: String::new(),
            query: String::new(),
            workspace_filter: String::new(),
            only_attention: false,
            notice: None,
            error: None,
            new_goal: String::new(),
            new_workspace: String::new(),
            new_phase: String::new(),
            new_requirements: String::new(),
            new_acceptance: String::new(),
            checkpoint_summary: String::new(),
            checkpoint_next: String::new(),
            work_text: String::new(),
            artifact_label: String::new(),
            agent_provider: "dsh".to_owned(),
            agent_session: String::new(),
            context: Map::new(),
            pending_history: Vec::new(),
            context_issued: Vec::new(),
            rollovers: HashMap::new(),
        }
    }
}

/// 一条 Fresh Session Rollover 历史（continuity.history 条目）。
#[derive(Clone, Debug, PartialEq)]
pub struct RolloverEntry {
    pub sequence: u64,
    pub from: String,
    pub to: String,
    pub reason: String,
    pub cross_provider: bool,
    pub at: u64,
}

/// 解析 continuity.history 响应。响应本身不带 taskId，关联由调用方按请求顺序维护。
pub fn parse_rollover_history(value: &Value) -> Vec<RolloverEntry> {
    let rows = match value.get("rollovers").and_then(Value::as_array) {
        Some(rows) => rows,
        None => return Vec::new(),
    };
    rows.iter()
        .filter_map(|row| {
            let sequence = row.get("sequence").and_then(Value::as_u64)?;
            let bind = |side: &str| {
                let item = row.get(side).unwrap_or(&Value::Null);
                format!(
                    "{}:{}",
                    string_field(item, "provider"),
                    string_field(item, "sessionId")
                )
            };
            Some(RolloverEntry {
                sequence,
                from: bind("from"),
                to: bind("to"),
                reason: string_field(row, "reason"),
                cross_provider: row.get("crossProvider").and_then(Value::as_bool).unwrap_or(false),
                at: row.get("at").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

/// 把 Continuity 动作映射为人读提示（Work 页详情用）。
pub fn continuity_action_hint(action: &str) -> &'static str {
    match action {
        "none" => "正常",
        "checkpoint" => "建议生成 Checkpoint",
        "ready" => "寻求安全点（接近 rollover）",
        "rollover" => "达到 Rollover 阈值（将自动 Fresh Session）",
        "forced" => "Forced Rollover（临限强制）",
        "emergency" => "Emergency Rollover",
        _ => "未知",
    }
}

fn lines_of(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty()).map(ToOwned::to_owned).collect()
}

impl TaskUi {
    /// 应用一次 task.overview 返回。返回 true 表示需要重新拉取。
    pub fn apply(&mut self, value: &Value) -> bool {
        self.error = None;
        if let Some(task_id) = value.get("taskId").and_then(Value::as_str) {
            if value.get("attached").is_some() {
                self.context.insert(task_id.to_owned(), value.clone());
                return false;
            }
        }
        if value.get("rollovers").is_some() {
            // continuity.history：响应无 taskId，按请求顺序关联（pending_history 队列）。
            let task_id = self.pending_history.pop().unwrap_or_default();
            if !task_id.is_empty() {
                self.rollovers.insert(task_id, parse_rollover_history(value));
            }
            return false;
        }
        if value.get("tasks").is_some() || value.get("counts").is_some() {
            self.details = parse_details(value);
            self.counts = parse_counts(value);
            self.attention = parse_attention(value);
            self.loaded = true;
            return false;
        }
        if value.get("deleted").is_some() {
            self.notice = Some("任务已删除，正在刷新…".to_owned());
            return true;
        }
        if value.get("id").is_some() {
            self.notice = Some("任务已更新，正在刷新…".to_owned());
            return true;
        }
        if value.get("task").is_some() {
            self.notice = Some("任务已更新，正在刷新…".to_owned());
            return true;
        }
        false
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    fn overview_params(&self) -> Value {
        let mut map = Map::new();
        if !self.status_filter.is_empty() {
            map.insert("status".to_owned(), Value::String(self.status_filter.clone()));
        }
        if !self.workspace_filter.trim().is_empty() {
            map.insert("workspaceId".to_owned(), Value::String(self.workspace_filter.trim().to_owned()));
        }
        if !self.query.trim().is_empty() {
            map.insert("query".to_owned(), Value::String(self.query.trim().to_owned()));
        }
        map.insert("limit".to_owned(), json!(100));
        Value::Object(map)
    }

    fn overview_action(&self) -> TaskAction {
        TaskAction::new("task.overview", self.overview_params())
    }

    /// 渲染 Tasks 页，返回本帧需要下发的调用意图。
    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<TaskAction> {
        let mut actions: Vec<TaskAction> = Vec::new();

        ui.label(
            egui::RichText::new("Task 由 CetaMesh 持有，独立于任何 Agent Session；更换 Provider 不会新建 Task。")
                .color(native_palette().muted),
        );
        ui.add_space(4.0);

        if !self.requested {
            self.requested = true;
            actions.push(self.overview_action());
        }
        if let Some(error) = &self.error {
            ui.colored_label(native_palette().error, error.as_str());
        }
        if let Some(notice) = &self.notice {
            ui.weak(notice.as_str());
        }

        // ── 计数 / Needs Attention ────────────────────────────────────────
        ui.horizontal_wrapped(|ui| {
            for (name, count) in self.counts.clone() {
                ui.label(egui::RichText::new(format!("{name} {count}")).color(status_color(&name)).strong());
            }
        });
        if !self.attention.is_empty() {
            ui.colored_label(native_palette().warning, format!("Needs Attention：{} 个任务需要人介入", self.attention.len()));
        }

        // ── 过滤 ──────────────────────────────────────────────────────────
        egui::Frame::new()
            .fill(native_palette().surface_alt)
            .stroke(egui::Stroke::new(1.0, native_palette().border))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label("状态");
                    egui::ComboBox::from_id_salt("task_status_filter")
                        .selected_text(if self.status_filter.is_empty() { "全部".to_owned() } else { self.status_filter.clone() })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.status_filter, String::new(), "全部");
                            for status in TASK_STATUSES {
                                ui.selectable_value(&mut self.status_filter, status.to_owned(), status);
                            }
                        });
                    ui.label("Workspace");
                    ui.add(egui::TextEdit::singleline(&mut self.workspace_filter).desired_width(150.0).hint_text("ws-id"));
                    ui.label("搜索");
                    ui.add(egui::TextEdit::singleline(&mut self.query).desired_width(180.0).hint_text("goal / phase / 需求"));
                    ui.checkbox(&mut self.only_attention, "只看 Needs Attention");
                    if ui.button("刷新").clicked() {
                        actions.push(self.overview_action());
                    }
                });
            });

        // ── 新建 ──────────────────────────────────────────────────────────
        ui.add_space(8.0);
        ui.label(egui::RichText::new("新建 Task").strong());
        egui::Grid::new("task_new_grid").num_columns(2).show(ui, |ui| {
            ui.label("Goal");
            ui.add(egui::TextEdit::singleline(&mut self.new_goal).desired_width(520.0).hint_text("这个 Task 要达成什么"));
            ui.end_row();
            ui.label("Workspace");
            ui.add(egui::TextEdit::singleline(&mut self.new_workspace).desired_width(240.0).hint_text("ws-id（可留空）"));
            ui.end_row();
            ui.label("当前阶段");
            ui.add(egui::TextEdit::singleline(&mut self.new_phase).desired_width(240.0).hint_text("foundation"));
            ui.end_row();
            ui.label("需求（每行一条）");
            ui.add(egui::TextEdit::multiline(&mut self.new_requirements).desired_rows(2).desired_width(520.0));
            ui.end_row();
            ui.label("验收标准（每行一条）");
            ui.add(egui::TextEdit::multiline(&mut self.new_acceptance).desired_rows(2).desired_width(520.0));
            ui.end_row();
        });
        let can_create = !self.new_goal.trim().is_empty();
        if ui.add_enabled(can_create, egui::Button::new("创建 Task")).clicked() {
            actions.push(TaskAction::new("task.create", json!({
                "goal": self.new_goal,
                "workspaceId": if self.new_workspace.trim().is_empty() { Value::Null } else { Value::String(self.new_workspace.trim().to_owned()) },
                "currentPhase": self.new_phase,
                "requirements": lines_of(&self.new_requirements),
                "acceptanceCriteria": lines_of(&self.new_acceptance),
            })));
            self.new_goal.clear();
            self.new_phase.clear();
            self.new_requirements.clear();
            self.new_acceptance.clear();
        }

        // ── 列表 ──────────────────────────────────────────────────────────
        ui.add_space(10.0);
        ui.separator();
        let visible: Vec<TaskDetail> = self
            .details
            .iter()
            .filter(|task| !self.only_attention || self.attention.contains(&task.id))
            .cloned()
            .collect();
        ui.label(egui::RichText::new(format!("任务（{}）", visible.len())).strong());
        if visible.is_empty() {
            ui.weak(if self.loaded { "没有符合条件的任务。" } else { "正在读取任务…" });
        }

        let mut want_select: Option<String> = None;
        for task in &visible {
            let attention = self.attention.contains(&task.id);
            egui::Frame::new()
                .fill(native_palette().surface_alt)
                .stroke(egui::Stroke::new(1.0, if attention { native_palette().warning } else { native_palette().border }))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(12, 10))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(format!("[{}]", task.status)).color(status_color(&task.status)).strong());
                        ui.label(egui::RichText::new(task.goal.as_str()).strong());
                        if attention {
                            ui.colored_label(native_palette().warning, "Needs Attention");
                        }
                    });
                    ui.horizontal_wrapped(|ui| {
                        ui.weak(format!("rev {}", task.rev));
                        ui.weak(format!("{}%", task.progress_percent));
                        if !task.current_phase.is_empty() {
                            ui.weak(format!("阶段 {}", task.current_phase));
                        }
                        if !task.workspace_id.is_empty() {
                            ui.weak(format!("workspace {}", task.workspace_id));
                        }
                        if !task.current_agent.is_empty() {
                            ui.weak(format!("agent {}", task.current_agent));
                        }
                    });
                    ui.add(egui::ProgressBar::new((task.progress_percent as f32) / 100.0).desired_width(320.0));
                    ui.horizontal(|ui| {
                        if ui.button("打开").clicked() {
                            want_select = Some(task.id.clone());
                        }
                        if task.status == "queued" || task.status == "paused" || task.status == "waiting" || task.status == "blocked" {
                            if ui.button("开始 / 恢复").clicked() {
                                actions.push(TaskAction::new("task.start", json!({ "id": task.id, "expectedRev": task.rev })));
                            }
                        }
                        if task.status == "running" {
                            if ui.button("暂停").clicked() {
                                actions.push(TaskAction::new("task.pause", json!({ "id": task.id, "expectedRev": task.rev, "reason": "用户暂停" })));
                            }
                            if ui.button("完成").clicked() {
                                actions.push(TaskAction::new("task.complete", json!({ "id": task.id, "expectedRev": task.rev, "summary": "由 Work 页标记完成" })));
                            }
                        }
                        let terminal = task.status == "completed" || task.status == "failed" || task.status == "cancelled";
                        if !terminal && ui.button("取消").clicked() {
                            actions.push(TaskAction::new("task.cancel", json!({ "id": task.id, "expectedRev": task.rev, "reason": "用户取消" })));
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
            .and_then(|id| self.details.iter().find(|task| &task.id == id).cloned());
        if let Some(task) = selected {
            ui.add_space(12.0);
            ui.separator();
            let attention = self.attention.contains(&task.id);
            ui.horizontal_wrapped(|ui| {
                ui.label(egui::RichText::new(format!("Task {}", task.id)).strong());
                ui.label(egui::RichText::new(format!("[{}]", task.status)).color(status_color(&task.status)).strong());
                ui.weak(format!("rev {}", task.rev));
                if attention {
                    ui.colored_label(native_palette().warning, "Needs Attention");
                }
                if ui.button("关闭详情").clicked() {
                    self.selected = None;
                }
            });
            ui.label(egui::RichText::new(task.goal.as_str()).strong());
            ui.add(egui::ProgressBar::new((task.progress_percent as f32) / 100.0).desired_width(360.0).text(format!("{}%", task.progress_percent)));
            if !task.progress_note.is_empty() {
                ui.weak(task.progress_note.as_str());
            }

            ui.horizontal_wrapped(|ui| {
                ui.weak(format!("Workspace：{}", if task.workspace_id.is_empty() { "未绑定" } else { task.workspace_id.as_str() }));
                ui.weak(format!("阶段：{}", if task.current_phase.is_empty() { "—" } else { task.current_phase.as_str() }));
                ui.weak(format!("Task Agent：{}", if task.agent_provider.is_empty() { "未绑定" } else { task.agent_provider.as_str() }));
                ui.weak(format!("Session：{}", if task.agent_session.is_empty() { "未绑定" } else { task.agent_session.as_str() }));
                if !task.checkpoint_summary.is_empty() {
                    ui.weak(format!("Checkpoint：{}", task.checkpoint_summary.as_str()));
                }
            });

            let session_key = format!("{}:{}", task.agent_provider, task.agent_session);
            // 选中任务自动读取 Continuity 状态（每任务一次；页面回到详情即有数据）。
            if !task.agent_session.is_empty() && !self.context_issued.contains(&task.id) {
                self.context_issued.push(task.id.clone());
                actions.push(TaskAction::new("continuity.status", json!({ "taskId": task.id })));
                self.pending_history.push(task.id.clone());
                actions.push(TaskAction::new("continuity.history", json!({ "taskId": task.id })));
            }
            let context = self.context.get(&task.id)
                .filter(|value| value.get("sessionKey").and_then(Value::as_str) == Some(session_key.as_str()))
                .cloned();
            ui.horizontal_wrapped(|ui| {
                if let Some(value) = &context {
                    let level = value.get("level").unwrap_or(&Value::Null);
                    let percent = level.get("percent").and_then(Value::as_u64);
                    let source = string_field(level, "source");
                    let source_text = if source == "usage" { "真实 usage".to_owned() } else if source == "estimated" { "字符估算".to_owned() } else { source };
                    ui.weak(match percent {
                        Some(percent) => format!("Context：{percent}%（{source_text}）"),
                        None => "Context：未知".to_owned(),
                    });
                    let action_text = continuity_action_hint(&string_field(value, "action"));
                    let hint = match percent {
                        Some(percent) if percent >= 85 => format!("{action_text}"),
                        Some(percent) if percent >= 70 => format!("{action_text}"),
                        _ => action_text.to_owned(),
                    };
                    ui.weak(format!("建议：{hint}"));
                    let strategy = value.get("strategy").unwrap_or(&Value::Null);
                    if strategy.is_object() {
                        ui.weak(format!(
                            "Rollover 策略：{}（实现 {}）",
                            string_field(strategy, "preferred"),
                            string_field(strategy, "implemented")
                        ));
                    }
                } else {
                    ui.weak(if task.agent_session.is_empty() { "Context：未绑定 Agent Session" } else { "Context：读取中…" });
                }
                if !task.agent_session.is_empty() && ui.button("重新读取 Context").clicked() {
                    self.context_issued.retain(|id| id != &task.id);
                }
            });

            // Rollover 历史：让 Owner 看到发生了什么（同一 Task 换了 Session）。
            if let Some(entries) = self.rollovers.get(&task.id) {
                if !entries.is_empty() {
                    egui::CollapsingHeader::new(format!("Rollover 历史（{}）", entries.len()))
                        .default_open(false)
                        .show(ui, |ui| {
                            for entry in entries {
                                ui.horizontal_wrapped(|ui| {
                                    ui.weak(format!(
                                        "#{} {} → {} · {}{} · seq {}",
                                        entry.sequence,
                                        entry.from,
                                        entry.to,
                                        entry.reason,
                                        if entry.cross_provider { " · 跨 Provider" } else { "" },
                                        entry.at,
                                    ));
                                });
                            }
                            ui.weak("以上为同一 Task 的 Fresh Session 交接记录；Task ID 始终不变。");
                        });
                }
            }

            egui::CollapsingHeader::new(format!("需求（{}）", task.requirements.len())).show(ui, |ui| {
                for item in &task.requirements { ui.label(item.as_str()); }
                if task.requirements.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("已完成工作（{}）", task.completed_work.len())).show(ui, |ui| {
                for item in &task.completed_work { ui.label(item.as_str()); }
                if task.completed_work.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("待完成工作（{}）", task.pending_work.len())).show(ui, |ui| {
                for item in &task.pending_work { ui.label(item.as_str()); }
                if task.pending_work.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("验收标准（{}）", task.acceptance.len())).show(ui, |ui| {
                for (text, met) in &task.acceptance {
                    ui.label(format!("{} {}", if *met { "✔" } else { "✗" }, text));
                }
                if task.acceptance.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("Artifacts（{}）", task.artifacts.len())).show(ui, |ui| {
                for item in &task.artifacts { ui.label(item.as_str()); }
                if task.artifacts.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("Agent History（{}）", task.agent_history.len())).show(ui, |ui| {
                for item in &task.agent_history { ui.label(item.as_str()); }
                if task.agent_history.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("Decisions（{}）", task.decisions.len())).show(ui, |ui| {
                for item in &task.decisions { ui.label(item.as_str()); }
                if task.decisions.is_empty() { ui.weak("无"); }
            });
            egui::CollapsingHeader::new(format!("Memory References（{}）", task.memory_refs.len())).show(ui, |ui| {
                for item in &task.memory_refs { ui.label(item.as_str()); }
                if task.memory_refs.is_empty() { ui.weak("无"); }
            });

            // 详情内动作
            let terminal = task.status == "completed" || task.status == "failed" || task.status == "cancelled";
            ui.horizontal_wrapped(|ui| {
                if !terminal && task.status != "running" && ui.button("开始 / 恢复").clicked() {
                    actions.push(TaskAction::new("task.resume", json!({ "id": task.id, "expectedRev": task.rev })));
                }
                if task.status == "running" {
                    if ui.button("暂停").clicked() {
                        actions.push(TaskAction::new("task.pause", json!({ "id": task.id, "expectedRev": task.rev, "reason": "用户暂停" })));
                    }
                    if ui.button("等待").clicked() {
                        actions.push(TaskAction::new("task.wait", json!({ "id": task.id, "expectedRev": task.rev, "reason": "等待外部输入" })));
                    }
                    if ui.button("阻塞").clicked() {
                        actions.push(TaskAction::new("task.block", json!({ "id": task.id, "expectedRev": task.rev, "reason": "遇到阻塞" })));
                    }
                }
                if !terminal {
                    if ui.button("标记完成").clicked() {
                        actions.push(TaskAction::new("task.complete", json!({ "id": task.id, "expectedRev": task.rev, "summary": "由 Work 页标记完成" })));
                    }
                    if ui.button("标记失败").clicked() {
                        actions.push(TaskAction::new("task.fail", json!({ "id": task.id, "expectedRev": task.rev, "reason": "由 Work 页标记失败" })));
                    }
                }
            });

            // Agent Provider 切换
            ui.horizontal_wrapped(|ui| {
                ui.label("绑定 Agent Provider");
                ui.add(egui::TextEdit::singleline(&mut self.agent_provider).desired_width(110.0));
                ui.add(egui::TextEdit::singleline(&mut self.agent_session).desired_width(150.0).hint_text("session id"));
                let ready = !self.agent_provider.trim().is_empty() && !self.agent_session.trim().is_empty();
                if ui.add_enabled(ready, egui::Button::new("绑定 / 更换")).clicked() {
                    actions.push(TaskAction::new("task.agent.attach", json!({
                        "id": task.id,
                        "expectedRev": task.rev,
                        "provider": self.agent_provider,
                        "sessionId": self.agent_session,
                    })));
                }
            });

            // Checkpoint / 工作项 / 产物
            ui.horizontal_wrapped(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.checkpoint_summary).desired_width(240.0).hint_text("checkpoint 摘要"));
                ui.add(egui::TextEdit::singleline(&mut self.checkpoint_next).desired_width(200.0).hint_text("下一步"));
                if ui.button("写入 Checkpoint").clicked() {
                    actions.push(TaskAction::new("task.checkpoint.set", json!({
                        "id": task.id,
                        "expectedRev": task.rev,
                        "summary": self.checkpoint_summary,
                        "nextAction": self.checkpoint_next,
                    })));
                }
            });
            ui.horizontal_wrapped(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.work_text).desired_width(240.0).hint_text("工作项"));
                let ready = !self.work_text.trim().is_empty();
                if ui.add_enabled(ready, egui::Button::new("记入已完成")).clicked() {
                    actions.push(TaskAction::new("task.work.add", json!({
                        "id": task.id, "expectedRev": task.rev, "kind": "completed", "text": self.work_text,
                    })));
                    self.work_text.clear();
                }
                if ui.add_enabled(ready, egui::Button::new("记入待完成")).clicked() {
                    actions.push(TaskAction::new("task.work.add", json!({
                        "id": task.id, "expectedRev": task.rev, "kind": "pending", "text": self.work_text,
                    })));
                    self.work_text.clear();
                }
                ui.add(egui::TextEdit::singleline(&mut self.artifact_label).desired_width(200.0).hint_text("artifact 名称"));
                let ready_artifact = !self.artifact_label.trim().is_empty();
                if ui.add_enabled(ready_artifact, egui::Button::new("添加 Artifact")).clicked() {
                    actions.push(TaskAction::new("task.artifact.add", json!({
                        "id": task.id, "expectedRev": task.rev, "kind": "file", "label": self.artifact_label,
                    })));
                    self.artifact_label.clear();
                }
            });
        }

        actions
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_attention, parse_counts, parse_details};
    use serde_json::json;

    #[test]
    fn parses_task_details_from_overview_payload() {
        let value = json!({
            "tasks": [
                {
                    "id": "task_1",
                    "goal": "交付 v1",
                    "status": "running",
                    "currentPhase": "foundation",
                    "progress": { "percent": 40, "note": "进行中" },
                    "requirements": ["Chat", "Tasks"],
                    "completedWork": [{ "at": 1, "text": "配置服务" }],
                    "pendingWork": [{ "at": 2, "text": "真机验收" }],
                    "workspaceId": "ws-1",
                    "artifacts": [{ "id": "a1", "kind": "test", "label": "t.mjs", "ref": "scripts/t.mjs" }],
                    "decisions": [{ "at": 1, "decision": "Task 独立于 Session" }],
                    "memoryRefs": [{ "memoryId": "mem_1" }],
                    "checkpoint": { "at": 5, "summary": "已过半", "nextAction": "接 UI" },
                    "acceptance": [{ "text": "可安装", "met": true }],
                    "agentHistory": [{ "provider": "dsh", "sessionId": "s1", "attachedAt": 1, "detachedAt": 2 }],
                    "currentAgent": { "provider": "codex", "sessionId": "s2" },
                    "rev": 7,
                    "updatedAt": 99
                }
            ]
        });
        let details = parse_details(&value);
        assert_eq!(details.len(), 1);
        let task = &details[0];
        assert_eq!(task.id, "task_1");
        assert_eq!(task.status, "running");
        assert_eq!(task.progress_percent, 40);
        assert_eq!(task.requirements.len(), 2);
        assert_eq!(task.completed_work, vec!["配置服务".to_string()]);
        assert_eq!(task.pending_work.len(), 1);
        assert_eq!(task.workspace_id, "ws-1");
        assert_eq!(task.artifacts.len(), 1);
        assert_eq!(task.decisions.len(), 1);
        assert_eq!(task.memory_refs, vec!["mem_1".to_string()]);
        assert_eq!(task.checkpoint_next, "接 UI");
        assert_eq!(task.acceptance[0], ("可安装".to_string(), true));
        assert_eq!(task.agent_history.len(), 1);
        assert_eq!(task.current_agent, "codex / s2");
        assert_eq!(task.agent_provider, "codex");
        assert_eq!(task.agent_session, "s2");
        assert_eq!(task.rev, 7);
        assert_eq!(task.updated_at, 99);
        assert!(parse_details(&json!({})).is_empty());
    }

    #[test]
    fn parses_counts_and_attention_in_status_order() {
        let value = json!({
            "counts": { "queued": 1, "running": 2, "completed": 3 },
            "needsAttention": ["task_a", "task_b"]
        });
        let counts = parse_counts(&value);
        assert_eq!(counts.len(), 8);
        assert_eq!(counts[0], ("queued".to_string(), 1));
        assert_eq!(counts[1], ("running".to_string(), 2));
        assert_eq!(counts[5], ("completed".to_string(), 3));
        assert_eq!(counts[3], ("blocked".to_string(), 0));
        assert_eq!(parse_attention(&value), vec!["task_a".to_string(), "task_b".to_string()]);
    }

    #[test]
    fn parses_tasks_without_optional_sections() {
        let value = json!({ "tasks": [{ "id": "t", "goal": "g", "status": "queued" }] });
        let details = parse_details(&value);
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].progress_percent, 0);
        assert!(details[0].requirements.is_empty());
        assert!(details[0].current_agent.is_empty());
        assert_eq!(details[0].checkpoint_next, "");
    }

    #[test]
    fn context_status_preserves_unknown_and_estimated_provider_data() {
        let mut ui = super::TaskUi::default();
        assert!(ui.context.is_empty());
        let status = json!({ "taskId": "t", "attached": true, "sessionKey": "dsh:s1",
            "level": { "percent": 70, "estimated": true, "source": "estimated", "band": "prepare" },
            "action": "checkpoint" });
        assert!(!ui.apply(&status));
        assert_eq!(ui.context["t"], status);
        assert!(!ui.loaded, "context results do not replace Task overview");
        assert!(!ui.apply(&json!({ "taskId": "t", "attached": false, "action": "none" })));
        assert!(ui.context["t"].get("level").is_none());
    }

    #[test]
    fn parses_rollover_history_entries() {
        let value = json!({ "rollovers": [
            { "sequence": 1, "from": { "provider": "dsh", "sessionId": "sA" },
              "to": { "provider": "dsh", "sessionId": "sB" }, "reason": "context-threshold",
              "crossProvider": false, "at": 1759651200000u64 },
            { "sequence": 2, "from": { "provider": "dsh", "sessionId": "sB" },
              "to": { "provider": "cetamesh", "sessionId": "sC" }, "reason": "provider-switch",
              "crossProvider": true, "at": 1759651300000u64 },
            { "sequence": 3 }
        ]});
        let rows = super::parse_rollover_history(&value);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].from, "dsh:sA");
        assert_eq!(rows[0].to, "dsh:sB");
        assert_eq!(rows[0].reason, "context-threshold");
        assert!(!rows[0].cross_provider);
        assert!(rows[1].cross_provider);
        assert_eq!(rows[2].from, ":");
        assert_eq!(super::parse_rollover_history(&json!({ "total": 0 })), Vec::new());
    }

    #[test]
    fn rollover_history_response_binds_to_pending_request_order() {
        let mut ui = super::TaskUi::default();
        ui.pending_history.push("task-b".to_owned());
        ui.pending_history.push("task-a".to_owned());
        let payload = json!({ "rollovers": [ { "sequence": 4, "from": { "provider": "dsh", "sessionId": "s1" },
            "to": { "provider": "dsh", "sessionId": "s2" }, "reason": "context-threshold", "crossProvider": false, "at": 1 } ]});
        assert!(!ui.apply(&payload));
        assert_eq!(ui.rollovers["task-a"].len(), 1, "响应无 taskId：按请求顺序（LIFO）关联");
        ui.pending_history.clear();
    }

    #[test]
    fn continuity_action_hints_cover_all_bands() {
        assert_eq!(super::continuity_action_hint("none"), "正常");
        assert_eq!(super::continuity_action_hint("checkpoint"), "建议生成 Checkpoint");
        assert_eq!(super::continuity_action_hint("ready"), "寻求安全点（接近 rollover）");
        assert_eq!(super::continuity_action_hint("rollover"), "达到 Rollover 阈值（将自动 Fresh Session）");
        assert_eq!(super::continuity_action_hint("forced"), "Forced Rollover（临限强制）");
        assert_eq!(super::continuity_action_hint("emergency"), "Emergency Rollover");
        assert_eq!(super::continuity_action_hint("mystery"), "未知");
    }
}
