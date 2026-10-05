//! Native management UI for the desktop shell.
//!
//! The shell supplies a `CoreApi` backed by its authenticated local IPC transport. This module
//! intentionally contains no browser, HTML, WebView, or arbitrary command execution path.

use crate::chat_ui::{ChatUi, parse_catalog, parse_history, parse_model_providers, parse_sessions, parse_turn};
use crate::memory_ui::MemoryUi;
use crate::task_ui::TaskUi;
use crate::workshop_ui::WorkshopUi;
use crate::mesh_ui::{MeshArea, MeshUi};
use crate::tray::{TrayCommand, TrayHandle, TrayStatus};
use crate::ui_prefs::{CloseBehavior, ThemePreference, UiPrefs};
use crate::workspace_ui::WorkspaceUi;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::thread;
use std::time::{Duration, Instant};

use crate::app_shell::{AppPage, LegacyTab as Tab, NavigationState, tabs_for};
use crate::supervisor::{Status, Supervisor};
use eframe::egui;
use raw_window_handle::HasWindowHandle;
use serde_json::{Value, json};

/// The active shell theme, shared by the palette helpers and the global style.
static DARK_THEME: AtomicBool = AtomicBool::new(false);

/// Synchronous Core transport. Calls are only made on this module's worker thread.
pub trait CoreApi: Send + Sync + 'static {
    fn request(&self, method: &str, params: Value) -> Result<Value, String>;
}

/// Work 页内部区域（Tasks / Workshop Owner 审阅）。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum WorkTab {
    #[default]
    Tasks,
    Workshop,
}

/// Capability 审批队列条目（Managed Agent 高风险能力请求；Owner 决定）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CapabilityApprovalRow {
    pub id: String,
    pub capability: String,
    pub permission: String,
    pub risk: String,
    pub actor: String,
    pub task_id: String,
    pub workspace_id: String,
    pub reason: String,
    pub expires_at: u64,
}

