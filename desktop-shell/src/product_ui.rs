//! 产品面 UI 辅助（任务 D：About / 更新公告 / Feedback / 首次运行引导）。
//!
//! 定位：**纯逻辑**。把 Core 的 JSON 结果解析成可渲染视图、生成 IPC 参数、在不依赖网络与
//! egui 的前提下提供中文兜底文案。绘制留在 `native_ui.rs`，因此这里可以单元测试。
//!
//! 为什么兜底文案要放在 Rust 侧一份：IPC 还没返回（或失败）时，界面**不能只显示技术错误**，
//! 但也不能空白。`builtin_copy()` 提供与 `src/product/empty-states.js` 一致的四条必需文案；
//! `product.copy` 一旦返回就用 Core 的那份覆盖（Core 是文案的唯一事实源）。

use serde_json::{json, Value};

// ── 首次运行引导 ────────────────────────────────────────────────────────────

/// 引导是否已完成。只认 Core 明确返回的 `completed`，拿不到就不算完成（首次运行要能弹出）。
pub(crate) fn onboarding_is_complete(status: &Value) -> bool {
    status.get("status").and_then(Value::as_str) == Some("completed")
}

/// 启动时是否应自动进入引导页：**只有**明确读到未完成状态才自动打开。
/// 读取失败/无数据时不打扰用户（fail-soft：宁可少弹一次，也不要在老用户机器上弹错误向导）。
pub(crate) fn should_open_onboarding_on_launch(status: &Value) -> bool {
    match status.get("status").and_then(Value::as_str) {
        Some("not_started") | Some("in_progress") => true,
        _ => false,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StepVisualState {
    Completed,
    Skipped,
    Current,
    Pending,
}

impl StepVisualState {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "completed" => Self::Completed,
            "skipped" => Self::Skipped,
            "current" => Self::Current,
            _ => Self::Pending,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Completed => "已完成",
            Self::Skipped => "已跳过",
            Self::Current => "当前步骤",
            Self::Pending => "待处理",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct OnboardingStepRow {
    pub id: String,
    pub order: u64,
    pub label: String,
    pub description: String,
    pub optional: bool,
    pub state: StepVisualState,
}

/// 解析 `onboarding.status` 的 steps 数组；缺字段一律降级而不是 panic。
pub(crate) fn onboarding_step_rows(status: &Value) -> Vec<OnboardingStepRow> {
    status
        .get("steps")
        .and_then(Value::as_array)
        .map(|steps| {
            steps
                .iter()
                .filter_map(|step| {
                    let id = step.get("id").and_then(Value::as_str)?.to_owned();
                    Some(OnboardingStepRow {
                        label: step
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or(&id)
                            .to_owned(),
                        description: step
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        order: step.get("order").and_then(Value::as_u64).unwrap_or(0),
                        optional: step.get("optional").and_then(Value::as_bool).unwrap_or(false),
                        state: StepVisualState::parse(
                            step.get("state").and_then(Value::as_str).unwrap_or("pending"),
                        ),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 当前步骤 id（Core 给的 currentStepId，缺失时返回 None）。
pub(crate) fn onboarding_current_step(status: &Value) -> Option<String> {
    status
        .get("currentStepId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// 引导是否还缺必填步骤（Core 的 canFinish 取反；缺失时按"还不能完成"处理，避免误判完成）。
pub(crate) fn onboarding_can_finish(status: &Value) -> bool {
    status.get("canFinish").and_then(Value::as_bool).unwrap_or(false)
}

/// 引导最近一次错误（含损坏的进度文件提示），供页面如实展示。
pub(crate) fn onboarding_notice(status: &Value) -> Option<String> {
    status
        .get("lastError")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(crate) fn complete_step_params(step_id: &str) -> Value {
    json!({ "stepId": step_id })
}

pub(crate) fn skip_step_params(step_id: &str) -> Value {
    json!({ "stepId": step_id })
}

// ── About ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub(crate) struct AboutView {
    pub product: String,
    pub edition: String,
    pub version: String,
    pub channel: Option<String>,
    pub build_number: Option<u64>,
    pub build_id: String,
    pub commit: String,
    pub build_time: String,
    pub platform: String,
    pub arch: String,
    pub version_consistent: bool,
    pub developer: Option<String>,
    pub website: Option<String>,
    pub gitcode: Option<String>,
    pub github: Option<String>,
    pub license: String,
    pub license_url: Option<String>,
    pub privacy_summary: Option<String>,
    pub security_summary: Option<String>,
    pub security_contact: Option<String>,
    pub security_contact_source: Option<String>,
    pub release_manifest_available: bool,
    pub release_manifest_version: Option<String>,
    pub release_config_source: Option<String>,
    pub release_config_error: Option<String>,
    /// 未配置的产品字段（UI 明确显示"未配置"，而不是空白或编造值）。
    pub unconfigured: Vec<&'static str>,
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && *text != "unknown")
        .map(str::to_owned)
}

/// `about.info` 的 `about` 对象 → 视图。
pub(crate) fn about_view(about: &Value) -> AboutView {
    let mut view = AboutView {
        product: string_at(about, "/product").unwrap_or_else(|| "CetaMesh".to_owned()),
        edition: string_at(about, "/edition").unwrap_or_else(|| "Desktop".to_owned()),
        version: string_at(about, "/version").unwrap_or_else(|| "未知".to_owned()),
        channel: string_at(about, "/channel"),
        build_number: about.pointer("/build/buildNumber").and_then(Value::as_u64),
        build_id: string_at(about, "/build/buildId").unwrap_or_else(|| "未提供".to_owned()),
        commit: string_at(about, "/build/commit").unwrap_or_else(|| "未提供".to_owned()),
        build_time: string_at(about, "/build/buildTime").unwrap_or_else(|| "未提供".to_owned()),
        platform: string_at(about, "/platform/label")
            .or_else(|| string_at(about, "/runtime/platform"))
            .unwrap_or_else(|| "未知".to_owned()),
        arch: string_at(about, "/platform/arch")
            .or_else(|| string_at(about, "/runtime/arch"))
            .unwrap_or_else(|| "未知".to_owned()),
        version_consistent: about
            .pointer("/versionConsistent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        developer: string_at(about, "/developer/name"),
        website: string_at(about, "/links/website"),
        gitcode: string_at(about, "/links/gitcode"),
        github: string_at(about, "/links/github"),
        license: string_at(about, "/legal/license/name").unwrap_or_else(|| "未知".to_owned()),
        license_url: string_at(about, "/legal/license/url"),
        privacy_summary: string_at(about, "/legal/privacy/summary"),
        security_summary: string_at(about, "/legal/security/summary"),
        security_contact: string_at(about, "/legal/security/contact"),
        security_contact_source: string_at(about, "/legal/security/contactSource"),
        release_manifest_available: about
            .pointer("/release/available")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        release_manifest_version: string_at(about, "/release/version"),
        release_config_source: string_at(about, "/releaseConfigSource"),
        release_config_error: string_at(about, "/releaseConfigError"),
        unconfigured: Vec::new(),
    };
    if view.developer.is_none() {
        view.unconfigured.push("开发者");
    }
    if view.website.is_none() {
        view.unconfigured.push("官方网站");
    }
    view
}

// ── 更新区块 ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub(crate) struct UpdateView {
    pub current: String,
    pub latest: Option<String>,
    pub status: String,
    pub checked_at: Option<String>,
    pub cache_available: bool,
    pub announcement_title: Option<String>,
    pub announcement_version: Option<String>,
    pub announcement_published_at: Option<String>,
    pub announcement_text: Option<String>,
    pub announcement_notes: Vec<String>,
    pub sources: Vec<(String, String)>,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
}

impl UpdateView {
    /// 状态的中文说明（About 页「更新状态」一行）。
    pub(crate) fn status_label(&self) -> &'static str {
        match self.status.as_str() {
            "update_available" => "有新版本可用",
            "up_to_date" => "已是最新版本",
            "error" => "上次检查失败",
            _ => "尚未检查",
        }
    }
}

pub(crate) fn update_view(update: &Value) -> UpdateView {
    let announcement = update.get("announcement").cloned().unwrap_or(Value::Null);
    let sources = update
        .get("sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.to_owned();
                    let url = item
                        .get("manifestUrl")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    Some((id, url))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let notes = announcement
        .get("notes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    UpdateView {
        current: string_at(update, "/currentVersion").unwrap_or_else(|| "未知".to_owned()),
        latest: string_at(update, "/latest"),
        status: string_at(update, "/status").unwrap_or_else(|| "unknown".to_owned()),
        checked_at: string_at(update, "/checkedAt"),
        cache_available: update
            .get("cacheAvailable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        announcement_title: string_at(&announcement, "/title"),
        announcement_version: string_at(&announcement, "/version"),
        announcement_published_at: string_at(&announcement, "/publishedAt"),
        announcement_text: string_at(&announcement, "/text"),
        announcement_notes: notes,
        sources,
        failure_code: string_at(update, "/failureCode"),
        failure_message: string_at(update, "/failureMessage"),
    }
}

// ── 反馈入口（修正版：只提供入口，不在软件内收集反馈） ─────────────────────
//
// 产品决策：软件内**没有**反馈表单 / Bug 提交 / 漏洞上传 / 本地队列，也不自动上传日志。
// 这里只做一件事：把 Core（依据随安装包分发的发行配置）给出的四个官方入口渲染出来，
// 点击交给系统默认浏览器。链接允许携带的 query 只有 version / build / platform ——
// 由 Core 构造，UI 只显示、不追加任何字段。

#[derive(Clone, Debug)]
pub(crate) struct FeedbackEntryRow {
    pub id: String,
    pub label: String,
    pub description: String,
    pub url: Option<String>,
    pub security: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct FeedbackLinksView {
    pub configured: bool,
    pub base_url: Option<String>,
    pub entries: Vec<FeedbackEntryRow>,
    pub security_notice: String,
    pub open_failure_message: String,
    pub not_configured_message: String,
    /// 会随链接一起带上的三个字段（对用户透明；不是让 UI 自己拼）。
    pub query_summary: String,
    pub allowed_query_keys: Vec<String>,
}

impl Default for FeedbackLinksView {
    fn default() -> Self {
        Self {
            configured: false,
            base_url: None,
            entries: Vec::new(),
            // 兜底文案与 Core（src/product/feedback-links.js）保持一致；Core 一到就以 Core 为准。
            security_notice: "安全问题请通过官方安全反馈页面提交，不要在公开 Issue 中披露敏感漏洞。"
                .to_owned(),
            open_failure_message: "无法打开浏览器，请稍后访问 CetaMesh 官方网站。".to_owned(),
            not_configured_message: "官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。".to_owned(),
            query_summary: String::new(),
            allowed_query_keys: vec!["version".to_owned(), "build".to_owned(), "platform".to_owned()],
        }
    }
}

fn payload_message(value: &Value, pointer: &str, fallback: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| fallback.to_owned())
}

fn query_summary(query: &Value) -> String {
    let mut parts = Vec::new();
    for key in ["version", "build", "platform"] {
        if let Some(value) = query.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()) {
            parts.push(format!("{key}={value}"));
        }
    }
    parts.join(" · ")
}

/// 解析 `product.feedbackLinks` 的返回（兼容 `{ links: {...} }` 与直接给 links 两种形态）。
pub(crate) fn feedback_links_view(result: &Value) -> FeedbackLinksView {
    let links = result.get("links").unwrap_or(result);
    let mut view = FeedbackLinksView {
        configured: links.get("configured").and_then(Value::as_bool).unwrap_or(false),
        base_url: links
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned),
        security_notice: payload_message(
            links,
            "/securityNotice",
            "安全问题请通过官方安全反馈页面提交，不要在公开 Issue 中披露敏感漏洞。",
        ),
        open_failure_message: payload_message(
            links,
            "/messages/openFailure",
            "无法打开浏览器，请稍后访问 CetaMesh 官方网站。",
        ),
        not_configured_message: payload_message(
            links,
            "/messages/notConfigured",
            "官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。",
        ),
        query_summary: query_summary(links.get("query").unwrap_or(&Value::Null)),
        allowed_query_keys: links
            .get("allowedQueryKeys")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_else(|| vec!["version".to_owned(), "build".to_owned(), "platform".to_owned()]),
        ..FeedbackLinksView::default()
    };
    view.entries = links
        .get("entries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.to_owned();
                    Some(FeedbackEntryRow {
                        label: item
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or(&id)
                            .to_owned(),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        url: item
                            .get("url")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                            .map(str::to_owned),
                        security: item.get("kind").and_then(Value::as_str) == Some("security"),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    view
}

// ── product.copy（Core 文案表 + 本地兜底） ──────────────────────────────────

#[derive(Clone, Debug, Default)]
pub(crate) struct ProductCopy {
    states: Vec<CopyEntry>,
    code_map: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
struct CopyEntry {
    key: String,
    title: String,
    message: String,
    action: String,
}

impl ProductCopy {
    pub(crate) fn from_value(value: &Value) -> Self {
        let states = value
            .get("emptyStates")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let key = item.get("key").and_then(Value::as_str)?.to_owned();
                        Some(CopyEntry {
                            title: item
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            message: item
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            action: item
                                .get("action")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            key,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let code_map = value
            .get("technicalCodeMap")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(code, state)| Some((code.clone(), state.as_str()?.to_owned())))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Self { states, code_map }
    }

    fn state(&self, key: &str) -> Option<&CopyEntry> {
        self.states.iter().find(|entry| entry.key == key)
    }

    /// 按空状态 key 取文案：(title, message, action)。
    pub(crate) fn empty_state(&self, key: &str) -> Option<(&str, &str, &str)> {
        self.state(key)
            .map(|entry| (entry.title.as_str(), entry.message.as_str(), entry.action.as_str()))
    }

    /// 技术错误码 → (title, message, action)；**只有**命中映射表才返回 Some。
    pub(crate) fn mapped_state(&self, code: &str) -> Option<(String, String, Option<String>)> {
        let key = self
            .code_map
            .iter()
            .find(|(candidate, _)| candidate == code)
            .map(|(_, state)| state.clone())?;
        let (title, message, action) = self.empty_state(&key)?;
        Some((title.to_owned(), message.to_owned(), Some(action.to_owned())))
    }

    /// 技术错误码 → (title, message, detail_aware_action)；未知码回落到"暂时无法完成"。
    pub(crate) fn for_error_code(&self, code: &str) -> (String, String, Option<String>) {
        if let Some(mapped) = self.mapped_state(code) {
            return mapped;
        }
        if let Some((title, message, action)) = self.empty_state("generic.error") {
            return (title.to_owned(), message.to_owned(), Some(action.to_owned()));
        }
        (
            "暂时无法完成".to_owned(),
            "这一步没有成功，具体原因见技术细节。".to_owned(),
            None,
        )
    }
}

/// 本地兜底文案：IPC 尚未返回时也要有中文人话（与 src/product/empty-states.js 的四条必需文案一致）。
pub(crate) fn builtin_copy() -> ProductCopy {
    ProductCopy {
        states: vec![
            CopyEntry {
                key: "chat.no-model".to_owned(),
                title: "先添加一个模型".to_owned(),
                message: "还没有配置任何对话模型，聊天暂时无法开始。".to_owned(),
                action: "打开 设置 → 模型，选择服务商并填入 API Key。".to_owned(),
            },
            CopyEntry {
                key: "agent.not-installed".to_owned(),
                title: "Codex 未安装".to_owned(),
                message: "这台电脑上还没有可用的 Agent 运行时，Agent 任务无法启动。".to_owned(),
                action: "按安装向导完成 Agent 运行时安装后重试。".to_owned(),
            },
            CopyEntry {
                key: "plugin.disabled".to_owned(),
                title: "插件已关闭".to_owned(),
                message: "这个扩展当前处于关闭状态，它的能力不会被执行。".to_owned(),
                action: "打开 插件 页面，确认权限后重新启用。".to_owned(),
            },
            CopyEntry {
                key: "capability.tool-denied".to_owned(),
                title: "需要审批".to_owned(),
                message: "这次操作超出了当前授权范围，已被安全策略拦下。".to_owned(),
                action: "在审批弹窗里确认本次操作，或调整该能力的授权范围。".to_owned(),
            },
            CopyEntry {
                key: "generic.error".to_owned(),
                title: "暂时无法完成".to_owned(),
                message: "这一步没有成功，具体原因见技术细节。".to_owned(),
                action: "按提示重试；仍然失败时展开技术细节并反馈给支持。".to_owned(),
            },
        ],
        code_map: vec![
            ("MODEL_NO_MODEL".to_owned(), "chat.no-model".to_owned()),
            ("MODEL_PROVIDER_KEY_MISSING".to_owned(), "chat.no-model".to_owned()),
            ("PROVIDER_SECRET_NOT_FOUND".to_owned(), "chat.no-model".to_owned()),
            ("AGENT_NOT_INSTALLED".to_owned(), "agent.not-installed".to_owned()),
            ("AGENT_PROVIDER_UNKNOWN".to_owned(), "agent.not-installed".to_owned()),
            ("PROVIDER_UNAVAILABLE".to_owned(), "agent.not-installed".to_owned()),
            ("EXTENSION_DISABLED".to_owned(), "plugin.disabled".to_owned()),
            ("PLUGIN_DISABLED".to_owned(), "plugin.disabled".to_owned()),
            ("NOT_INSTALLED".to_owned(), "plugin.disabled".to_owned()),
            ("TOOL_DENIED".to_owned(), "capability.tool-denied".to_owned()),
            ("CAPABILITY_DENIED".to_owned(), "capability.tool-denied".to_owned()),
            ("PERMISSION_DENIED".to_owned(), "capability.tool-denied".to_owned()),
            ("TARGET_NOT_ALLOWED".to_owned(), "capability.tool-denied".to_owned()),
        ],
    }
}

/// IPC 返回的技术错误文本 → (友好标题, 友好说明, 原始技术细节)。
///
/// Core 的 `product.emptyStateForError` 给出同样语义；这里做无网络时的本地等价处理。
/// 未知错误码有两种情形，必须区别对待：
///   - Core 的消息本身已是中文人话（绝大多数领域错误都带可执行提示）：直接当主文案展示，
///     把技术原文留在 detail —— 硬塞"暂时无法完成"反而会丢掉用户真正需要的提示；
///   - 纯技术串（英文/编码）：才回落到通用文案 + 技术细节。
pub(crate) fn friendly_error(copy: &ProductCopy, raw_error: &str) -> (String, String, Option<String>) {
    let code = raw_error
        .split(|ch: char| ch == ':' || ch == ' ' || ch == '(')
        .next()
        .unwrap_or("")
        .trim();
    if code.is_empty() {
        return (
            "暂时无法完成".to_owned(),
            "这一步没有成功。".to_owned(),
            Some(raw_error.to_owned()),
        );
    }
    if let Some((title, message, _action)) = copy.mapped_state(code) {
        return (title, message, Some(raw_error.to_owned()));
    }
    let looks_human = raw_error
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch));
    if looks_human {
        ("处理失败".to_owned(), raw_error.to_owned(), Some(raw_error.to_owned()))
    } else {
        let (title, message, _action) = copy.for_error_code(code);
        (title, message, Some(raw_error.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboarding_completion_and_first_run_detection_are_explicit() {
        assert!(onboarding_is_complete(&json!({ "status": "completed" })));
        assert!(!onboarding_is_complete(&json!({ "status": "in_progress" })));
        assert!(!onboarding_is_complete(&json!({})));

        assert!(should_open_onboarding_on_launch(&json!({ "status": "not_started" })));
        assert!(should_open_onboarding_on_launch(&json!({ "status": "in_progress" })));
        assert!(!should_open_onboarding_on_launch(&json!({ "status": "completed" })));
        // 读取失败（空对象）绝不自动弹向导，避免干扰已完成的用户。
        assert!(!should_open_onboarding_on_launch(&json!({})));
    }

    #[test]
    fn onboarding_steps_are_parsed_with_state_and_optional_flags() {
        let status = json!({
            "status": "in_progress",
            "currentStepId": "connection",
            "canFinish": false,
            "lastError": "引导进度文件字段异常",
            "steps": [
                { "id": "welcome", "order": 1, "label": "欢迎使用 CetaMesh", "description": "本地优先", "optional": false, "state": "completed" },
                { "id": "connection", "order": 3, "label": "测试连接", "description": "真实请求", "optional": false, "state": "current" },
                { "id": "agent", "order": 5, "label": "连接 Agent（可选）", "description": "", "optional": true, "state": "skipped" }
            ]
        });
        let rows = onboarding_step_rows(&status);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].state, StepVisualState::Completed);
        assert_eq!(rows[1].state, StepVisualState::Current);
        assert!(rows[2].optional);
        assert_eq!(rows[2].state, StepVisualState::Skipped);
        assert_eq!(onboarding_current_step(&status).as_deref(), Some("connection"));
        assert!(!onboarding_can_finish(&status));
        assert!(onboarding_notice(&status).is_some());
        assert_eq!(complete_step_params("model"), json!({ "stepId": "model" }));
    }

    #[test]
    fn about_view_reads_build_facts_and_marks_unconfigured_fields() {
        let about = json!({
            "product": "CetaMesh",
            "edition": "Desktop",
            "version": "1.0.0-rc.1",
            "versionConsistent": true,
            "build": { "buildId": "ci-42", "commit": "deadbee", "buildTime": "2026-10-09T00:00:00Z" },
            "platform": { "label": "Windows · x64", "arch": "x64" },
            "developer": { "name": null, "configured": false },
            "links": { "website": null, "gitcode": "https://gitcode.com/ygdnn/CetaMesh", "github": "https://github.com/chx6418-source/whalebridge" },
            "legal": {
                "license": { "name": "GPL-3.0-only", "url": "https://www.gnu.org/licenses/gpl-3.0.html" },
                "privacy": { "summary": "本地优先" },
                "security": { "summary": "请不要公开披露", "contact": "https://github.com/x/y/security/advisories/new", "contactSource": "github-advisories" }
            },
            "release": { "available": true, "version": "1.0.0-rc.2" },
            "releaseConfigSource": "injected"
        });
        let view = about_view(&about);
        assert_eq!(view.version, "1.0.0-rc.1");
        assert_eq!(view.build_id, "ci-42");
        assert_eq!(view.platform, "Windows · x64");
        assert!(view.version_consistent);
        assert!(view.developer.is_none());
        assert!(view.website.is_none());
        assert_eq!(view.unconfigured, vec!["开发者", "官方网站"]);
        assert!(view.gitcode.as_deref().unwrap().contains("gitcode.com"));
        assert_eq!(view.license, "GPL-3.0-only");
        assert!(view.release_manifest_available);
        assert!(view.security_contact.as_deref().unwrap().starts_with("https://"));
    }

    #[test]
    fn about_view_tolerates_missing_metadata_without_panicking() {
        let view = about_view(&json!({}));
        assert_eq!(view.product, "CetaMesh");
        assert_eq!(view.version, "未知");
        assert_eq!(view.build_id, "未提供");
        // "unknown" 是 Core 的未知标记，UI 不应把它当版本展示。
        let unknown = about_view(&json!({ "version": "unknown", "build": { "commit": "unknown" } }));
        assert_eq!(unknown.version, "未知");
        assert_eq!(unknown.commit, "未提供");
    }

    #[test]
    fn update_view_surfaces_announcement_sources_and_failure() {
        let update = json!({
            "currentVersion": "1.0.0-rc.1",
            "latest": "1.0.0-rc.2",
            "status": "update_available",
            "checkedAt": "2026-10-09T00:00:00Z",
            "cacheAvailable": true,
            "sources": [ { "id": "gitcode", "manifestUrl": "https://api.gitcode.com/x" }, { "id": "github", "manifestUrl": null } ],
            "announcement": {
                "version": "1.0.0-rc.2",
                "title": "稳定性更新",
                "publishedAt": "2026-10-09T00:00:00Z",
                "notes": ["修复更新检查", "改进错误文案"],
                "text": "稳定性更新\n• 修复更新检查"
            }
        });
        let view = update_view(&update);
        assert_eq!(view.status_label(), "有新版本可用");
        assert_eq!(view.latest.as_deref(), Some("1.0.0-rc.2"));
        assert_eq!(view.announcement_title.as_deref(), Some("稳定性更新"));
        assert_eq!(view.announcement_notes.len(), 2);
        assert_eq!(view.sources.len(), 2);
        assert_eq!(view.sources[0].0, "gitcode");

        let offline = update_view(&json!({ "currentVersion": "1.0.0-rc.1", "status": "error", "failureCode": "NETWORK_ERROR", "failureMessage": "所有更新源均失败" }));
        assert_eq!(offline.status_label(), "上次检查失败");
        assert_eq!(offline.failure_code.as_deref(), Some("NETWORK_ERROR"));
        assert_eq!(update_view(&json!({})).status_label(), "尚未检查");
    }

    #[test]
    fn feedback_links_view_parses_entries_messages_and_query() {
        let result = json!({
            "links": {
                "configured": true,
                "baseUrl": "https://cetamesh.example.com",
                "allowedQueryKeys": ["version", "build", "platform"],
                "query": { "version": "1.0.0", "build": "1052", "platform": "windows" },
                "securityNotice": "安全问题请通过官方安全反馈页面提交，不要在公开 Issue 中披露敏感漏洞。",
                "messages": {
                    "openFailure": "无法打开浏览器，请稍后访问 CetaMesh 官方网站。",
                    "notConfigured": "官方反馈页面尚未配置，请稍后访问 CetaMesh 官方网站。"
                },
                "entries": [
                    { "id": "general", "label": "反馈与建议", "description": "整体意见", "kind": "feedback", "url": "https://cetamesh.example.com/feedback?version=1.0.0&build=1052&platform=windows" },
                    { "id": "bug", "label": "Bug 反馈", "description": "功能异常", "kind": "feedback", "url": "https://cetamesh.example.com/feedback?type=bug&version=1.0.0" },
                    { "id": "feature", "label": "功能建议", "description": "新增能力", "kind": "feedback", "url": "https://cetamesh.example.com/feedback?type=feature" },
                    { "id": "security", "label": "安全漏洞", "description": "安全问题", "kind": "security", "url": "https://cetamesh.example.com/security" }
                ]
            }
        });
        let view = feedback_links_view(&result);
        assert!(view.configured);
        assert_eq!(view.entries.len(), 4);
        assert_eq!(view.entries[0].label, "反馈与建议");
        assert!(view.entries[3].security);
        assert!(!view.entries[0].security);
        assert_eq!(view.query_summary, "version=1.0.0 · build=1052 · platform=windows");
        assert_eq!(view.allowed_query_keys, vec!["version", "build", "platform"]);
        assert!(view.security_notice.contains("不要"));
        assert!(view.open_failure_message.contains("无法打开浏览器"));
        assert_eq!(
            view.entries[3].url.as_deref(),
            Some("https://cetamesh.example.com/security")
        );
        assert!(view.entries[3].security);
    }

    #[test]
    fn feedback_links_view_falls_back_when_unconfigured_or_missing() {
        // 未配置：configured=false、url 为空，文案仍是产品给定原文。
        let unconfigured = json!({
            "links": {
                "configured": false,
                "baseUrl": null,
                "entries": [
                    { "id": "general", "label": "反馈与建议", "kind": "feedback", "url": null },
                    { "id": "security", "label": "安全漏洞", "kind": "security", "url": null }
                ]
            }
        });
        let view = feedback_links_view(&unconfigured);
        assert!(!view.configured);
        assert!(view.entries.iter().all(|entry| entry.url.is_none()));
        assert!(view.not_configured_message.contains("尚未配置"));
        assert_eq!(view.entries[0].url.as_deref(), None);

        // 空 payload（Core 未就绪/返回异常）：不 panic，且四条必需文案仍在。
        let empty = feedback_links_view(&json!({}));
        assert!(!empty.configured);
        assert!(empty.entries.is_empty());
        assert!(empty.security_notice.contains("不要在公开 Issue"));
        assert!(empty.open_failure_message.contains("无法打开浏览器，请稍后访问 CetaMesh 官方网站。"));
        assert_eq!(empty.allowed_query_keys, vec!["version", "build", "platform"]);
    }

    #[test]
    fn builtin_copy_matches_the_required_product_wording() {
        let copy = builtin_copy();
        assert_eq!(copy.empty_state("chat.no-model").unwrap().0, "先添加一个模型");
        assert_eq!(copy.empty_state("agent.not-installed").unwrap().0, "Codex 未安装");
        assert_eq!(copy.empty_state("plugin.disabled").unwrap().0, "插件已关闭");
        assert_eq!(copy.empty_state("capability.tool-denied").unwrap().0, "需要审批");
        // 技术码映射到同一张表
        assert_eq!(copy.for_error_code("TOOL_DENIED").0, "需要审批");
        assert_eq!(copy.for_error_code("MODEL_NO_MODEL").0, "先添加一个模型");
        assert_eq!(copy.for_error_code("EXTENSION_DISABLED").0, "插件已关闭");
        assert_eq!(copy.for_error_code("SOMETHING_NEW").0, "暂时无法完成");
    }

    #[test]
    fn core_copy_overrides_builtin_and_friendly_error_keeps_technical_detail() {
        let copy = ProductCopy::from_value(&json!({
            "emptyStates": [
                { "key": "chat.no-model", "title": "来自 Core 的标题", "message": "m", "action": "a" },
                { "key": "generic.error", "title": "通用失败", "message": "m", "action": "重试" }
            ],
            "technicalCodeMap": { "MODEL_NO_MODEL": "chat.no-model" }
        }));
        assert_eq!(copy.for_error_code("MODEL_NO_MODEL").0, "来自 Core 的标题");
        let (title, message, detail) = friendly_error(&copy, "MODEL_NO_MODEL: 尚未配置任何 API Key");
        assert_eq!(title, "来自 Core 的标题");
        assert!(!message.contains("MODEL_NO_MODEL"));
        // 技术原文必须保留在 detail 里（供"技术细节"展开与反馈使用），只是不作为主文案。
        assert!(detail.unwrap().contains("MODEL_NO_MODEL"));
    }

    #[test]
    fn empty_core_copy_does_not_erase_builtin_wording() {
        // Core 返回空表时，本地兜底仍然给出四条必需文案（不能因为一次空响应就显示技术串）。
        let copy = builtin_copy();
        let (title, _, _) = friendly_error(&copy, "AGENT_NOT_INSTALLED: agent provider unavailable");
        assert_eq!(title, "Codex 未安装");
    }

    #[test]
    fn unknown_but_human_readable_core_errors_stay_visible() {
        let copy = builtin_copy();
        // Core 已经给出中文可执行提示：不能用一个通用标题把它盖掉。
        let (title, message, detail) =
            friendly_error(&copy, "SOME_NEW_CODE: 请先在设置中配置服务商后再试");
        assert_eq!(title, "处理失败");
        assert!(message.contains("请先在设置中配置服务商"));
        assert!(detail.unwrap().contains("SOME_NEW_CODE"));
        // 纯技术串才回落到通用文案，且原文只出现在 detail。
        let (title, message, detail) = friendly_error(&copy, "ECONNRESET socket hang up");
        assert_eq!(title, "暂时无法完成");
        assert!(!message.contains("ECONNRESET"));
        assert!(detail.unwrap().contains("ECONNRESET"));
    }
}
