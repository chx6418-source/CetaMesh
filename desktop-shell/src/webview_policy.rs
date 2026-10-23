//! Policy at the WebView2 presentation boundary.

use serde_json::Value;
use url::Url;

pub const APP_ORIGIN: &str = "https://cetamesh.localhost";
pub const DEV_ORIGIN: &str = "http://127.0.0.1:5173";
pub const MAX_BRIDGE_REQUEST_BYTES: usize = 900 * 1024;
pub const PRODUCTION_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const UI_METHODS: &[&str] = &[
    "ui.preview.open", "ui.preview.read", "ui.preview.close",
    "ui.events.next",
    "ui.chat.sessions.list", "ui.chat.sessions.create", "ui.chat.sessions.rename",
    "ui.chat.sessions.archive", "ui.chat.sessions.delete", "ui.chat.history", "ui.chat.status",
    "ui.chat.send", "ui.chat.stop", "ui.chat.retry", "ui.chat.continue", "ui.chat.catalog", "ui.chat.config.set",
    "ui.task.overview", "ui.task.get", "ui.task.create", "ui.task.start", "ui.task.pause", "ui.task.resume", "ui.task.reconcile", "ui.task.cancel", "ui.task.handoff",
    "ui.workshop.proposals", "ui.workshop.proposal", "ui.workshop.review", "ui.workshop.retry", "ui.workshop.task.status", "ui.workshop.deliver",
    "ui.workspace.list", "ui.workspace.open", "ui.workspace.create",
    "ui.memory.overview", "ui.memory.get", "ui.memory.create", "ui.memory.update", "ui.memory.pin", "ui.memory.delete",
    "ui.memory.candidates.confirm", "ui.memory.candidates.confirmBatch",
    "ui.agent.security", "ui.agent.authorize", "ui.agent.list", "ui.agent.health", "ui.agent.configure", "ui.agent.presets",
    "ui.extensions.settings.describe", "ui.extensions.settings.get", "ui.extensions.settings.update",
    "ui.plugins.catalog", "ui.plugins.status", "ui.plugins.detail", "ui.plugins.refresh", "ui.plugins.stage", "ui.plugins.stage-local", "ui.plugins.enable.review",
    "ui.plugins.install", "ui.plugins.enable", "ui.plugins.disable", "ui.plugins.uninstall",
    "ui.plugins.integration.list", "ui.plugins.integration.settings", "ui.plugins.integration.manage", "ui.plugins.integration.action", "ui.plugins.integration.tool.toggle",
    "ui.mcp.list", "ui.mcp.tools", "ui.mcp.manage", "ui.mcp.config.get", "ui.mcp.config.update",
    "ui.settings.describe", "ui.settings.get", "ui.settings.update",
    "ui.about.info", "ui.feedback.links", "ui.about.update", "ui.update.capabilities", "ui.update.check", "ui.update.notes",
    "ui.onboarding.status", "ui.onboarding.start", "ui.onboarding.completeStep", "ui.onboarding.skipStep",
    "ui.onboarding.finish", "ui.onboarding.testProvider", "ui.onboarding.setModel",
    "ui.approvals.list", "ui.approvals.decide", "ui.approvals.operation", "ui.approvals.cancel", "ui.search"
];

fn is_allowed_method(method: &str) -> bool {
    matches!(method, "app.previewBrowser.open" | "app.previewBrowser.layout" | "app.previewBrowser.command" | "app.windowAction" | "app.ping" | "app.about" | "app.status" | "app.openExternal" | "app.openArtifact" | "app.pickFolder" | "app.pickFiles" | "app.pickExtensionPackage" | "app.setWindowBehavior")
        || UI_METHODS.contains(&method)
}