pub fn parse_capability_approvals(value: &Value) -> Vec<CapabilityApprovalRow> {
    let rows = match value.get("approvals").and_then(Value::as_array) {
        Some(rows) => rows,
        None => return Vec::new(),
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_str)?;
            let actor = row.get("actor").unwrap_or(&Value::Null);
            Some(CapabilityApprovalRow {
                id: id.to_owned(),
                capability: row.get("capability").and_then(Value::as_str).unwrap_or("").to_owned(),
                permission: row.get("permission").and_then(Value::as_str).unwrap_or("").to_owned(),
                risk: row.get("risk").and_then(Value::as_str).unwrap_or("").to_owned(),
                actor: format!(
                    "{}:{}",
                    actor.get("kind").and_then(Value::as_str).unwrap_or("?"),
                    actor.get("id").and_then(Value::as_str).unwrap_or("?")
                ),
                task_id: row.get("taskId").and_then(Value::as_str).unwrap_or("").to_owned(),
                workspace_id: row.get("workspaceId").and_then(Value::as_str).unwrap_or("").to_owned(),
                reason: row.get("reason").and_then(Value::as_str).unwrap_or("").to_owned(),
                expires_at: row.get("expiresAt").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Area {
    Chat,
    ChatStatus,
    Overview,
    Roles,
    Policy,
    Services,
    ModelCatalog,
    ModelDefaults,
    ProviderKeys,
    PresetList,
    PresetBindings,
    Pending,
    CapabilityApproval,
    Security,
    Slang,
    Sessions,
    Activity,
    Logs,
    Diagnostics,
    Memory,
    Task,
    Workshop,
    Mesh,
    Channel,
    Workspace,
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    ChatSessionsLoad,
    ChatSessionCreate,
    ChatSessionRename,
    ChatSessionArchive,
    ChatSessionDelete,
    ChatHistoryLoad,
    ChatSend,
    ChatStop,
    ChatRetry,
    ChatContinue,
    ChatConfigSave,
    ChatCatalogLoad,
    ChatStatusPoll,
    OverviewPing,
    RolesRefresh,
    RoleSet,
    RoleCreate,
    RoleMode,
    PolicyLoad,
    PolicySave,
    ServicesRefresh,
    ServicesDetect,
    ServiceSelect(ServiceKind),
    ServiceInstallSnowLuma,
    ServiceStart(ServiceKind),
    ServiceStop(ServiceKind),
    ModelCatalogLoad,
    ModelDefaultsLoad,
    ModelDefaultsSave,
    ProviderSecretsLoad,
    ProviderSecretSave,
    ProviderSecretDelete,
    ProviderSecretTest,
    PresetListLoad,
    PresetBindingsLoad,
    PresetBindingSave(PresetTarget),
    PendingRefresh,
    PendingDecision,
    CapabilityApprovalList,
    CapabilityApprovalDecide,
    SecurityLoad,
    SecuritySave,
    SlangLoad,
    SlangSave,
    SessionsRefresh,
    SessionPhase,
    ActivityRefresh,
    LogsRefresh,
    DiagnosticsPing,
    DiagnosticsRun,
    MemoryCall,
    TaskCall,
    WorkshopCall,
    MeshCall,
    ChannelCall,
    WorkspaceCall,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceKind {
    SnowLuma,
    Dsh,
}

impl ServiceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::SnowLuma => "snowluma",
            Self::Dsh => "dsh",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::SnowLuma => "SnowLuma",
            Self::Dsh => "DSH",
        }
    }

    #[cfg(test)]
    fn parse(value: &str) -> Option<Self> {
        match value {
            "snowluma" => Some(Self::SnowLuma),
            "dsh" => Some(Self::Dsh),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceAction {
    InstallSnowLuma,
    Start(ServiceKind),
    Stop(ServiceKind),
}

#[derive(Clone, Debug, Default)]
struct DetectedInstall {
    id: String,
    name: String,
    version: Option<String>,
    source: Option<String>,
    valid: Option<bool>,
    status: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct ServiceSnapshot {
    installed: Option<bool>,
    running: Option<bool>,
    status: Option<String>,
    message: Option<String>,
    selected_id: Option<String>,
    installations: Vec<DetectedInstall>,
}

impl ServiceSnapshot {
    fn has_selectable_install(&self, id: &str) -> bool {
        self.installations
            .iter()
            .any(|installation| installation.id == id && installation.valid == Some(true))
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ModelEntry {
    provider: String,
    model: String,
    image: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModelDefaults {
    provider: String,
    model: String,
    reasoning_effort: String,
}

impl Default for ModelDefaults {
    fn default() -> Self {
        Self {
            provider: String::new(),
            model: String::new(),
            reasoning_effort: "off".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProviderSecretRow {
    provider: String,
    hint: String,
    base_url: String,
    updated_at: String,
}

fn parse_provider_secrets(value: &Value) -> Result<Vec<ProviderSecretRow>, String> {
    let items = value
        .get("secrets")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core 返回的 Provider 凭据列表格式无效。".to_owned())?;
    let mut rows = Vec::with_capacity(items.len().min(100));
    for item in items.iter().take(100) {
        let provider = item
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.chars().count() <= 64)
            .ok_or_else(|| "Provider 凭据缺少 provider。".to_owned())?;
        rows.push(ProviderSecretRow {
            provider: provider.to_owned(),
            hint: item.get("hint").and_then(Value::as_str).unwrap_or("").to_owned(),
            base_url: item.get("baseUrl").and_then(Value::as_str).unwrap_or("").to_owned(),
            updated_at: item.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_owned(),
        });
    }
    Ok(rows)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PresetRecord {
    id: String,
    trust: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PresetTarget {
    Chat,
    ClosedAgent,
    Social,
    Workshop,
    Learner,
}

impl PresetTarget {
    fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::ClosedAgent => "closedAgent",
            Self::Social => "social",
            Self::Workshop => "workshop",
            Self::Learner => "learner",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Chat => "聊天",
            Self::ClosedAgent => "Owner Agent",
            Self::Social => "社交仿生",
            Self::Workshop => "工作坊",
            Self::Learner => "黑话学习",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "chat" => Some(Self::Chat),
            "closedAgent" => Some(Self::ClosedAgent),
            "social" => Some(Self::Social),
            "workshop" => Some(Self::Workshop),
            "learner" => Some(Self::Learner),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PresetBindings {
    chat: Option<String>,
    closed_agent: Option<String>,
    social: Option<String>,
    workshop: Option<String>,
    learner: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PresetSelection {
    chat: String,
    closed_agent: String,
    social: String,
    workshop: String,
    learner: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PendingItem {
    kind: String,
    key: String,
    id: String,
    session_id: String,
    tool_name: String,
    reason: String,
    question: String,
    options: Vec<String>,
    status: String,
    card_title: String,
    button_label: String,
    risk_reasons: Vec<String>,
}

impl PresetBindings {
    fn get(&self, target: PresetTarget) -> Option<&str> {
        match target {
            PresetTarget::Chat => self.chat.as_deref(),
            PresetTarget::ClosedAgent => self.closed_agent.as_deref(),
            PresetTarget::Social => self.social.as_deref(),
            PresetTarget::Workshop => self.workshop.as_deref(),
            PresetTarget::Learner => self.learner.as_deref(),
        }
    }
}

impl PresetSelection {
    fn get(&self, target: PresetTarget) -> &str {
        match target {
            PresetTarget::Chat => &self.chat,
            PresetTarget::ClosedAgent => &self.closed_agent,
            PresetTarget::Social => &self.social,
            PresetTarget::Workshop => &self.workshop,
            PresetTarget::Learner => &self.learner,
        }
    }

    fn get_mut(&mut self, target: PresetTarget) -> &mut String {
        match target {
            PresetTarget::Chat => &mut self.chat,
            PresetTarget::ClosedAgent => &mut self.closed_agent,
            PresetTarget::Social => &mut self.social,
            PresetTarget::Workshop => &mut self.workshop,
            PresetTarget::Learner => &mut self.learner,
        }
    }
}

enum ApiCall {
    Ping,
    Control { method: &'static str, params: Value },
    /// 产品私有方法族（chat.* / memory.*）：作为顶层 IPC method 发送。
    Family { method: &'static str, params: Value },
}

struct WorkerJob {
    id: u64,
    area: Area,
    operation: Operation,
    call: ApiCall,
}

struct WorkerEvent {
    id: u64,
    area: Area,
    operation: Operation,
    result: Result<Value, String>,
}

#[derive(Clone, Debug)]
struct SessionRow {
    key: String,
    session_id: String,
    owner: bool,
}

const ACTIVITY_LIMITS: [usize; 4] = [50, 100, 250, 500];
const LOG_LIMITS: [usize; 4] = [50, 100, 250, 500];
const MAX_ACTIVITY_ITEMS: usize = 500;
const MAX_LOG_LINES: usize = 500;
const MAX_DISPLAY_LINE_CHARS: usize = 1_600;
const MODEL_REASONING_EFFORTS: [&str; 4] = ["off", "low", "high", "max"];
const PRESET_TARGETS: [PresetTarget; 5] = [
    PresetTarget::Chat,
    PresetTarget::ClosedAgent,
    PresetTarget::Social,
    PresetTarget::Workshop,
    PresetTarget::Learner,
];

const SHORTCUTS: &[(&str, &str)] = &[
    ("Ctrl+1 … Ctrl+7", "切换 Home / Chat / Work / Social / Agents / Plugins / Memory"),
    ("Ctrl+,", "打开 Settings"),
    ("F1", "显示/关闭本快捷键列表"),
    ("Ctrl+0", "重置界面缩放"),
    ("Ctrl+=", "放大界面"),
    ("Ctrl+-", "缩小界面"),
    ("Enter", "发送消息（输入框内；中文输入法组合完成前不会误发）"),
    ("Shift+Enter", "在消息中换行"),
    ("Ctrl+Q", "退出 CetaMesh（会先确认）"),
    ("Esc", "关闭当前对话框"),
];

/// Ctrl+1 … Ctrl+7 map onto the product navigation in this order.
fn page_for_shortcut_slot(slot: u8) -> Option<AppPage> {
    match slot {
        1 => Some(AppPage::Home),
        2 => Some(AppPage::Chat),
        3 => Some(AppPage::Work),
        4 => Some(AppPage::Social),
        5 => Some(AppPage::Agents),
        6 => Some(AppPage::Plugins),
        7 => Some(AppPage::Memory),
        _ => None,
    }
}

/// Enter sends only when the composer owns focus, Shift is not held, and no IME composition
/// event was part of the same frame (so confirming a Chinese candidate never sends).
fn should_send_on_enter(has_focus: bool, enter_pressed: bool, shift: bool, ime_active: bool) -> bool {
    has_focus && enter_pressed && !shift && !ime_active
}

#[derive(Clone, Debug)]
struct SlangForm {
    enabled: bool,
    extract_min_messages: String,
    extract_cooldown_ms: String,
    inject_max: String,
    auto_research: bool,
    learner_preset: String,
    workspace_title: String,
    inference_thresholds: String,
}

#[derive(Clone, Debug)]
struct PolicyForm {
    mode: String,
    allow_private: String,
    allow_groups: String,
    deny_private: String,
    deny_groups: String,
    owner_qq: String,
}

impl Default for PolicyForm {
    fn default() -> Self {
        Self {
            mode: "chat".to_owned(),
            allow_private: String::new(),
            allow_groups: String::new(),
            deny_private: String::new(),
            deny_groups: String::new(),
            owner_qq: String::new(),
        }
    }
}

fn runtime_policy_label(mode: &str) -> &str {
    match mode {
        "owner-agent" => "Owner Agent",
        "social" => "Social",
        "workshop" => "Workshop",
        "chat" => "Chat (legacy runtime)",
        other => other,
    }
}

impl PolicyForm {
    fn params(&self, include_mode: bool) -> Result<Value, String> {
        const MODES: [&str; 4] = ["chat", "owner-agent", "social", "workshop"];
        if !MODES.contains(&self.mode.as_str()) {
            return Err("运行策略必须是 chat、owner-agent、social 或 workshop。".to_owned());
        }
        let owner_qq = if self.owner_qq.trim().is_empty() {
            None
        } else {
            Some(parse_policy_id("管理员 QQ", self.owner_qq.trim())?)
        };
        let mut params = json!({
            "allow": {
                "private": parse_policy_id_list("私聊白名单", &self.allow_private)?,
                "groups": parse_policy_id_list("群白名单", &self.allow_groups)?,
            },
            "deny": {
                "private": parse_policy_id_list("私聊黑名单", &self.deny_private)?,
                "groups": parse_policy_id_list("群黑名单", &self.deny_groups)?,
            },
            "ownerQQ": owner_qq,
        });
        if include_mode {
            params["mode"] = json!(self.mode);
        }
        Ok(params)
    }

    fn apply(&mut self, value: &Value) -> Result<(), String> {
        let policy = value.get("policy").unwrap_or(value);
        let mode = policy
            .get("mode")
            .and_then(Value::as_str)
            .ok_or_else(|| "Core 返回的运行模式缺失或无效。".to_owned())?;
        let mode = match mode {
            "closed-agent" => "owner-agent",
            "reserved" => "chat",
            "reserved2" => "social",
            canonical => canonical,
        };
        if !["chat", "owner-agent", "social", "workshop"].contains(&mode) {
            return Err("Core 返回了不支持的运行模式。".to_owned());
        }
        self.mode = mode.to_owned();
        self.allow_private = format_policy_id_list(policy.pointer("/allow/private"), "私聊白名单")?;
        self.allow_groups = format_policy_id_list(policy.pointer("/allow/groups"), "群白名单")?;
        self.deny_private = format_policy_id_list(policy.pointer("/deny/private"), "私聊黑名单")?;
        self.deny_groups = format_policy_id_list(policy.pointer("/deny/groups"), "群黑名单")?;
        self.owner_qq = match policy.get("ownerQQ") {
            None | Some(Value::Null) => String::new(),
            Some(value) => parse_policy_id_value("管理员 QQ", value)?.to_string(),
        };
        Ok(())
    }
}

impl Default for SlangForm {
    fn default() -> Self {
        Self {
            enabled: true,
            extract_min_messages: "10".to_owned(),
            extract_cooldown_ms: "300000".to_owned(),
            inject_max: "8".to_owned(),
            auto_research: true,
            learner_preset: "whale-chat".to_owned(),
            workspace_title: "QQ 黑话学习".to_owned(),
            inference_thresholds: "2, 4, 8".to_owned(),
        }
    }
}

/// The native egui management application. Construct this from the shell with its Core IPC
/// implementation and the creation context's egui context.
pub struct NativeUi {
    supervisor: Arc<Supervisor>,
    job_tx: Sender<WorkerJob>,
    event_rx: Receiver<WorkerEvent>,
    worker_available: bool,
    worker_error: Option<String>,
    navigation: NavigationState,
    memory: MemoryUi,
    task: TaskUi,
    workshop: WorkshopUi,
    work_tab: WorkTab,
    mesh: MeshUi,
    chat: ChatUi,
    workspace: WorkspaceUi,
    pending: HashSet<Area>,
    feedback: HashMap<Area, Result<Value, String>>,
    next_id: u64,

    core_online: Option<bool>,
    core_summary: String,

    roles: Vec<String>,
    current_role: Option<String>,
    selected_role: String,
    role_mode: String,
    new_role_name: String,
    new_role_content: String,

    security_loaded: bool,
    intercept_notify: bool,

    policy_loaded: bool,
    policy: PolicyForm,
    loaded_policy_mode: Option<String>,
    policy_confirmation: Option<Value>,

    services_snowluma: ServiceSnapshot,
    services_dsh: ServiceSnapshot,
    services_loaded: bool,
    selected_snowluma_install: String,
    selected_dsh_install: String,
    service_confirmation: Option<ServiceAction>,
    services_notice: Option<String>,

    model_catalog: Vec<ModelEntry>,
    model_catalog_loaded: bool,
    model_defaults: ModelDefaults,
    model_defaults_loaded: bool,
    model_notice: Option<String>,
    provider_secrets: Vec<ProviderSecretRow>,
    provider_secrets_loaded: bool,
    provider_key_provider: String,
    provider_key_input: String,
    provider_key_base: String,
    provider_secrets_notice: Option<String>,

    presets: Vec<PresetRecord>,
    preset_list_loaded: bool,
    preset_bindings: PresetBindings,
    preset_selection: PresetSelection,
    preset_bindings_loaded: bool,
    preset_notice: Option<String>,

    pending_items: Vec<PendingItem>,
    pending_loaded: bool,
    pending_answer: String,
    pending_notice: Option<String>,
    pending_refresh_at: Instant,
    capability_approvals: Vec<CapabilityApprovalRow>,
    capability_approvals_loaded: bool,
    capability_approval_notice: Option<String>,

    slang_loaded: bool,
    slang: SlangForm,

    sessions: Vec<SessionRow>,

    activity_entries: Vec<String>,
    activity_limit: usize,
    log_lines: Vec<String>,
    log_limit: usize,
    log_source: String,

    diagnostics_runtime: bool,
    diagnostics_config: bool,
    diagnostics_paths: bool,
    diagnostics_services: bool,

    prefs: Arc<Mutex<UiPrefs>>,
    data_dir: PathBuf,
    tray: Option<TrayHandle>,
    tray_window_attached: bool,
    window_hidden: bool,
    hidden_notice_shown: bool,
    exit_confirmed: bool,
    quit_confirm: Option<String>,
    shortcuts_open: bool,
    /// Per-session chat drafts so switching sessions (or hiding to the tray) never loses text.
    chat_drafts: HashMap<String, String>,
    last_active_chat: Option<String>,
    /// Manual model id entry, used when the DSH catalog is unavailable or stale.
    chat_model_input: String,
    last_tray_status: Option<TrayStatus>,
    toast: Option<(String, Instant)>,
    last_prefs_sync: Instant,
    last_page: AppPage,
    applied_theme_dark: Option<bool>,
    applied_zoom: Option<f32>,
}

#[derive(Clone, Copy)]
struct NativePalette {
    background: egui::Color32,
    surface: egui::Color32,
    surface_alt: egui::Color32,
    border: egui::Color32,
    text: egui::Color32,
    muted: egui::Color32,
    accent: egui::Color32,
    accent_bg: egui::Color32,
    success: egui::Color32,
    warning: egui::Color32,
    error: egui::Color32,
    error_bg: egui::Color32,
}

fn native_palette() -> NativePalette {
    if DARK_THEME.load(AtomicOrdering::Relaxed) {
        return dark_palette();
    }
    light_palette()
}

fn light_palette() -> NativePalette {
    NativePalette {
        background: egui::Color32::from_rgb(244, 247, 247),
        surface: egui::Color32::WHITE,
        surface_alt: egui::Color32::from_rgb(246, 249, 248),
        border: egui::Color32::from_rgb(220, 228, 226),
        text: egui::Color32::from_rgb(34, 48, 48),
        muted: egui::Color32::from_rgb(103, 119, 117),
        accent: egui::Color32::from_rgb(23, 126, 115),
        accent_bg: egui::Color32::from_rgb(222, 241, 237),
        success: egui::Color32::from_rgb(35, 125, 83),
        warning: egui::Color32::from_rgb(151, 102, 21),
        error: egui::Color32::from_rgb(174, 54, 49),
        error_bg: egui::Color32::from_rgb(253, 237, 234),
    }
}

fn dark_palette() -> NativePalette {
    NativePalette {
        background: egui::Color32::from_rgb(18, 22, 24),
        surface: egui::Color32::from_rgb(27, 33, 35),
        surface_alt: egui::Color32::from_rgb(33, 40, 42),
        border: egui::Color32::from_rgb(58, 70, 71),
        text: egui::Color32::from_rgb(230, 237, 236),
        muted: egui::Color32::from_rgb(152, 167, 165),
        accent: egui::Color32::from_rgb(72, 190, 174),
        accent_bg: egui::Color32::from_rgb(31, 58, 55),
        success: egui::Color32::from_rgb(98, 201, 148),
        warning: egui::Color32::from_rgb(226, 178, 84),
        error: egui::Color32::from_rgb(240, 124, 112),
        error_bg: egui::Color32::from_rgb(58, 32, 32),
    }
}

fn native_widget_visuals(
    bg_fill: egui::Color32,
    weak_bg_fill: egui::Color32,
    fg_color: egui::Color32,
    border: egui::Color32,
) -> egui::style::WidgetVisuals {
    egui::style::WidgetVisuals {
        bg_fill,
        weak_bg_fill,
        bg_stroke: egui::Stroke::new(1.0, border),
        corner_radius: egui::CornerRadius::same(6),
        fg_stroke: egui::Stroke::new(1.0, fg_color),
        expansion: 0.0,
    }
}

fn native_style() -> egui::Style {
    let palette = native_palette();
    let mut style = egui::Style::default();
    style.spacing.item_spacing = egui::vec2(12.0, 10.0);
    style.spacing.window_margin = egui::Margin::symmetric(18, 16);
    style.spacing.button_padding = egui::vec2(10.0, 6.0);
    style.spacing.menu_margin = egui::Margin::same(8);
    style.spacing.interact_size = egui::vec2(40.0, 32.0);
    style.spacing.combo_width = 260.0;
    style.spacing.text_edit_width = 320.0;
    style.spacing.extra_text_line_spacing = 2.0;

    style
        .text_styles
        .insert(egui::TextStyle::Heading, egui::FontId::proportional(26.0));
    style
        .text_styles
        .insert(egui::TextStyle::Body, egui::FontId::proportional(15.0));
    style
        .text_styles
        .insert(egui::TextStyle::Button, egui::FontId::proportional(14.0));
    style
        .text_styles
        .insert(egui::TextStyle::Small, egui::FontId::proportional(13.0));
    style
        .text_styles
        .insert(egui::TextStyle::Monospace, egui::FontId::monospace(13.0));

    let dark = DARK_THEME.load(AtomicOrdering::Relaxed);
    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    visuals.dark_mode = dark;
    visuals.override_text_color = Some(palette.text);
    visuals.weak_text_color = Some(palette.muted);
    visuals.panel_fill = palette.background;
    visuals.window_fill = palette.surface;
    visuals.window_stroke = egui::Stroke::new(1.0, palette.border);
    visuals.window_corner_radius = egui::CornerRadius::same(10);
    visuals.faint_bg_color = palette.surface_alt;
    visuals.extreme_bg_color = palette.surface;
    visuals.text_edit_bg_color = Some(palette.surface);
    visuals.code_bg_color = palette.surface_alt;
    visuals.hyperlink_color = palette.accent;
    visuals.warn_fg_color = palette.warning;
    visuals.error_fg_color = palette.error;
    visuals.selection = egui::style::Selection {
        bg_fill: palette.accent_bg,
        stroke: egui::Stroke::new(1.0, palette.accent),
    };
    visuals.widgets.noninteractive = native_widget_visuals(
        palette.surface,
        palette.surface,
        palette.text,
        palette.border,
    );
    visuals.widgets.inactive = native_widget_visuals(
        palette.surface_alt,
        palette.surface,
        palette.text,
        palette.border,
    );
    visuals.widgets.hovered = native_widget_visuals(
        palette.accent_bg,
        palette.surface_alt,
        palette.text,
        palette.accent,
    );
    visuals.widgets.active = native_widget_visuals(
        palette.accent_bg,
        palette.accent_bg,
        palette.text,
        palette.accent,
    );
    visuals.widgets.open = visuals.widgets.active;
    visuals.button_frame = true;
    visuals.collapsing_header_frame = true;
    visuals.striped = true;
    visuals.disabled_alpha = 0.55;
    style.visuals = visuals;
    style
}

fn configure_native_theme(context: &egui::Context) {
    let dark = DARK_THEME.load(AtomicOrdering::Relaxed);
    context.set_theme(if dark {
        egui::Theme::Dark
    } else {
        egui::Theme::Light
    });
    context.set_global_style(native_style());
}

/// Follow the stored theme preference (and the OS theme when set to `System`).
fn sync_theme_preference(context: &egui::Context, preference: ThemePreference) {
    let system_dark = context.system_theme() == Some(egui::Theme::Dark);
    let dark = preference.resolves_to_dark(system_dark);
    let previous = DARK_THEME.swap(dark, AtomicOrdering::Relaxed);
    if previous != dark {
        context.set_global_style(native_style());
    }
    context.set_theme(if dark {
        egui::Theme::Dark
    } else {
        egui::Theme::Light
    });
}

fn friendly_read_error(area: Area, error: &str) -> Option<&'static str> {
    let is_model_or_preset = matches!(
        area,
        Area::ModelCatalog | Area::ModelDefaults | Area::PresetList | Area::PresetBindings
    );
    let is_dsh_method_error = error.contains("settings/describe") || error.contains("agentPresets");
    if is_model_or_preset && is_dsh_method_error && error.contains("ECONNREFUSED") {
        Some("DSH/目录服务当前不可用。Core IPC 仍在线，请启动 DSH 后重试。")
    } else {
        None
    }
}

impl NativeUi {
    pub fn new(
        api: Arc<dyn CoreApi>,
        supervisor: Arc<Supervisor>,
        egui_context: egui::Context,
        data_dir: PathBuf,
        prefs: Arc<Mutex<UiPrefs>>,
        tray: Option<TrayHandle>,
    ) -> Self {
        let initial_prefs = prefs.lock().expect("ui prefs lock").clone();
        let system_dark = egui_context.system_theme() == Some(egui::Theme::Dark);
        DARK_THEME.store(
            initial_prefs.theme.resolves_to_dark(system_dark),
            AtomicOrdering::Relaxed,
        );
        match initial_prefs.geometry {
            Some(geometry) => crate::supervisor::write_shell_log(
                &data_dir,
                &format!(
                    "[ui] 窗口几何已恢复：{:.0}x{:.0} @ ({:.0},{:.0}){}",
                    geometry.width,
                    geometry.height,
                    geometry.x,
                    geometry.y,
                    if geometry.maximized { "（最大化）" } else { "" }
                ),
            ),
            None => crate::supervisor::write_shell_log(
                &data_dir,
                "[ui] 窗口几何：使用默认 1180x780（首帧后写回偏好）",
            ),
        }
        // Use installed system fonts as a fallback so the Chinese UI remains readable without
        // shipping a browser font stack. The app still uses egui's native text rendering.
        let _detected_fonts =
            egui_system_fonts::add_auto(&egui_context, egui_system_fonts::FontStyle::Sans);
        configure_native_theme(&egui_context);
        egui_context.set_zoom_factor(initial_prefs.zoom);
        let (job_tx, job_rx) = mpsc::channel::<WorkerJob>();
        let (event_tx, event_rx) = mpsc::channel::<WorkerEvent>();
        let worker_context = egui_context.clone();
        let worker = thread::Builder::new()
            .name("whalebridge-core-ui-worker".to_owned())
            .spawn(move || {
                while let Ok(job) = job_rx.recv() {
                    let result = match job.call {
                        ApiCall::Ping => api.request("core.ping", json!({})),
                        ApiCall::Control { method, params } => api.request(
                            "control.execute",
                            json!({ "method": method, "params": params }),
                        ),
ApiCall::Family { method, params } => api.request(method, params),
                    };
                    if event_tx
                        .send(WorkerEvent {
                            id: job.id,
                            area: job.area,
                            operation: job.operation,
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                    worker_context.request_repaint();
                }
            });

        let mut app = Self {
            supervisor,
            job_tx,
            event_rx,
            worker_available: worker.is_ok(),
            worker_error: worker
                .err()
                .map(|error| format!("无法启动 Core 工作线程：{error}")),
            navigation: NavigationState::default(),
            memory: MemoryUi::default(),
            task: TaskUi::default(),
            workshop: WorkshopUi::default(),
            work_tab: WorkTab::default(),
            mesh: MeshUi::default(),
            chat: ChatUi::default(),
            workspace: WorkspaceUi::default(),
            pending: HashSet::new(),
            feedback: HashMap::new(),
            next_id: 1,

            core_online: None,
            core_summary: "尚未连接".to_owned(),

            roles: Vec::new(),
            current_role: None,
            selected_role: String::new(),
            role_mode: "unknown".to_owned(),
            new_role_name: String::new(),
            new_role_content: String::new(),

            security_loaded: false,
            intercept_notify: true,

            policy_loaded: false,
            policy: PolicyForm::default(),
            loaded_policy_mode: None,
            policy_confirmation: None,

            services_snowluma: ServiceSnapshot::default(),
            services_dsh: ServiceSnapshot::default(),
            services_loaded: false,
            selected_snowluma_install: String::new(),
            selected_dsh_install: String::new(),
            service_confirmation: None,
            services_notice: None,

            model_catalog: Vec::new(),
            model_catalog_loaded: false,
            model_defaults: ModelDefaults::default(),
            model_defaults_loaded: false,
            model_notice: None,
            provider_secrets: Vec::new(),
            provider_secrets_loaded: false,
            provider_key_provider: "deepseek-official".to_owned(),
            provider_key_input: String::new(),
            provider_key_base: String::new(),
            provider_secrets_notice: None,

            presets: Vec::new(),
            preset_list_loaded: false,
            preset_bindings: PresetBindings::default(),
            preset_selection: PresetSelection::default(),
            preset_bindings_loaded: false,
            preset_notice: None,

            pending_items: Vec::new(),
            pending_loaded: false,
            pending_answer: String::new(),
            pending_notice: None,
            pending_refresh_at: Instant::now(),
            capability_approvals: Vec::new(),
            capability_approvals_loaded: false,
            capability_approval_notice: None,

            slang_loaded: false,
            slang: SlangForm::default(),

            sessions: Vec::new(),

            activity_entries: Vec::new(),
            activity_limit: 100,
            log_lines: Vec::new(),
            log_limit: 200,
            log_source: "bridge".to_owned(),

            diagnostics_runtime: true,
            diagnostics_config: true,
            diagnostics_paths: false,
            diagnostics_services: false,

            prefs,
            data_dir,
            tray,
            tray_window_attached: false,
            window_hidden: false,
            hidden_notice_shown: false,
            exit_confirmed: false,
            quit_confirm: None,
            shortcuts_open: false,
            chat_drafts: HashMap::new(),
            last_active_chat: None,
            chat_model_input: String::new(),
            last_tray_status: None,
            toast: None,
            last_prefs_sync: Instant::now(),
            last_page: AppPage::Chat,
            applied_theme_dark: None,
            applied_zoom: None,
        };

        // Start with read-only snapshots. The only initial write-like form request is also
        // read-only: slang.getConfig must be implemented as a pure query by the Core adapter.
        app.issue(Area::Overview, Operation::OverviewPing, ApiCall::Ping);
        app.issue_control(Area::Roles, Operation::RolesRefresh, "role.list", json!({}));
        app.issue_control(
            Area::Security,
            Operation::SecurityLoad,
            "security.get",
            json!({}),
        );
        app.issue_control(Area::Policy, Operation::PolicyLoad, "policy.get", json!({}));
        app.issue_control(
            Area::Services,
            Operation::ServicesRefresh,
            "services.get",
            json!({}),
        );
        app.issue_control(
            Area::ModelCatalog,
            Operation::ModelCatalogLoad,
            "model.catalog.list",
            json!({}),
        );
        app.issue_control(
            Area::ModelDefaults,
            Operation::ModelDefaultsLoad,
            "model.defaults.get",
            json!({}),
        );
        app.issue_family(
            Area::ProviderKeys,
            Operation::ProviderSecretsLoad,
            "providers.secrets.list",
            json!({}),
        );
        app.issue_control(
            Area::PresetList,
            Operation::PresetListLoad,
            "preset.list",
            json!({}),
        );
        app.issue_control(
            Area::PresetBindings,
            Operation::PresetBindingsLoad,
            "preset.bindings.get",
            json!({}),
        );
        app.issue_control(
            Area::Pending,
            Operation::PendingRefresh,
            "pending.list",
            json!({}),
        );
        app.issue_control(
            Area::Slang,
            Operation::SlangLoad,
            "slang.getConfig",
            json!({}),
        );
        app.issue_control(
            Area::Sessions,
            Operation::SessionsRefresh,
            "session.list",
            json!({}),
        );
        app.issue_control(
            Area::Activity,
            Operation::ActivityRefresh,
            "activity.list",
            json!({ "limit": app.activity_limit }),
        );
        app.issue_control(
            Area::Logs,
            Operation::LogsRefresh,
            "logs.read",
            json!({ "source": app.log_source, "limit": app.log_limit }),
        );
        app
    }

    fn issue_chat_sessions(&mut self) {
        self.issue_control(Area::Chat, Operation::ChatSessionsLoad, "chat.sessions.list", json!({}));
    }

    fn issue_chat_history(&mut self) {
        if let Some(id) = self.chat.active_id.clone() {
            self.issue_control(Area::Chat, Operation::ChatHistoryLoad, "chat.history", json!({ "id": id }));
        }
    }

    /// Chat 流式轮询：仅在存在在途回合或等待首个回合确认时进行。
    fn maybe_poll_chat(&mut self, ctx: &egui::Context) {
        if self.navigation.page != AppPage::Chat {
            return;
        }
        let streaming = self
            .chat
            .turn
            .as_ref()
            .is_some_and(|turn| turn.state == "streaming" || turn.state == "cancelling");
        let watching = streaming || self.chat.expecting_turn;
        if !watching || self.pending.contains(&Area::ChatStatus) || !self.worker_available {
            return;
        }
        let due = match self.chat.last_poll {
            None => true,
            Some(at) => at.elapsed() >= Duration::from_millis(150),
        };
        if due {
            if let Some(id) = self.chat.active_id.clone() {
                self.chat.last_poll = Some(Instant::now());
                self.issue_control(Area::ChatStatus, Operation::ChatStatusPoll, "chat.status", json!({ "id": id }));
            }
        }
        if streaming {
            ctx.request_repaint_after(Duration::from_millis(120));
        }
    }

    fn issue_control(
        &mut self,
        area: Area,
        operation: Operation,
        method: &'static str,
        params: Value,
    ) {
        if method == "pending.list" {
            self.pending_refresh_at = Instant::now();
        }
        self.issue(area, operation, ApiCall::Control { method, params });
    }

    /// 产品私有方法族（chat.* / memory.*）：作为顶层 IPC method 发送，不经 control.execute。
    fn issue_family(
        &mut self,
        area: Area,
        operation: Operation,
        method: &'static str,
        params: Value,
    ) {
        self.issue(area, operation, ApiCall::Family { method, params });
    }

    fn maybe_refresh_pending(&mut self) {
        if self.navigation.legacy_tab != Tab::Pending
            || self.pending.contains(&Area::Pending)
            || self.pending_refresh_at.elapsed() < Duration::from_secs(3)
        {
            return;
        }
        self.issue_control(
            Area::Pending,
            Operation::PendingRefresh,
            "pending.list",
            json!({}),
        );
    }

    /// 进入审批页时自动读取一次 Capability 审批队列（每次进入读取一次）。
    fn maybe_load_capability_approvals(&mut self) {
        if self.navigation.legacy_tab != Tab::Pending
            || self.capability_approvals_loaded
            || self.pending.contains(&Area::CapabilityApproval)
        {
            return;
        }
        self.issue_family(
            Area::CapabilityApproval,
            Operation::CapabilityApprovalList,
            "capability.approval.list",
            json!({}),
        );
    }

    fn issue(&mut self, area: Area, operation: Operation, call: ApiCall) {
        if self.pending.contains(&area) {
            return;
        }
        if !self.worker_available {
            self.feedback.insert(
                area,
                Err(self
                    .worker_error
                    .clone()
                    .unwrap_or_else(|| "Core 工作线程不可用".to_owned())),
            );
            return;
        }

        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        match self.job_tx.send(WorkerJob {
            id,
            area,
            operation,
            call,
        }) {
            Ok(()) => {
                self.pending.insert(area);
                self.feedback.remove(&area);
                if area == Area::Services {
                    self.services_notice = None;
                }
            }
            Err(error) => {
                self.worker_available = false;
                let message = format!("Core 工作线程已停止：{error}");
                self.worker_error = Some(message.clone());
                self.feedback.insert(area, Err(message));
            }
        }
    }

    fn receive_events(&mut self) {
        while let Ok(event) = self.event_rx.try_recv() {
            // The single worker serializes calls. An id mismatch is ignored defensively in case
            // a future transport introduces cancellation or retries.
            let _request_id = event.id;
            self.pending.remove(&event.area);
            self.feedback.insert(event.area, event.result.clone());

            match (event.operation, event.result.as_ref()) {
                // ── 产品 Chat（阶段 03）──
                (Operation::ChatSessionsLoad, Ok(value)) => match parse_sessions(value) {
                    Ok(sessions) => {
                        self.chat.sessions = sessions;
                        self.chat.sessions_loaded = true;
                        let active_alive = self
                            .chat
                            .active_id
                            .as_ref()
                            .is_some_and(|id| self.chat.sessions.iter().any(|s| &s.id == id));
                        if !active_alive {
                            self.chat.active_id = self.chat.sessions.first().map(|s| s.id.clone());
                            self.chat.reset();
                            self.issue_chat_history();
                        }
                    }
                    Err(error) => self.chat.notice = Some(error),
                },
                (Operation::ChatSessionCreate, Ok(value)) => {
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        self.chat.active_id = Some(id.to_owned());
                        self.chat.reset();
                    }
                    self.chat.notice = Some("新会话已创建。".to_owned());
                    self.issue_chat_sessions();
                }
                (Operation::ChatSessionRename, Ok(_)) => {
                    self.chat.renaming = None;
                    self.chat.notice = Some("会话已重命名。".to_owned());
                    self.issue_chat_sessions();
                }
                (Operation::ChatSessionArchive, Ok(_)) => {
                    self.chat.notice = Some("会话归档状态已更新。".to_owned());
                    self.issue_chat_sessions();
                }
                (Operation::ChatSessionDelete, Ok(_)) => {
                    if self.chat.active_id.is_some() {
                        self.chat.active_id = None;
                        self.chat.reset();
                    }
                    self.chat.notice = Some("会话已删除。".to_owned());
                    self.issue_chat_sessions();
                }
                (Operation::ChatHistoryLoad, Ok(value)) => match parse_history(value) {
                    Ok(messages) => {
                        self.chat.messages = messages;
                        self.chat.history_loaded = true;
                    }
                    Err(error) => self.chat.notice = Some(error),
                },
                (Operation::ChatSend, Ok(_)) => {
                    self.chat.expecting_turn = true;
                    self.chat.last_poll = None;
                    self.issue_chat_history();
                }
                (Operation::ChatStop, Ok(_)) => {
                    self.chat.last_poll = None;
                }
                (Operation::ChatRetry | Operation::ChatContinue, Ok(_)) => {
                    self.chat.expecting_turn = true;
                    self.chat.last_poll = None;
                }
                (Operation::ChatConfigSave, Ok(_)) => {
                    self.chat.notice = Some("会话配置已保存并生效。".to_owned());
                    self.issue_chat_sessions();
                }
                (Operation::ChatCatalogLoad, Ok(value)) => {
                    let (models, error) = parse_catalog(value);
                    let model_providers = parse_model_providers(value);
                    self.chat.catalog = Some(json!({
                        "models": models.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
                        "error": error,
                        "agentProviders": value.get("agentProviders").cloned().unwrap_or(json!([])),
                        "modelProviders": model_providers.iter().map(|provider| json!({
                            "id": provider.id,
                            "label": provider.label,
                            "hasKey": provider.has_key,
                            "models": provider.models.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
                            "error": provider.error,
                        })).collect::<Vec<_>>(),
                        "defaultModelProvider": value.get("defaultModelProvider").cloned().unwrap_or(json!(null)),
                    }));
                }
                (Operation::ChatStatusPoll, Ok(value)) => {
                    match parse_turn(value) {
                        Some(turn) => {
                            self.chat.turn = Some(turn);
                            self.chat.had_turn = true;
                            self.chat.expecting_turn = false;
                        }
                        None => {
                            if self.chat.had_turn {
                                // 回合刚结束：清空在途状态并刷新历史拿最终消息。
                                self.chat.turn = None;
                                self.chat.had_turn = false;
                                self.issue_chat_history();
                            }
                            self.chat.expecting_turn = false;
                        }
                    }
                }
                (Operation::OverviewPing, Ok(value)) => {
                    self.core_online = Some(true);
                    self.core_summary = core_summary(value);
                }
                (Operation::OverviewPing, Err(error)) => {
                    self.core_online = Some(false);
                    self.core_summary = error.clone();
                }
                (Operation::DiagnosticsPing, Ok(value)) => {
                    self.core_online = Some(true);
                    self.core_summary = core_summary(value);
                }
                (Operation::DiagnosticsPing, Err(error)) => {
                    self.core_online = Some(false);
                    self.core_summary = error.clone();
                }
                (Operation::RolesRefresh, Ok(value)) => self.apply_roles(value),
                (Operation::RoleSet, Ok(value)) => {
                    self.current_role = value
                        .get("role")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    self.issue_control(
                        Area::Roles,
                        Operation::RolesRefresh,
                        "role.list",
                        json!({}),
                    );
                }
                (Operation::RoleCreate, Ok(_)) => {
                    self.new_role_name.clear();
                    self.new_role_content.clear();
                    self.issue_control(
                        Area::Roles,
                        Operation::RolesRefresh,
                        "role.list",
                        json!({}),
                    );
                }
                (Operation::RoleMode, Ok(value)) => {
                    if let Some(mode) = value.get("roleMode").and_then(Value::as_str) {
                        self.role_mode = mode.to_owned();
                    }
                }
                (Operation::SecurityLoad, Ok(value)) => self.apply_security(value),
                (Operation::SecuritySave, Ok(value)) => self.apply_security(value),
                (Operation::PolicyLoad, Ok(value)) => self.apply_policy(value),
                (Operation::PolicySave, Ok(value)) => {
                    self.policy_confirmation = None;
                    self.apply_policy(value);
                }
                (Operation::ServicesRefresh, Ok(value)) => {
                    self.services_notice = Some("服务状态已刷新。".to_owned());
                    self.apply_services(value);
                }
                (Operation::ServicesDetect, Ok(value)) => {
                    self.services_notice =
                        Some("检测任务已提交；如仍显示旧状态，请稍后刷新。".to_owned());
                    self.apply_services(value);
                }
                (Operation::ServiceSelect(service), Ok(value)) => {
                    self.services_notice =
                        Some("安装项选择已提交；可刷新确认最新状态。".to_owned());
                    self.apply_service(service, value);
                }
                (Operation::ServiceStart(service), Ok(value)) => {
                    self.services_notice = Some(format!(
                        "{} 启动请求已提交；任务可能仍在后台运行，可稍后刷新。",
                        service.label()
                    ));
                    self.apply_service(service, value);
                }
                (Operation::ServiceStop(service), Ok(value)) => {
                    self.services_notice = Some(format!(
                        "{} 停止请求已提交；任务可能仍在后台运行，可稍后刷新。",
                        service.label()
                    ));
                    self.apply_service(service, value);
                }
                (Operation::ServiceInstallSnowLuma, Ok(value)) => {
                    self.services_notice = Some(
                        "SnowLuma 安装已提交；下载/安装可能仍在后台运行，可稍后刷新。".to_owned(),
                    );
                    self.apply_service(ServiceKind::SnowLuma, value);
                }
                (Operation::ModelCatalogLoad, Ok(value)) => self.apply_model_catalog(value),
                (Operation::ModelDefaultsLoad, Ok(value)) => self.apply_model_defaults(value),
                (Operation::ModelDefaultsSave, Ok(value)) => {
                    self.model_notice = Some(
                        "默认模型已保存；仅影响未来新建会话，不会传递 secret/settings 全文。"
                            .to_owned(),
                    );
                    self.apply_model_defaults(value);
                }
                (Operation::ProviderSecretsLoad, Ok(value)) => {
                    match parse_provider_secrets(value) {
                        Ok(rows) => {
                            self.provider_secrets = rows;
                            self.provider_secrets_loaded = true;
                        }
                        Err(error) => {
                            self.feedback.insert(Area::ProviderKeys, Err(error));
                        }
                    }
                }
                (Operation::ProviderSecretSave, Ok(_)) => {
                    self.provider_key_input.clear();
                    self.provider_secrets_notice = Some("API Key 已保存（仅本机，界面只显示掩码）。".to_owned());
                    self.issue_family(
                        Area::ProviderKeys,
                        Operation::ProviderSecretsLoad,
                        "providers.secrets.list",
                        json!({}),
                    );
                }
                (Operation::ProviderSecretDelete, Ok(value)) => {
                    let removed = value.get("removed").and_then(Value::as_bool).unwrap_or(false);
                    self.provider_secrets_notice = Some(if removed {
                        "API Key 已删除。".to_owned()
                    } else {
                        "该 Provider 未配置 API Key。".to_owned()
                    });
                    self.issue_family(
                        Area::ProviderKeys,
                        Operation::ProviderSecretsLoad,
                        "providers.secrets.list",
                        json!({}),
                    );
                }
                (Operation::ProviderSecretTest, Ok(value)) => {
                    let provider = value.get("provider").and_then(Value::as_str).unwrap_or("provider");
                    let message = value.get("message").and_then(Value::as_str).unwrap_or("测试完成");
                    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    self.provider_secrets_notice = Some(format!(
                        "{provider}：{}{message}",
                        if ok { "可用 — " } else { "不可用 — " }
                    ));
                }
                (Operation::PresetListLoad, Ok(value)) => self.apply_preset_list(value),
                (Operation::PresetBindingsLoad, Ok(value)) => self.apply_preset_bindings(value),
                (Operation::PresetBindingSave(target), Ok(value)) => {
                    self.preset_notice = Some(format!("{} 的 Preset 绑定已保存。", target.label()));
                    self.apply_preset_bindings(value);
                }
                (Operation::PendingRefresh, Ok(value)) => {
                    self.pending_notice = Some("挂起请求已刷新。".to_owned());
                    self.apply_pending(value);
                }
                (Operation::PendingDecision, Ok(_)) => {
                    self.pending_answer.clear();
                    self.pending_notice = Some("决定已提交，正在刷新挂起请求。".to_owned());
                    self.issue_control(
                        Area::Pending,
                        Operation::PendingRefresh,
                        "pending.list",
                        json!({}),
                    );
                }
                (Operation::CapabilityApprovalList, Ok(value)) => {
                    self.capability_approvals = parse_capability_approvals(value);
                    self.capability_approvals_loaded = true;
                }
                (Operation::CapabilityApprovalDecide, Ok(_)) => {
                    self.capability_approval_notice = Some("决定已提交，正在刷新能力审批队列。".to_owned());
                    self.issue_family(
                        Area::CapabilityApproval,
                        Operation::CapabilityApprovalList,
                        "capability.approval.list",
                        json!({}),
                    );
                }
                (Operation::SlangLoad, Ok(value)) => self.apply_slang(value),
                (Operation::SlangSave, Ok(value)) => self.apply_slang(value),
                (Operation::SessionsRefresh, Ok(value)) => self.apply_sessions(value),
                (Operation::SessionPhase, Ok(_)) => self.issue_control(
                    Area::Sessions,
                    Operation::SessionsRefresh,
                    "session.list",
                    json!({}),
                ),
                (Operation::ActivityRefresh, Ok(value)) => self.apply_activity(value),
                (Operation::LogsRefresh, Ok(value)) => self.apply_logs(value),
                (Operation::MemoryCall, Ok(value)) => {
                    if self.memory.apply(value) {
                        self.issue_family(
                            Area::Memory,
                            Operation::MemoryCall,
                            "memory.overview",
                            json!({}),
                        );
                    }
                }
                (Operation::WorkspaceCall, Ok(value)) => {
                    // 单飞守卫：每个 area 同时只有一个在途调用，因此这里每步只发一个请求，
                    // 形成可终止的刷新链：变更 → info → list（detail 已就绪则停止）。
                    let is_list = value.get("workspaces").is_some();
                    let needs_refresh = self.workspace.apply(value);
                    let selected = self.workspace.selected.clone();
                    if is_list {
                        // 首次清单：自动加载选中工作区的详情（最近文件 / 活动 / 待审批）。
                        if self.workspace.detail.is_none() {
                            if let Some(id) = selected {
                                self.issue_family(
                                    Area::Workspace,
                                    Operation::WorkspaceCall,
                                    "workspace.info",
                                    json!({ "id": id }),
                                );
                            }
                        }
                    } else if needs_refresh && selected.is_some() {
                        // 变更类响应（create/open/rename/remove/settings/commit/decide）：
                        // 先刷详情（含 pending），详情到达后再补一次清单同步行级数据。
                        if let Some(id) = selected {
                            self.issue_family(
                                Area::Workspace,
                                Operation::WorkspaceCall,
                                "workspace.info",
                                json!({ "id": id }),
                            );
                        }
                    } else {
                        // 详情 / 工具响应：同步一次清单（行级数据可能已变化）。
                        self.issue_family(
                            Area::Workspace,
                            Operation::WorkspaceCall,
                            "workspace.list",
                            json!({}),
                        );
                    }
                }
                (Operation::TaskCall, Ok(value)) => {
                    if self.task.apply(value) {
                        self.issue_family(
                            Area::Task,
                            Operation::TaskCall,
                            "task.overview",
                            json!({}),
                        );
                    }
                }
                (Operation::WorkshopCall, Ok(value)) => {
                    if self.workshop.apply(value) {
                        self.issue_family(
                            Area::Workshop,
                            Operation::WorkshopCall,
                            "workshop.proposal.list",
                            json!({ "limit": 200 }),
                        );
                    }
                }
                (Operation::MeshCall, Ok(value)) => {
                    if self.mesh.apply(value) {
                        self.issue_family(Area::Mesh, Operation::MeshCall, "mesh.snapshot", json!({}));
                    }
                }
                (Operation::ChannelCall, Ok(value)) => {
                    if self.mesh.apply(value) {
                        self.issue_family(Area::Channel, Operation::ChannelCall, "channel.list", json!({}));
                    }
                }
                _ => {}
            }
        }
    }

    fn apply_roles(&mut self, value: &Value) {
        let result = value.get("roles").unwrap_or(&Value::Null);
        let mut roles = Vec::new();
        if let Some(items) = result.as_array() {
            for item in items {
                let name = item
                    .as_str()
                    .or_else(|| item.get("name").and_then(Value::as_str));
                if let Some(name) = name {
                    roles.push(name.to_owned());
                }
            }
        }
        self.roles = roles;
        self.current_role = value
            .get("current")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        self.role_mode = value
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or(&self.role_mode)
            .to_owned();

        if !self.roles.iter().any(|role| role == &self.selected_role) {
            self.selected_role = self
                .current_role
                .clone()
                .or_else(|| self.roles.first().cloned())
                .unwrap_or_default();
        }
    }

    fn apply_security(&mut self, value: &Value) {
        let security = value.get("security").unwrap_or(value);
        if let Some(enabled) = security.get("interceptNotify").and_then(Value::as_bool) {
            self.intercept_notify = enabled;
            self.security_loaded = true;
        }
    }

    fn apply_policy(&mut self, value: &Value) {
        match self.policy.apply(value) {
            Ok(()) => {
                self.loaded_policy_mode = Some(self.policy.mode.clone());
                self.policy_loaded = true;
            }
            Err(error) => {
                self.policy_loaded = false;
                self.feedback.insert(Area::Policy, Err(error));
            }
        }
    }

    fn apply_services(&mut self, value: &Value) {
        let services = value.get("services").unwrap_or(value);
        let snowluma = services
            .get("snowluma")
            .ok_or_else(|| "Core 返回的 SnowLuma 状态缺失。".to_owned())
            .and_then(parse_service_snapshot);
        let dsh = services
            .get("dsh")
            .ok_or_else(|| "Core 返回的 DSH 状态缺失。".to_owned())
            .and_then(parse_service_snapshot);
        match (snowluma, dsh) {
            (Ok(snowluma), Ok(dsh)) => {
                self.services_snowluma = snowluma;
                self.services_dsh = dsh;
                self.services_loaded = true;
                self.reconcile_selected_install(ServiceKind::SnowLuma);
                self.reconcile_selected_install(ServiceKind::Dsh);
            }
            (Err(error), _) | (_, Err(error)) => {
                self.feedback.insert(Area::Services, Err(error));
            }
        }
    }

    fn apply_service(&mut self, service: ServiceKind, value: &Value) {
        let snapshot_value = value.get("service").unwrap_or(value);
        let result = parse_service_snapshot(snapshot_value);
        match result {
            Ok(snapshot) => {
                match service {
                    ServiceKind::SnowLuma => self.services_snowluma = snapshot,
                    ServiceKind::Dsh => self.services_dsh = snapshot,
                }
                self.reconcile_selected_install(service);
                self.services_loaded = true;
            }
            Err(error) => {
                self.feedback.insert(Area::Services, Err(error));
            }
        }
    }

    fn apply_model_catalog(&mut self, value: &Value) {
        match parse_model_catalog(value) {
            Ok(models) => {
                self.model_catalog = models;
                self.model_catalog_loaded = true;
            }
            Err(error) => {
                self.feedback.insert(Area::ModelCatalog, Err(error));
            }
        }
    }

    fn apply_model_defaults(&mut self, value: &Value) {
        match parse_model_defaults(value) {
            Ok(defaults) => {
                self.model_defaults = defaults;
                self.model_defaults_loaded = true;
            }
            Err(error) => {
                self.feedback.insert(Area::ModelDefaults, Err(error));
            }
        }
    }

    fn apply_preset_list(&mut self, value: &Value) {
        match parse_preset_list(value) {
            Ok(presets) => {
                self.presets = presets;
                self.preset_list_loaded = true;
                self.reconcile_preset_selections();
            }
            Err(error) => {
                self.feedback.insert(Area::PresetList, Err(error));
            }
        }
    }

    fn apply_preset_bindings(&mut self, value: &Value) {
        match parse_preset_bindings(value) {
            Ok(bindings) => {
                self.preset_bindings = bindings;
                self.preset_bindings_loaded = true;
                self.reconcile_preset_selections();
            }
            Err(error) => {
                self.feedback.insert(Area::PresetBindings, Err(error));
            }
        }
    }

    fn apply_pending(&mut self, value: &Value) {
        match parse_pending(value) {
            Ok(items) => {
                self.pending_items = items;
                self.pending_loaded = true;
            }
            Err(error) => {
                self.pending_loaded = false;
                self.feedback.insert(Area::Pending, Err(error));
            }
        }
    }

    fn reconcile_preset_selections(&mut self) {
        for target in PRESET_TARGETS {
            let selected = self.preset_selection.get(target);
            if self.presets.iter().any(|preset| preset.id == selected) && !selected.is_empty() {
                continue;
            }
            let current = self.preset_bindings.get(target).unwrap_or_default();
            *self.preset_selection.get_mut(target) =
                if self.presets.iter().any(|preset| preset.id == current) {
                    current.to_owned()
                } else {
                    String::new()
                };
        }
    }

    fn reconcile_selected_install(&mut self, service: ServiceKind) {
        let (snapshot, selected) = match service {
            ServiceKind::SnowLuma => (&self.services_snowluma, &mut self.selected_snowluma_install),
            ServiceKind::Dsh => (&self.services_dsh, &mut self.selected_dsh_install),
        };
        if snapshot.has_selectable_install(selected) {
            return;
        }
        *selected = snapshot
            .selected_id
            .as_ref()
            .filter(|selected_id| snapshot.has_selectable_install(selected_id))
            .or_else(|| {
                snapshot
                    .installations
                    .iter()
                    .find(|item| item.valid == Some(true))
                    .map(|item| &item.id)
            })
            .cloned()
            .unwrap_or_default();
    }

    fn apply_slang(&mut self, value: &Value) {
        let config = value
            .get("config")
            .or_else(|| value.get("slang"))
            .unwrap_or(value);
        if let Some(enabled) = config.get("enabled").and_then(Value::as_bool) {
            self.slang.enabled = enabled;
        }
        if let Some(number) = config.get("extractMinMessages").and_then(Value::as_u64) {
            self.slang.extract_min_messages = number.to_string();
        }
        if let Some(number) = config.get("extractCooldownMs").and_then(Value::as_u64) {
            self.slang.extract_cooldown_ms = number.to_string();
        }
        if let Some(number) = config.get("injectMax").and_then(Value::as_u64) {
            self.slang.inject_max = number.to_string();
        }
        if let Some(enabled) = config.get("autoResearch").and_then(Value::as_bool) {
            self.slang.auto_research = enabled;
        }
        if let Some(text) = config.get("learnerPreset").and_then(Value::as_str) {
            self.slang.learner_preset = text.to_owned();
        }
        if let Some(text) = config.get("workspaceTitle").and_then(Value::as_str) {
            self.slang.workspace_title = text.to_owned();
        }
        if let Some(values) = config.get("inferenceThresholds").and_then(Value::as_array) {
            self.slang.inference_thresholds = values
                .iter()
                .filter_map(Value::as_u64)
                .map(|number| number.to_string())
                .collect::<Vec<_>>()
                .join(", ");
        }
        self.slang_loaded = true;
    }

    fn apply_sessions(&mut self, value: &Value) {
        let mut sessions = Vec::new();
        if let Some(items) = value.get("sessions").and_then(Value::as_array) {
            for item in items {
                let key = match item.get("key").and_then(Value::as_str) {
                    Some(key) => key.to_owned(),
                    None => continue,
                };
                let session_id = item
                    .get("sessionId")
                    .map(compact_value)
                    .unwrap_or_else(|| "—".to_owned());
                let owner = item.get("owner").and_then(Value::as_bool).unwrap_or(false);
                sessions.push(SessionRow {
                    key,
                    session_id,
                    owner,
                });
            }
        }
        self.sessions = sessions;
    }

    fn apply_activity(&mut self, value: &Value) {
        match read_string_collection(
            value,
            "entries",
            self.activity_limit.min(MAX_ACTIVITY_ITEMS),
            "活动记录",
        ) {
            Ok(entries) => self.activity_entries = entries,
            Err(error) => {
                self.feedback.insert(Area::Activity, Err(error));
            }
        }
    }

    fn apply_logs(&mut self, value: &Value) {
        match read_string_collection(value, "lines", self.log_limit.min(MAX_LOG_LINES), "日志") {
            Ok(lines) => self.log_lines = lines,
            Err(error) => {
                self.feedback.insert(Area::Logs, Err(error));
            }
        }
    }

    fn prefs_snapshot(&self) -> UiPrefs {
        self.prefs.lock().expect("ui prefs lock").clone()
    }

    fn update_prefs(&mut self, update: impl FnOnce(&mut UiPrefs)) -> UiPrefs {
        let snapshot = {
            let mut prefs = self.prefs.lock().expect("ui prefs lock");
            update(&mut prefs);
            prefs.clone()
        };
        self.save_prefs_now();
        snapshot
    }

    fn save_prefs_now(&self) {
        let result = {
            let prefs = self.prefs.lock().expect("ui prefs lock");
            prefs.save(&self.data_dir)
        };
        if let Err(error) = result {
            crate::supervisor::write_shell_log(&self.data_dir, &format!("[ui-prefs] {error}"));
        }
    }

    fn save_geometry(&mut self, ctx: &egui::Context) {
        let viewport = ctx.input(|input| input.viewport().clone());
        let Some(rect) = viewport.outer_rect else {
            return;
        };
        let maximized = viewport.maximized.unwrap_or(false);
        let Some(geometry) = crate::ui_prefs::sanitize_geometry(
            rect.min.x,
            rect.min.y,
            rect.width(),
            rect.height(),
            maximized,
        ) else {
            return;
        };
        let changed = {
            let mut prefs = self.prefs.lock().expect("ui prefs lock");
            if prefs.geometry == Some(geometry) {
                false
            } else {
                prefs.geometry = Some(geometry);
                true
            }
        };
        if changed {
            self.save_prefs_now();
        }
    }

    fn quit_blockers(&self) -> Vec<String> {
        let mut blockers = Vec::new();
        let streaming = self
            .chat
            .turn
            .as_ref()
            .is_some_and(|turn| turn.state == "streaming" || turn.state == "cancelling");
        if streaming {
            blockers.push("有一条回复正在生成（退出会中断它）".to_owned());
        }
        let mut draft_count = self
            .chat_drafts
            .values()
            .filter(|draft| !draft.trim().is_empty())
            .count();
        if !self.chat.input.trim().is_empty() {
            draft_count += 1;
        }
        if draft_count > 0 {
            blockers.push(format!("有 {draft_count} 条未发送的聊天草稿"));
        }
        if !self.task.attention.is_empty() {
            blockers.push(format!(
                "有 {} 个任务正在等待人工处理",
                self.task.attention.len()
            ));
        }
        blockers
    }

    fn request_quit(&mut self, ctx: &egui::Context, reason: &str) {
        if self.exit_confirmed {
            return;
        }
        if self.quit_blockers().is_empty() {
            self.exit_confirmed = true;
            crate::supervisor::write_shell_log(
                &self.data_dir,
                &format!("[ui] 退出应用：{reason}"),
            );
            self.save_geometry(ctx);
            self.save_prefs_now();
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        } else {
            self.quit_confirm = Some(reason.to_owned());
        }
    }

    fn hide_to_tray(&mut self, ctx: &egui::Context) {
        if self.tray.is_none() {
            self.request_quit(ctx, "关闭主窗口");
            return;
        }
        self.window_hidden = true;
        if let Some(tray) = &self.tray {
            tray.set_window_visible(false);
        }
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
        self.save_geometry(ctx);
        self.save_prefs_now();
        crate::supervisor::write_shell_log(
            &self.data_dir,
            "[ui] 主窗口已隐藏到托盘；Core 与任务继续运行",
        );
        if !self.hidden_notice_shown {
            self.hidden_notice_shown = true;
            self.toast = Some((
                "已隐藏到托盘：Core 与任务继续运行；托盘菜单选择“退出”才会停止。".to_owned(),
                Instant::now(),
            ));
        }
    }

    fn show_main_window(&mut self, ctx: &egui::Context) {
        self.window_hidden = false;
        if let Some(tray) = &self.tray {
            tray.set_window_visible(true);
        }
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
    }

    fn handle_close_request(&mut self, ctx: &egui::Context) {
        if !ctx.input(|input| input.viewport().close_requested()) {
            return;
        }
        if self.exit_confirmed {
            return;
        }
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        let close_behavior = self.prefs_snapshot().close_behavior;
        if self.tray.is_some() && close_behavior == CloseBehavior::HideToTray {
            self.hide_to_tray(ctx);
        } else {
            self.request_quit(ctx, "关闭主窗口");
        }
    }

    fn handle_tray_commands(&mut self, ctx: &egui::Context) {
        let commands = match &self.tray {
            Some(tray) => tray.poll(),
            None => Vec::new(),
        };
        for command in commands {
            match command {
                TrayCommand::ShowWindow => self.show_main_window(ctx),
                TrayCommand::HideWindow => self.hide_to_tray(ctx),
                TrayCommand::RestartCore => {
                    self.supervisor.request_restart();
                    self.toast = Some(("已请求重启 Core…".to_owned(), Instant::now()));
                }
                TrayCommand::ExitRequested => self.request_quit(ctx, "托盘菜单选择退出"),
            }
        }
    }

    fn handle_shortcuts(&mut self, ctx: &egui::Context) {
        use egui::{Key, Modifiers};
        let mut target: Option<AppPage> = None;
        if !ctx.egui_wants_keyboard_input() {
            let keys = [
                Key::Num1,
                Key::Num2,
                Key::Num3,
                Key::Num4,
                Key::Num5,
                Key::Num6,
                Key::Num7,
            ];
            for (index, key) in keys.iter().enumerate() {
                if ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, *key)) {
                    target = page_for_shortcut_slot((index + 1) as u8);
                }
            }
            if ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::Comma)) {
                target = Some(AppPage::Settings);
            }
            if ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::Q)) {
                self.request_quit(ctx, "快捷键 Ctrl+Q");
            }
            if ctx.input_mut(|input| input.consume_key(Modifiers::NONE, Key::F1)) {
                self.shortcuts_open = true;
            }
            if self.quit_confirm.is_some()
                && ctx.input_mut(|input| input.consume_key(Modifiers::NONE, Key::Escape))
            {
                self.quit_confirm = None;
            } else if self.shortcuts_open
                && ctx.input_mut(|input| input.consume_key(Modifiers::NONE, Key::Escape))
            {
                self.shortcuts_open = false;
            }
        }

        // Zoom works even while typing, like a browser.
        let current = self.prefs_snapshot().zoom;
        let mut zoom: Option<f32> = None;
        if ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::Num0)) {
            zoom = Some(1.0);
        }
        if ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::Plus))
            || ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::Equals))
        {
            zoom = Some(crate::ui_prefs::clamp_zoom(current + 0.1));
        }
        if ctx.input_mut(|input| input.consume_key(Modifiers::CTRL, Key::Minus)) {
            zoom = Some(crate::ui_prefs::clamp_zoom(current - 0.1));
        }
        if let Some(zoom) = zoom {
            let snapshot = self.update_prefs(|prefs| prefs.zoom = zoom);
            ctx.set_zoom_factor(snapshot.zoom);
        }
        if let Some(page) = target {
            self.navigation.select_page(page);
        }
    }

    fn sync_theme_and_zoom(&mut self, ctx: &egui::Context) {
        let prefs = self.prefs_snapshot();
        let system_dark = ctx.system_theme() == Some(egui::Theme::Dark);
        let dark = prefs.theme.resolves_to_dark(system_dark);
        if self.applied_theme_dark != Some(dark) {
            self.applied_theme_dark = Some(dark);
            crate::supervisor::write_shell_log(
                &self.data_dir,
                &format!(
                    "[ui] 主题已应用：{}（偏好：{}）",
                    if dark { "深色" } else { "浅色" },
                    prefs.theme.as_str()
                ),
            );
        }
        if self.applied_zoom != Some(prefs.zoom) {
            self.applied_zoom = Some(prefs.zoom);
            crate::supervisor::write_shell_log(
                &self.data_dir,
                &format!(
                    "[ui] 界面缩放已应用：{}%",
                    (prefs.zoom * 100.0).round() as i32
                ),
            );
        }
        sync_theme_preference(ctx, prefs.theme);
        if (ctx.zoom_factor() - prefs.zoom).abs() > 0.001 {
            ctx.set_zoom_factor(prefs.zoom);
        }
    }

    fn sync_chat_draft(&mut self) {
        if self.chat.active_id != self.last_active_chat {
            if let Some(previous) = self.last_active_chat.clone() {
                if self.chat.input.trim().is_empty() {
                    self.chat_drafts.remove(&previous);
                } else {
                    self.chat_drafts.insert(previous, self.chat.input.clone());
                }
            }
            self.last_active_chat = self.chat.active_id.clone();
            self.chat.input = self
                .chat
                .active_id
                .as_ref()
                .and_then(|id| self.chat_drafts.get(id).cloned())
                .unwrap_or_default();
            self.chat.attachments.clear();
        } else if let Some(active) = self.chat.active_id.clone() {
            if self.chat.input.trim().is_empty() {
                self.chat_drafts.remove(&active);
            } else {
                self.chat_drafts.insert(active, self.chat.input.clone());
            }
        }
    }

    fn tray_status(&self) -> TrayStatus {
        let core = match self.core_online {
            Some(true) => "已连接".to_owned(),
            Some(false) => "不可用".to_owned(),
            None => "正在启动…".to_owned(),
        };
        let mut details = Vec::new();
        if !self.task.attention.is_empty() {
            details.push(format!("{} 个任务", self.task.attention.len()));
        }
        if !self.pending_items.is_empty() {
            details.push(format!("{} 项审批/问题", self.pending_items.len()));
        }
        let attention = if details.is_empty() {
            None
        } else {
            Some(details.join("，"))
        };
        TrayStatus { core, attention }
    }

    fn update_tray(&mut self) {
        let Some(tray) = &self.tray else {
            return;
        };
        let status = self.tray_status();
        if self.last_tray_status.as_ref() != Some(&status) {
            tray.update_status(&status);
            self.last_tray_status = Some(status);
        }
    }

    fn open_logs(&self) {
        let directory = crate::desktop_paths::log_dir(&self.data_dir);
        crate::supervisor::write_shell_log(
            &self.data_dir,
            &format!("[ui] 打开日志目录 {}", directory.display()),
        );
        let _ = std::process::Command::new("explorer.exe")
            .arg(directory)
            .spawn();
    }

    fn show_core_attention_banner(&mut self, ui: &mut egui::Ui) {
        let status = self.supervisor.status();
        let core_offline = self.core_online == Some(false);
        if !status.needs_attention() && !core_offline {
            return;
        }
        let palette = native_palette();
        egui::Frame::new()
            .fill(palette.error_bg)
            .stroke(egui::Stroke::new(1.0, palette.error))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(
                        egui::RichText::new(format!("Core 需要处理：{}", status.summary()))
                            .color(palette.error)
                            .strong(),
                    );
                    if ui.button("重启 Core").clicked() {
                        self.supervisor.request_restart();
                    }
                    if ui.button("重新检查").clicked() {
                        self.issue(Area::Overview, Operation::OverviewPing, ApiCall::Ping);
                    }
                    if ui.button("打开日志目录").clicked() {
                        self.open_logs();
                    }
                });
            });
        ui.add_space(8.0);
    }

    fn show_toast(&mut self, ui: &mut egui::Ui) {
        let Some((message, created)) = self.toast.clone() else {
            return;
        };
        if created.elapsed() > Duration::from_secs(8) {
            self.toast = None;
            return;
        }
        let palette = native_palette();
        egui::Frame::new()
            .fill(palette.accent_bg)
            .stroke(egui::Stroke::new(1.0, palette.accent))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 8))
            .show(ui, |ui| {
                ui.label(egui::RichText::new(message).color(palette.text));
            });
        ui.add_space(8.0);
    }

    fn show_shortcuts_window(&mut self, ctx: &egui::Context) {
        if !self.shortcuts_open {
            return;
        }
        let mut open = true;
        egui::Window::new("键盘快捷键")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .show(ctx, |ui| {
                for (keys, description) in SHORTCUTS {
                    ui.horizontal(|ui| {
                        ui.monospace(*keys);
                        ui.label(*description);
                    });
                }
            });
        if !open {
            self.shortcuts_open = false;
        }
    }

    fn show_quit_confirm(&mut self, ctx: &egui::Context) {
        let Some(reason) = self.quit_confirm.clone() else {
            return;
        };
        let blockers = self.quit_blockers();
        let mut cancel = false;
        let mut quit = false;
        egui::Window::new("退出 CetaMesh 前确认")
            .collapsible(false)
            .resizable(false)
            .show(ctx, |ui| {
                ui.label(egui::RichText::new(format!("触发：{reason}")).strong());
                ui.label("退出会停止 Core；正在运行的任务与正在生成的回复将被中断。");
                if !blockers.is_empty() {
                    ui.separator();
                    for blocker in &blockers {
                        ui.label(format!("• {blocker}"));
                    }
                }
                ui.separator();
                ui.horizontal(|ui| {
                    if ui.button("继续使用").clicked() {
                        cancel = true;
                    }
                    if ui
                        .button(
                            egui::RichText::new("退出并停止 Core").color(native_palette().error),
                        )
                        .clicked()
                    {
                        quit = true;
                    }
                });
            });
        if cancel {
            self.quit_confirm = None;
        }
        if quit {
            self.quit_confirm = None;
            self.exit_confirmed = true;
            self.save_geometry(ctx);
            self.save_prefs_now();
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }

    fn compact_page_button(&mut self, ui: &mut egui::Ui, page: AppPage) {
        let selected = self.navigation.page == page;
        if ui.selectable_label(selected, page.label()).clicked() {
            self.navigation.select_page(page);
        }
    }

    fn show_compact_nav(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        egui::Frame::new()
            .fill(palette.surface)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(10, 8))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.strong("CetaMesh");
                    ui.separator();
                    for page in AppPage::PRIMARY {
                        self.compact_page_button(ui, page);
                    }
                    ui.separator();
                    for page in AppPage::SECONDARY {
                        self.compact_page_button(ui, page);
                    }
                });
            });
    }

    fn show_settings_appearance(&mut self, ui: &mut egui::Ui) {
        let mut prefs = self.prefs_snapshot();
        let mut changed = false;
        ui.heading("外观与窗口");
        ui.horizontal_wrapped(|ui| {
            ui.label("主题：");
            changed |= ui
                .radio_value(&mut prefs.theme, ThemePreference::System, "跟随系统")
                .changed();
            changed |= ui
                .radio_value(&mut prefs.theme, ThemePreference::Light, "浅色")
                .changed();
            changed |= ui
                .radio_value(&mut prefs.theme, ThemePreference::Dark, "深色")
                .changed();
        });
        ui.horizontal_wrapped(|ui| {
            ui.label("界面缩放：");
            if ui.small_button("－").clicked() {
                prefs.zoom = crate::ui_prefs::clamp_zoom(prefs.zoom - 0.1);
                changed = true;
            }
            ui.monospace(format!("{}%", (prefs.zoom * 100.0).round() as i32));
            if ui.small_button("＋").clicked() {
                prefs.zoom = crate::ui_prefs::clamp_zoom(prefs.zoom + 0.1);
                changed = true;
            }
            if ui.small_button("重置").clicked() {
                prefs.zoom = 1.0;
                changed = true;
            }
            ui.small("快捷键：Ctrl+0 重置，Ctrl+= 放大，Ctrl+- 缩小");
        });
        ui.horizontal_wrapped(|ui| {
            ui.label("关闭主窗口时：");
            changed |= ui
                .radio_value(
                    &mut prefs.close_behavior,
                    CloseBehavior::HideToTray,
                    "隐藏到托盘，任务继续运行",
                )
                .changed();
            changed |= ui
                .radio_value(
                    &mut prefs.close_behavior,
                    CloseBehavior::Quit,
                    "退出应用并停止 Core",
                )
                .changed();
        });
        ui.small("只有托盘菜单“退出”或上面的退出选项会停止 Core；隐藏到托盘不会。");
        if ui.button("查看键盘快捷键（F1）").clicked() {
            self.shortcuts_open = true;
        }
        if changed {
            self.update_prefs(|stored| *stored = prefs);
        }
    }

    fn show_header(&self, ui: &mut egui::Ui, narrow: bool) {
        let palette = native_palette();
        let (status, color) = match self.core_online {
            Some(true) => ("Core 已连接", palette.success),
            Some(false) => ("Core 不可用", palette.error),
            None => ("Core 状态未知", palette.warning),
        };
        egui::Frame::new()
            .fill(palette.surface)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(egui::CornerRadius::same(10))
            .inner_margin(egui::Margin::symmetric(20, 14))
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());
                if narrow {
                    ui.vertical(|ui| {
                        ui.heading(self.navigation.page.label());
                        ui.label(
                            egui::RichText::new(self.navigation.page.description())
                                .color(palette.muted),
                        );
                        ui.add_space(4.0);
                        ui.label(egui::RichText::new(status).color(color).strong());
                    });
                } else {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.heading(self.navigation.page.label());
                            ui.label(
                                egui::RichText::new(self.navigation.page.description())
                                    .color(palette.muted),
                            );
                        });
                    ui.with_layout(
                        egui::Layout::right_to_left(egui::Align::Center),
                        |ui| {
                            ui.label(egui::RichText::new(status).color(color).strong());
                        },
                    );
                    });
                }
            });
    }

    fn page_button(&mut self, ui: &mut egui::Ui, page: AppPage) {
        let palette = native_palette();
        let selected = self.navigation.page == page;
        let color = if selected { palette.text } else { palette.muted };
        let width = ui.available_width().clamp(120.0, 240.0);
        let response = ui.add_sized(
            egui::vec2(width, 34.0),
            egui::Button::new(egui::RichText::new(page.label()).color(color)).selected(selected),
        );
        if response.clicked() {
            self.navigation.select_page(page);
        }
    }

    fn show_sidebar(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        ui.add_space(4.0);
        ui.heading(egui::RichText::new("CetaMesh").strong());
        ui.label(egui::RichText::new("Desktop").color(palette.muted));
        ui.add_space(16.0);
        for page in AppPage::PRIMARY {
            self.page_button(ui, page);
            ui.add_space(4.0);
        }
        ui.add_space(12.0);
        ui.separator();
        ui.add_space(6.0);
        ui.label(egui::RichText::new("管理").small().color(palette.muted).strong());
        ui.add_space(6.0);
        for page in AppPage::SECONDARY {
            self.page_button(ui, page);
            ui.add_space(4.0);
        }
    }

    fn show_page_section_nav(&mut self, ui: &mut egui::Ui) {
        let tabs = tabs_for(self.navigation.page);
        if tabs.is_empty() {
            return;
        }

        let palette = native_palette();
        egui::Frame::new()
            .fill(palette.surface)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(10, 8))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    for tab in tabs {
                        self.tab_button(ui, *tab, tab.label());
                    }
                });
            });
    }

    fn show_chat_page(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        if !self.chat.sessions_loaded && !self.pending.contains(&Area::Chat) && self.worker_available {
            self.issue_chat_sessions();
        }
        if self.chat.catalog.is_none() && !self.pending.contains(&Area::Chat) && self.worker_available {
            self.issue_control(Area::Chat, Operation::ChatCatalogLoad, "chat.catalog", json!({}));
        }
        self.accept_chat_drops(ui);

        // ── 会话管理行 ────────────────────────────────────────────────
        ui.horizontal_wrapped(|ui| {
            ui.heading("对话");
            ui.add_space(6.0);
            if ui.small_button("＋ 新会话").clicked() && !self.pending.contains(&Area::Chat) {
                self.issue_control(Area::Chat, Operation::ChatSessionCreate, "chat.sessions.create", json!({"title": "新会话"}));
            }
            let sessions = self.chat.sessions.clone();
            let active_id = self.chat.active_id.clone();
            egui::ComboBox::from_id_salt("chat_session_select")
                .selected_text(
                    sessions
                        .iter()
                        .find(|session| Some(&session.id) == active_id.as_ref())
                        .map(|session| session.title.clone())
                        .unwrap_or_else(|| "选择会话".to_owned()),
                )
                .width(240.0)
                .show_ui(ui, |ui| {
                    for session in &sessions {
                        let label = if session.archived {
                            format!("[归档] {}", session.title)
                        } else {
                            session.title.clone()
                        };
                        if ui.selectable_label(Some(&session.id) == active_id.as_ref(), label).clicked() {
                            self.chat.active_id = Some(session.id.clone());
                            self.chat.reset();
                            self.issue_chat_history();
                        }
                    }
                });
            if self.chat.active_id.is_some() {
                if ui.small_button("重命名").clicked() {
                    let title = self.chat.active_session().map(|s| s.title.clone()).unwrap_or_default();
                    self.chat.renaming = Some((self.chat.active_id.clone().unwrap_or_default(), title));
                }
                let delete_label = if self.chat.confirm_delete { "确认删除？" } else { "删除" };
                if ui.small_button(delete_label).clicked() {
                    if self.chat.confirm_delete {
                        if let Some(id) = self.chat.active_id.clone() {
                            self.chat.confirm_delete = false;
                            if !self.pending.contains(&Area::Chat) {
                                self.issue_control(Area::Chat, Operation::ChatSessionDelete, "chat.sessions.delete", json!({"id": id}));
                            }
                        }
                    } else {
                        self.chat.confirm_delete = true;
                    }
                } else if self.chat.confirm_delete {
                    self.chat.confirm_delete = false;
                }
                let archived = self.chat.active_session().is_some_and(|s| s.archived);
                let archive_label = if archived { "取消归档" } else { "归档" };
                if ui.small_button(archive_label).clicked() && !self.pending.contains(&Area::Chat) {
                    if let Some(id) = self.chat.active_id.clone() {
                        self.issue_control(Area::Chat, Operation::ChatSessionArchive, "chat.sessions.archive", json!({"id": id, "archived": !archived}));
                    }
                }
            }
        });
        let mut rename_confirmed = false;
        let mut rename_cancelled = false;
        if let Some((_, buffer)) = self.chat.renaming.as_mut() {
            ui.horizontal(|ui| {
                let response = ui.add(egui::TextEdit::singleline(buffer).desired_width(280.0).hint_text("新的会话名"));
                if ui.button("确定").clicked() {
                    rename_confirmed = true;
                }
                if response.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter)) {
                    rename_confirmed = true;
                }
                if ui.button("取消").clicked() {
                    rename_cancelled = true;
                }
            });
        }
        if rename_confirmed {
            if let Some((id, buffer)) = self.chat.renaming.take() {
                if !buffer.trim().is_empty() && !self.pending.contains(&Area::Chat) {
                    self.issue_control(Area::Chat, Operation::ChatSessionRename, "chat.sessions.rename", json!({"id": id, "title": buffer.trim()}));
                }
            }
        }
        if rename_cancelled {
            self.chat.renaming = None;
        }
        if !self.chat.notice_or_empty().is_empty() {
            ui.label(egui::RichText::new(self.chat.notice_or_empty().to_owned()).small().color(palette.muted));
        }
        ui.add_space(8.0);

        // ── 对话区 ───────────────────────────────────────────────────
        let active_title = self.chat.active_session().map(|s| s.title.clone()).unwrap_or_default();
        let config = self.chat.active_config();
        egui::Frame::new()
            .fill(palette.surface_alt)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(egui::CornerRadius::same(10))
            .inner_margin(egui::Margin::symmetric(14, 10))
            .show(ui, |ui| {
                if active_title.is_empty() {
                    ui.weak("选择或新建一个会话开始对话。");
                } else {
                    ui.horizontal(|ui| {
                        ui.strong(active_title);
                        ui.small(format!("{} · {} · reasoning={}", config.provider, config.model, config.reasoning));
                    });
                }
                ui.separator();
                egui::ScrollArea::vertical()
                    .id_salt("chat_transcript_scroll")
                    .auto_shrink([false, false])
                    .stick_to_bottom(true)
                    .max_height(400.0)
                    .show(ui, |ui| {
                        self.show_chat_transcript(ui);
                    });
            });
        ui.add_space(8.0);

        // ── Composer ────────────────────────────────────────────────
        self.show_chat_composer(ui);
        ui.add_space(6.0);

        // ── 弱化的会话配置（次级控件行） ───────────────────────────────
        self.show_chat_secondary_controls(ui);

        // 配置保存失败（例如 DSH 未连接导致 MODEL_BIND_FAILED）时必须可见，否则下拉看起来像“没反应”。
        ui.add_space(8.0);
        self.show_feedback(ui, Area::Chat);
    }

    fn show_chat_transcript(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        if !self.chat.history_loaded && !self.pending.contains(&Area::Chat) {
            ui.weak("正在加载对话历史…");
        }
        let messages = self.chat.messages.clone();
        for message in &messages {
            let is_user = message.role == "user";
            ui.push_id(&message.id, |ui| {
            egui::Frame::new()
                .fill(if is_user { palette.surface } else { palette.surface_alt })
                .stroke(egui::Stroke::new(1.0, palette.border))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(10, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.small(if is_user { "你" } else { "助手" });
                    });
                    ui.label(message.text.clone());
                    if let Some(error) = &message.error {
                        ui.label(egui::RichText::new(format!("错误：{error}")).color(palette.error));
                    }
                    if message.cancelled {
                        ui.label(egui::RichText::new("已停止（保留部分结果，可发送\"继续\"）").color(palette.muted));
                    }
                    ui.horizontal(|ui| {
                        if ui.small_button("复制").clicked() {
                            ui.ctx().copy_text(message.text.clone());
                        }
                        if let Some(usage) = &message.usage {
                            ui.small(format!("usage：{usage}"));
                        }
                    });
                });
            });
            ui.add_space(4.0);
        }
        if let Some(turn) = self.chat.turn.clone() {
            egui::Frame::new()
                .fill(palette.surface_alt)
                .stroke(egui::Stroke::new(1.0, palette.border))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(10, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.small("助手");
                        let state_label = match turn.state.as_str() {
                            "streaming" => "（回复中…）",
                            "cancelling" => "（正在停止…）",
                            _ => "",
                        };
                        if !state_label.is_empty() {
                            ui.small(state_label);
                        }
                    });
                    if turn.display_text.is_empty() {
                        ui.weak("正在等待模型输出…");
                    } else {
                        let mut display = turn.display_text.clone();
                        if turn.state == "streaming" {
                            display.push('▍');
                        }
                        ui.label(display);
                    }
                    if let Some(error) = &turn.error {
                        ui.label(egui::RichText::new(format!("错误：{error}")).color(palette.error));
                    }
                });
        } else if self.chat.history_loaded && self.chat.messages.last().is_some_and(|m| m.role == "user") {
            ui.label(egui::RichText::new("上一条消息尚未获得回复；可重试或重新发送。").color(palette.muted));
        }
        if self.chat.messages.is_empty() && self.chat.history_loaded {
            ui.weak("还没有消息。在下方输入并发送第一条消息。");
        }
    }

    fn show_chat_composer(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        let streaming = self.chat.turn.as_ref().is_some_and(|turn| turn.state == "streaming" || turn.state == "cancelling");
        let last_is_user = self.chat.messages.last().is_some_and(|m| m.role == "user");
        let can_continue = self
            .chat
            .messages
            .iter()
            .any(|m| m.role == "assistant" && (m.cancelled || m.error.is_some()));
        egui::Frame::new()
            .fill(palette.surface_alt)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(egui::CornerRadius::same(10))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                if !self.chat.attachments.is_empty() {
                    ui.horizontal_wrapped(|ui| {
                        let attachments = self.chat.attachments.clone();
                        for (index, (name, content)) in attachments.iter().enumerate() {
                            ui.label(format!("📎 {}（{} 字符）", name, content.chars().count()));
                            if ui.small_button("✕").clicked() {
                                self.chat.attachments.remove(index);
                            }
                        }
                    });
                }
                let composer = ui.add(
                    egui::TextEdit::multiline(&mut self.chat.input)
                        .id(egui::Id::new("cetamesh_chat_composer"))
                        .hint_text("输入消息；Enter 发送，Shift+Enter 换行（中文输入法不会误发）")
                        .desired_rows(3)
                        .desired_width(f32::INFINITY),
                );
                // IME-safe Enter-to-send: the composer must own focus, Shift must not be held, and
                // the same frame must not carry IME preedit/commit events. Confirming a Chinese
                // candidate therefore never sends the message by accident.
                let ime_active = ui.input(|input| {
                    input
                        .events
                        .iter()
                        .any(|event| matches!(event, egui::Event::Ime(_)))
                });
                let enter_send = should_send_on_enter(
                    composer.has_focus(),
                    ui.input(|input| input.key_pressed(egui::Key::Enter)),
                    ui.input(|input| input.modifiers.shift),
                    ime_active,
                );
                ui.horizontal(|ui| {
                    if streaming {
                        if ui.button("■ 停止").clicked() && !self.pending.contains(&Area::ChatStatus) {
                            if let Some(id) = self.chat.active_id.clone() {
                                self.issue_control(Area::Chat, Operation::ChatStop, "chat.stop", json!({"id": id}));
                            }
                        }
                    } else {
                        let can_send = self.chat.active_id.is_some()
                            && (!self.chat.input.trim().is_empty() || !self.chat.attachments.is_empty());
                        let send_button = ui.add_enabled(can_send, egui::Button::new("发送"));
                        let busy = self.pending.contains(&Area::Chat);
                        if (send_button.clicked() || (enter_send && can_send)) && !busy {
                            let text = self.chat.input.trim().to_owned();
                            let attachments = self.chat.attachments.clone();
                            if let Some(id) = self.chat.active_id.clone() {
                                let payload = json!({
                                    "id": id,
                                    "text": text,
                                    "attachments": attachments.iter().map(|(name, content)| json!({
                                        "name": name,
                                        "content": content,
                                    })).collect::<Vec<_>>(),
                                });
                                self.chat.input.clear();
                                self.chat.attachments.clear();
                                self.chat_drafts.remove(&id);
                                self.issue_control(Area::Chat, Operation::ChatSend, "chat.send", payload);
                            }
                        }
                        ui.small("拖入文本文件可作为附件");
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if !streaming && last_is_user && ui.small_button("重试").clicked() && !self.pending.contains(&Area::Chat) {
                            if let Some(id) = self.chat.active_id.clone() {
                                self.issue_control(Area::Chat, Operation::ChatRetry, "chat.retry", json!({"id": id}));
                            }
                        }
                        if !streaming && can_continue && ui.small_button("继续").clicked() && !self.pending.contains(&Area::Chat) {
                            if let Some(id) = self.chat.active_id.clone() {
                                self.issue_control(Area::Chat, Operation::ChatContinue, "chat.continue", json!({"id": id}));
                            }
                        }
                    });
                });
            });
    }

    fn show_chat_secondary_controls(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        let config = self.chat.active_config();
        if self.chat_model_input.trim().is_empty() && !config.model.is_empty() {
            self.chat_model_input = config.model.clone();
        }
        let catalog = self.chat.catalog.clone();
        let active_id = self.chat.active_id.clone();
        // Agent 选择：""=Auto（Smart 路由），"none"=Disabled，其余为显式 Agent Provider（如 dsh）。
        let agent_value = config.agent_provider.clone();
        let dsh_agent_selected = !agent_value.is_empty() && agent_value != "none";
        ui.horizontal_wrapped(|ui| {
            ui.small("会话配置：");
            let agent_options = match &catalog {
                Some(value) => value
                    .get("agentProviders")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| Some((
                                item.get("id").and_then(Value::as_str)?.to_owned(),
                                item.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                            )))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                None => Vec::new(),
            };
            egui::ComboBox::from_id_salt("chat_agent_select")
                .selected_text(match agent_value.as_str() {
                    "" => "Agent: Auto".to_owned(),
                    "none" => "Agent: Disabled".to_owned(),
                    id => format!(
                        "Agent: {}",
                        agent_options
                            .iter()
                            .find(|(option, _)| option == id)
                            .map(|(_, label)| label.clone())
                            .unwrap_or_else(|| id.to_owned())
                    ),
                })
                .width(130.0)
                .show_ui(ui, |ui| {
                    if ui.selectable_label(agent_value.is_empty(), "Auto").clicked() {
                        if let Some(session_id) = active_id.clone() {
                            self.issue_control(Area::Chat, Operation::ChatConfigSave, "chat.config.set", json!({"id": session_id, "config": {"agentProvider": null}}));
                        }
                    }
                    if ui.selectable_label(agent_value == "none", "Disabled").clicked() {
                        if let Some(session_id) = active_id.clone() {
                            self.issue_control(Area::Chat, Operation::ChatConfigSave, "chat.config.set", json!({"id": session_id, "config": {"agentProvider": "none"}}));
                        }
                    }
                    for (id, label) in &agent_options {
                        if ui.selectable_label(agent_value == *id, label).clicked() {
                            if let Some(session_id) = active_id.clone() {
                                self.issue_control(Area::Chat, Operation::ChatConfigSave, "chat.config.set", json!({"id": session_id, "config": {"agentProvider": id}}));
                            }
                        }
                    }
                });
            let (model_providers, default_model_provider) = match &catalog {
                Some(value) => {
                    let providers = parse_model_providers(value);
                    let default_id = value
                        .get("defaultModelProvider")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    (providers, default_id)
                }
                None => (Vec::new(), String::new()),
            };
            let selected_provider = if config.model_provider.is_empty() {
                default_model_provider.clone()
            } else {
                config.model_provider.clone()
            };
            // Model Provider 下拉只在非显式 Agent 时出现：普通聊天属于 Model Runtime。
            if !dsh_agent_selected {
                if model_providers.is_empty() {
                    ui.label(egui::RichText::new("Model Provider 不可用").small().color(palette.error));
                } else {
                    egui::ComboBox::from_id_salt("chat_model_provider_select")
                        .selected_text(format!(
                            "Provider: {}",
                            model_providers
                                .iter()
                                .find(|provider| provider.id == selected_provider)
                                .map(|provider| provider.label.clone())
                                .unwrap_or_else(|| "自动".to_owned())
                        ))
                        .width(150.0)
                        .show_ui(ui, |ui| {
                            for provider in &model_providers {
                                let suffix = if provider.has_key { "" } else { "（未配置 Key）" };
                                if ui
                                    .selectable_label(selected_provider == provider.id, format!("{}{suffix}", provider.label))
                                    .clicked()
                                {
                                    if let Some(session_id) = active_id.clone() {
                                        self.issue_control(
                                            Area::Chat,
                                            Operation::ChatConfigSave,
                                            "chat.config.set",
                                            json!({"id": session_id, "config": {"modelProvider": provider.id}}),
                                        );
                                    }
                                }
                            }
                        });
                }
            }
            // 模型列表来源：显式 Agent → DSH 目录；Model 通道 → 所选 Provider 的模型目录。
            let (models, model_source_error) = if dsh_agent_selected {
                match &catalog {
                    Some(value) => {
                        let models = value
                            .get("models")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(|item| Some((
                                        item.get("id").and_then(Value::as_str)?.to_owned(),
                                        item.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                                    )))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        let error = value.get("error").and_then(Value::as_str).map(ToOwned::to_owned);
                        (models, error)
                    }
                    None => (Vec::new(), None),
                }
            } else {
                match model_providers
                    .iter()
                    .find(|provider| provider.id == selected_provider)
                    .or_else(|| model_providers.iter().find(|provider| provider.has_key))
                {
                    Some(provider) if !provider.has_key => (Vec::new(), Some(format!("{} 未配置 API Key（设置 → 模型）", provider.label))),
                    Some(provider) => (provider.models.clone(), provider.error.clone()),
                    None => (Vec::new(), Some("未配置任何 Model Provider API Key（设置 → 模型）".to_owned())),
                }
            };
            if dsh_agent_selected && models.is_empty() {
                let reason = model_source_error.unwrap_or_else(|| "模型目录为空".to_owned());
                ui.label(egui::RichText::new(format!("模型不可用（{reason}）")).small().color(palette.error));
            } else if !models.is_empty() {
                egui::ComboBox::from_id_salt("chat_model_select")
                    .selected_text(config.model.clone())
                    .width(200.0)
                    .show_ui(ui, |ui| {
                        for (id, label) in &models {
                            let selected = config.model == *id;
                            let display = if label.is_empty() { id.clone() } else { format!("{label} ({id})") };
                            if ui.selectable_label(selected, display).clicked() {
                                if let Some(session_id) = active_id.clone() {
                                    self.issue_control(Area::Chat, Operation::ChatConfigSave, "chat.config.set", json!({"id": session_id, "config": {"model": id}}));
                                }
                            }
                        }
                    });
            } else if !dsh_agent_selected {
                ui.label(egui::RichText::new(model_source_error.unwrap_or_else(|| "模型列表不可用".to_owned())).small().color(palette.error));
            }
            // 目录不可用或需要指定目录外模型时，允许直接输入模型 ID。
            ui.label("自定义模型");
            ui.add(
                egui::TextEdit::singleline(&mut self.chat_model_input)
                    .desired_width(150.0)
                    .hint_text("模型 ID"),
            );
            if ui.small_button("应用").clicked() {
                let model = self.chat_model_input.trim().to_owned();
                if !model.is_empty() {
                    if let Some(session_id) = active_id.clone() {
                        self.issue_control(
                            Area::Chat,
                            Operation::ChatConfigSave,
                            "chat.config.set",
                            json!({"id": session_id, "config": {"model": model}}),
                        );
                    }
                }
            }
            egui::ComboBox::from_id_salt("chat_reasoning_select")
                .selected_text(format!("reasoning: {}", config.reasoning))
                .width(140.0)
                .show_ui(ui, |ui| {
                    for effort in ["off", "low", "high", "max"] {
                        if ui.selectable_label(config.reasoning == effort, effort).clicked() {
                            if let Some(session_id) = active_id.clone() {
                                self.issue_control(Area::Chat, Operation::ChatConfigSave, "chat.config.set", json!({"id": session_id, "config": {"reasoning": effort}}));
                            }
                        }
                    }
                });
            egui::ComboBox::from_id_salt("chat_mode_select")
                .selected_text(format!("Chat Session: {}", config.mode))
                .width(110.0)
                .show_ui(ui, |ui| {
                    for mode in ["chat", "smart"] {
                        if ui.selectable_label(config.mode == mode, mode).clicked() {
                            if let Some(session_id) = active_id.clone() {
                                self.issue_control(Area::Chat, Operation::ChatConfigSave, "chat.config.set", json!({"id": session_id, "config": {"mode": mode}}));
                            }
                        }
                    }
                });
            if dsh_agent_selected {
                ui.small("通道：DSH Agent");
            } else {
                ui.small("通道：Model Runtime");
            }
        });
    }

    fn accept_chat_drops(&mut self, ui: &mut egui::Ui) {
        let dropped = ui.ctx().input(|input| input.raw.dropped_files.clone());
        for file in dropped {
            let path = file.path().to_path_buf();
            let name = path
                .file_name()
                .map(|item| item.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_owned());
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    const MAX_ATTACHMENT_CHARS: usize = 256 * 1024;
                    if content.chars().count() > MAX_ATTACHMENT_CHARS {
                        self.chat.notice = Some(format!("附件「{name}」超过 256K 字符上限，未添加。"));
                    } else {
                        self.chat.attachments.push((name, content));
                    }
                }
                Err(error) => {
                    self.chat.notice = Some(format!("附件「{name}」读取失败：{error}（仅支持文本文件）"));
                }
        }
            }
    }
    fn show_tasks_page(&mut self, ui: &mut egui::Ui) {
        let actions = self.task.show(ui);
        for action in actions {
            self.issue_family(Area::Task, Operation::TaskCall, action.method, action.params);
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Task) {
            self.task.set_error(error.clone());
        }
        self.show_feedback(ui, Area::Task);
    }

    /// Work 页：Tasks 与 Workshop（Owner 审阅）两个内部区域。
    fn show_work_page(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.work_tab, WorkTab::Tasks, "Tasks");
            ui.selectable_value(&mut self.work_tab, WorkTab::Workshop, "Workshop（工作坊）");
        });
        ui.separator();
        match self.work_tab {
            WorkTab::Tasks => self.show_tasks_page(ui),
            WorkTab::Workshop => self.show_workshop_page(ui),
        }
    }

    fn show_workshop_page(&mut self, ui: &mut egui::Ui) {
        let actions = self.workshop.show(ui);
        for action in actions {
            self.issue_family(Area::Workshop, Operation::WorkshopCall, action.method, action.params);
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Workshop) {
            self.workshop.set_error(error.clone());
        }
        self.show_feedback(ui, Area::Workshop);
    }

    fn show_memory_page(&mut self, ui: &mut egui::Ui) {
        let actions = self.memory.show(ui);
        for action in actions {
            self.issue_family(Area::Memory, Operation::MemoryCall, action.method, action.params);
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Memory) {
            self.memory.set_error(error.clone());
        }
        self.show_feedback(ui, Area::Memory);
    }

    fn show_workspace_page(&mut self, ui: &mut egui::Ui) {
        let actions = self.workspace.show(ui);
        for action in actions {
            self.issue_family(Area::Workspace, Operation::WorkspaceCall, action.method, action.params);
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Workspace) {
            self.workspace.set_error(error.clone());
        }
        self.show_feedback(ui, Area::Workspace);
    }

    fn show_legacy_tab_page(&mut self, ui: &mut egui::Ui) {
        match self.navigation.legacy_tab {
            Tab::Overview => self.show_overview(ui),
            Tab::Roles => self.show_roles(ui),
            Tab::Policy => self.show_policy(ui),
            Tab::Services => self.show_services(ui),
            Tab::ModelsPresets => self.show_models_presets(ui),
            Tab::Pending => self.show_pending(ui),
            Tab::Security => self.show_security(ui),
            Tab::Slang => self.show_slang(ui),
            Tab::Sessions => self.show_sessions(ui),
            Tab::Activity => self.show_activity(ui),
            Tab::Logs => self.show_logs(ui),
            Tab::Diagnostics => self.show_diagnostics(ui),
        }
    }

    fn show_settings_page(&mut self, ui: &mut egui::Ui) {
        self.show_settings_appearance(ui);
    }

    fn show_devices_page(&mut self, ui: &mut egui::Ui) {
        // mesh 与 channel 分属两个 Area，因此同一帧可以各发一条请求（Area 互斥只作用于同一个 Area）。
        let mesh_actions = self.mesh.show(ui);
        for action in mesh_actions {
            match action.area {
                MeshArea::Mesh => {
                    self.issue_family(Area::Mesh, Operation::MeshCall, action.method, action.params)
                }
                MeshArea::Channel => {
                    self.issue_family(Area::Channel, Operation::ChannelCall, action.method, action.params)
                }
            }
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Mesh) {
            self.mesh.set_error(error.clone());
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Channel) {
            self.mesh.set_error(error.clone());
        }
    }

    fn show_page(&mut self, ui: &mut egui::Ui) {
        match self.navigation.page {
            AppPage::Chat => self.show_chat_page(ui),
            AppPage::Work => self.show_work_page(ui),
            AppPage::Memory => self.show_memory_page(ui),
            AppPage::Workspaces => self.show_workspace_page(ui),
            AppPage::Settings => self.show_settings_page(ui),
            AppPage::Devices => self.show_devices_page(ui),
            AppPage::Home | AppPage::Social | AppPage::Agents | AppPage::Connections | AppPage::Security => {
                self.show_legacy_tab_page(ui);
            }
            AppPage::Plugins => {
                ui.heading("Plugins");
                ui.label("插件管理页面尚未接入。已注册的能力继续由 Core 管理。");
            }
        }
    }

    fn tab_button(&mut self, ui: &mut egui::Ui, tab: Tab, label: &str) {
        let palette = native_palette();
        let active = self.navigation.legacy_tab == tab;
        let text_color = if active { palette.text } else { palette.muted };
        let response = ui.add(
            egui::Button::new(egui::RichText::new(label).color(text_color))
                .selected(active)
                .frame(true),
        );
        if response.clicked() {
            self.navigation.select_legacy_tab(tab);
        }
    }

    fn show_overview(&mut self, ui: &mut egui::Ui) {
        let palette = native_palette();
        ui.heading("运行概览");
        ui.horizontal(|ui| {
            ui.label("监管状态：");
            let status = self.supervisor.status();
            match &status {
                Status::Ready { .. } => ui.colored_label(palette.success, status.summary()),
                Status::Stopped { .. } | Status::GivenUp { .. } => {
                    ui.colored_label(palette.error, status.summary())
                }
                _ => ui.label(status.summary()),
            };
            if self.button(ui, Area::Overview, "重新检查") {
                self.issue(Area::Overview, Operation::OverviewPing, ApiCall::Ping);
            }
            if ui.button("重启 Core").clicked() {
                self.supervisor.request_restart();
            }
        });
        if let Some(pid) = self.supervisor.child_pid() {
            ui.label(format!("Core PID：{pid}"));
        }
        ui.label(format!("IPC：{}", self.core_summary));
        ui.label("管理流量使用当前桌面实例的本机命名管道；后台兼容 API 仅用于 DSH/MCP 数据面。");
        self.show_feedback(ui, Area::Overview);
    }

    fn show_roles(&mut self, ui: &mut egui::Ui) {
        ui.heading("角色管理");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Roles, "刷新角色") {
                self.issue_control(Area::Roles, Operation::RolesRefresh, "role.list", json!({}));
            }
            ui.label(format!("共 {} 个角色", self.roles.len()));
        });
        ui.horizontal(|ui| {
            ui.label("当前角色：");
            ui.label(self.current_role.as_deref().unwrap_or("未指定"));
        });
        if self.roles.is_empty() {
            ui.weak("暂无角色或尚未读取角色列表。");
        } else {
            egui::ComboBox::from_label("选择角色")
                .selected_text(if self.selected_role.is_empty() {
                    "请选择"
                } else {
                    self.selected_role.as_str()
                })
                .show_ui(ui, |ui| {
                    for name in &self.roles {
                        ui.selectable_value(&mut self.selected_role, name.clone(), name.as_str());
                    }
                });
        }
        ui.horizontal(|ui| {
            if self.button(ui, Area::Roles, "设为当前角色") {
                if !self.selected_role.trim().is_empty() {
                    self.issue_control(
                        Area::Roles,
                        Operation::RoleSet,
                        "role.set",
                        json!({ "role": self.selected_role.trim() }),
                    );
                }
            }
            if self.button(ui, Area::Roles, "清除当前角色") {
                self.issue_control(
                    Area::Roles,
                    Operation::RoleSet,
                    "role.set",
                    json!({ "role": null }),
                );
            }
        });

        ui.separator();
        ui.label("默认模式");
        ui.horizontal(|ui| {
            ui.label(match self.role_mode.as_str() {
                "active" => "当前值：活跃",
                "silent" => "当前值：静默",
                _ => "当前值：未读取，请选择后保存",
            });
            ui.radio_value(&mut self.role_mode, "active".to_owned(), "活跃");
            ui.radio_value(&mut self.role_mode, "silent".to_owned(), "静默");
            let valid_mode = self.role_mode == "active" || self.role_mode == "silent";
            let response = ui.add_enabled(
                valid_mode && !self.pending.contains(&Area::Roles),
                egui::Button::new("保存模式"),
            );
            if response.clicked() {
                self.issue_control(
                    Area::Roles,
                    Operation::RoleMode,
                    "role.setMode",
                    json!({ "mode": self.role_mode }),
                );
            }
        });

        ui.separator();
        ui.label("新建角色");
        ui.horizontal(|ui| {
            ui.label("名称");
            ui.text_edit_singleline(&mut self.new_role_name);
        });
        ui.label("内容");
        ui.add(
            egui::TextEdit::multiline(&mut self.new_role_content)
                .desired_rows(5)
                .hint_text("输入角色说明"),
        );
        if self.button(ui, Area::Roles, "创建角色") {
            let name = self.new_role_name.trim();
            let content = self.new_role_content.trim();
            if name.is_empty() || content.is_empty() {
                self.feedback
                    .insert(Area::Roles, Err("角色名称和内容都不能为空。".to_owned()));
            } else {
                self.issue_control(
                    Area::Roles,
                    Operation::RoleCreate,
                    "role.create",
                    json!({ "name": name, "content": content }),
                );
            }
        }
        self.show_feedback(ui, Area::Roles);
    }

    fn show_security(&mut self, ui: &mut egui::Ui) {
        ui.heading("安全设置");
        ui.label("通知拦截设置。更改后会由 Core 写入配置并更新当前进程行为。");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Security, "重新读取") {
                self.issue_control(
                    Area::Security,
                    Operation::SecurityLoad,
                    "security.get",
                    json!({}),
                );
            }
            if !self.security_loaded {
                ui.weak("尚未读取当前值");
            }
        });
        ui.checkbox(&mut self.intercept_notify, "拦截通知");
        let can_save = self.security_loaded && !self.pending.contains(&Area::Security);
        if ui
            .add_enabled(can_save, egui::Button::new("保存安全设置"))
            .clicked()
        {
            self.issue_control(
                Area::Security,
                Operation::SecuritySave,
                "security.update",
                json!({ "interceptNotify": self.intercept_notify }),
            );
        }
        self.show_feedback(ui, Area::Security);
    }

    fn show_policy(&mut self, ui: &mut egui::Ui) {
        ui.heading("运行策略");
        ui.label("Social、Owner Agent 与 Workshop 是运行策略。Chat / Smart 在 Chat 页按 Session 设置。");
        ui.label("管理连接渠道的访问名单与管理员身份。");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Policy, "重新读取") {
                self.issue_control(Area::Policy, Operation::PolicyLoad, "policy.get", json!({}));
            }
            if !self.policy_loaded {
                ui.weak("尚未读取 Core 当前策略，读取前不能保存。");
            }
        });
        egui::Grid::new("policy_config_grid")
            .num_columns(2)
            .spacing([12.0, 8.0])
            .show(ui, |ui| {
                ui.label("运行模式");
                egui::ComboBox::from_id_salt("policy_mode")
                    .selected_text(runtime_policy_label(self.policy.mode.as_str()))
                    .show_ui(ui, |ui| {
                        for mode in ["social", "owner-agent", "workshop"] {
                            ui.selectable_value(&mut self.policy.mode, mode.to_owned(), runtime_policy_label(mode));
                        }
                    });
                ui.end_row();
                ui.label("私聊白名单");
                ui.add(egui::TextEdit::multiline(&mut self.policy.allow_private).desired_rows(2));
                ui.end_row();
                ui.label("群白名单");
                ui.add(egui::TextEdit::multiline(&mut self.policy.allow_groups).desired_rows(2));
                ui.end_row();
                ui.label("私聊黑名单");
                ui.add(egui::TextEdit::multiline(&mut self.policy.deny_private).desired_rows(2));
                ui.end_row();
                ui.label("群黑名单");
                ui.add(egui::TextEdit::multiline(&mut self.policy.deny_groups).desired_rows(2));
                ui.end_row();
                ui.label("管理员 QQ（留空清除）");
                ui.text_edit_singleline(&mut self.policy.owner_qq);
                ui.end_row();
            });
        ui.weak("QQ 号使用正整数，多个值以逗号、空格或换行分隔；黑名单优先于白名单。");

        let can_save = self.policy_loaded
            && !self.pending.contains(&Area::Policy)
            && self.policy_confirmation.is_none();
        if ui
            .add_enabled(can_save, egui::Button::new("应用运行策略"))
            .clicked()
        {
            let mode_changed =
                self.loaded_policy_mode.as_deref() != Some(self.policy.mode.as_str());
            match self.policy.params(mode_changed) {
                Ok(params) => {
                    if mode_changed {
                        self.policy_confirmation = Some(params);
                    } else {
                        self.issue_control(
                            Area::Policy,
                            Operation::PolicySave,
                            "policy.update",
                            params,
                        );
                    }
                }
                Err(error) => {
                    self.feedback.insert(Area::Policy, Err(error));
                }
            }
        }

        if self.policy_confirmation.is_some() {
            let mut open = true;
            let mut decision = None;
            egui::Window::new("确认切换运行模式")
                .collapsible(false)
                .resizable(false)
                .open(&mut open)
                .show(ui.ctx(), |ui| {
                    ui.label("切换模式可能清理社交状态、待处理投递队列和定时器。是否确认应用本次模式及策略更改？");
                    ui.horizontal(|ui| {
                        if ui.button("确认应用").clicked() {
                            decision = Some(true);
                        }
                        if ui.button("取消").clicked() {
                            decision = Some(false);
                        }
                    });
                });
            if !open && decision.is_none() {
                decision = Some(false);
            }
            match decision {
                Some(true) => {
                    if let Some(params) = self.policy_confirmation.take() {
                        self.issue_control(
                            Area::Policy,
                            Operation::PolicySave,
                            "policy.update",
                            params,
                        );
                    }
                }
                Some(false) => {
                    self.policy_confirmation = None;
                }
                None => {}
            }
        }
        self.show_feedback(ui, Area::Policy);
    }

    fn show_services(&mut self, ui: &mut egui::Ui) {
        ui.heading("本地服务");
        ui.label("通过本机 Core IPC 查看和控制 SnowLuma、DSH。安装项由 Core 检测返回；此页不接受命令、URL 或路径输入。");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Services, "刷新状态") {
                self.issue_control(
                    Area::Services,
                    Operation::ServicesRefresh,
                    "services.get",
                    json!({}),
                );
            }
            if self.button(ui, Area::Services, "检测安装项") {
                self.issue_control(
                    Area::Services,
                    Operation::ServicesDetect,
                    "services.detect",
                    json!({}),
                );
            }
            if !self.services_loaded {
                ui.weak("尚未读取服务状态。");
            }
        });
        ui.separator();
        self.show_service_card(ui, ServiceKind::SnowLuma);
        ui.separator();
        self.show_service_card(ui, ServiceKind::Dsh);

        if let Some(action) = self.service_confirmation {
            let mut open = true;
            let mut decision = None;
            egui::Window::new("确认本地服务操作")
                .collapsible(false)
                .resizable(false)
                .open(&mut open)
                .show(ui.ctx(), |ui| {
                    ui.label(service_confirmation_text(action));
                    ui.horizontal(|ui| {
                        if ui.button("确认操作").clicked() {
                            decision = Some(true);
                        }
                        if ui.button("取消").clicked() {
                            decision = Some(false);
                        }
                    });
                });
            if !open && decision.is_none() {
                decision = Some(false);
            }
            match decision {
                Some(true) => {
                    self.service_confirmation = None;
                    self.issue_service_action(action);
                }
                Some(false) => self.service_confirmation = None,
                None => {}
            }
        }
        self.show_service_feedback(ui);
    }

    fn show_models_presets(&mut self, ui: &mut egui::Ui) {
        ui.heading("模型与 Preset");
        ui.label("模型只从 Core 返回的 catalog 选择；默认模型更改只影响未来新建会话，不会传递 secret 或 settings 全文。");
        ui.separator();

        ui.heading("默认模型");
        ui.horizontal_wrapped(|ui| {
            if self.button(ui, Area::ModelCatalog, "刷新模型目录") {
                self.issue_control(
                    Area::ModelCatalog,
                    Operation::ModelCatalogLoad,
                    "model.catalog.list",
                    json!({}),
                );
            }
            if self.button(ui, Area::ModelDefaults, "重新读取默认值") {
                self.issue_control(
                    Area::ModelDefaults,
                    Operation::ModelDefaultsLoad,
                    "model.defaults.get",
                    json!({}),
                );
            }
            if !self.model_defaults_loaded {
                ui.weak("尚未读取当前默认值。");
            }
            if !self.model_catalog_loaded {
                ui.weak("尚未读取模型目录。");
            }
        });

        if self.model_catalog.is_empty() {
            ui.weak("Core 暂未返回可选模型。请检查 provider 配置后刷新目录。");
        } else {
            let selected_text = model_entry_label(self.model_catalog.iter().find(|entry| {
                entry.provider == self.model_defaults.provider
                    && entry.model == self.model_defaults.model
            }))
            .unwrap_or_else(|| "请选择目录中的模型".to_owned());
            let catalog = self.model_catalog.clone();
            egui::ComboBox::from_id_salt("native_model_default_choice")
                .selected_text(selected_text)
                .show_ui(ui, |ui| {
                    for entry in catalog {
                        let label = model_entry_label(Some(&entry)).unwrap_or_default();
                        let is_selected = self.model_defaults.provider == entry.provider
                            && self.model_defaults.model == entry.model;
                        if ui.selectable_label(is_selected, label).clicked() {
                            self.model_defaults.provider = entry.provider;
                            self.model_defaults.model = entry.model;
                        }
                    }
                });
        }
        if self.model_defaults_loaded
            && !self.model_catalog.iter().any(|entry| {
                entry.provider == self.model_defaults.provider
                    && entry.model == self.model_defaults.model
            })
        {
            ui.colored_label(
                native_palette().warning,
                "当前默认模型不在 catalog 中；请选择目录项后才能保存。",
            );
        }

        ui.horizontal(|ui| {
            ui.label("推理强度");
            egui::ComboBox::from_id_salt("native_model_reasoning_effort")
                .selected_text(
                    if is_supported_reasoning_effort(&self.model_defaults.reasoning_effort) {
                        self.model_defaults.reasoning_effort.as_str()
                    } else {
                        "请选择支持的强度"
                    },
                )
                .show_ui(ui, |ui| {
                    for effort in MODEL_REASONING_EFFORTS {
                        ui.selectable_value(
                            &mut self.model_defaults.reasoning_effort,
                            effort.to_owned(),
                            effort,
                        );
                    }
                });
        });
        if self.model_defaults_loaded
            && !is_supported_reasoning_effort(&self.model_defaults.reasoning_effort)
        {
            ui.colored_label(
                native_palette().warning,
                format!(
                    "当前推理强度 {:?} 不受支持；请选择 off、low、high 或 max 后保存。",
                    self.model_defaults.reasoning_effort
                ),
            );
        }

        let model_is_catalogued = self.model_catalog.iter().any(|entry| {
            entry.provider == self.model_defaults.provider
                && entry.model == self.model_defaults.model
        });
        let can_save_defaults = self.model_catalog_loaded
            && self.model_defaults_loaded
            && model_is_catalogued
            && is_supported_reasoning_effort(&self.model_defaults.reasoning_effort)
            && !self.pending.contains(&Area::ModelDefaults);
        if ui
            .add_enabled(can_save_defaults, egui::Button::new("保存默认模型"))
            .clicked()
        {
            match model_defaults_payload(&self.model_defaults, &self.model_catalog) {
                Ok(params) => self.issue_control(
                    Area::ModelDefaults,
                    Operation::ModelDefaultsSave,
                    "model.defaults.update",
                    params,
                ),
                Err(error) => {
                    self.feedback.insert(Area::ModelDefaults, Err(error));
                }
            }
        }
        self.show_read_status(ui, Area::ModelCatalog);
        self.show_read_status(ui, Area::ModelDefaults);
        if let Some(notice) = self.model_notice.as_deref() {
            ui.weak(notice);
        }

        ui.add_space(12.0);
        ui.separator();
        ui.heading("Provider API Key");
        ui.label("Key 只保存在本机 state/provider-keys.json（0600），界面仅显示掩码；测试会用 Key 访问该 Provider 的 /models 端点。");
        for row in self.provider_secrets.clone() {
            ui.horizontal_wrapped(|ui| {
                ui.monospace(row.provider.as_str());
                ui.label(row.hint.as_str());
                if !row.base_url.is_empty() {
                    ui.weak(row.base_url.as_str());
                }
                if !row.updated_at.is_empty() {
                    ui.weak(row.updated_at.as_str());
                }
                if ui.small_button("测试").clicked() {
                    self.issue_family(
                        Area::ProviderKeys,
                        Operation::ProviderSecretTest,
                        "providers.secrets.test",
                        json!({"provider": row.provider}),
                    );
                }
                if ui.small_button("删除").clicked() {
                    self.issue_family(
                        Area::ProviderKeys,
                        Operation::ProviderSecretDelete,
                        "providers.secrets.delete",
                        json!({"provider": row.provider}),
                    );
                }
            });
        }
        if self.provider_secrets.is_empty() && self.provider_secrets_loaded {
            ui.weak("尚未配置任何 Provider API Key。");
        }
        ui.horizontal_wrapped(|ui| {
            ui.label("Provider");
            ui.add(
                egui::TextEdit::singleline(&mut self.provider_key_provider)
                    .desired_width(170.0)
                    .hint_text("deepseek-official"),
            );
            ui.label("API Key");
            ui.add(
                egui::TextEdit::singleline(&mut self.provider_key_input)
                    .password(true)
                    .desired_width(220.0)
                    .hint_text("sk-…"),
            );
            ui.label("Base URL（可选）");
            ui.add(
                egui::TextEdit::singleline(&mut self.provider_key_base)
                    .desired_width(220.0)
                    .hint_text("https://…"),
            );
            if ui.button("保存 Key").clicked() {
                let provider = self.provider_key_provider.trim().to_owned();
                let api_key = self.provider_key_input.trim().to_owned();
                let base_url = self.provider_key_base.trim().to_owned();
                if provider.is_empty() || api_key.is_empty() {
                    self.provider_secrets_notice = Some("Provider 与 API Key 不能为空。".to_owned());
                } else {
                    self.issue_family(
                        Area::ProviderKeys,
                        Operation::ProviderSecretSave,
                        "providers.secrets.set",
                        json!({"provider": provider, "apiKey": api_key, "baseUrl": base_url}),
                    );
                }
            }
        });
        self.show_read_status(ui, Area::ProviderKeys);
        if let Some(notice) = self.provider_secrets_notice.as_deref() {
            ui.weak(notice);
        }

        ui.separator();
        ui.heading("Preset 綁定");
        ui.label("目標與 Preset ID 均受白名單限制；只提交当前目标与所选 Preset ID，不传递 secret/settings 全文。");
        ui.horizontal_wrapped(|ui| {
            if self.button(ui, Area::PresetList, "刷新 Preset 列表") {
                self.issue_control(
                    Area::PresetList,
                    Operation::PresetListLoad,
                    "preset.list",
                    json!({}),
                );
            }
            if self.button(ui, Area::PresetBindings, "重新读取绑定") {
                self.issue_control(
                    Area::PresetBindings,
                    Operation::PresetBindingsLoad,
                    "preset.bindings.get",
                    json!({}),
                );
            }
            if !self.preset_list_loaded {
                ui.weak("尚未读取 Preset 列表。");
            }
            if !self.preset_bindings_loaded {
                ui.weak("尚未读取当前绑定。");
            }
        });
        if self.presets.is_empty() {
            ui.weak("Core 未返回可选 Preset；列表为空时不能提交绑定。");
        }
        for target in PRESET_TARGETS {
            self.show_preset_target(ui, target);
        }
        self.show_read_status(ui, Area::PresetList);
        self.show_read_status(ui, Area::PresetBindings);
        if let Some(notice) = self.preset_notice.as_deref() {
            ui.weak(notice);
        }
    }

    fn show_preset_target(&mut self, ui: &mut egui::Ui, target: PresetTarget) {
        let mut selected_id = self.preset_selection.get(target).to_owned();
        let current_id = self
            .preset_bindings
            .get(target)
            .unwrap_or_default()
            .to_owned();
        let current = if current_id.is_empty() {
            "未绑定".to_owned()
        } else if self.presets.iter().any(|preset| preset.id == current_id) {
            format!("当前绑定：{current_id}")
        } else {
            format!("当前绑定：{current_id}（不在当前列表中）")
        };

        ui.horizontal_wrapped(|ui| {
            ui.label(target.label());
            ui.weak(current);
            let selected_text =
                preset_entry_label(self.presets.iter().find(|preset| preset.id == selected_id))
                    .unwrap_or_else(|| "请选择列表中的 Preset".to_owned());
            let presets = self.presets.clone();
            egui::ComboBox::from_id_salt(format!("native_preset_{}", target.as_str()))
                .selected_text(selected_text)
                .show_ui(ui, |ui| {
                    for preset in presets {
                        let label = preset_entry_label(Some(&preset)).unwrap_or_default();
                        ui.selectable_value(&mut selected_id, preset.id, label);
                    }
                });
            *self.preset_selection.get_mut(target) = selected_id.clone();

            let can_save = self.preset_list_loaded
                && self.preset_bindings_loaded
                && self.presets.iter().any(|preset| preset.id == selected_id)
                && !self.pending.contains(&Area::PresetBindings);
            if ui
                .add_enabled(can_save, egui::Button::new("保存绑定"))
                .clicked()
            {
                match preset_binding_payload(target.as_str(), &selected_id, &self.presets) {
                    Ok(params) => self.issue_control(
                        Area::PresetBindings,
                        Operation::PresetBindingSave(target),
                        "preset.bindings.update",
                        params,
                    ),
                    Err(error) => {
                        self.feedback.insert(Area::PresetBindings, Err(error));
                    }
                }
            }
        });
    }

    fn show_service_card(&mut self, ui: &mut egui::Ui, service: ServiceKind) {
        let snapshot = self.service_snapshot(service).clone();
        let selected_id = self.selected_install_id(service).to_owned();
        ui.heading(service.label());
        ui.horizontal_wrapped(|ui| {
            ui.label(format!("安装：{}", bool_status(snapshot.installed)));
            ui.label(format!("运行：{}", bool_status(snapshot.running)));
            if let Some(status) = snapshot.status.as_deref() {
                ui.label(format!("状态：{status}"));
            }
        });
        if let Some(message) = snapshot.message.as_deref() {
            ui.weak(message);
        }

        ui.label("Core 已发现的安装项");
        if snapshot.installations.is_empty() {
            ui.weak("没有已发现安装项；可重新检测。DSH 未安装时属于正常状态。");
        } else {
            let valid_installations = snapshot
                .installations
                .iter()
                .filter(|item| item.valid == Some(true))
                .collect::<Vec<_>>();
            if valid_installations.is_empty() {
                ui.weak("检测到了安装记录，但 Core 未将其标记为可用，因此不能选择。");
                for item in &snapshot.installations {
                    ui.weak(install_label(item));
                }
            } else {
                let mut selected_id = selected_id;
                egui::ComboBox::from_id_salt(format!("service_install_{}", service.as_str()))
                    .selected_text(selected_install_label(&snapshot, &selected_id))
                    .show_ui(ui, |ui| {
                        for item in &valid_installations {
                            ui.selectable_value(
                                &mut selected_id,
                                item.id.clone(),
                                install_label(item),
                            );
                        }
                    });
                if selected_id != self.selected_install_id(service) {
                    *self.selected_install_id_mut(service) = selected_id.clone();
                }
                let response = ui.add_enabled(
                    valid_installations
                        .iter()
                        .any(|item| item.id == selected_id)
                        && !self.pending.contains(&Area::Services),
                    egui::Button::new("选择此安装项"),
                );
                if response.clicked() {
                    self.select_detected_install(service, &selected_id);
                }
            }
        }

        ui.horizontal_wrapped(|ui| {
            if service == ServiceKind::SnowLuma {
                let can_install =
                    snapshot.installed != Some(true) && !self.pending.contains(&Area::Services);
                if ui
                    .add_enabled(can_install, egui::Button::new("安装 SnowLuma…"))
                    .clicked()
                {
                    self.service_confirmation = Some(ServiceAction::InstallSnowLuma);
                }
            }
            let can_start = snapshot.installed != Some(false)
                && snapshot.running != Some(true)
                && !self.pending.contains(&Area::Services);
            if ui
                .add_enabled(
                    can_start,
                    egui::Button::new(format!("启动 {}…", service.label())),
                )
                .clicked()
            {
                self.service_confirmation = Some(ServiceAction::Start(service));
            }
            let can_stop =
                snapshot.running == Some(true) && !self.pending.contains(&Area::Services);
            if ui
                .add_enabled(
                    can_stop,
                    egui::Button::new(format!("停止 {}…", service.label())),
                )
                .clicked()
            {
                self.service_confirmation = Some(ServiceAction::Stop(service));
            }
        });
    }

    fn select_detected_install(&mut self, service: ServiceKind, id: &str) {
        let is_detected = self.service_snapshot(service).has_selectable_install(id);
        if !is_detected {
            self.feedback.insert(
                Area::Services,
                Err("只能选择 Core 已发现的本地安装项。".to_owned()),
            );
            return;
        }
        self.issue_control(
            Area::Services,
            Operation::ServiceSelect(service),
            "services.select",
            json!({ "service": service.as_str(), "id": id }),
        );
    }

    fn issue_service_action(&mut self, action: ServiceAction) {
        let (operation, method, params) = match action {
            ServiceAction::InstallSnowLuma => (
                Operation::ServiceInstallSnowLuma,
                "services.installSnowLuma",
                json!({}),
            ),
            ServiceAction::Start(service) => (
                Operation::ServiceStart(service),
                "services.start",
                json!({ "service": service.as_str() }),
            ),
            ServiceAction::Stop(service) => (
                Operation::ServiceStop(service),
                "services.stop",
                json!({ "service": service.as_str() }),
            ),
        };
        self.issue_control(Area::Services, operation, method, params);
    }

    fn service_snapshot(&self, service: ServiceKind) -> &ServiceSnapshot {
        match service {
            ServiceKind::SnowLuma => &self.services_snowluma,
            ServiceKind::Dsh => &self.services_dsh,
        }
    }

    fn selected_install_id(&self, service: ServiceKind) -> &str {
        match service {
            ServiceKind::SnowLuma => &self.selected_snowluma_install,
            ServiceKind::Dsh => &self.selected_dsh_install,
        }
    }

    fn selected_install_id_mut(&mut self, service: ServiceKind) -> &mut String {
        match service {
            ServiceKind::SnowLuma => &mut self.selected_snowluma_install,
            ServiceKind::Dsh => &mut self.selected_dsh_install,
        }
    }

    fn show_slang(&mut self, ui: &mut egui::Ui) {
        ui.heading("黑话学习配置");
        ui.label("读取和保存均经本机 IPC；读取使用只读命令 slang.getConfig。");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Slang, "重新读取") {
                self.issue_control(
                    Area::Slang,
                    Operation::SlangLoad,
                    "slang.getConfig",
                    json!({}),
                );
            }
            if !self.slang_loaded {
                ui.weak("尚未读取当前值，显示的是可编辑默认值。");
            }
        });
        ui.checkbox(&mut self.slang.enabled, "启用黑话学习");
        ui.checkbox(&mut self.slang.auto_research, "自动研究候选");
        egui::Grid::new("slang_config_grid")
            .num_columns(2)
            .spacing([12.0, 8.0])
            .show(ui, |ui| {
                ui.label("提取最少消息数");
                ui.text_edit_singleline(&mut self.slang.extract_min_messages);
                ui.end_row();
                ui.label("提取冷却（毫秒）");
                ui.text_edit_singleline(&mut self.slang.extract_cooldown_ms);
                ui.end_row();
                ui.label("注入上限");
                ui.text_edit_singleline(&mut self.slang.inject_max);
                ui.end_row();
                ui.label("学习 Preset");
                ui.text_edit_singleline(&mut self.slang.learner_preset);
                ui.end_row();
                ui.label("工作区标题");
                ui.text_edit_singleline(&mut self.slang.workspace_title);
                ui.end_row();
                ui.label("推断阈值（逗号分隔）");
                ui.text_edit_singleline(&mut self.slang.inference_thresholds);
                ui.end_row();
            });
        let can_save = self.slang_loaded && !self.pending.contains(&Area::Slang);
        if ui
            .add_enabled(can_save, egui::Button::new("保存黑话配置"))
            .clicked()
        {
            match self.slang_params() {
                Ok(params) => self.issue_control(
                    Area::Slang,
                    Operation::SlangSave,
                    "slang.updateConfig",
                    params,
                ),
                Err(error) => {
                    self.feedback.insert(Area::Slang, Err(error));
                }
            }
        }
        self.show_feedback(ui, Area::Slang);
    }

    fn slang_params(&self) -> Result<Value, String> {
        let extract_min_messages = parse_number("最少消息数", &self.slang.extract_min_messages)?;
        let extract_cooldown_ms = parse_number("提取冷却", &self.slang.extract_cooldown_ms)?;
        let inject_max = parse_number("注入上限", &self.slang.inject_max)?;
        let mut thresholds = Vec::new();
        for part in self
            .slang
            .inference_thresholds
            .split(|character: char| {
                character == ',' || character == '，' || character.is_whitespace()
            })
            .filter(|part| !part.trim().is_empty())
        {
            thresholds.push(parse_number("推断阈值", part.trim())?);
        }
        if thresholds.is_empty() {
            return Err("至少填写一个推断阈值。".to_owned());
        }
        Ok(json!({
            "enabled": self.slang.enabled,
            "extractMinMessages": extract_min_messages,
            "extractCooldownMs": extract_cooldown_ms,
            "injectMax": inject_max,
            "autoResearch": self.slang.auto_research,
            "learnerPreset": self.slang.learner_preset.trim(),
            "workspaceTitle": self.slang.workspace_title.trim(),
            "inferenceThresholds": thresholds,
        }))
    }

    fn show_sessions(&mut self, ui: &mut egui::Ui) {
        ui.heading("会话映射");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Sessions, "刷新会话") {
                self.issue_control(
                    Area::Sessions,
                    Operation::SessionsRefresh,
                    "session.list",
                    json!({}),
                );
            }
            ui.label(format!("共 {} 个会话", self.sessions.len()));
        });
        if self.sessions.is_empty() {
            ui.weak("暂无会话映射。");
        } else {
            egui::Grid::new("sessions_grid")
                .striped(true)
                .num_columns(4)
                .show(ui, |ui| {
                    ui.strong("会话键");
                    ui.strong("Session ID");
                    ui.strong("所有者");
                    ui.strong("社交状态");
                    ui.end_row();
                    let rows = self.sessions.clone();
                    for session in rows {
                        ui.label(session.key.as_str());
                        ui.label(session.session_id.as_str());
                        ui.label(if session.owner { "是" } else { "否" });
                        ui.horizontal(|ui| {
                            if self.button(ui, Area::Sessions, "活跃") {
                                self.issue_control(
                                    Area::Sessions,
                                    Operation::SessionPhase,
                                    "social.setPhase",
                                    json!({ "key": session.key, "phase": "active" }),
                                );
                            }
                            if self.button(ui, Area::Sessions, "休息") {
                                self.issue_control(
                                    Area::Sessions,
                                    Operation::SessionPhase,
                                    "social.setPhase",
                                    json!({ "key": session.key, "phase": "idle" }),
                                );
                            }
                        });
                        ui.end_row();
                    }
                });
        }
        self.show_feedback(ui, Area::Sessions);
    }

    fn show_pending(&mut self, ui: &mut egui::Ui) {
        ui.heading("审批 / 提问");
        ui.label("通过本机 IPC 查看并处理 DSH 的提问、工具审批和风险卡片审批；不开放任意 RPC 或脚本入口。");
        ui.horizontal(|ui| {
            if self.button(ui, Area::Pending, "刷新挂起请求") {
                self.issue_control(
                    Area::Pending,
                    Operation::PendingRefresh,
                    "pending.list",
                    json!({}),
                );
            }
            ui.label(format!("{} 条待处理", self.pending_items.len()));
        });

        if !self.pending_loaded && !self.pending.contains(&Area::Pending) {
            ui.weak("尚未读取挂起请求。");
        } else if self.pending_items.is_empty() && !self.pending.contains(&Area::Pending) {
            ui.weak("当前没有待处理的审批或提问。");
        }

        let rows = self.pending_items.clone();
        for item in rows {
            ui.group(|ui| {
                let title = match item.kind.as_str() {
                    "question" => "提问",
                    "approval" => "工具审批",
                    "card-approval" => "风险卡片审批",
                    _ => "挂起请求",
                };
                ui.horizontal(|ui| {
                    ui.strong(title);
                    if !item.key.is_empty() {
                        ui.weak(item.key.as_str());
                    }
                    if !item.status.is_empty() {
                        ui.weak(format!("状态：{}", item.status));
                    }
                });
                if !item.session_id.is_empty() {
                    ui.weak(format!("Session：{}", item.session_id));
                }
                match item.kind.as_str() {
                    "question" => {
                        if !item.question.is_empty() {
                            ui.label(item.question.as_str());
                        }
                        if !item.options.is_empty() {
                            ui.weak(format!("选项：{}", item.options.join(" / ")));
                        }
                        ui.horizontal(|ui| {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.pending_answer)
                                    .hint_text("输入回答或选项文字"),
                            );
                            let enabled = !self.pending.contains(&Area::Pending)
                                && !self.pending_answer.trim().is_empty();
                            if ui.add_enabled(enabled, egui::Button::new("提交回答")).clicked() {
                                self.issue_control(
                                    Area::Pending,
                                    Operation::PendingDecision,
                                    "pending.decide",
                                    json!({
                                        "kind": "question",
                                        "key": item.key,
                                        "answer": self.pending_answer.trim()
                                    }),
                                );
                            }
                        });
                    }
                    "approval" => {
                        if !item.tool_name.is_empty() {
                            ui.label(format!("工具：{}", item.tool_name));
                        }
                        if !item.reason.is_empty() {
                            ui.label(format!("理由：{}", item.reason));
                        }
                        ui.horizontal(|ui| {
                            let enabled = !self.pending.contains(&Area::Pending);
                            if ui.add_enabled(enabled, egui::Button::new("通过")).clicked() {
                                self.issue_control(
                                    Area::Pending,
                                    Operation::PendingDecision,
                                    "pending.decide",
                                    json!({ "kind": "approval", "key": item.key, "decision": "approve" }),
                                );
                            }
                            if ui.add_enabled(enabled, egui::Button::new("拒绝")).clicked() {
                                self.issue_control(
                                    Area::Pending,
                                    Operation::PendingDecision,
                                    "pending.decide",
                                    json!({ "kind": "approval", "key": item.key, "decision": "reject" }),
                                );
                            }
                        });
                    }
                    "card-approval" => {
                        if !item.card_title.is_empty() {
                            ui.label(format!("卡片：{}", item.card_title));
                        }
                        if !item.button_label.is_empty() {
                            ui.label(format!("按钮：{}", item.button_label));
                        }
                        if !item.risk_reasons.is_empty() {
                            ui.weak(format!("风险：{}", item.risk_reasons.join("；")));
                        }
                        ui.horizontal(|ui| {
                            let enabled = !self.pending.contains(&Area::Pending);
                            if ui.add_enabled(enabled, egui::Button::new("批准执行")).clicked() {
                                self.issue_control(
                                    Area::Pending,
                                    Operation::PendingDecision,
                                    "pending.decide",
                                    json!({ "kind": "card-approval", "id": item.id, "decision": "approve" }),
                                );
                            }
                            if ui.add_enabled(enabled, egui::Button::new("拒绝")).clicked() {
                                self.issue_control(
                                    Area::Pending,
                                    Operation::PendingDecision,
                                    "pending.decide",
                                    json!({ "kind": "card-approval", "id": item.id, "decision": "reject" }),
                                );
                            }
                        });
                    }
                    _ => {}
                }
            });
        }
        if let Some(notice) = self.pending_notice.as_deref() {
            ui.weak(notice);
        }
        self.show_feedback(ui, Area::Pending);

        // ── Capability 审批（Managed Agent 高风险能力请求）──────────────────
        ui.add_space(14.0);
        ui.separator();
        ui.heading("Capability 审批");
        ui.label(
            "Managed Agent 的受控能力请求。批准只影响这一次请求（指纹绑定）；拒绝不改变已授予的 Task 能力集。",
        );
        ui.horizontal(|ui| {
            if self.button(ui, Area::CapabilityApproval, "刷新能力审批") {
                self.issue_family(
                    Area::CapabilityApproval,
                    Operation::CapabilityApprovalList,
                    "capability.approval.list",
                    json!({}),
                );
            }
            if self.capability_approvals_loaded {
                ui.label(format!("{} 条待决定", self.capability_approvals.len()));
            } else {
                ui.weak("尚未读取；点击刷新或进入本页后自动读取。");
            }
        });
        let rows = self.capability_approvals.clone();
        for row in rows {
            ui.group(|ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.strong(row.capability.as_str());
                    ui.weak(format!("权限 {}", row.permission));
                    if row.risk == "high" || row.risk == "critical" {
                        ui.colored_label(native_palette().warning, format!("风险 {}", row.risk));
                    } else {
                        ui.weak(format!("风险 {}", row.risk));
                    }
                });
                ui.horizontal_wrapped(|ui| {
                    ui.weak(format!("请求者 {}", row.actor));
                    if !row.task_id.is_empty() {
                        ui.weak(format!("Task {}", row.task_id));
                    }
                    if !row.workspace_id.is_empty() {
                        ui.weak(format!("Workspace {}", row.workspace_id));
                    }
                    ui.weak(format!("到期 {}", row.expires_at));
                });
                if !row.reason.is_empty() {
                    ui.label(format!("理由：{}", row.reason));
                }
                ui.horizontal(|ui| {
                    let enabled = !self.pending.contains(&Area::CapabilityApproval);
                    if ui.add_enabled(enabled, egui::Button::new("批准一次")).clicked() {
                        self.issue_family(
                            Area::CapabilityApproval,
                            Operation::CapabilityApprovalDecide,
                            "capability.approval.decide",
                            json!({ "id": row.id, "approve": true }),
                        );
                    }
                    if ui.add_enabled(enabled, egui::Button::new("拒绝")).clicked() {
                        self.issue_family(
                            Area::CapabilityApproval,
                            Operation::CapabilityApprovalDecide,
                            "capability.approval.decide",
                            json!({ "id": row.id, "approve": false }),
                        );
                    }
                });
            });
        }
        if let Some(notice) = self.capability_approval_notice.as_deref() {
            ui.weak(notice);
        }
        if let Some(Err(error)) = self.feedback.get(&Area::CapabilityApproval) {
            ui.colored_label(native_palette().error, error.as_str());
        }
    }

    fn show_diagnostics(&mut self, ui: &mut egui::Ui) {
        ui.heading("诊断");
        ui.label("此页仅提供安全的只读检查提示，不提供任意命令或脚本执行入口。");
        ui.separator();
        ui.label("• 确认桌面壳已启动 Core，并检查窗口顶部的 IPC 在线状态。");
        ui.label("• 若 Core 不可用，请检查本地服务进程、命名管道 ACL 和日志文件。");
        ui.label("• 可在概览页重新执行 core.ping；本页不会读取或运行系统命令。");
        if self.button(ui, Area::Diagnostics, "只读检查 Core 连接") {
            self.issue(Area::Diagnostics, Operation::DiagnosticsPing, ApiCall::Ping);
        }
        ui.separator();
        ui.label("只读诊断项（固定白名单）");
        ui.horizontal_wrapped(|ui| {
            ui.checkbox(&mut self.diagnostics_runtime, "运行状态");
            ui.checkbox(&mut self.diagnostics_config, "配置摘要");
            ui.checkbox(&mut self.diagnostics_paths, "路径检查");
            ui.checkbox(&mut self.diagnostics_services, "服务检查");
        });
        let mut checks = Vec::new();
        if self.diagnostics_runtime {
            checks.push("runtime");
        }
        if self.diagnostics_config {
            checks.push("config");
        }
        if self.diagnostics_paths {
            checks.push("paths");
        }
        if self.diagnostics_services {
            checks.push("services");
        }
        let can_run_checks = !checks.is_empty() && !self.pending.contains(&Area::Diagnostics);
        if ui
            .add_enabled(can_run_checks, egui::Button::new("运行选中检查"))
            .clicked()
        {
            self.issue_control(
                Area::Diagnostics,
                Operation::DiagnosticsRun,
                "diagnostics.run",
                json!({ "checks": checks }),
            );
        }
        self.show_feedback(ui, Area::Diagnostics);
    }

    fn show_activity(&mut self, ui: &mut egui::Ui) {
        ui.heading("活动记录");
        ui.label("只读查看最近的活动摘要；内容通过本机 IPC 获取，不执行命令。 ");
        ui.horizontal(|ui| {
            egui::ComboBox::from_id_salt("activity_limit")
                .selected_text(format!("{} 条", self.activity_limit))
                .show_ui(ui, |ui| {
                    for limit in ACTIVITY_LIMITS {
                        ui.selectable_value(&mut self.activity_limit, limit, format!("{limit} 条"));
                    }
                });
            if self.button(ui, Area::Activity, "刷新活动记录") {
                self.issue_control(
                    Area::Activity,
                    Operation::ActivityRefresh,
                    "activity.list",
                    json!({ "limit": self.activity_limit }),
                );
            }
            ui.label(format!("当前显示 {} 条", self.activity_entries.len()));
        });
        if self.activity_entries.is_empty() && !self.pending.contains(&Area::Activity) {
            if self.area_failed(Area::Activity) {
                ui.weak("活动记录读取失败，请检查 Core 连接后重试。");
            } else {
                ui.weak("暂无活动记录。");
            }
        } else {
            egui::ScrollArea::vertical()
                .id_salt("activity_entries_scroll")
                .max_height(440.0)
                .show(ui, |ui| {
                    for (index, entry) in self.activity_entries.iter().enumerate() {
                        ui.horizontal_top(|ui| {
                            ui.weak(format!("{}.", index + 1));
                            ui.label(entry);
                        });
                        ui.separator();
                    }
                });
        }
        self.show_read_status(ui, Area::Activity);
    }

    fn show_logs(&mut self, ui: &mut egui::Ui) {
        ui.heading("本机日志");
        ui.label("只读日志查看器；每次请求和显示内容都有数量与单行长度上限。 ");
        ui.horizontal_wrapped(|ui| {
            egui::ComboBox::from_id_salt("logs_source")
                .selected_text(log_source_label(&self.log_source))
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut self.log_source, "bridge".to_owned(), "桥接 Core");
                    ui.selectable_value(&mut self.log_source, "worker".to_owned(), "Worker");
                    ui.selectable_value(&mut self.log_source, "desktop".to_owned(), "桌面壳");
                });
            egui::ComboBox::from_id_salt("logs_limit")
                .selected_text(format!("{} 行", self.log_limit))
                .show_ui(ui, |ui| {
                    for limit in LOG_LIMITS {
                        ui.selectable_value(&mut self.log_limit, limit, format!("{limit} 行"));
                    }
                });
            if self.button(ui, Area::Logs, "刷新日志") {
                self.issue_control(
                    Area::Logs,
                    Operation::LogsRefresh,
                    "logs.read",
                    json!({ "source": self.log_source, "limit": self.log_limit }),
                );
            }
            ui.label(format!(
                "{}：{} 行",
                log_source_label(&self.log_source),
                self.log_lines.len()
            ));
        });
        if self.log_lines.is_empty() && !self.pending.contains(&Area::Logs) {
            if self.area_failed(Area::Logs) {
                ui.weak("日志读取失败，请确认所选日志源可用后重试。");
            } else {
                ui.weak("所选日志源暂无内容。");
            }
        } else {
            egui::ScrollArea::vertical()
                .id_salt("logs_lines_scroll")
                .max_height(500.0)
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    for line in &self.log_lines {
                        ui.label(egui::RichText::new(line).monospace());
                    }
                });
        }
        self.show_read_status(ui, Area::Logs);
    }

    fn button(&self, ui: &mut egui::Ui, area: Area, label: &str) -> bool {
        let response = ui.add_enabled(!self.pending.contains(&area), egui::Button::new(label));
        response.clicked()
    }

    fn show_error_message(&self, ui: &mut egui::Ui, area: Area, error: &str) {
        let palette = native_palette();
        let hint = friendly_read_error(area, error);
        egui::Frame::new()
            .fill(palette.error_bg)
            .stroke(egui::Stroke::new(1.0, palette.error))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 9))
            .show(ui, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(
                        egui::RichText::new("处理失败")
                            .color(palette.error)
                            .strong(),
                    );
                    ui.label(egui::RichText::new(error).color(palette.text));
                    if ui.small_button("复制错误").clicked() {
                        ui.ctx().copy_text(error.to_owned());
                    }
                });
                if let Some(hint) = hint {
                    ui.label(egui::RichText::new(hint).color(palette.warning));
                }
            });
    }

    fn show_loading_state(&self, ui: &mut egui::Ui, message: &str) {
        let palette = native_palette();
        egui::Frame::new()
            .fill(palette.surface_alt)
            .stroke(egui::Stroke::new(1.0, palette.border))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 9))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label(egui::RichText::new(message).color(palette.muted));
                });
            });
    }

    fn show_service_feedback(&self, ui: &mut egui::Ui) {
        if self.pending.contains(&Area::Services) {
            self.show_loading_state(ui, "正在通过本机 IPC 处理服务请求…");
        }
        if let Some(Err(error)) = self.feedback.get(&Area::Services) {
            self.show_error_message(ui, Area::Services, error);
        } else if let Some(notice) = self.services_notice.as_deref() {
            ui.weak(notice);
        }
    }

    fn show_feedback(&self, ui: &mut egui::Ui, area: Area) {
        if self.pending.contains(&area) {
            self.show_loading_state(ui, "正在通过本机 IPC 处理…");
        }
        if let Some(result) = self.feedback.get(&area) {
            match result {
                Ok(value) => {
                    let summary = concise_result(value);
                    if !summary.is_empty() {
                        ui.label(egui::RichText::new(summary).color(native_palette().success));
                    }
                }
                Err(error) => {
                    self.show_error_message(ui, area, error);
                }
            }
        }
    }

    fn show_read_status(&self, ui: &mut egui::Ui, area: Area) {
        if self.pending.contains(&area) {
            self.show_loading_state(ui, "正在通过本机 IPC 读取…");
        }
        if let Some(Err(error)) = self.feedback.get(&area) {
            self.show_error_message(ui, area, error);
        } else if !self.pending.contains(&area) && self.feedback.contains_key(&area) {
            ui.label(egui::RichText::new("读取完成。").color(native_palette().success));
        }
    }

    fn area_failed(&self, area: Area) -> bool {
        matches!(self.feedback.get(&area), Some(Err(_)))
    }
}

