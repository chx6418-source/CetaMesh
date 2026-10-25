//! WebView2 presentation host. Core, IPC, installation and lifecycle stay in the existing shell.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::windows::WindowExtWindows;
use tao::window::{Icon, Window, WindowBuilder, ResizeDirection};
use wry::http::{Request, Response};
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows};

use crate::desktop_paths::DesktopPaths;
use crate::ipc_client::IpcClient;
use crate::native_ui::CoreApi;
use crate::supervisor::{Status, StatusListener, Supervisor};
use crate::tray::{TrayCommand, TrayHandle, TrayStatus};
use crate::ui_prefs::{self, CloseBehavior, UiPrefs};
use crate::webview_policy::{self, APP_ORIGIN, BridgeRequest, PRODUCTION_CSP, WindowAction};

enum UiEvent {
    ReferenceRequest { id: String, method: String, params: Value },
    ReferenceEvent(Value),
    Wake,
    WindowAction { id: String, action: WindowAction },
    CoreStatus(Status),
    WindowBehavior { confirm_on_exit: bool },
    Reply { id: String, result: Result<Value, String> },
}

fn resolve_bundle() -> Result<PathBuf, String> {
    let installed = crate::current_exe_dir().join("resources").join("desktop-ui");
    if installed.join("index.html").is_file() {
        return installed.canonicalize().map_err(|error| format!("读取 v2 UI 资源失败：{error}"));
    }
    if cfg!(debug_assertions) {
        let repo_root = std::env::var_os("WHALEBRIDGE_REPO_ROOT")
            .map(PathBuf::from)
            .or_else(|| crate::current_exe_dir().ancestors().nth(3).map(Path::to_path_buf));
        if let Some(root) = repo_root {
            let built = root.join("desktop-ui").join("dist");
            if built.join("index.html").is_file() {
                return built.canonicalize().map_err(|error| format!("读取 v2 UI 资源失败：{error}"));
            }
        }
    }
    Err("缺少本地 v2 UI bundle。请先运行 npm run build:ui，或以 --ui=legacy 启动。".to_owned())
}

