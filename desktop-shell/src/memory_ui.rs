//! CetaMesh Desktop —— Memory 产品页（阶段 04）。
//!
//! 只做两件事：维护页面状态、把用户操作翻译成 Core 调用意图（MemoryAction）。
//! 真正下发 IPC 的是 native_ui（唯一持有 CoreApi 的地方），因此本模块不依赖 worker。
//!
//! 产品约束（与 src/memory/ 一致）：
//! - 列表只展示 Core 授权后返回的记录；本页不做任何本地"全量再过滤"。
//! - 模型提出的候选必须由用户在此页显式确认，才会写入长期记忆。
//! - 编辑 / 删除携带 rev，冲突时由 Core 返回错误而不是静默覆盖。

use eframe::egui;
use serde_json::{Map, Value, json};

const SURFACE_ALT: egui::Color32 = egui::Color32::from_rgb(246, 249, 248);
const BORDER: egui::Color32 = egui::Color32::from_rgb(220, 228, 226);
const ACCENT: egui::Color32 = egui::Color32::from_rgb(23, 126, 115);
const MUTED: egui::Color32 = egui::Color32::from_rgb(103, 119, 117);
const ERROR: egui::Color32 = egui::Color32::from_rgb(174, 54, 49);

const MEMORY_TYPES: [&str; 5] = ["working", "chat", "user", "task", "workspace"];

/// 一条待下发的 Core 调用意图。
pub struct MemoryAction {
    pub method: &'static str,
    pub params: Value,
}

impl MemoryAction {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

#[derive(Clone, Debug, Default)]
pub struct MemoryRow {
    pub id: String,
    pub type_name: String,
    pub scope: String,
    pub content: String,
    pub source: String,
    pub pinned: bool,
    pub updated_at: u64,
    pub rev: u64,
}

#[derive(Clone, Debug, Default)]
pub struct MemoryCandidateRow {
    pub id: String,
    pub status: String,
    pub type_name: String,
    pub scope: String,
    pub content: String,
    pub reason: String,
    pub proposed_by: String,
}

pub fn parse_memories(value: &Value) -> Vec<MemoryRow> {
    let items = value.get("memories").and_then(Value::as_array);
    let Some(items) = items else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| MemoryRow {
            id: string_field(item, "id"),
            type_name: string_field(item, "type"),
            scope: string_field(item, "scope"),
            content: string_field(item, "content"),
            source: string_field(item, "source"),
            pinned: item.get("pinned").and_then(Value::as_bool).unwrap_or(false),
            updated_at: item.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
            rev: item.get("rev").and_then(Value::as_u64).unwrap_or(0),
        })
        .collect()
}

pub fn parse_candidates(value: &Value) -> Vec<MemoryCandidateRow> {
    let items = value.get("candidates").and_then(Value::as_array);
    let Some(items) = items else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| MemoryCandidateRow {
            id: string_field(item, "id"),
            status: string_field(item, "status"),
            type_name: string_field(item, "type"),
            scope: string_field(item, "scope"),
            content: string_field(item, "content"),
            reason: string_field(item, "reason"),
            proposed_by: string_field(item, "proposedBy"),
        })
        .collect()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// 无依赖的时间格式化（epoch ms -> 本地无时区的 YYYY-MM-DD HH:MM）。