impl eframe::App for NativeUi {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if !self.tray_window_attached {
            if let Some(tray) = &self.tray {
                if let Ok(handle) = frame.window_handle() {
                    if let raw_window_handle::RawWindowHandle::Win32(win32) = handle.as_raw() {
                        tray.attach_window(win32.hwnd.get());
                        self.tray_window_attached = true;
                    }
                }
            }
        }
        self.handle_tray_commands(&ctx);
        self.handle_shortcuts(&ctx);
        if self.last_page != self.navigation.page {
            self.last_page = self.navigation.page;
            if self.navigation.page == AppPage::Chat {
                // Keyboard-first flow: entering Chat focuses the composer for immediate typing/IME.
                ctx.memory_mut(|memory| {
                    memory.request_focus(egui::Id::new("cetamesh_chat_composer"));
                });
            }
        }
        self.sync_theme_and_zoom(&ctx);
        self.handle_close_request(&ctx);
        self.receive_events();
        self.sync_chat_draft();
        self.maybe_poll_chat(&ctx);
        self.maybe_refresh_pending();
        self.maybe_load_capability_approvals();
        if self.last_prefs_sync.elapsed() >= Duration::from_secs(2) {
            self.save_geometry(&ctx);
            self.last_prefs_sync = Instant::now();
        }
        self.update_tray();