fn mime_type(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|part| part.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn asset_response(root: &Path, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some(relative) = webview_policy::relative_asset_path(request.uri().path()) else {
        return response(403, "text/plain; charset=utf-8", b"Forbidden".to_vec());
    };
    let candidate = root.join(&relative);
    let Ok(canonical) = candidate.canonicalize() else {
        return response(404, "text/plain; charset=utf-8", b"Not found".to_vec());
    };
    if !canonical.starts_with(root) || !canonical.is_file() {
        return response(403, "text/plain; charset=utf-8", b"Forbidden".to_vec());
    }
    match fs::read(&canonical) {
        Ok(bytes) => response(200, mime_type(&relative), bytes),
        Err(_) => response(500, "text/plain; charset=utf-8", b"Asset unavailable".to_vec()),
    }
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", PRODUCTION_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(body))
        .expect("fixed local asset response headers are valid")
}

fn core_error_payload(error: &str) -> (String, String) {
    let (code, message) = error.strip_prefix("Core IPC ")
        .and_then(|value| value.split_once(": "))
        .filter(|(code, _)| !code.is_empty() && code.len() <= 64
            && code.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
        .map(|(code, message)| (code.to_owned(), message))
        .unwrap_or_else(|| ("CORE_IPC_ERROR".to_owned(), error));
    (code, sanitize_error_message(message))
}

fn sanitize_error_message(message: &str) -> String {
    let mut sanitized = String::new();
    for (index, token) in message.split_whitespace().enumerate() {
        if index > 0 { sanitized.push(' '); }
        let lower = token.to_ascii_lowercase();
        if lower.contains("sk-") || lower.starts_with("bearer")
            || lower.contains("api_key=") || lower.contains("apikey=") {
            sanitized.push_str("[REDACTED]");
        } else {
            sanitized.push_str(token);
        }
        if sanitized.len() >= 1000 {
            let mut boundary = 1000.min(sanitized.len());
            while !sanitized.is_char_boundary(boundary) { boundary -= 1; }
            sanitized.truncate(boundary);
            break;
        }
    }
    sanitized
}

fn send_reply(webview: &WebView, id: String, result: Result<Value, String>) {
    let payload = match result {
        Ok(value) => json!({ "id": id, "ok": true, "result": value }),
        Err(message) => {
            let (code, message) = core_error_payload(&message);
            json!({ "id": id, "ok": false, "error": { "code": code, "message": message } })
        }
    };
    if let Ok(encoded) = serde_json::to_string(&payload) {
        let _ = webview.evaluate_script(&format!("window.__cetameshReceive?.({encoded})"));
    }
}

fn send_status_event(webview: &WebView, status: &Status) {
    let payload = json!({ "event": "core.status", "data": { "ready": status.is_ready(), "needsAttention": status.needs_attention() } });
    if let Ok(encoded) = serde_json::to_string(&payload) {
        let _ = webview.evaluate_script(&format!("window.__cetameshEvent?.({encoded})"));
    }
}

fn dispatch_bridge(
    request: BridgeRequest,
    proxy: &tao::event_loop::EventLoopProxy<UiEvent>,
    supervisor: &Arc<Supervisor>,
    api: &Arc<IpcClient>,
) {
    let id = request.id;
    let method = request.method.clone();
    if method.starts_with("app.previewBrowser.") {
        let _ = proxy.send_event(UiEvent::ReferenceRequest { id, method, params: request.params });
        return;
    }
    match method.as_str() {
        "app.ping" => {
            let _ = proxy.send_event(UiEvent::Reply { id, result: Ok(json!({ "host": "webview2", "ready": true })) });
        }
        "app.status" => {
            let status = supervisor.status();
            let _ = proxy.send_event(UiEvent::Reply { id, result: Ok(json!({ "ready": status.is_ready(), "needsAttention": status.needs_attention() })) });
        }
        "app.openExternal" => {
            let url = request.params["url"].as_str().unwrap_or_default();
            let result = crate::external_link::open_in_default_browser(url)
                .map(|_| json!({ "opened": true }))
                .map_err(|_| "无法打开外部链接，请稍后再试。".to_owned());
            let _ = proxy.send_event(UiEvent::Reply { id, result });
        }
        "app.openArtifact" => {
            let task_id = request.params["taskId"].as_str().unwrap_or_default().to_owned();
            let artifact_id = request.params["artifactId"].as_str().unwrap_or_default().to_owned();
            let api = Arc::clone(api);
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let result = api.request("task.artifact.resolveOpen", json!({
                    "taskId": task_id,
                    "artifactId": artifact_id
                })).map_err(|_| "此交付物当前不可用。".to_owned())
                    .and_then(|authorized| {
                        let canonical_path = authorized["canonicalPath"].as_str()
                            .ok_or_else(|| "Core 未返回有效的本地 Artifact 路径。".to_owned())?;
                        let extension = authorized["extension"].as_str()
                            .ok_or_else(|| "Core 未返回有效的 Artifact 类型。".to_owned())?;
                        crate::external_link::open_artifact(canonical_path, extension)
                            .map(|_| json!({ "opened": true }))
                            .map_err(|_| "无法安全打开此交付物。".to_owned())
                    });
                let _ = proxy.send_event(UiEvent::Reply { id, result });
            });
        }
        "app.about" => {
            let api = Arc::clone(api);
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let result = api.request("ui.about.info", json!({}))
                    .map_err(|error| error);
                let _ = proxy.send_event(UiEvent::Reply { id, result });
            });
        }
        "app.pickFolder" => {
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let path = rfd::FileDialog::new().pick_folder().map(|path| path.to_string_lossy().into_owned());
                let _ = proxy.send_event(UiEvent::Reply { id, result: Ok(json!({ "path": path })) });
            });
        }
        "app.pickFiles" => {
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let result = pick_text_attachments()
                    .map(|attachments| json!({ "attachments": attachments }))
                    .map_err(|_| "所选附件无法读取，请选择不超过 256 KiB 的文本或源码文件。".to_owned());
                let _ = proxy.send_event(UiEvent::Reply { id, result });
            });
        }
        "app.pickExtensionPackage" => {
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let path = rfd::FileDialog::new()
                    .set_title("选择本地扩展包")
                    .add_filter("CetaMesh 扩展包", &["zip", "cmpkg"])
                    .pick_file()
                    .map(|path| path.to_string_lossy().into_owned());
                let _ = proxy.send_event(UiEvent::Reply { id, result: Ok(json!({ "path": path })) });
            });
        }
        "app.windowAction" => {
            match webview_policy::window_action(&request.params) {
                Ok(action) => { let _ = proxy.send_event(UiEvent::WindowAction { id, action }); }
                Err(error) => { let _ = proxy.send_event(UiEvent::Reply { id, result: Err(error) }); }
            }
        }
        "app.setWindowBehavior" => {
            let result = match request.params["confirmOnExit"].as_bool() {
                Some(confirm_on_exit) => proxy.send_event(UiEvent::WindowBehavior { confirm_on_exit })
                    .map(|_| json!({ "updated": true }))
                    .map_err(|_| "无法更新桌面窗口偏好。".to_owned()),
                None => Err("窗口偏好格式无效。".to_owned()),
            };
            let _ = proxy.send_event(UiEvent::Reply { id, result });
        }
        method if method.starts_with("ui.") => {
            let method = request.method;
            let params = request.params;
            let api = Arc::clone(api);
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let result = api.request(&method, params)
                    .map_err(|error| error);
                let _ = proxy.send_event(UiEvent::Reply { id, result });
            });
        }
        _ => {} // parse_bridge_request has already rejected every other method.
    }
}