fn validate_artifact_open_params(params: &Value) -> Result<(), String> {
    let object = params.as_object().ok_or("artifact open params must be an object")?;
    if object.len() != 2 || !object.contains_key("taskId") || !object.contains_key("artifactId") {
        return Err("artifact open requires only taskId and artifactId".to_owned());
    }
    for field in ["taskId", "artifactId"] {
        let value = object.get(field).and_then(Value::as_str)
            .ok_or("artifact identity must be a string")?;
        if value.is_empty() || value.len() > 128
            || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-'))
        {
            return Err("artifact identity is invalid".to_owned());
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub enum WindowAction { State, Drag, Minimize, Maximize, Close, ResizeNorth, ResizeNorthEast, ResizeEast, ResizeSouthEast, ResizeSouth, ResizeSouthWest, ResizeWest, ResizeNorthWest }

pub fn window_action(params: &Value) -> Result<WindowAction, String> {
    let object = params.as_object().ok_or("window action must be an object")?;
    if object.len() != 1 { return Err("window action requires only action".to_owned()); }
    match object.get("action").and_then(Value::as_str) {
        Some("state") => Ok(WindowAction::State),
        Some("drag") => Ok(WindowAction::Drag),
        Some("minimize") => Ok(WindowAction::Minimize),
        Some("maximize") => Ok(WindowAction::Maximize),
        Some("close") => Ok(WindowAction::Close),
        Some("resizeNorth") => Ok(WindowAction::ResizeNorth),
        Some("resizeNorthEast") => Ok(WindowAction::ResizeNorthEast),
        Some("resizeEast") => Ok(WindowAction::ResizeEast),
        Some("resizeSouthEast") => Ok(WindowAction::ResizeSouthEast),
        Some("resizeSouth") => Ok(WindowAction::ResizeSouth),
        Some("resizeSouthWest") => Ok(WindowAction::ResizeSouthWest),
        Some("resizeWest") => Ok(WindowAction::ResizeWest),
        Some("resizeNorthWest") => Ok(WindowAction::ResizeNorthWest),
        _ => Err("invalid window action".to_owned()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiMode { Legacy, V2 }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiSelection {
    pub mode: UiMode,
    pub dev_url: Option<String>,
}

pub fn select_ui(args: &[String], debug_build: bool) -> Result<UiSelection, String> {
    let mut mode = UiMode::V2;
    let mut seen_mode = false;
    let mut dev_url = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mode_value = if arg == "--ui" { Some(iter.next().ok_or("--ui requires a value")?.as_str()) } else { arg.strip_prefix("--ui=") };
        if let Some(value) = mode_value {
            if seen_mode { return Err("--ui may be specified only once".to_owned()); }
            mode = match value {
                "legacy" => UiMode::Legacy,
                "v2" => UiMode::V2,
                _ => return Err("--ui must be legacy or v2".to_owned()),
            };
            seen_mode = true;
            continue;
        }
        let dev_value = if arg == "--dev-ui-url" { Some(iter.next().ok_or("--dev-ui-url requires a value")?.as_str()) } else { arg.strip_prefix("--dev-ui-url=") };
        if let Some(value) = dev_value {
            if dev_url.is_some() || value != DEV_ORIGIN || !debug_build {
                return Err("development UI URL is allowed only once in a debug build at 127.0.0.1:5173".to_owned());
            }
            dev_url = Some(value.to_owned());
        }
    }
    if dev_url.is_some() && mode != UiMode::V2 {
        return Err("--dev-ui-url requires --ui=v2".to_owned());
    }
    Ok(UiSelection { mode, dev_url })
}

pub fn project_about(core_value: &Value) -> Value {
    let about = &core_value["about"];
    let field = |value: &Value| value.as_str().map(|text| text.chars().take(256).collect::<String>());
    serde_json::json!({
        "version": field(&about["version"]),
        "buildId": field(&about["build"]["buildId"]).or_else(|| field(&about["buildId"])),
        "developer": field(&about["developer"]["name"]),
        "website": field(&about["links"]["website"]).or_else(|| field(&about["website"])),
        "gitcode": field(&about["links"]["gitcode"]),
        "github": field(&about["links"]["github"]),
    })
}

#[derive(Debug, PartialEq)]
pub struct BridgeRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
}

fn is_same_origin(candidate: &str, origin: &str) -> bool {
    let (Ok(url), Ok(expected)) = (Url::parse(candidate), Url::parse(origin)) else {
        return false;
    };
    url.scheme() == expected.scheme()
        && url.host_str() == expected.host_str()
        && url.port_or_known_default() == expected.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn navigation_allowed(url: &str, dev_origin: Option<&str>) -> bool {
    is_same_origin(url, APP_ORIGIN)
        || dev_origin.is_some_and(|origin| origin == DEV_ORIGIN && is_same_origin(url, origin))
}

pub fn trusted_message_source(url: &str, dev_origin: Option<&str>) -> bool {
    navigation_allowed(url, dev_origin)
}

pub fn relative_asset_path(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['\\', '%', ':', '\0']) {
        return None;
    }
    let relative = &path[1..];
    if relative.is_empty() {
        return Some("index.html".to_owned());
    }
    let segments: Vec<&str> = relative.split('/').collect();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || !segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    }) {
        return None;
    }
    if segments[0] == "design"
        && segments.len() >= 2
        && matches!(segments[1], "01" | "02" | "03" | "04" | "05")
    {
        return Some("index.html".to_owned());
    }
    if relative == "index.html" || relative == "favicon.svg" || (segments[0] == "assets" && segments.len() >= 2) {
        return Some(relative.to_owned());
    }
    None
}

pub fn parse_bridge_request(raw: &str) -> Result<BridgeRequest, String> {
    if raw.len() > MAX_BRIDGE_REQUEST_BYTES {
        return Err("bridge request is too large".to_owned());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "bridge request is not valid JSON".to_owned())?;
    let object = value.as_object().ok_or("bridge request must be an object")?;
    if object.len() != 3 || !object.contains_key("id") || !object.contains_key("method") || !object.contains_key("params") {
        return Err("bridge request has unknown or missing fields".to_owned());
    }
    let id = object.get("id").and_then(Value::as_str).ok_or("bridge request id must be a string")?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("bridge request id is invalid".to_owned());
    }
    let method = object.get("method").and_then(Value::as_str).ok_or("bridge method must be a string")?;
    if !is_allowed_method(method) {
        return Err("bridge method is not allowed".to_owned());
    }
    let params = object.get("params").ok_or("bridge params are required")?;
    let params_object = params.as_object().ok_or("bridge params must be an object")?;
    if method.starts_with("app.previewBrowser.") {
        crate::reference_browser_policy::validate(method, params)?;
    } else if method == "app.windowAction" {
        window_action(params)?;
    } else if method == "app.openExternal" {
        if params_object.len() != 1 || params_object.get("url").and_then(Value::as_str).is_none_or(|url| url.len() > 2048) {
            return Err("external link requires one bounded URL".to_owned());
        }
    } else if method == "app.openArtifact" {
        validate_artifact_open_params(params)?;
    } else if method.starts_with("app.") && !params_object.is_empty() {
        return Err("this bridge method takes no parameters".to_owned());
    }
    Ok(BridgeRequest { id: id.to_owned(), method: method.to_owned(), params: params.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_browser_bridge_accepts_only_scoped_operations() {
        let request = serde_json::json!({"id":"preview1","method":"app.previewBrowser.open","params":{"targetId":"preview-1","url":"https://example.com","bounds":{"x":800,"y":100,"width":400,"height":600,"scale":1}}});
        assert!(parse_bridge_request(&request.to_string()).is_ok());
        let mut bad = request; bad["params"]["url"] = Value::String("https://127.0.0.1".into());
        assert!(parse_bridge_request(&bad.to_string()).is_err());
    }

    #[test]
    fn window_actions_accept_only_local_window_operations() {
        for action in ["state", "drag", "minimize", "maximize", "close", "resizeNorth", "resizeNorthEast", "resizeEast", "resizeSouthEast", "resizeSouth", "resizeSouthWest", "resizeWest", "resizeNorthWest"] {
            let request = serde_json::json!({"id":"chrome", "method":"app.windowAction", "params":{"action":action}});
            assert!(parse_bridge_request(&request.to_string()).is_ok(), "{action}");
        }
        for params in [serde_json::json!({}), serde_json::json!({"action":"exitProcess"}), serde_json::json!({"action":"close", "pid":123}), serde_json::json!({"action":"drag", "path":"C:/"}), serde_json::json!({"action":true})] {
            let request = serde_json::json!({"id":"chrome", "method":"app.windowAction", "params":params});
            assert!(parse_bridge_request(&request.to_string()).is_err());
        }
    }

    #[test]
    fn owner_review_methods_are_explicit_and_unknown_privileged_methods_stay_denied() {
        for method in ["ui.task.reconcile", "ui.memory.candidates.confirm", "ui.memory.candidates.confirmBatch",
            "ui.extensions.settings.describe", "ui.extensions.settings.get", "ui.extensions.settings.update"] {
            let body = serde_json::json!({"id":"owner-review-1","method":method,"params":{}}).to_string();
            assert!(parse_bridge_request(&body).is_ok(), "registered Owner UI method: {method}");
        }
        for method in ["memory.candidates.confirmBatch", "ui.task.releaseLock", "ui.memory.exportAll"] {
            let body = serde_json::json!({"id":"denied-1","method":method,"params":{}}).to_string();
            assert!(parse_bridge_request(&body).is_err(), "unregistered authority must remain denied: {method}");
        }
    }

    #[test]
    fn packaged_origin_allows_its_routes_and_blocks_lookalikes() {
        assert!(navigation_allowed("https://cetamesh.localhost/design/01", None));
        assert!(!navigation_allowed("https://cetamesh.localhost.evil.test/", None));
        assert!(!navigation_allowed("https://cetamesh.localhost@evil.test/", None));
        assert!(!navigation_allowed("https://example.org/", None));
        assert!(!navigation_allowed("cetamesh://localhost/", None));
        assert!(!navigation_allowed("file:///C:/secrets", None));
    }

    #[test]
    fn bridge_request_limit_is_bounded_for_text_attachments_and_stays_below_core_frame_limit() {
        assert!(MAX_BRIDGE_REQUEST_BYTES < 1024 * 1024);
        let oversized = " ".repeat(MAX_BRIDGE_REQUEST_BYTES + 1);
        assert_eq!(parse_bridge_request(&oversized), Err("bridge request is too large".to_owned()));
    }

    #[test]
    fn explicit_dev_origin_is_the_only_dev_navigation() {
        assert!(navigation_allowed("http://127.0.0.1:5173/design/05", Some(DEV_ORIGIN)));
        assert!(!navigation_allowed("http://127.0.0.1:5174/", Some(DEV_ORIGIN)));
        assert!(!navigation_allowed("http://localhost:5173/", Some(DEV_ORIGIN)));
        assert!(!navigation_allowed("http://127.0.0.1:5173/", None));
    }

    #[test]
    fn bridge_source_uses_the_same_origin_gate() {
        assert!(trusted_message_source("https://cetamesh.localhost/design/02", None));
        assert!(!trusted_message_source("https://evil.test/", None));
        assert!(!trusted_message_source("http://127.0.0.1:5173/", None));
    }

    #[test]
    fn asset_resolution_blocks_traversal_and_remote_paths() {
        assert_eq!(relative_asset_path("/"), Some("index.html".to_owned()));
        assert_eq!(relative_asset_path("/design/03/plugins"), Some("index.html".to_owned()));
        assert_eq!(relative_asset_path("/assets/index-a1.js"), Some("assets/index-a1.js".to_owned()));
        for path in ["/../secret", "/assets/../secret", "/assets/%2e%2e/secret", "/assets/\\secret", "//evil.test/x"] {
            assert_eq!(relative_asset_path(path), None, "{path}");
        }
    }

    #[test]
    fn bridge_envelope_is_bounded_and_method_allowlisted() {
        let request = parse_bridge_request(r#"{"id":"r-1","method":"app.ping","params":{}}"#).unwrap();
        assert_eq!(request.id, "r-1");
        assert_eq!(request.method, "app.ping");
        assert!(parse_bridge_request(r#"{"id":"r-2","method":"control.execute","params":{}}"#).is_err());
        assert!(parse_bridge_request(r#"{"id":"r-3","method":"chat.send","params":{}}"#).is_err());
        assert!(parse_bridge_request(r#"{"id":"r-4","method":"ui.chat.send","params":{"id":"s","text":"hello"}}"#).is_ok());
        assert!(parse_bridge_request(r#"{"id":"r-5","method":"app.ping","params":[]}"#).is_err());
        assert!(parse_bridge_request(&"x".repeat(70_000)).is_err());
    }

    #[test]
    fn snowluma_integration_action_is_allowlisted_for_the_harbor_ui() {
        let request = parse_bridge_request(
            r#"{"id":"r-snow","method":"ui.plugins.integration.action","params":{"id":"snowluma","action":"start"}}"#,
        ).unwrap();
        assert_eq!(request.method, "ui.plugins.integration.action");
    }

    #[test]
    fn workshop_owner_review_is_allowlisted_without_raw_domain_or_actor_routes() {
        for method in ["ui.workshop.proposals", "ui.workshop.proposal", "ui.workshop.review",
            "ui.workshop.retry", "ui.workshop.task.status", "ui.workshop.deliver"] {
            let raw = format!(r#"{{"id":"r-workshop","method":"{method}","params":{{}}}}"#);
            assert!(parse_bridge_request(&raw).is_ok(), "missing Owner UI method: {method}");
        }
        for method in ["workshop.proposal.review", "workshop.proposal.submit", "ui.workshop.external.submit"] {
            let raw = format!(r#"{{"id":"r-workshop","method":"{method}","params":{{"actor":{{"kind":"owner"}}}}}}"#);
            assert!(parse_bridge_request(&raw).is_err(), "unsafe route accepted: {method}");
        }
    }

    #[test]
    fn artifact_open_bridge_accepts_only_bounded_task_and_artifact_identities() {
        let request = parse_bridge_request(
            r#"{"id":"r-open","method":"app.openArtifact","params":{"taskId":"task_123","artifactId":"art_456"}}"#,
        ).unwrap();
        assert_eq!(request.params["taskId"], "task_123");
        assert_eq!(request.params["artifactId"], "art_456");
        for raw in [
            r#"{"id":"r-open","method":"app.openArtifact","params":{"taskId":"task_123"}}"#,
            r#"{"id":"r-open","method":"app.openArtifact","params":{"taskId":"task_123","artifactId":"art_456","path":"C:/secret.txt"}}"#,
            r#"{"id":"r-open","method":"app.openArtifact","params":{"taskId":"../task","artifactId":"art_456"}}"#,
            r#"{"id":"r-open","method":"app.openArtifact","params":{"taskId":"task_123","artifactId":"https://example.test/file.pdf"}}"#,
        ] {
            assert!(parse_bridge_request(raw).is_err(), "accepted unsafe request: {raw}");
        }
        let oversized_id = format!(
            r#"{{"id":"r-open","method":"app.openArtifact","params":{{"taskId":"{}","artifactId":"art_456"}}}}"#,
            "t".repeat(129),
        );
        assert!(parse_bridge_request(&oversized_id).is_err());
    }

    #[test]
    fn ui_selection_defaults_to_harbor_and_keeps_legacy_opt_in() {
        assert_eq!(select_ui(&[], true).unwrap().mode, UiMode::V2);
        assert_eq!(select_ui(&["--ui=legacy".to_owned()], true).unwrap().mode, UiMode::Legacy);
        assert_eq!(select_ui(&["--ui=v2".to_owned()], true).unwrap().mode, UiMode::V2);
        let dev = select_ui(&["--ui=v2".to_owned(), "--dev-ui-url=http://127.0.0.1:5173".to_owned()], true).unwrap();
        assert_eq!(dev.dev_url.as_deref(), Some(DEV_ORIGIN));
        assert!(select_ui(&["--ui=v2".to_owned(), "--dev-ui-url=http://127.0.0.1:5173".to_owned()], false).is_err());
        assert!(select_ui(&["--ui=v2".to_owned(), "--dev-ui-url=https://evil.test".to_owned()], true).is_err());
    }

    #[test]
    fn about_projection_excludes_secret_and_internal_fields() {
        let input = serde_json::json!({"about": {"version": "1.0", "build": {"buildId": "v2"}, "developer": {"name": "CetaMesh"}, "links": {"website": "https://example.org"}, "consoleToken": "secret", "paths": {"data": "C:/private"}}});
        let view = project_about(&input);
        assert_eq!(view["version"], "1.0");
        assert_eq!(view["buildId"], "v2");
        assert!(view.get("consoleToken").is_none());
        assert!(view.get("paths").is_none());
    }

    #[test]
    fn production_csp_denies_eval_and_remote_connections() {
        assert!(PRODUCTION_CSP.contains("connect-src 'none'"));
        assert!(PRODUCTION_CSP.contains("frame-src 'none'"));
        assert!(!PRODUCTION_CSP.contains("unsafe-eval"));
        assert!(!PRODUCTION_CSP.contains("unsafe-inline"));
    }
}