        let palette = native_palette();
        // Layout is built from real panels: the navigation can never squeeze the page, panels wrap
        // their own content, and the central page always gets the remaining rectangle.
        let narrow = ctx.viewport_rect().width() < 1040.0;
        if !narrow {
            egui::Panel::left("cetamesh_sidebar")
                .resizable(false)
                .exact_size(196.0)
                .frame(
                    egui::Frame::new()
                        .fill(palette.background)
                        .inner_margin(egui::Margin::symmetric(12, 14)),
                )
                .show(ui, |ui| {
                    self.show_sidebar(ui);
                });
        }
        egui::Panel::top("cetamesh_header")
            .resizable(false)
            .frame(
                egui::Frame::new()
                    .fill(palette.background)
                    .inner_margin(egui::Margin::symmetric(16, 12)),
            )
            .show(ui, |ui| {
                if narrow {
                    self.show_compact_nav(ui);
                    ui.add_space(8.0);
                }
                self.show_header(ui, narrow);
                ui.add_space(8.0);
                self.show_core_attention_banner(ui);
                self.show_toast(ui);
                ui.add_space(4.0);
                self.show_page_section_nav(ui);
            });
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(palette.background)
                    .inner_margin(egui::Margin::symmetric(16, 4)),
            )
            .show(ui, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("cetamesh_product_page_scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        egui::Frame::new()
                            .fill(palette.surface)
                            .stroke(egui::Stroke::new(1.0, palette.border))
                            .corner_radius(egui::CornerRadius::same(10))
                            .inner_margin(egui::Margin::symmetric(20, 18))
                            .show(ui, |ui| {
                                ui.set_min_width(ui.available_width());
                                self.show_page(ui);
                            });
                    });
            });
        self.show_shortcuts_window(&ctx);
        self.show_quit_confirm(&ctx);
        ctx.request_repaint_after(Duration::from_millis(500));
    }
}