fn pick_text_attachments() -> Result<Vec<Value>, String> {
    const MAX_FILES: usize = 8;
    const MAX_FILE_BYTES: u64 = 128 * 1024;
    const MAX_TOTAL_BYTES: u64 = 128 * 1024;
    let extensions = ["txt", "md", "json", "rs", "js", "ts", "tsx", "jsx", "html", "css", "toml", "yaml", "yml", "csv", "xml", "log", "py", "sh", "ps1", "sql", "diff", "patch"];
    let Some(paths) = rfd::FileDialog::new().add_filter("文本与源码", &extensions).pick_files() else {
        return Ok(Vec::new());
    };
    if paths.len() > MAX_FILES { return Err("too many files".to_owned()); }
    let mut attachments = Vec::with_capacity(paths.len());
    let mut total_bytes = 0_u64;
    for path in paths {
        let selected_extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if !extensions.contains(&selected_extension.as_str()) {
            return Err("仅支持文本和源码附件；图片与富媒体尚不可发送给模型".to_owned());
        }
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_FILE_BYTES { return Err("attachment exceeds file size limit".to_owned()); }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_TOTAL_BYTES { return Err("selected attachments exceed the total size limit".to_owned()); }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let content = String::from_utf8(bytes).map_err(|error| error.to_string())?;
        let name = path.file_name().and_then(|value| value.to_str()).ok_or("invalid attachment file name")?;
        attachments.push(json!({ "name": name, "content": content, "mimeType": "text/plain" }));
    }
    Ok(attachments)
}

fn confirm_quit(confirm: bool) -> bool {
    if !confirm { return true; }
    rfd::MessageDialog::new()
        .set_title("退出 CetaMesh")
        .set_description("退出将停止 Core 和运行中的任务。确定退出吗？")
        .set_buttons(rfd::MessageButtons::YesNo)
        .show() == rfd::MessageDialogResult::Yes
}

