//! CetaMesh Desktop —— Workspace 产品页（阶段 05）。
//!
//! 只做两件事：维护页面状态、把用户操作翻译成 Core 调用意图（WorkspaceAction）。
//! 真正下发 IPC 的是 native_ui（唯一持有 CoreApi 的地方），本模块不依赖 worker。
//!
//! 产品约束（与 src/workspace/ 一致）：
//! - Agent / 工具只能访问当前工作区 root 内部；本页展示边界信息，不提供任何
//!   "任意路径"输入框（新建工作区的 root 由用户显式填写，Core 侧仍会拒绝危险 root）。
//! - Remove 只是把目录从 CetaMesh 清单移除，**绝不删除用户目录**（Core 保证）。
//! - git commit 默认走审批：页面发出 commit 请求后显示待审批请求，由用户在此页
//!   显式批准/拒绝；deny 策略的工作区不提供 commit 入口。

use eframe::egui;
use crate::native_ui::native_palette;
use serde_json::{json, Value};


const COMMIT_POLICIES: [&str; 3] = ["allow", "approval", "deny"];

/// 一条待下发的 Core 调用意图。
pub struct WorkspaceAction {
    pub method: &'static str,
    pub params: Value,
}

impl WorkspaceAction {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

#[derive(Clone, Debug, Default)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub root: String,
    pub active: bool,
    pub branch: String,
    pub is_repo: bool,
    pub dirty: bool,
}

#[derive(Clone, Debug, Default)]
pub struct FileEventRow {
    pub path: String,
    pub action: String,
    pub at: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ActivityRow {
    pub action: String,
    pub actor: String,
    pub detail: String,
    pub at: u64,
}

#[derive(Clone, Debug, Default)]
pub struct PendingCommitRow {
    pub id: String,
    pub message: String,
}

pub fn parse_workspaces(value: &Value) -> Vec<WorkspaceRow> {
    let Some(items) = value.get("workspaces").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            let git = item.get("git").cloned().unwrap_or(Value::Null);
            WorkspaceRow {
                id: string_field(item, "id"),
                name: string_field(item, "name"),
                root: string_field(item, "root"),
                active: item.get("active").and_then(Value::as_bool).unwrap_or(false),
                branch: string_field(&git, "branch"),
                is_repo: git.get("isRepo").and_then(Value::as_bool).unwrap_or(false),
                dirty: git.get("dirty").and_then(Value::as_bool).unwrap_or(false),
            }
        })
        .collect()
}

pub fn parse_file_events(value: &Value, field: &str) -> Vec<FileEventRow> {
    let Some(items) = value.get(field).and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| FileEventRow {
            path: string_field(item, "path"),
            action: string_field(item, "action"),
            at: item.get("at").and_then(Value::as_u64).unwrap_or(0),
        })
        .collect()
}

pub fn parse_activity(value: &Value) -> Vec<ActivityRow> {
    let Some(items) = value.get("activity").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| ActivityRow {
            action: string_field(item, "action"),
            actor: string_field(item, "actor"),
            detail: string_field(item, "detail"),
            at: item.get("at").and_then(Value::as_u64).unwrap_or(0),
        })
        .collect()
}