fn bounded_model_text(value: Option<&Value>, field: &str) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 128 && !text.chars().any(char::is_control))
        .ok_or_else(|| format!("Core 返回的 {field} 无效。"))?;
    Ok(text.to_owned())
}

fn parse_model_catalog(value: &Value) -> Result<Vec<ModelEntry>, String> {
    let items = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core 返回的模型目录格式无效。".to_owned())?;
    let mut seen = HashSet::new();
    let mut models = Vec::with_capacity(items.len().min(500));
    for item in items.iter().take(500) {
        let provider = bounded_model_text(item.get("provider"), "provider")?;
        let model = bounded_model_text(item.get("model"), "model")?;
        let key = format!("{provider}\u{0000}{model}");
        if !seen.insert(key) {
            continue;
        }
        let image = item
            .get("image")
            .and_then(Value::as_bool)
            .ok_or_else(|| "Core 返回的模型目录缺少 image 标志。".to_owned())?;
        models.push(ModelEntry {
            provider,
            model,
            image,
        });
    }
    Ok(models)
}

fn parse_model_defaults(value: &Value) -> Result<ModelDefaults, String> {
    let defaults = value
        .get("defaults")
        .ok_or_else(|| "Core 返回的默认模型格式无效。".to_owned())?;
    let provider = bounded_model_text(defaults.get("provider"), "provider")?;
    let model = bounded_model_text(defaults.get("model"), "model")?;
    let reasoning_effort = bounded_model_text(defaults.get("reasoningEffort"), "reasoningEffort")?;
    Ok(ModelDefaults {
        provider,
        model,
        reasoning_effort,
    })
}