fn capture_window_geometry(window: &Window) -> Option<ui_prefs::WindowGeometry> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size();
    let scale = window.scale_factor() as f32;
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    ui_prefs::sanitize_geometry(
        position.x as f32 / scale,
        position.y as f32 / scale,
        size.width as f32 / scale,
        size.height as f32 / scale,
        window.is_maximized(),
    )
}

fn sync_window_geometry(window: &Window, prefs: &mut UiPrefs) -> bool {
    let Some(geometry) = capture_window_geometry(window) else {
        return false;
    };
    if prefs.geometry == Some(geometry) {
        return false;
    }
    prefs.geometry = Some(geometry);
    true
}

fn save_ui_prefs(data_dir: &Path, prefs: &UiPrefs) {
    if let Err(error) = prefs.save(data_dir) {
        crate::supervisor::write_shell_log(data_dir, &format!("[ui-prefs] {error}"));
    }
}

fn log_applied_zoom(data_dir: &Path, zoom: f32) {
    crate::supervisor::write_shell_log(
        data_dir,
        &format!("[ui] 界面缩放已应用：{}%", (zoom * 100.0).round() as i32),
    );
}

pub fn run_webview_ui(paths: DesktopPaths, dev_url: Option<String>) -> Result<(), String> {
    wry::webview_version().map_err(|_| {
        "缺少 Microsoft Edge WebView2 Runtime。请从 Microsoft 官方页面手动安装：https://developer.microsoft.com/en-us/microsoft-edge/webview2/ 。或以 --ui=legacy 启动。".to_owned()
    })?;
    let asset_root = if dev_url.is_some() { None } else { Some(resolve_bundle()?) };
    let event_loop = EventLoopBuilder::<UiEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let status_proxy = proxy.clone();
    let status_listener: StatusListener = Arc::new(move |status| {
        let _ = status_proxy.send_event(UiEvent::CoreStatus(status));
    });
    let (supervisor, pipe, _) = crate::start_supervisor_with_listener(&paths, Some(status_listener))?;
    let supervisor = Arc::new(supervisor);
    let api = Arc::new(IpcClient::new(pipe));
    let startup_settings = api.request("ui.settings.get", json!({})).ok().unwrap_or(Value::Null);
    let general_settings = &startup_settings["settings"]["general"];
    let start_minimized = general_settings["startMinimized"].as_bool().unwrap_or(false);
    let mut confirm_on_exit = general_settings["confirmOnExit"].as_bool().unwrap_or(true);
    let (mut prefs, prefs_warning) = UiPrefs::load(&paths.data_dir);
    if let Some(warning) = prefs_warning {
        crate::supervisor::write_shell_log(&paths.data_dir, &format!("[ui-prefs] {warning}"));
    }

    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../icons/128x128.png"))
        .ok()
        .and_then(|data| Icon::from_rgba(data.rgba, data.width, data.height).ok());
    let mut window_builder = WindowBuilder::new()
        .with_title("CetaMesh")
        .with_decorations(false)
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .with_visible(!start_minimized)
        .with_window_icon(icon);
    if let Some(geometry) = prefs.geometry {
        window_builder = window_builder
            .with_inner_size(LogicalSize::new(geometry.width as f64, geometry.height as f64))
            .with_position(LogicalPosition::new(geometry.x as f64, geometry.y as f64))
            .with_maximized(geometry.maximized);
        crate::supervisor::write_shell_log(
            &paths.data_dir,
            &format!(
                "[ui] 窗口几何已恢复：{:.0}x{:.0} @ ({:.0},{:.0}){}",
                geometry.width,
                geometry.height,
                geometry.x,
                geometry.y,
                if geometry.maximized { "（最大化）" } else { "" }
            ),
        );
    } else {
        crate::supervisor::write_shell_log(
            &paths.data_dir,
            "[ui] 窗口几何：使用默认 1280x800，运行时保存偏好",
        );
    }
    let window = window_builder
        .build(&event_loop)
        .map_err(|error| format!("无法创建 CetaMesh v2 窗口：{error}"))?;
    sync_window_geometry(&window, &mut prefs);
    save_ui_prefs(&paths.data_dir, &prefs);

    let wake_proxy = proxy.clone();
    let wake = Arc::new(move || { let _ = wake_proxy.send_event(UiEvent::Wake); });
    let tray = TrayHandle::new(Arc::clone(&supervisor), paths.data_dir.clone(), wake)
        .map_err(|error| {
            crate::supervisor::write_shell_log(&paths.data_dir, &format!("[tray] {error}"));
            error
        })
        .ok();
    if let Some(tray) = &tray { tray.attach_window(window.hwnd()); }
    if start_minimized && tray.is_none() { window.set_visible(true); }

    let source_dev = dev_url.clone();
    let navigation_dev = dev_url.clone();
    let bridge_proxy = proxy.clone();
    let bridge_supervisor = Arc::clone(&supervisor);
    let bridge_api = Arc::clone(&api);
    let start_url = dev_url
        .clone()
        .unwrap_or_else(|| APP_ORIGIN.to_owned());
    // Keep the mutable WebView2 profile out of the installed, read-only program directory.
    let webview_data_dir = paths.data_dir.join("webview2");
    fs::create_dir_all(&webview_data_dir)
        .map_err(|error| format!("创建 WebView2 用户数据目录失败 {}：{error}", webview_data_dir.display()))?;
    let mut web_context = WebContext::new(Some(webview_data_dir));
    let builder = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(start_url)
        .with_devtools(cfg!(debug_assertions))
        .with_clipboard(true)
        .with_navigation_handler(move |url| webview_policy::navigation_allowed(&url, navigation_dev.as_deref()))
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_ipc_handler(move |message| {
            if !webview_policy::trusted_message_source(&message.uri().to_string(), source_dev.as_deref()) {
                return;
            }
            if let Ok(request) = webview_policy::parse_bridge_request(message.body()) {
                dispatch_bridge(request, &bridge_proxy, &bridge_supervisor, &bridge_api);
            }
        });
    let builder = if let Some(root) = asset_root {
        builder
            .with_custom_protocol("cetamesh".to_owned(), move |_, request| asset_response(&root, request))
            .with_https_scheme(true)
    } else {
        builder
    };
    let webview = crate::main_webview::build(builder, &window)
        .map_err(|error| format!("WebView2 启动失败：{error}。可尝试 --ui=legacy。"))?;
    match webview.zoom(f64::from(prefs.zoom)) {
        Ok(()) => log_applied_zoom(&paths.data_dir, prefs.zoom),
        Err(error) => crate::supervisor::write_shell_log(
            &paths.data_dir,
            &format!("[ui-prefs] 应用 WebView2 缩放失败：{error}"),
        ),
    }
    crate::supervisor::write_shell_log(&paths.data_dir, &format!("[ui-v2] WebView2 ready, origin={APP_ORIGIN}"));

    let prefs_data_dir = paths.data_dir.clone();
    let mut next_prefs_sync = Instant::now() + Duration::from_secs(2);
    let mut reference_browser: Option<crate::reference_browser::ReferenceBrowser> = None;
    let reference_profile = paths.data_dir.join("reference-webview2");
    let reference_proxy = proxy.clone();
    let mut reference_generation = 0u64;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(next_prefs_sync);
        match event {
            Event::UserEvent(UiEvent::ReferenceRequest { id, method, params }) => {
                let target = params["targetId"].as_str().unwrap_or_default();
                let result = if method.ends_with(".open") {
                    reference_browser.take();
                    reference_generation += 1;
                    let generation = reference_generation;
                    let callback = reference_proxy.clone();
                    let notify = std::rc::Rc::new(move |mut data: Value| { data["generation"] = Value::from(generation); let _ = callback.send_event(UiEvent::ReferenceEvent(data)); });
                    crate::reference_browser::ReferenceBrowser::new(&window, &reference_profile, target.to_owned(), params["url"].as_str().unwrap_or_default().to_owned(), &params["bounds"], notify)
                        .map(|browser| { reference_browser = Some(browser); json!({"opened":true}) })
                } else if method.ends_with(".command") && params["action"] == "close" {
                    if reference_browser.as_ref().is_some_and(|browser| browser.id == target) { reference_browser.take(); }
                    Ok(json!({"updated":true}))
                } else if let Some(browser) = reference_browser.as_ref().filter(|browser| browser.id == target) {
                    if method.ends_with(".layout") { browser.layout(&window, &params["bounds"], params["visible"].as_bool().unwrap_or(false)) }
                    else { browser.command(params["action"].as_str().unwrap_or_default()) }.map(|()| json!({"updated":true}))
                } else { Err("此网页标签已关闭。".into()) };
                send_reply(&webview, id, result);
            }
            Event::UserEvent(UiEvent::ReferenceEvent(data)) => {
                if data["generation"] == reference_generation && reference_browser.as_ref().is_some_and(|browser| data["targetId"] == browser.id) {
                    if data["initialized"] == true { if let Some(browser) = &reference_browser { browser.reapply_visibility(); } }
                    if data["focusRequested"] == true { let _ = webview.focus(); }
                    if let Ok(encoded) = serde_json::to_string(&json!({"event":"preview.browser","data":data})) { let _ = webview.evaluate_script(&format!("window.__cetameshEvent?.({encoded})")); }
                }
            }
            Event::UserEvent(UiEvent::WindowAction { id, action }) => {
                if matches!(action, WindowAction::Minimize | WindowAction::Close) { if let Some(browser) = &reference_browser { browser.hide(); } }
                let result = match action {
                    WindowAction::State => Ok(()),
                    WindowAction::Drag => window.drag_window().map_err(|error| error.to_string()),
                    WindowAction::Minimize => { window.set_minimized(true); Ok(()) }
                    WindowAction::Maximize => { window.set_maximized(!window.is_maximized()); Ok(()) }
                    // WM_CLOSE reuses CloseRequested, including hide-to-tray and Owner exit confirmation.
                    WindowAction::Close => unsafe {
                        use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
                        if PostMessageW(window.hwnd() as _, WM_CLOSE, 0, 0) != 0 { Ok(()) }
                        else { Err("无法请求关闭窗口。".to_owned()) }
                    },
                    edge => {
                        let direction = match edge {
                            WindowAction::ResizeNorth => ResizeDirection::North,
                            WindowAction::ResizeNorthEast => ResizeDirection::NorthEast,
                            WindowAction::ResizeEast => ResizeDirection::East,
                            WindowAction::ResizeSouthEast => ResizeDirection::SouthEast,
                            WindowAction::ResizeSouth => ResizeDirection::South,
                            WindowAction::ResizeSouthWest => ResizeDirection::SouthWest,
                            WindowAction::ResizeWest => ResizeDirection::West,
                            WindowAction::ResizeNorthWest => ResizeDirection::NorthWest,
                            _ => unreachable!("non-resize actions handled above"),
                        };
                        window.drag_resize_window(direction).map_err(|error| error.to_string())
                    }
                }.map(|()| json!({ "maximized": window.is_maximized() }));
                send_reply(&webview, id, result);
            }
            Event::UserEvent(UiEvent::Reply { id, result }) => send_reply(&webview, id, result),
            Event::UserEvent(UiEvent::WindowBehavior { confirm_on_exit: value }) => confirm_on_exit = value,
            Event::UserEvent(UiEvent::CoreStatus(status)) => {
                send_status_event(&webview, &status);
                if let Some(tray) = &tray {
                    tray.update_status(&TrayStatus {
                        core: status.summary(),
                        attention: status.needs_attention().then(|| "Core 需要处理".to_owned()),
                    });
                }
            }
            Event::UserEvent(UiEvent::Wake) => {
                if let Some(tray) = &tray {
                    for command in tray.poll() {
                        match command {
                            TrayCommand::ShowWindow => { window.set_visible(true); window.set_focus(); tray.set_window_visible(true); }
                            TrayCommand::HideWindow => { window.set_visible(false); tray.set_window_visible(false); }
                            TrayCommand::RestartCore => supervisor.request_restart(),
                            TrayCommand::ExitRequested | TrayCommand::ExitRequestedByInstaller => {
                                if confirm_quit(confirm_on_exit) {
                                    sync_window_geometry(&window, &mut prefs);
                                    save_ui_prefs(&prefs_data_dir, &prefs);
                                    supervisor.shutdown();
                                    *control_flow = ControlFlow::Exit;
                                }
                            }
                        }
                    }
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if let Some(browser) = &reference_browser { browser.hide(); }
                sync_window_geometry(&window, &mut prefs);
                save_ui_prefs(&prefs_data_dir, &prefs);
                if prefs.close_behavior == CloseBehavior::HideToTray {
                    if let Some(tray) = &tray {
                        window.set_visible(false);
                        tray.set_window_visible(false);
                        crate::supervisor::write_shell_log(
                            &prefs_data_dir,
                            "[ui] 主窗口已隐藏到托盘；Core 与任务继续运行",
                        );
                    } else if confirm_quit(confirm_on_exit) {
                        supervisor.shutdown();
                        *control_flow = ControlFlow::Exit;
                    }
                } else if confirm_quit(confirm_on_exit) {
                    supervisor.shutdown();
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::WindowEvent { event: WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. }, .. } => {
                sync_window_geometry(&window, &mut prefs);
                if let Err(error) = crate::main_webview::resized(&webview, &window) {
                    crate::supervisor::write_shell_log(&paths.data_dir, &format!("[ui-v2] 同步主视图尺寸失败：{error}"));
                }
            }
            Event::WindowEvent { event: WindowEvent::Focused(true), .. } => {
                // Child views do not install Wry's parent focus forwarding hook.
                let _ = webview.focus();
            }
            Event::MainEventsCleared => {
                if window.is_visible() && !window.is_minimized() { if let Some(browser) = &reference_browser { browser.resume(); } }
                if Instant::now() >= next_prefs_sync {
                    if sync_window_geometry(&window, &mut prefs) {
                        save_ui_prefs(&prefs_data_dir, &prefs);
                    }
                    next_prefs_sync = Instant::now() + Duration::from_secs(2);
                }
            }
            Event::LoopDestroyed => {
                sync_window_geometry(&window, &mut prefs);
                save_ui_prefs(&prefs_data_dir, &prefs);
                supervisor.shutdown();
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::core_error_payload;

    #[test]
    fn core_reply_keeps_stable_error_code_and_redacts_secret_material() {
        assert_eq!(
            core_error_payload("Core IPC SETTINGS_CONFLICT: stale revision sk-live-example-token"),
            ("SETTINGS_CONFLICT".to_owned(), "stale revision [REDACTED]".to_owned())
        );
        assert_eq!(
            core_error_payload("connect to Core pipe: unavailable"),
            ("CORE_IPC_ERROR".to_owned(), "connect to Core pipe: unavailable".to_owned())
        );
    }

    #[test]
    fn long_unicode_errors_are_truncated_at_a_utf8_boundary() {
        let message = "界".repeat(1001);
        let (_, sanitized) = core_error_payload(&format!("Core IPC PROVIDER_ERROR: {message}"));
        assert!(sanitized.len() <= 1000);
        assert!(sanitized.chars().all(|character| character == '界'));
    }
}