fn format_time(ms: u64) -> String {
    if ms == 0 {
        return "—".to_owned();
    }
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        year,
        month,
        day,
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

pub struct MemoryUi {
    pub loaded: bool,
    requested: bool,
    pub rows: Vec<MemoryRow>,
    pub candidates: Vec<MemoryCandidateRow>,
    pub query: String,
    pub scope_filter: String,
    pub type_filter: String,
    pub pinned_only: bool,
    pub notice: Option<String>,
    pub error: Option<String>,
    pub new_type: String,
    pub new_scope: String,
    pub new_content: String,
    pub edit_id: Option<String>,
    pub edit_rev: u64,
    pub edit_draft: String,
}

impl Default for MemoryUi {
    fn default() -> Self {
        Self {
            loaded: false,
            requested: false,
            rows: Vec::new(),
            candidates: Vec::new(),
            query: String::new(),
            scope_filter: String::new(),
            type_filter: String::new(),
            pinned_only: false,
            notice: None,
            error: None,
            new_type: "chat".to_owned(),
            new_scope: "chat:default".to_owned(),
            new_content: String::new(),
            edit_id: None,
            edit_rev: 0,
            edit_draft: String::new(),
        }
    }
}

impl MemoryUi {
    /// 应用一次 Core 返回值。返回 true 表示需要重新拉取页面聚合数据。
    pub fn apply(&mut self, value: &Value) -> bool {
        self.error = None;
        let mut snapshot = false;
        if value.get("memories").is_some() {
            self.rows = parse_memories(value);
            self.loaded = true;
            snapshot = true;
        }
        if value.get("candidates").is_some() {
            self.candidates = parse_candidates(value);
            snapshot = true;
        }
        if snapshot {
            return false;
        }
        if value.get("candidate").is_some() {
            self.notice = Some("候选已处理，正在刷新…".to_owned());
            return true;
        }
        if value.get("deleted").is_some() {
            self.notice = Some("记忆已删除，正在刷新…".to_owned());
            return true;
        }
        if value.get("id").is_some() {
            self.notice = Some("记忆已保存，正在刷新…".to_owned());
            return true;
        }
        false
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    fn list_params(&self) -> Value {
        let mut map = Map::new();
        if !self.query.trim().is_empty() {
            map.insert("query".to_owned(), Value::String(self.query.trim().to_owned()));
        }
        if !self.scope_filter.trim().is_empty() {
            map.insert(
                "scope".to_owned(),
                Value::String(self.scope_filter.trim().to_owned()),
            );
        }
        if !self.type_filter.is_empty() {
            map.insert("types".to_owned(), json!([self.type_filter]));
        }
        if self.pinned_only {
            map.insert("pinned".to_owned(), Value::Bool(true));
        }
        map.insert("limit".to_owned(), json!(100));
        Value::Object(map)
    }

    fn overview_action(&self) -> MemoryAction {
        MemoryAction::new("memory.overview", self.list_params())
    }

    /// 渲染 Memory 页，返回本帧需要下发的调用意图。
    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<MemoryAction> {
        let mut actions: Vec<MemoryAction> = Vec::new();

        ui.label(
            egui::RichText::new("统一记忆：检索先经授权，长期记忆只在用户确认后写入。")
                .color(MUTED),
        );
        ui.add_space(4.0);

        if !self.requested {
            self.requested = true;
            actions.push(self.overview_action());
        }

        if let Some(error) = &self.error {
            ui.colored_label(ERROR, error.as_str());
        }

        // ── 过滤 / 查询 ──────────────────────────────────────────────────
        egui::Frame::new()
            .fill(SURFACE_ALT)
            .stroke(egui::Stroke::new(1.0, BORDER))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label("搜索");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.query)
                            .desired_width(200.0)
                            .hint_text("内容或标签"),
                    );
                    ui.label("Scope");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.scope_filter)
                            .desired_width(170.0)
                            .hint_text("chat:c1"),
                    );
                    ui.label("类型");
                    egui::ComboBox::from_id_salt("memory_type_filter")
                        .selected_text(if self.type_filter.is_empty() {
                            "全部".to_owned()
                        } else {
                            self.type_filter.clone()
                        })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.type_filter, String::new(), "全部");
                            for kind in MEMORY_TYPES {
                                ui.selectable_value(
                                    &mut self.type_filter,
                                    kind.to_owned(),
                                    kind,
                                );
                            }
                        });
                    ui.checkbox(&mut self.pinned_only, "只看 Pin");
                    if ui.button("查询").clicked() {
                        self.notice = None;
                        actions.push(self.overview_action());
                    }
                    if ui.button("重置").clicked() {
                        self.query.clear();
                        self.scope_filter.clear();
                        self.type_filter.clear();
                        self.pinned_only = false;
                        actions.push(self.overview_action());
                    }
                });
            });

        if let Some(notice) = &self.notice {
            ui.add_space(4.0);
            ui.weak(notice.as_str());
        }

        // ── 待确认候选（模型提出，用户确认） ──────────────────────────────
        let pending: Vec<MemoryCandidateRow> = self
            .candidates
            .iter()
            .filter(|candidate| candidate.status == "pending")
            .cloned()
            .collect();
        if !pending.is_empty() {
            ui.add_space(10.0);
            ui.label(
                egui::RichText::new(format!("待确认的 Chat Memory 候选（{}）", pending.len()))
                    .strong(),
            );
            ui.label(
                egui::RichText::new("模型只能提出候选；只有你确认后才会写入长期记忆。")
                    .color(MUTED),
            );
            for candidate in &pending {
                ui.group(|ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(
                            egui::RichText::new(format!(
                                "[{}] {}",
                                candidate.type_name, candidate.scope
                            ))
                            .strong(),
                        );
                        ui.weak(format!("来自 {}", candidate.proposed_by));
                    });
                    ui.label(candidate.content.as_str());
                    if !candidate.reason.is_empty() {
                        ui.weak(format!("理由：{}", candidate.reason));
                    }
                    ui.horizontal(|ui| {
                        if ui.button("确认写入").clicked() {
                            actions.push(MemoryAction::new(
                                "memory.candidates.confirm",
                                json!({ "id": candidate.id, "decision": "accept" }),
                            ));
                        }
                        if ui.button("拒绝").clicked() {
                            actions.push(MemoryAction::new(
                                "memory.candidates.confirm",
                                json!({ "id": candidate.id, "decision": "reject" }),
                            ));
                        }
                    });
                });
            }
        }

        // ── 编辑中的记忆 ────────────────────────────────────────────────
        if let Some(edit_id) = self.edit_id.clone() {
            ui.add_space(10.0);
            ui.group(|ui| {
                ui.label(egui::RichText::new(format!("编辑记忆 {edit_id}")).strong());
                ui.add(
                    egui::TextEdit::multiline(&mut self.edit_draft)
                        .desired_rows(3)
                        .desired_width(f32::INFINITY),
                );
                ui.horizontal(|ui| {
                    if ui.button("保存修改").clicked() {
                        actions.push(MemoryAction::new(
                            "memory.update",
                            json!({
                                "id": edit_id.clone(),
                                "expectedRev": self.edit_rev,
                                "content": self.edit_draft.clone(),
                            }),
                        ));
                        self.edit_id = None;
                    }
                    if ui.button("取消编辑").clicked() {
                        self.edit_id = None;
                    }
                });
            });
        }

        // ── 新建 ────────────────────────────────────────────────────────
        ui.add_space(10.0);
        ui.label(egui::RichText::new("新建记忆").strong());
        egui::Grid::new("memory_new_grid")
            .num_columns(2)
            .show(ui, |ui| {
                ui.label("类型");
                egui::ComboBox::from_id_salt("memory_new_type")
                    .selected_text(self.new_type.clone())
                    .show_ui(ui, |ui| {
                        for kind in MEMORY_TYPES {
                            ui.selectable_value(&mut self.new_type, kind.to_owned(), kind);
                        }
                    });
                ui.end_row();
                ui.label("Scope");
                ui.add(egui::TextEdit::singleline(&mut self.new_scope).desired_width(240.0));
                ui.end_row();
                ui.label("内容");
                ui.add(
                    egui::TextEdit::multiline(&mut self.new_content)
                        .desired_rows(3)
                        .desired_width(520.0),
                );
                ui.end_row();
            });
        let can_create = !self.new_content.trim().is_empty() && !self.new_scope.trim().is_empty();
        if ui
            .add_enabled(can_create, egui::Button::new("创建记忆"))
            .clicked()
        {
            actions.push(MemoryAction::new(
                "memory.create",
                json!({
                    "type": self.new_type,
                    "scope": self.new_scope,
                    "content": self.new_content,
                }),
            ));
            self.new_content.clear();
        }

        // ── 列表 ────────────────────────────────────────────────────────
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new(format!("记忆（{}）", self.rows.len())).strong());
            ui.weak("来源 / 更新时间 / Scope / rev");
        });
        if self.rows.is_empty() {
            ui.weak(if self.loaded {
                "当前条件下没有记忆。"
            } else {
                "正在读取记忆…"
            });
        }

        let rows = self.rows.clone();
        let mut want_edit: Option<(String, u64, String)> = None;
        for row in &rows {
            egui::Frame::new()
                .fill(SURFACE_ALT)
                .stroke(egui::Stroke::new(1.0, BORDER))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(12, 10))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(
                            egui::RichText::new(if row.pinned { "★" } else { "☆" }).color(ACCENT),
                        );
                        ui.label(egui::RichText::new(format!("[{}]", row.type_name)).strong());
                        ui.weak(row.scope.as_str());
                        ui.weak(format!("来源 {}", row.source));
                        ui.weak(format_time(row.updated_at));
                        ui.weak(format!("rev {}", row.rev));
                    });
                    ui.label(row.content.as_str());
                    ui.horizontal(|ui| {
                        if ui
                            .button(if row.pinned { "取消 Pin" } else { "Pin" })
                            .clicked()
                        {
                            actions.push(MemoryAction::new(
                                "memory.pin",
                                json!({
                                    "id": row.id,
                                    "expectedRev": row.rev,
                                    "pinned": !row.pinned,
                                }),
                            ));
                        }
                        if ui.button("编辑").clicked() {
                            want_edit = Some((row.id.clone(), row.rev, row.content.clone()));
                        }
                        if ui.button("删除").clicked() {
                            actions.push(MemoryAction::new(
                                "memory.delete",
                                json!({ "id": row.id, "expectedRev": row.rev }),
                            ));
                        }
                    });
                });
        }
        if let Some((id, rev, content)) = want_edit {
            self.edit_id = Some(id);
            self.edit_rev = rev;
            self.edit_draft = content;
        }

        actions
    }
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, format_time, parse_candidates, parse_memories};
    use serde_json::json;

    #[test]
    fn parses_memory_rows_from_core_payload() {
        let value = json!({
            "memories": [
                {
                    "id": "m1",
                    "type": "chat",
                    "scope": "chat:c1",
                    "content": "记住这条",
                    "source": "qq-adapter",
                    "pinned": true,
                    "updatedAt": 1700000000000u64,
                    "rev": 3
                }
            ],
            "meta": { "scanned": 1 }
        });
        let rows = parse_memories(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "m1");
        assert_eq!(rows[0].scope, "chat:c1");
        assert!(rows[0].pinned);
        assert_eq!(rows[0].rev, 3);
        assert!(parse_memories(&json!({})).is_empty());
    }

    #[test]
    fn parses_candidate_rows_from_core_payload() {
        let value = json!({
            "candidates": [
                {
                    "id": "c1",
                    "status": "pending",
                    "type": "user",
                    "scope": "chat:c1",
                    "content": "候选内容",
                    "reason": "多次出现",
                    "proposedBy": "agent:chat"
                }
            ]
        });
        let rows = parse_candidates(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "pending");
        assert_eq!(rows[0].proposed_by, "agent:chat");
    }

    #[test]
    fn formats_epoch_millis_as_utc_civil_time() {
        assert_eq!(format_time(0), "—");
        assert_eq!(format_time(1_700_000_000_000), "2023-11-14 22:13");
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }
}