fn parse_preset_list(value: &Value) -> Result<Vec<PresetRecord>, String> {
    let items = value
        .get("presets")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core 返回的 Preset 列表格式无效。".to_owned())?;
    let mut seen = HashSet::new();
    let mut presets = Vec::with_capacity(items.len().min(500));
    for item in items.iter().take(500) {
        let id = bounded_model_text(item.get("id"), "Preset ID")?;
        if !seen.insert(id.clone()) {
            continue;
        }
        let trust = match item.get("trust") {
            Some(Value::String(text)) => truncate_display_line(text.trim(), 80),
            Some(value) if value.is_number() || value.is_boolean() => value.to_string(),
            _ => "unknown".to_owned(),
        };
        presets.push(PresetRecord { id, trust });
    }
    Ok(presets)
}

fn parse_optional_preset(value: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(_)) => bounded_model_text(value, field).map(Some),
        _ => Err(format!("Core 返回的 {field} 无效。")),
    }
}

fn parse_preset_bindings(value: &Value) -> Result<PresetBindings, String> {
    let bindings = value
        .get("bindings")
        .ok_or_else(|| "Core 返回的 Preset 绑定格式无效。".to_owned())?;
    Ok(PresetBindings {
        chat: parse_optional_preset(bindings.get("chat"), "chat preset")?,
        closed_agent: parse_optional_preset(bindings.get("closedAgent"), "closedAgent preset")?,
        social: parse_optional_preset(bindings.get("social"), "social preset")?,
        workshop: parse_optional_preset(bindings.get("workshop"), "workshop preset")?,
        learner: parse_optional_preset(bindings.get("learner"), "learner preset")?,
    })
}