pub fn parse_pending_commits(value: &Value) -> Vec<PendingCommitRow> {
    let Some(items) = value.get("pending").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| PendingCommitRow {
            id: string_field(item, "id"),
            message: string_field(item, "message"),
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
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 146_096) / 365;
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

pub struct WorkspaceUi {
    pub loaded: bool,
    requested: bool,
    pub rows: Vec<WorkspaceRow>,
    pub selected: Option<String>,
    pub detail: Option<Value>,
    pub recent_files: Vec<FileEventRow>,
    pub artifacts: Vec<FileEventRow>,
    pub activity: Vec<ActivityRow>,
    pub pending_commits: Vec<PendingCommitRow>,
    pub new_name: String,
    pub new_root: String,
    pub new_create_dir: bool,
    pub rename_draft: String,
    pub commit_message: String,
    pub test_output: String,
    pub test_command_draft: String,
    pub policy_draft: String,
    pub notice: Option<String>,
    pub error: Option<String>,
}

impl Default for WorkspaceUi {
    fn default() -> Self {
        Self {
            loaded: false,
            requested: false,
            rows: Vec::new(),
            selected: None,
            detail: None,
            recent_files: Vec::new(),
            artifacts: Vec::new(),
            activity: Vec::new(),
            pending_commits: Vec::new(),
            new_name: String::new(),
            new_root: String::new(),
            new_create_dir: true,
            rename_draft: String::new(),
            commit_message: String::new(),
            test_output: String::new(),
            test_command_draft: String::new(),
            policy_draft: "approval".to_owned(),
            notice: None,
            error: None,
        }
    }
}

impl WorkspaceUi {
    fn overview_action(&self) -> WorkspaceAction {
        WorkspaceAction::new("workspace.list", json!({}))
    }

    /// 应用一次 Core 返回值。返回 true 表示需要重新拉取页面聚合数据。
    pub fn apply(&mut self, value: &Value) -> bool {
        self.error = None;
        if value.get("workspaces").is_some() {
            self.rows = parse_workspaces(value);
            self.loaded = true;
            if self.selected.is_none() {
                self.selected = self
                    .rows
                    .iter()
                    .find(|row| row.active)
                    .or_else(|| self.rows.first())
                    .map(|row| row.id.clone());
            }
            return false;
        }
        // 完整详情载荷（workspace.info）：包含 git / recentFiles / activity / pending。
        if value.get("git").is_some()
            || value.get("recentFiles").is_some()
            || value.get("activity").is_some()
            || value.get("pending").is_some()
        {
            self.detail = Some(value.clone());
            self.recent_files = parse_file_events(value, "recentFiles");
            self.artifacts = parse_file_events(value, "artifacts");
            self.activity = parse_activity(value);
            self.pending_commits = parse_pending_commits(value);
            if let Some(ws) = value.get("workspace") {
                if let Some(id) = ws.get("id").and_then(Value::as_str) {
                    self.selected = Some(id.to_owned());
                }
                if let Some(name) = ws.get("name").and_then(Value::as_str) {
                    self.rename_draft = name.to_owned();
                }
                if let Some(settings) = ws.get("settings") {
                    self.test_command_draft = settings
                        .get("testCommand")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if let Some(policy) = settings
                        .get("policies")
                        .and_then(|p| p.get("gitCommit"))
                        .and_then(Value::as_str)
                    {
                        self.policy_draft = policy.to_owned();
                    }
                }
            }
            self.notice = None;
            return false;
        }
        // 薄摘要载荷（create / open / rename / settings）：只更新选择与草稿，
        // 不覆盖已有详情（详情由随后的 workspace.info 刷新）。
        if let Some(ws) = value.get("workspace") {
            if let Some(id) = ws.get("id").and_then(Value::as_str) {
                self.selected = Some(id.to_owned());
            }
            if let Some(name) = ws.get("name").and_then(Value::as_str) {
                self.rename_draft = name.to_owned();
            }
            return true;
        }
        if value.get("removed").is_some() {
            self.selected = None;
            self.detail = None;
            self.notice = Some("已从 CetaMesh 清单移除（用户目录保留）".to_owned());
            return true;
        }
        if value.get("requestId").is_some() {
            self.notice = Some("commit 已进入待审批，请在下方批准或拒绝".to_owned());
            return true;
        }
        if value.get("status").and_then(Value::as_str) == Some("committed") {
            self.commit_message.clear();
            self.notice = Some("commit 已执行".to_owned());
            return true;
        }
        if value.get("status").and_then(Value::as_str) == Some("rejected") {
            self.notice = Some("commit 请求已拒绝".to_owned());
            return true;
        }
        if value.get("exitCode").is_some() {
            let out = [
                format!("exit={}", value.get("exitCode").and_then(Value::as_i64).unwrap_or(-1)),
                value.get("stdout").and_then(Value::as_str).unwrap_or("").to_owned(),
                value.get("stderr").and_then(Value::as_str).unwrap_or("").to_owned(),
            ]
            .join("\n");
            self.test_output = out;
            return false;
        }
        if value.get("settings").is_some() {
            self.notice = Some("设置已保存".to_owned());
            return true;
        }
        false
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<WorkspaceAction> {
        let mut actions: Vec<WorkspaceAction> = Vec::new();

        ui.label(
            egui::RichText::new("工作区是 Agent 与工具访问文件系统的唯一安全边界：root 之外一律拒绝。")
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
            ui.add_space(2.0);
            ui.weak(notice.as_str());
        }
        ui.add_space(6.0);

        // ── 新建 / 打开（选择已有目录） ─────────────────────────────────
        egui::Frame::new()
            .fill(native_palette().surface_alt)
            .stroke(egui::Stroke::new(1.0, native_palette().border))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.label(egui::RichText::new("新建 / 登记工作区").strong());
                ui.horizontal_wrapped(|ui| {
                    ui.label("名称");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.new_name)
                            .desired_width(160.0)
                            .hint_text("项目名"),
                    );
                    ui.label("根目录");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.new_root)
                            .desired_width(360.0)
                            .hint_text(r"D:\projects\demo"),
                    );
                    if ui.button("浏览…").clicked() {
                        // Native folder picker: avoids hand-copying long Windows paths.
                        if let Some(folder) = rfd::FileDialog::new()
                            .set_title("选择工作区根目录")
                            .pick_folder()
                        {
                            self.new_root = folder.display().to_string();
                            if self.new_name.trim().is_empty() {
                                if let Some(name) = folder.file_name().and_then(|value| value.to_str()) {
                                    self.new_name = name.to_owned();
                                }
                            }
                        }
                    }
                    ui.checkbox(&mut self.new_create_dir, "目录不存在时创建");
                    if ui.button("登记工作区").clicked() {
                        actions.push(WorkspaceAction::new(
                            "workspace.create",
                            json!({
                                "name": self.new_name.clone(),
                                "root": self.new_root.clone(),
                                "createIfMissing": self.new_create_dir,
                            }),
                        ));
                    }
                });
                ui.weak("盘符根、Windows / Program Files / 用户主目录及其祖先不允许作为工作区。");
            });

        ui.add_space(8.0);

        // ── 工作区清单 ──────────────────────────────────────────────────
        ui.label(egui::RichText::new("工作区").strong());
        if self.rows.is_empty() {
            ui.weak("还没有登记任何工作区。");
        }
        for row in &self.rows {
            ui.group(|ui| {
                ui.horizontal_wrapped(|ui| {
                    let selected = self.selected.as_deref() == Some(row.id.as_str());
                    if ui
                        .selectable_label(selected, egui::RichText::new(row.name.as_str()).strong())
                        .clicked()
                    {
                        self.selected = Some(row.id.clone());
                        actions.push(WorkspaceAction::new(
                            "workspace.info",
                            json!({ "id": row.id.clone() }),
                        ));
                    }
                    ui.monospace(row.root.as_str());
                    if row.active {
                        ui.colored_label(native_palette().accent, "当前");
                    }
                    if row.is_repo {
                        ui.label(format!("⎇ {}", row.branch));
                        if row.dirty {
                            ui.colored_label(native_palette().warning, "有未提交改动");
                        } else {
                            ui.colored_label(native_palette().accent, "clean");
                        }
                    } else {
                        ui.weak("非 git 仓库");
                    }
                    if ui.button("打开").clicked() {
                        actions.push(WorkspaceAction::new(
                            "workspace.open",
                            json!({ "id": row.id.clone() }),
                        ));
                    }
                });
            });
        }

        // ── 详情面板 ────────────────────────────────────────────────────
        let Some(selected_id) = self.selected.clone() else {
            return actions;
        };
        let Some(detail) = self.detail.clone() else {
            return actions;
        };
        let ws = detail.get("workspace").cloned().unwrap_or(Value::Null);
        if string_field(&ws, "id") != selected_id {
            return actions;
        }

        ui.add_space(10.0);
        egui::Frame::new()
            .fill(native_palette().surface_alt)
            .stroke(egui::Stroke::new(1.0, native_palette().border))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(egui::RichText::new(string_field(&ws, "name")).strong());
                    ui.monospace(string_field(&ws, "root"));
                });

                // 重命名元数据
                ui.horizontal_wrapped(|ui| {
                    ui.add(
                        egui::TextEdit::singleline(&mut self.rename_draft)
                            .desired_width(200.0),
                    );
                    if ui.button("重命名").clicked() {
                        actions.push(WorkspaceAction::new(
                            "workspace.rename",
                            json!({ "id": selected_id.clone(), "name": self.rename_draft.clone() }),
                        ));
                    }
                    if ui.button("刷新").clicked() {
                        actions.push(WorkspaceAction::new(
                            "workspace.info",
                            json!({ "id": selected_id.clone(), "refreshGit": true }),
                        ));
                    }
                    if ui.button("从清单移除").clicked() {
                        actions.push(WorkspaceAction::new(
                            "workspace.remove",
                            json!({ "id": selected_id.clone() }),
                        ));
                    }
                });

                // 设置：测试命令 + commit 策略（草稿值在 apply() 收到详情时初始化，
                // 这里只渲染，避免每帧覆盖用户正在输入的内容）。
                ui.horizontal_wrapped(|ui| {
                    ui.label("测试命令");
                    ui.add(
                        egui::TextEdit::singleline(&mut self.test_command_draft)
                            .desired_width(320.0)
                            .hint_text("例如 npm test（留空则禁用 test.run）"),
                    );
                    ui.label("commit 策略");
                    egui::ComboBox::from_id_salt("ws_commit_policy")
                        .selected_text(self.policy_draft.as_str())
                        .show_ui(ui, |ui| {
                            for option in COMMIT_POLICIES {
                                ui.selectable_value(&mut self.policy_draft, option.to_owned(), option);
                            }
                        });
                    if ui.button("保存设置").clicked() {
                        actions.push(WorkspaceAction::new(
                            "workspace.settings",
                            json!({ "id": selected_id.clone(), "patch": {
                                "testCommand": self.test_command_draft.clone(),
                                "policies": { "gitCommit": self.policy_draft.clone() },
                            } }),
                        ));
                    }
                });
            });

        // ── 工具动作 ────────────────────────────────────────────────────
        ui.add_space(10.0);
        ui.label(egui::RichText::new("工作区工具（全部经边界裁决）").strong());
        ui.horizontal_wrapped(|ui| {
            if ui.button("git status").clicked() {
                actions.push(WorkspaceAction::new(
                    "workspace.git.status",
                    json!({ "id": selected_id.clone() }),
                ));
            }
            if ui.button("git diff").clicked() {
                actions.push(WorkspaceAction::new(
                    "workspace.git.diff",
                    json!({ "id": selected_id.clone() }),
                ));
            }
            if ui.button("运行测试").clicked() {
                actions.push(WorkspaceAction::new(
                    "workspace.test.run",
                    json!({ "id": selected_id.clone() }),
                ));
            }
        });
        if !self.test_output.is_empty() {
            ui.monospace(
                egui::RichText::new(self.test_output.as_str())
                    .size(11.0)
                    .color(native_palette().muted),
            );
        }

        // commit + 审批（策略取自详情快照，deny 时不提供提交入口）
        let policy = self.policy_draft.clone();
        if policy != "deny" {
            ui.add_space(6.0);
            ui.horizontal_wrapped(|ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.commit_message)
                        .desired_width(420.0)
                        .hint_text("提交信息"),
                );
                if ui.button("提交（按策略）").clicked() {
                    actions.push(WorkspaceAction::new(
                        "workspace.git.commit",
                        json!({ "id": selected_id.clone(), "message": self.commit_message.clone() }),
                    ));
                }
            });
            ui.weak(format!("当前 commit 策略：{policy}（approval = 提交前需你在此页批准）"));
        } else {
            ui.weak("当前 commit 策略：deny（此工作区禁止提交）");
        }
        if !self.pending_commits.is_empty() {
            ui.add_space(6.0);
            ui.label(egui::RichText::new("待审批的 commit").strong());
            for request in &self.pending_commits {
                ui.group(|ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(request.message.as_str());
                        if ui.button("批准").clicked() {
                            actions.push(WorkspaceAction::new(
                                "workspace.pending.decide",
                                json!({ "requestId": request.id.clone(), "approve": true }),
                            ));
                        }
                        if ui.button("拒绝").clicked() {
                            actions.push(WorkspaceAction::new(
                                "workspace.pending.decide",
                                json!({ "requestId": request.id.clone(), "approve": false }),
                            ));
                        }
                    });
                });
            }
        }

        // ── 派生信息 ────────────────────────────────────────────────────
        ui.add_space(10.0);
        egui::Grid::new("ws_detail_grid")
            .num_columns(2)
            .show(ui, |ui| {
                ui.label("最近文件");
                ui.vertical(|ui| {
                    if self.recent_files.is_empty() {
                        ui.weak("—");
                    }
                    for event in self.recent_files.iter().take(8) {
                        ui.horizontal(|ui| {
                            ui.monospace(event.path.as_str());
                            ui.weak(format!("{} · {}", event.action, format_time(event.at)));
                        });
                    }
                });
                ui.end_row();
                ui.label("产物（Artifacts）");
                ui.vertical(|ui| {
                    if self.artifacts.is_empty() {
                        ui.weak("—");
                    }
                    for event in self.artifacts.iter().take(8) {
                        ui.horizontal(|ui| {
                            ui.monospace(event.path.as_str());
                            ui.weak(format_time(event.at));
                        });
                    }
                });
                ui.end_row();
                ui.label("任务关联");
                ui.weak("Persistent Task 未启用（所有者冻结中），暂无任务关联");
                ui.end_row();
                ui.label("Agent 活动");
                ui.vertical(|ui| {
                    if self.activity.is_empty() {
                        ui.weak("—");
                    }
                    for event in self.activity.iter().take(10) {
                        ui.horizontal(|ui| {
                            ui.label(format!("{} · {} · {}", format_time(event.at), event.actor, event.action));
                            if !event.detail.is_empty() {
                                ui.weak(event.detail.as_str());
                            }
                        });
                    }
                });
                ui.end_row();
            });

        actions
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_activity, parse_file_events, parse_pending_commits, parse_workspaces, WorkspaceUi};
    use serde_json::json;

    #[test]
    fn parses_workspace_rows_from_core_payload() {
        let value = json!({
            "workspaces": [
                {
                    "id": "ws-1",
                    "name": "Demo",
                    "root": "D:\\projects\\demo",
                    "active": true,
                    "git": { "isRepo": true, "branch": "main", "dirty": false }
                }
            ]
        });
        let rows = parse_workspaces(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "Demo");
        assert_eq!(rows[0].branch, "main");
        assert!(rows[0].active);
        assert!(!rows[0].dirty);
        assert!(parse_workspaces(&json!({})).is_empty());
    }

    #[test]
    fn parses_detail_sections() {
        let value = json!({
            "recentFiles": [ { "path": "a.txt", "action": "write", "at": 1700000000000u64 } ],
            "artifacts": [ { "path": "report.md", "at": 1700000000000u64 } ],
            "activity": [ { "action": "write", "actor": "agent", "detail": "a.txt", "at": 1700000000000u64 } ],
            "pending": [ { "id": "pnd-1", "message": "needs approval" } ]
        });
        assert_eq!(parse_file_events(&value, "recentFiles")[0].path, "a.txt");
        assert_eq!(parse_file_events(&value, "artifacts")[0].path, "report.md");
        assert_eq!(parse_activity(&value)[0].actor, "agent");
        assert_eq!(parse_pending_commits(&value)[0].id, "pnd-1");
    }

    #[test]
    fn apply_tracks_snapshot_and_refresh_contract() {
        let mut ui = WorkspaceUi::default();
        // 清单快照：loaded 置位，不要求再刷新。
        assert!(!ui.apply(&json!({ "workspaces": [] })));
        assert!(ui.loaded);
        // remove 结果：要求刷新清单。
        assert!(ui.apply(&json!({ "removed": "ws-1", "directoryPreserved": true })));
        // pending commit：要求刷新以显示待审批。
        assert!(ui.apply(&json!({ "status": "pending", "requestId": "pnd-2", "expiresAt": 1 })));
        // 测试结果：只更新输出，不刷新。
        assert!(!ui.apply(&json!({ "exitCode": 0, "stdout": "ok", "stderr": "" })));
        assert!(ui.test_output.contains("exit=0"));
    }
}