fn parse_pending(value: &Value) -> Result<Vec<PendingItem>, String> {
    let items = value
        .get("pending")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core 返回的挂起请求格式无效。".to_owned())?;
    let mut pending = Vec::with_capacity(items.len().min(100));
    for item in items.iter().take(100) {
        let Some(kind) = item.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if !["question", "approval", "card-approval"].contains(&kind) {
            continue;
        }
        let text = |field: &str, max: usize| {
            item.get(field)
                .and_then(Value::as_str)
                .map(|value| truncate_display_line(value.trim(), max))
                .unwrap_or_default()
        };
        let mut entry = PendingItem {
            kind: kind.to_owned(),
            key: text("key", 256),
            id: text("id", 128),
            session_id: text("sessionId", 256),
            tool_name: text("toolName", 256),
            reason: text("reason", 2_000),
            question: String::new(),
            options: Vec::new(),
            status: text("status", 80),
            card_title: text("cardTitle", 240),
            button_label: text("buttonLabel", 160),
            risk_reasons: Vec::new(),
        };
        if kind == "question" {
            if let Some(question) = item
                .get("questions")
                .and_then(Value::as_array)
                .and_then(|questions| questions.first())
            {
                entry.question = question
                    .get("question")
                    .and_then(Value::as_str)
                    .map(|value| truncate_display_line(value.trim(), 2_000))
                    .unwrap_or_default();
                if let Some(options) = question.get("options").and_then(Value::as_array) {
                    entry.options = options
                        .iter()
                        .take(20)
                        .filter_map(|option| option.get("label").and_then(Value::as_str))
                        .map(|label| truncate_display_line(label.trim(), 256))
                        .filter(|label| !label.is_empty())
                        .collect();
                }
            }
        } else if kind == "card-approval" {
            if let Some(reasons) = item.get("riskReasons").and_then(Value::as_array) {
                entry.risk_reasons = reasons
                    .iter()
                    .take(6)
                    .filter_map(Value::as_str)
                    .map(|reason| truncate_display_line(reason.trim(), 256))
                    .filter(|reason| !reason.is_empty())
                    .collect();
            }
        }
        pending.push(entry);
    }
    Ok(pending)
}

fn model_entry_label(entry: Option<&ModelEntry>) -> Option<String> {
    entry.map(|entry| {
        format!(
            "{}/{}{}",
            entry.provider,
            entry.model,
            if entry.image { " · 图像" } else { "" }
        )
    })
}

fn is_supported_reasoning_effort(value: &str) -> bool {
    MODEL_REASONING_EFFORTS.contains(&value)
}

fn model_defaults_payload(
    defaults: &ModelDefaults,
    catalog: &[ModelEntry],
) -> Result<Value, String> {
    if !catalog
        .iter()
        .any(|entry| entry.provider == defaults.provider && entry.model == defaults.model)
    {
        return Err("默认模型必须来自当前 Core 返回的目录。".to_owned());
    }
    if !is_supported_reasoning_effort(&defaults.reasoning_effort) {
        return Err("推理强度必须是 off、low、high 或 max。".to_owned());
    }
    Ok(json!({
        "provider": defaults.provider,
        "model": defaults.model,
        "reasoningEffort": defaults.reasoning_effort,
    }))
}

fn preset_entry_label(entry: Option<&PresetRecord>) -> Option<String> {
    entry.map(|entry| format!("{} · trust: {}", entry.id, entry.trust))
}

fn preset_binding_payload(
    target: &str,
    preset_id: &str,
    presets: &[PresetRecord],
) -> Result<Value, String> {
    if PresetTarget::parse(target).is_none() {
        return Err("Preset 绑定目标不在白名单中。".to_owned());
    }
    let preset_id = preset_id.trim();
    if preset_id.is_empty() || !presets.iter().any(|preset| preset.id == preset_id) {
        return Err("Preset ID 必须来自当前 Core 返回的列表。".to_owned());
    }
    Ok(json!({ "target": target, "presetId": preset_id }))
}

fn parse_service_snapshot(value: &Value) -> Result<ServiceSnapshot, String> {
    if !value.is_object() {
        return Err("Core 返回的服务状态不是对象。".to_owned());
    }

    let installations_value = value
        .get("installations")
        .or_else(|| value.get("detectedInstallations"));
    let mut installations = Vec::new();
    if let Some(items) = installations_value {
        let items = items
            .as_array()
            .ok_or_else(|| "Core 返回的已发现安装项格式无效。".to_owned())?;
        let mut seen_ids = HashSet::new();
        for item in items.iter().take(100) {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control))
                .ok_or_else(|| "Core 返回了无效的已发现安装项 ID。".to_owned())?
                .to_owned();
            if !seen_ids.insert(id.clone()) {
                continue;
            }
            installations.push(DetectedInstall {
                id,
                name: bounded_snapshot_text(item.get("name"))
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "检测到的安装项".to_owned()),
                version: bounded_snapshot_text(item.get("version")),
                source: bounded_snapshot_text(item.get("source")),
                valid: item.get("valid").and_then(Value::as_bool),
                status: bounded_snapshot_text(item.get("status"))
                    .or_else(|| bounded_snapshot_text(item.get("invalidReason"))),
            });
        }
    }

    let selected_id = value
        .get("selectedId")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/selected/id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control))
        .filter(|id| {
            installations
                .iter()
                .any(|item| item.id == *id && item.valid == Some(true))
        })
        .map(ToOwned::to_owned);

    Ok(ServiceSnapshot {
        installed: value
            .get("installed")
            .and_then(Value::as_bool)
            .or_else(|| value.get("isInstalled").and_then(Value::as_bool)),
        running: value
            .get("running")
            .and_then(Value::as_bool)
            .or_else(|| value.get("isRunning").and_then(Value::as_bool)),
        status: bounded_snapshot_text(value.get("status")),
        message: bounded_snapshot_text(value.get("message"))
            .or_else(|| bounded_snapshot_text(value.get("lastError"))),
        selected_id,
        installations,
    })
}

fn bounded_snapshot_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_display_line(text, 240))
}

fn bool_status(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "是",
        Some(false) => "否",
        None => "未知",
    }
}

fn install_label(installation: &DetectedInstall) -> String {
    let mut label = installation.name.clone();
    if let Some(version) = installation.version.as_deref() {
        label.push_str(" · ");
        label.push_str(version);
    }
    if let Some(status) = installation.status.as_deref() {
        label.push_str(" · ");
        label.push_str(status);
    }
    if let Some(source) = installation.source.as_deref() {
        label.push_str(" · ");
        label.push_str(source);
    }
    if installation.valid == Some(false) {
        label.push_str(" · 无效");
    }
    label
}

fn selected_install_label(snapshot: &ServiceSnapshot, selected_id: &str) -> String {
    snapshot
        .installations
        .iter()
        .find(|item| item.id == selected_id && item.valid == Some(true))
        .map(install_label)
        .unwrap_or_else(|| "请选择 Core 已发现的安装项".to_owned())
}

fn service_confirmation_text(action: ServiceAction) -> String {
    match action {
        ServiceAction::InstallSnowLuma => {
            "将由本地 Core 安装 SnowLuma，可能下载组件、写入本机文件并更改系统状态。确认继续？"
                .to_owned()
        }
        ServiceAction::Start(service) => format!(
            "将启动 {}，会在本机创建或恢复服务进程，并可能影响正在使用它的应用。确认继续？",
            service.label()
        ),
        ServiceAction::Stop(service) => format!(
            "将停止 {}，可能中断当前服务连接或正在运行的任务。确认继续？",
            service.label()
        ),
    }
}

fn parse_number(label: &str, text: &str) -> Result<u64, String> {
    text.trim()
        .parse::<u64>()
        .map_err(|_| format!("{label}必须是非负整数。"))
}

const MAX_SAFE_QQ_ID: u64 = 9_007_199_254_740_991;

fn parse_policy_id(label: &str, text: &str) -> Result<u64, String> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{label}必须是正整数 QQ 号。"));
    }
    let id = text
        .parse::<u64>()
        .map_err(|_| format!("{label}超出有效 QQ 号范围。"))?;
    if id == 0 || id > MAX_SAFE_QQ_ID {
        return Err(format!("{label}必须是有效范围内的正整数 QQ 号。"));
    }
    Ok(id)
}

fn parse_policy_id_value(label: &str, value: &Value) -> Result<u64, String> {
    match value {
        Value::String(text) => parse_policy_id(label, text.trim()),
        Value::Number(number) => match number.as_u64() {
            Some(id) if id > 0 && id <= MAX_SAFE_QQ_ID => Ok(id),
            _ => Err(format!("Core 返回的{label}不是有效正整数 QQ 号。")),
        },
        _ => Err(format!("Core 返回的{label}不是有效 QQ 号。")),
    }
}

fn parse_policy_id_list(label: &str, text: &str) -> Result<Vec<u64>, String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for token in text
        .split(|character: char| character == ',' || character == '，' || character.is_whitespace())
    {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let id = parse_policy_id(label, token)?;
        if seen.insert(id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn format_policy_id_list(value: Option<&Value>, label: &str) -> Result<String, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Core 返回的{label}格式无效。"))?;
    let mut ids = Vec::with_capacity(values.len());
    for item in values {
        ids.push(parse_policy_id_value(label, item)?.to_string());
    }
    Ok(ids.join(", "))
}

fn compact_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| "未知".to_owned()),
    }
}

fn read_string_collection(
    value: &Value,
    field: &str,
    max_items: usize,
    label: &str,
) -> Result<Vec<String>, String> {
    let entries = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Core 返回的{label}格式无效。"))?;
    let mut bounded = Vec::with_capacity(entries.len().min(max_items));
    for item in entries.iter().take(max_items) {
        let text = item
            .as_str()
            .ok_or_else(|| format!("Core 返回的{label}包含非文本项目。"))?;
        bounded.push(truncate_display_line(text, MAX_DISPLAY_LINE_CHARS));
    }
    Ok(bounded)
}

fn truncate_display_line(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn log_source_label(source: &str) -> &'static str {
    match source {
        "worker" => "Worker",
        "desktop" => "桌面壳",
        _ => "桥接 Core",
    }
}

fn core_summary(value: &Value) -> String {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/result/status").and_then(Value::as_str));
    match status {
        Some("pong") => "在线（pong）".to_owned(),
        Some(text) => format!("在线（{text}）"),
        None if value.get("ok").and_then(Value::as_bool) == Some(true) => "在线".to_owned(),
        None => format!("已响应：{}", concise_result(value)),
    }
}

fn concise_result(value: &Value) -> String {
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return error.to_owned();
    }
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return "操作成功。".to_owned();
    }
    if let Some(status) = value.get("status").and_then(Value::as_str) {
        return format!("状态：{status}");
    }
    if value.is_null() {
        return String::new();
    }
    let serialized = serde_json::to_string(value).unwrap_or_else(|_| "结果无法显示".to_owned());
    const MAX_CHARS: usize = 420;
    if serialized.chars().count() > MAX_CHARS {
        let prefix = serialized.chars().take(MAX_CHARS).collect::<String>();
        format!("{prefix}…")
    } else {
        serialized
    }
}

#[cfg(test)]
mod capability_approval_tests {
    use super::parse_capability_approvals;
    use serde_json::json;

    #[test]
    fn parses_capability_approval_queue() {
        let value = json!({ "approvals": [
            { "id": "cap-1", "capability": "filesystem.write", "permission": "filesystem.write",
              "risk": "medium", "actor": { "kind": "agent", "id": "task:t1" },
              "taskId": "t1", "workspaceId": "ws1", "reason": "写入导出文件", "expiresAt": 1759660000000u64 }
        ]});
        let rows = parse_capability_approvals(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "cap-1");
        assert_eq!(rows[0].capability, "filesystem.write");
        assert_eq!(rows[0].risk, "medium");
        assert_eq!(rows[0].actor, "agent:task:t1");
        assert_eq!(rows[0].task_id, "t1");
        assert_eq!(rows[0].workspace_id, "ws1");
        assert_eq!(rows[0].reason, "写入导出文件");
        assert_eq!(rows[0].expires_at, 1759660000000);
        assert!(parse_capability_approvals(&json!({ "approvals": [] })).is_empty());
        assert!(parse_capability_approvals(&json!({})).is_empty());
    }
}

#[cfg(test)]
mod policy_tests {
    use super::{MAX_SAFE_QQ_ID, PolicyForm, parse_policy_id_list};
    use serde_json::json;

    #[test]
    fn policy_id_lists_are_strict_positive_safe_integers_and_deduplicated() {
        assert_eq!(
            parse_policy_id_list("QQ 列表", "123, 456，123\n789").unwrap(),
            vec![123, 456, 789]
        );
        for invalid in [
            "0",
            "-1",
            "1.5",
            "1e3",
            "12abc",
            "Infinity",
            "9007199254740992",
        ] {
            assert!(
                parse_policy_id_list("QQ 列表", invalid).is_err(),
                "accepted {invalid}"
            );
        }
        assert_eq!(
            parse_policy_id_list("QQ 列表", &MAX_SAFE_QQ_ID.to_string()).unwrap(),
            vec![MAX_SAFE_QQ_ID]
        );
        assert_eq!(
            parse_policy_id_list("QQ 列表", "   ").unwrap(),
            Vec::<u64>::new()
        );
    }

    #[test]
    fn policy_payload_contains_only_allowlisted_fields() {
        let form = PolicyForm {
            mode: "social".to_owned(),
            allow_private: "123".to_owned(),
            allow_groups: String::new(),
            deny_private: String::new(),
            deny_groups: "456".to_owned(),
            owner_qq: String::new(),
        };
        let params = form.params(true).unwrap();
        assert_eq!(
            params,
            json!({
                "mode": "social",
                "allow": { "private": [123], "groups": [] },
                "deny": { "private": [], "groups": [456] },
                "ownerQQ": null,
            })
        );
        let keys = params
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(keys, vec!["allow", "deny", "mode", "ownerQQ"]);
        let policy_only = form.params(false).unwrap();
        let policy_only_keys = policy_only
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(policy_only_keys, vec!["allow", "deny", "ownerQQ"]);
    }

    #[test]
    fn only_supported_policy_modes_are_accepted() {
        let mut form = PolicyForm::default();
        for mode in ["chat", "owner-agent", "social", "workshop"] {
            form.mode = mode.to_owned();
            assert!(form.params(true).is_ok());
        }
        form.mode = "unknown".to_owned();
        assert!(form.params(true).is_err());
    }

    #[test]
    fn old_runtime_policy_responses_are_read_with_canonical_names() {
        for (legacy, canonical) in [("closed-agent", "owner-agent"), ("reserved", "chat"), ("reserved2", "social")] {
            let mut form = PolicyForm::default();
            form.apply(&json!({ "policy": {
                "mode": legacy, "allow": { "private": [], "groups": [] },
                "deny": { "private": [], "groups": [] }, "ownerQQ": null
            }})).unwrap();
            assert_eq!(form.mode, canonical);
            assert_eq!(form.params(true).unwrap()["mode"], canonical);
        }
    }
}

#[cfg(test)]
mod readonly_view_tests {
    use super::{MAX_DISPLAY_LINE_CHARS, read_string_collection};
    use serde_json::json;

    #[test]
    fn activity_and_log_collections_are_schema_checked_and_bounded() {
        let long_line = "x".repeat(MAX_DISPLAY_LINE_CHARS + 20);
        let value = json!({ "lines": ["one", long_line, "three"] });
        let lines = read_string_collection(&value, "lines", 2, "日志").unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "one");
        assert_eq!(lines[1].chars().count(), MAX_DISPLAY_LINE_CHARS + 1);
        assert!(lines[1].ends_with('…'));
    }

    #[test]
    fn readonly_collection_rejects_wrong_shape_and_non_text_entries() {
        assert!(read_string_collection(&json!({}), "entries", 10, "活动记录").is_err());
        assert!(
            read_string_collection(
                &json!({ "entries": "not-array" }),
                "entries",
                10,
                "活动记录"
            )
            .is_err()
        );
        assert!(
            read_string_collection(&json!({ "entries": [1] }), "entries", 10, "活动记录").is_err()
        );
    }
}

#[cfg(test)]
mod services_ui_tests {
    use super::{ServiceKind, parse_service_snapshot};
    use serde_json::json;

    #[test]
    fn only_supported_local_service_names_are_allowed() {
        assert_eq!(ServiceKind::parse("snowluma"), Some(ServiceKind::SnowLuma));
        assert_eq!(ServiceKind::parse("dsh"), Some(ServiceKind::Dsh));
        for unsupported in [
            "",
            "SnowLuma",
            "node",
            "https://example.invalid",
            "C:\\temp",
        ] {
            assert_eq!(ServiceKind::parse(unsupported), None);
        }
    }

    #[test]
    fn service_snapshot_parses_only_core_discovered_install_items() {
        let snapshot = parse_service_snapshot(&json!({
            "installed": true,
            "running": false,
            "status": "stopped",
            "lastError": "启动失败提示",
            "selectedId": "local-1",
            "installations": [
                { "id": "local-1", "name": "SnowLuma", "version": "1.2", "status": "ready", "source": "configured", "valid": true, "path": "ignored" },
                { "id": "local-1", "name": "duplicate", "valid": false },
                { "id": "invalid-1", "name": "Invalid install", "valid": false, "invalidReason": "missing launcher" },
                { "id": "unknown-1", "name": "Missing validity field" }
            ]
        }))
        .unwrap();

        assert_eq!(snapshot.installed, Some(true));
        assert_eq!(snapshot.running, Some(false));
        assert_eq!(snapshot.status.as_deref(), Some("stopped"));
        assert_eq!(snapshot.message.as_deref(), Some("启动失败提示"));
        assert_eq!(snapshot.selected_id.as_deref(), Some("local-1"));
        assert_eq!(snapshot.installations.len(), 3);
        assert_eq!(snapshot.installations[0].name, "SnowLuma");
        assert_eq!(snapshot.installations[0].version.as_deref(), Some("1.2"));
        assert_eq!(snapshot.installations[0].status.as_deref(), Some("ready"));
        assert_eq!(
            snapshot.installations[0].source.as_deref(),
            Some("configured")
        );
        assert_eq!(snapshot.installations[0].valid, Some(true));
        assert!(snapshot.has_selectable_install("local-1"));
        assert!(!snapshot.has_selectable_install("invalid-1"));
        assert!(!snapshot.has_selectable_install("unknown-1"));
        assert_eq!(
            snapshot.installations[1].status.as_deref(),
            Some("missing launcher")
        );
    }

    #[test]
    fn service_snapshot_rejects_malformed_or_unidentified_install_items() {
        assert!(parse_service_snapshot(&json!({ "installations": "arbitrary path" })).is_err());
        assert!(
            parse_service_snapshot(&json!({ "installations": [{ "name": "No ID" }] })).is_err()
        );
        assert!(parse_service_snapshot(&json!("not a snapshot")).is_err());
    }
}

#[cfg(test)]
mod model_preset_ui_tests {
    use super::{
        is_supported_reasoning_effort, model_defaults_payload, parse_model_catalog,
        parse_model_defaults, parse_preset_bindings, parse_preset_list, preset_binding_payload,
    };
    use serde_json::json;

    #[test]
    fn model_catalog_and_defaults_are_schema_checked_and_allowlisted() {
        let catalog = parse_model_catalog(&json!({
            "models": [
                { "provider": "p", "model": "m", "image": true, "secret": "ignored" },
                { "provider": "p", "model": "m", "image": false },
            ]
        }))
        .unwrap();
        assert_eq!(catalog.len(), 1);
        assert!(catalog[0].image);
        let defaults = parse_model_defaults(&json!({
            "defaults": { "provider": "p", "model": "m", "reasoningEffort": "low", "token": "ignored" }
        }))
        .unwrap();
        assert_eq!(
            model_defaults_payload(&defaults, &catalog).unwrap(),
            json!({ "provider": "p", "model": "m", "reasoningEffort": "low" })
        );
        for effort in ["off", "low", "high", "max"] {
            assert!(is_supported_reasoning_effort(effort));
        }
        assert!(!is_supported_reasoning_effort("medium"));
        assert!(
            model_defaults_payload(
                &super::ModelDefaults {
                    provider: "p".into(),
                    model: "missing".into(),
                    reasoning_effort: "low".into()
                },
                &catalog
            )
            .is_err()
        );
    }

    #[test]
    fn preset_bindings_only_accept_known_targets_and_listed_ids() {
        let presets = parse_preset_list(&json!({
            "presets": [
                { "id": "router-standard", "trust": "system", "path": "ignored" },
                { "id": "router-standard", "trust": "duplicate" },
                { "id": "whale-chat", "trust": true },
            ]
        }))
        .unwrap();
        assert_eq!(presets.len(), 2);
        let bindings = parse_preset_bindings(&json!({
            "bindings": { "chat": null, "closedAgent": "router-standard", "social": "whale-chat", "workshop": "router-standard", "learner": "" }
        }))
        .unwrap();
        assert!(bindings.chat.is_none());
        assert_eq!(bindings.closed_agent.as_deref(), Some("router-standard"));
        assert_eq!(bindings.workshop.as_deref(), Some("router-standard"));
        assert!(preset_binding_payload("chat", "router-standard", &presets).is_ok());
        assert!(preset_binding_payload("unknown", "router-standard", &presets).is_err());
        assert!(preset_binding_payload("chat", "not-listed", &presets).is_err());
    }
}

#[cfg(test)]
mod pending_ui_tests {
    use super::parse_pending;
    use serde_json::json;

    #[test]
    fn pending_view_projects_questions_approvals_and_card_risks() {
        let pending = parse_pending(&json!({
            "pending": [
                {
                    "kind": "question",
                    "key": "private:1",
                    "sessionId": "session-1",
                    "questions": [{ "id": "q1", "question": "继续吗？", "options": [{ "label": "是" }] }],
                    "secret": "ignored"
                },
                {
                    "kind": "approval",
                    "key": "group:2",
                    "toolName": "web_search",
                    "reason": "联网",
                    "eventId": "event-1"
                },
                {
                    "kind": "card-approval",
                    "id": "card_1",
                    "status": "pending",
                    "cardTitle": "卡片",
                    "buttonLabel": "打开",
                    "riskReasons": ["外部跳转"]
                },
                { "kind": "arbitrary", "command": "ignored" }
            ]
        }))
        .unwrap();
        assert_eq!(pending.len(), 3);
        assert_eq!(pending[0].question, "继续吗？");
        assert_eq!(pending[0].options, vec!["是"]);
        assert_eq!(pending[1].tool_name, "web_search");
        assert_eq!(pending[2].button_label, "打开");
        assert_eq!(pending[2].risk_reasons, vec!["外部跳转"]);
    }

    #[test]
    fn pending_view_rejects_missing_collection() {
        assert!(parse_pending(&json!({})).is_err());
    }
}

#[cfg(test)]
mod theme_tests {
    use super::{Area, DARK_THEME, friendly_read_error, native_style};
    use eframe::egui::{self, Color32, TextStyle};
    use std::sync::atomic::Ordering;

    #[test]
    fn native_theme_uses_readable_text_and_touch_targets_in_both_modes() {
        DARK_THEME.store(false, Ordering::Relaxed);
        let light = native_style();
        assert!(!light.visuals.dark_mode, "light shell theme");
        assert_eq!(light.spacing.item_spacing, egui::vec2(12.0, 10.0));
        assert_eq!(light.spacing.button_padding, egui::vec2(10.0, 6.0));
        assert!(light.spacing.interact_size.y >= 30.0);
        assert_eq!(light.text_styles[&TextStyle::Body].size, 15.0);
        assert_eq!(light.text_styles[&TextStyle::Small].size, 13.0);
        assert_eq!(light.text_styles[&TextStyle::Heading].size, 26.0);
        assert!(light.visuals.override_text_color.is_some());
        assert!(light.visuals.weak_text_color.unwrap_or(Color32::BLACK).r() < 150);
        assert_ne!(light.visuals.panel_fill, Color32::BLACK);

        DARK_THEME.store(true, Ordering::Relaxed);
        let dark = native_style();
        assert!(dark.visuals.dark_mode, "dark shell theme");
        assert!(dark.visuals.weak_text_color.unwrap_or(Color32::WHITE).r() > 100);
        assert_ne!(dark.visuals.panel_fill, Color32::WHITE);
        assert!(dark.visuals.override_text_color.is_some());
        DARK_THEME.store(false, Ordering::Relaxed);
    }

    #[test]
    fn dsh_connection_errors_have_actionable_model_and_preset_hint() {
        let error = "Core IPC INTERNAL_ERROR: agentPresets/list: 传输失败 (ECONNREFUSED)";
        let expected = Some("DSH/目录服务当前不可用。Core IPC 仍在线，请启动 DSH 后重试。");

        assert_eq!(friendly_read_error(Area::ModelCatalog, error), expected);
        assert_eq!(friendly_read_error(Area::ModelDefaults, error), expected);
        assert_eq!(friendly_read_error(Area::PresetList, error), expected);
        assert_eq!(friendly_read_error(Area::PresetBindings, error), expected);
        assert_eq!(friendly_read_error(Area::Overview, error), None);
        assert_eq!(
            friendly_read_error(Area::ModelCatalog, "模型目录格式无效"),
            None
        );
        assert_eq!(
            friendly_read_error(Area::ModelCatalog, "Core IPC transport ECONNREFUSED"),
            None
        );
    }
}

#[cfg(test)]
mod interaction_tests {
    use super::{AppPage, page_for_shortcut_slot, should_send_on_enter};

    #[test]
    fn navigation_shortcuts_cover_the_first_seven_product_pages() {
        assert_eq!(page_for_shortcut_slot(1), Some(AppPage::Home));
        assert_eq!(page_for_shortcut_slot(2), Some(AppPage::Chat));
        assert_eq!(page_for_shortcut_slot(3), Some(AppPage::Work));
        assert_eq!(page_for_shortcut_slot(4), Some(AppPage::Social));
        assert_eq!(page_for_shortcut_slot(5), Some(AppPage::Agents));
        assert_eq!(page_for_shortcut_slot(6), Some(AppPage::Plugins));
        assert_eq!(page_for_shortcut_slot(7), Some(AppPage::Memory));
        assert_eq!(page_for_shortcut_slot(0), None);
        assert_eq!(page_for_shortcut_slot(8), None);
    }

    #[test]
    fn enter_send_requires_focus_and_is_ime_safe() {
        assert!(should_send_on_enter(true, true, false, false));
        assert!(!should_send_on_enter(true, true, true, false), "Shift+Enter inserts a newline");
        assert!(!should_send_on_enter(true, true, false, true), "IME composition must not send");
        assert!(!should_send_on_enter(false, true, false, false), "composer must own focus");
        assert!(!should_send_on_enter(true, false, false, false), "no Enter, no send");
    }
}
