#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat_ui;
mod core_launch;
mod agent_ui;
mod app_shell;
mod integrations_ui;
mod desktop_paths;
mod external_link;
mod install_cli;
mod installer;
mod ipc_client;
mod migrate;
mod memory_ui;
mod task_ui;
mod workshop_ui;
mod mesh_ui;
mod workspace_ui;
mod native_installer_ui;
mod native_ui;
mod product_ui;
mod theme;
mod supervisor;
mod tray;
mod ui_prefs;
mod webview_policy;
#[cfg(windows)]
mod webview_ui;

use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_launch::{CoreLaunchSpec, ResolveOptions};
use desktop_paths::{DesktopPaths, probe_config, resolve_data_dir};
use eframe::egui;
use ipc_client::IpcClient;
use native_ui::{CoreApi, NativeUi};
use supervisor::{Status, StatusListener, Supervisor, SupervisorConfig};

fn current_exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_core(exe_dir: &Path) -> Result<CoreLaunchSpec, String> {
    let override_command = env::var("WHALEBRIDGE_CORE_EXE").ok();
    let override_mode = env::var("WHALEBRIDGE_CORE_MODE").ok();
    let repo_root = env::var("WHALEBRIDGE_REPO_ROOT").ok();
    core_launch::resolve_core_launch(ResolveOptions {
        exe_dir,
        override_command: override_command.as_deref(),
        override_mode: override_mode.as_deref(),
        repo_root: repo_root.as_deref(),
        data_dir: None,
        exists: &|candidate: &Path| candidate.exists(),
    })
}

fn resolve_paths(explicit_data_dir: Option<&str>) -> DesktopPaths {
    let exe_dir = current_exe_dir();
    let env_data_dir = env::var("WHALEBRIDGE_DATA_DIR").ok();
    let local_app_data = env::var("LOCALAPPDATA").ok().map(PathBuf::from);
    resolve_data_dir(
        explicit_data_dir,
        env_data_dir.as_deref(),
        &exe_dir,
        local_app_data.as_deref(),
        &|candidate: &Path| candidate.exists(),
    )
}

fn data_dir_from_args(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--data-dir" {
            return iter.next().cloned();
        }
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            return Some(value.to_owned());
        }
    }
    None
}

/// Shared by the native installer wizard when deciding whether this exe already lives in an install.
pub(crate) fn default_install_dir() -> PathBuf {
    let exe_dir = current_exe_dir();
    if installer::InstallManifest::read(&exe_dir).is_some() {
        return exe_dir;
    }
    // 2026-10 产品化：全新安装默认 per-user（免管理员 / 不触发 UAC），目录品牌为 CetaMesh；
    // 既有安装在升级时由注册表 InstallLocation / 安装清单发现并复用原位置。
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("Programs")
        .join("CetaMesh")
}

fn pipe_name() -> String {
    #[cfg(windows)]
    {
        // The owning GUI PID makes accidental collisions between parallel dev/test instances unlikely.
        format!(r"\\.\pipe\WhaleBridge-UI-{}", std::process::id())
    }
    #[cfg(not(windows))]
    {
        env::temp_dir()
            .join(format!("whalebridge-ui-{}.sock", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(windows)]
struct SingleInstance(Option<windows_sys::Win32::Foundation::HANDLE>);

#[cfg(windows)]
impl SingleInstance {
    fn acquire() -> Result<Option<Self>, String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};
        use windows_sys::Win32::System::Threading::{CreateEventW, CreateMutexW, SetEvent};

        let mutex_name = format!("Local\\WhaleBridge.Desktop{}", crate::tray::instance_suffix());
        let mut name: Vec<u16> = std::ffi::OsStr::new(&mutex_name).encode_wide().collect();
        name.push(0);
        // SAFETY: the name is a NUL-terminated UTF-16 string and null attributes select the
        // process token's default DACL. The returned handle remains owned by this guard.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "无法创建应用单实例锁：{}",
                std::io::Error::last_os_error()
            ));
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) };
            // A second launch is the user asking for the hidden window back. Signal the running
            // instance and exit; the tray listener restores the window from the system tray.
            let show_event = format!(
                "Local\\CetaMesh.Desktop.ShowWindow{}",
                crate::tray::instance_suffix()
            );
            let mut event_name: Vec<u16> =
                std::ffi::OsStr::new(&show_event).encode_wide().collect();
            event_name.push(0);
            // SAFETY: NUL-terminated UTF-16 name; default attributes; auto-reset, unsignaled.
            let event =
                unsafe { CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr()) };
            if !event.is_null() {
                unsafe {
                    SetEvent(event);
                    CloseHandle(event);
                }
            }
            return Ok(None);
        }
        Ok(Some(Self(Some(handle))))
    }
}

#[cfg(windows)]
impl Drop for SingleInstance {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        }
    }
}

#[cfg(not(windows))]
struct SingleInstance;

#[cfg(not(windows))]
impl SingleInstance {
    fn acquire() -> Result<Option<Self>, String> {
        Ok(Some(Self))
    }
}

fn supervise_seconds_from_args(args: &[String]) -> Duration {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--supervise-seconds" {
            if let Some(value) = iter.next().and_then(|value| value.parse::<u64>().ok()) {
                return Duration::from_secs(value.min(300));
            }
        } else if let Some(value) = arg
            .strip_prefix("--supervise-seconds=")
            .and_then(|value| value.parse::<u64>().ok())
        {
            return Duration::from_secs(value.min(300));
        }
    }
    Duration::ZERO
}

fn start_supervisor(paths: &DesktopPaths) -> Result<(Supervisor, String, u16), String> {
    start_supervisor_with_listener(paths, None)
}

fn start_supervisor_with_listener(
    paths: &DesktopPaths,
    listener: Option<StatusListener>,
) -> Result<(Supervisor, String, u16), String> {
    let probe = probe_config(&paths.data_dir);
    let launch = resolve_core(&current_exe_dir())?;
    let pipe = pipe_name();
    supervisor::write_shell_log(
        &paths.data_dir,
        &format!(
            "[start] data_dir={} ipc_pipe={} core={} config_warning={}",
            paths.data_dir.display(),
            pipe,
            launch.program.display(),
            probe.warning.clone().unwrap_or_default()
        ),
    );
    let config = SupervisorConfig {
        launch,
        data_dir: paths.data_dir.clone(),
        console_port: probe.port,
        ipc_pipe: Some(pipe.clone()),
        health_timeout: supervisor::DEFAULT_HEALTH_TIMEOUT,
    };
    let supervisor = match listener {
        Some(listener) => Supervisor::start_with_status_listener(config, listener),
        None => Supervisor::start(config),
    };
    Ok((supervisor, pipe, probe.port))
}

fn log_smoke_snapshot(
    supervisor: &Supervisor,
    paths: &DesktopPaths,
    last_status: &mut Option<Status>,
    last_pid: &mut Option<u32>,
) {
    let status = supervisor.status();
    if last_status.as_ref() != Some(&status) {
        let summary = status.summary();
        supervisor::write_shell_log(&paths.data_dir, &format!("[smoke] status={summary}"));
        println!("status={summary}");
        *last_status = Some(status);
    }
    if let Some(pid) = supervisor.child_pid() {
        if *last_pid != Some(pid) {
            println!("worker_pid={pid}");
            *last_pid = Some(pid);
        }
    }
}

fn smoke_test(supervise: Duration, test_restart_once: bool) -> i32 {
    let paths = resolve_paths(None);
    let Ok((supervisor, pipe, port)) = start_supervisor(&paths) else {
        return 3;
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut reached_ready = false;
    let mut last_status = None;
    let mut last_pid = None;
    while Instant::now() < deadline {
        log_smoke_snapshot(&supervisor, &paths, &mut last_status, &mut last_pid);
        let status = supervisor.status();
        if status.is_ready() {
            reached_ready = true;
            break;
        }
        if status.needs_attention() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    println!("reached_ready={reached_ready}");
    if reached_ready {
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({ "method": "role.list", "params": {} }),
        ) {
            Ok(_) => println!("ipc_control_request=ok"),
            Err(error) => {
                eprintln!("ipc_control_request=failed: {error}");
                println!("ipc_control_request=failed");
            }
        }
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({ "method": "policy.get", "params": {} }),
        ) {
            Ok(value) if value.get("policy").is_some() => println!("ipc_policy_read=ok"),
            Ok(value) => {
                eprintln!("ipc_policy_read=invalid: {value}");
                println!("ipc_policy_read=failed");
            }
            Err(error) => {
                eprintln!("ipc_policy_read=failed: {error}");
                println!("ipc_policy_read=failed");
            }
        }
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({ "method": "activity.list", "params": { "limit": 10 } }),
        ) {
            Ok(value)
                if value
                    .get("entries")
                    .and_then(serde_json::Value::as_array)
                    .is_some() =>
            {
                println!("ipc_activity_read=ok");
            }
            Ok(value) => {
                eprintln!("ipc_activity_read=invalid: {value}");
                println!("ipc_activity_read=failed");
            }
            Err(error) => {
                eprintln!("ipc_activity_read=failed: {error}");
                println!("ipc_activity_read=failed");
            }
        }
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({
                "method": "logs.read",
                "params": { "source": "bridge", "limit": 10 }
            }),
        ) {
            Ok(value)
                if value
                    .get("lines")
                    .and_then(serde_json::Value::as_array)
                    .is_some() =>
            {
                println!("ipc_logs_read=ok");
            }
            Ok(value) => {
                eprintln!("ipc_logs_read=invalid: {value}");
                println!("ipc_logs_read=failed");
            }
            Err(error) => {
                eprintln!("ipc_logs_read=failed: {error}");
                println!("ipc_logs_read=failed");
            }
        }
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({ "method": "model.defaults.get", "params": {} }),
        ) {
            Ok(value)
                if value
                    .get("defaults")
                    .and_then(serde_json::Value::as_object)
                    .is_some() =>
            {
                println!("ipc_model_defaults=ok");
            }
            Ok(value) => {
                eprintln!("ipc_model_defaults=invalid: {value}");
                println!("ipc_model_defaults=failed");
            }
            Err(error) => {
                eprintln!("ipc_model_defaults=failed: {error}");
                println!("ipc_model_defaults=failed");
            }
        }
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({ "method": "pending.list", "params": {} }),
        ) {
            Ok(value)
                if value
                    .get("pending")
                    .and_then(serde_json::Value::as_array)
                    .is_some() =>
            {
                println!("ipc_pending_list=ok");
            }
            Ok(value) => {
                eprintln!("ipc_pending_list=invalid: {value}");
                println!("ipc_pending_list=failed");
            }
            Err(error) => {
                eprintln!("ipc_pending_list=failed: {error}");
                println!("ipc_pending_list=failed");
            }
        }
        match IpcClient::new(pipe.clone()).request(
            "control.execute",
            serde_json::json!({
                "method": "policy.update",
                "params": { "allow": { "private": [], "groups": [] } }
            }),
        ) {
            Ok(value) if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) => {
                println!("ipc_policy_write=ok");
            }
            Ok(value) => {
                eprintln!("ipc_policy_write=invalid: {value}");
                println!("ipc_policy_write=failed");
            }
            Err(error) => {
                eprintln!("ipc_policy_write=failed: {error}");
                println!("ipc_policy_write=failed");
            }
        }
    }
    supervisor::write_shell_log(
        &paths.data_dir,
        &format!(
            "[smoke] reached_ready={reached_ready} port={port} pipe={pipe} spawn_count={}",
            supervisor.spawn_count()
        ),
    );
    if reached_ready && !supervise.is_zero() {
        let until = Instant::now() + supervise;
        let restart_at = Instant::now() + Duration::from_secs(1);
        let mut restart_sent = false;
        while Instant::now() < until {
            log_smoke_snapshot(&supervisor, &paths, &mut last_status, &mut last_pid);
            if test_restart_once && !restart_sent && Instant::now() >= restart_at {
                supervisor.request_restart();
                restart_sent = true;
                println!("test_restart_requested=true");
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    println!("spawn_count_after_supervise={}", supervisor.spawn_count());
    supervisor.shutdown();
    if reached_ready { 0 } else { 4 }
}

fn print_core_command(args: &[String]) -> i32 {
    let paths = resolve_paths(data_dir_from_args(args).as_deref());
    let probe = probe_config(&paths.data_dir);
    match resolve_core(&current_exe_dir()) {
        Ok(launch) => {
            println!("mode={}", launch.mode.as_str());
            println!("program={}", launch.program.display());
            println!("args={:?}", launch.args);
            println!("data_dir={}", paths.data_dir.display());
            println!("console_port={}", probe.port);
            println!("portable={}", paths.portable);
            if let Some(warning) = probe.warning {
                println!("config_warning={warning}");
            }
            0
        }
        Err(error) => {
            eprintln!("[whalebridge-desktop] {error}");
            2
        }
    }
}

fn run_native_ui(paths: DesktopPaths) -> Result<(), String> {
    let (supervisor, pipe, _port) = start_supervisor(&paths)?;
    let supervisor = Arc::new(supervisor);
    let api = Arc::new(IpcClient::new(pipe));
    let (prefs, prefs_warning) = ui_prefs::UiPrefs::load(&paths.data_dir);
    if let Some(warning) = &prefs_warning {
        supervisor::write_shell_log(&paths.data_dir, &format!("[ui-prefs] {warning}"));
    }
    let prefs = Arc::new(Mutex::new(prefs));
    let ui_supervisor = Arc::clone(&supervisor);
    // Debug-only QA hook: `--screenshot-dir <dir>` captures every theme at 1280x800. Release
    // builds compile the whole driver out (see `theme::qa`).
    #[cfg(debug_assertions)]
    let screenshot_dir = {
        let argv: Vec<String> = env::args().skip(1).collect();
        argv.iter()
            .position(|arg| arg == "--screenshot-dir")
            .and_then(|index| argv.get(index + 1))
            .map(PathBuf::from)
    };
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("CetaMesh")
        .with_icon(eframe::icon_data::from_png_bytes(include_bytes!("../icons/128x128.png"))
            .expect("bundled CetaMesh window icon"))
        .with_min_inner_size([ui_prefs::MIN_WINDOW_WIDTH, ui_prefs::MIN_WINDOW_HEIGHT]);
    match prefs.lock().expect("ui prefs lock").geometry {
        Some(geometry) => {
            viewport = viewport
                .with_inner_size([geometry.width, geometry.height])
                .with_position([geometry.x, geometry.y]);
            if geometry.maximized {
                viewport = viewport.with_maximized(true);
            }
        }
        None => {
            viewport = viewport.with_inner_size([
                ui_prefs::DEFAULT_WINDOW_WIDTH,
                ui_prefs::DEFAULT_WINDOW_HEIGHT,
            ]);
        }
    }
    #[cfg(debug_assertions)]
    if screenshot_dir.is_some() {
        // Acceptance shots are specified at exactly 1280x800.
        viewport = viewport
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([1280.0, 800.0])
            .with_maximized(false)
            .with_resizable(false);
    }
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };
    let prefs_for_ui = Arc::clone(&prefs);
    let tray_data_dir = paths.data_dir.clone();
    let ui_data_dir = paths.data_dir.clone();
    let tray_supervisor = Arc::clone(&supervisor);
    let app_result = eframe::run_native(
        "CetaMesh",
        options,
        Box::new(move |creation_context| {
            let tray = tray::TrayHandle::new(
                Arc::clone(&tray_supervisor),
                tray_data_dir.clone(),
                Arc::new({
                    let context = creation_context.egui_ctx.clone();
                    move || context.request_repaint()
                }),
            )
            .map_err(|error| {
                supervisor::write_shell_log(
                    &tray_data_dir,
                    &format!("[tray] {error}；本次运行没有托盘图标"),
                );
                error
            })
            .ok();
            let mut app = NativeUi::new(
                api,
                ui_supervisor,
                creation_context.egui_ctx.clone(),
                ui_data_dir,
                prefs_for_ui,
                tray,
            );
            #[cfg(debug_assertions)]
            if let Some(dir) = &screenshot_dir {
                eprintln!("[qa] theme screenshot pass → {}", dir.display());
                app.qa_screenshots = Some(crate::theme::qa::ScreenshotPlan::new(dir));
            }
            Ok(Box::new(app))
        }),
    );
    supervisor.shutdown();
    if let Ok(prefs) = prefs.lock() {
        if let Err(error) = prefs.save(&paths.data_dir) {
            supervisor::write_shell_log(&paths.data_dir, &format!("[ui-prefs] {error}"));
        }
    }
    app_result.map_err(|error| format!("原生主窗口启动失败：{error}"))
}

fn main() {
    let argv = env::args().skip(1).collect::<Vec<_>>();
    if argv.iter().any(|arg| arg == "--installer-ui") {
        let resolve_arg_path = |name: &str| {
            let mut iter = argv.iter();
            while let Some(arg) = iter.next() {
                if arg == name {
                    return iter.next().map(PathBuf::from);
                }
                if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                    return Some(PathBuf::from(value));
                }
            }
            None
        };
        if let Err(error) = native_installer_ui::run_installer_ui(
            resolve_arg_path("--payload-core"),
            resolve_arg_path("--payload-archive"),
        ) {
            eprintln!("[whalebridge-desktop] {error}");
            std::process::exit(1);
        }
        return;
    }

    match install_cli::parse(&argv) {
        Ok(Some(cli)) => {
            if argv.iter().any(|arg| arg == "--help") {
                println!("{}", install_cli::USAGE);
                std::process::exit(0);
            }
            std::process::exit(install_cli::run(&cli));
        }
        Ok(None) => {}
        Err(message) => {
            eprintln!("[whalebridge-desktop] {message}\n\n{}", install_cli::USAGE);
            std::process::exit(2);
        }
    }
    if argv.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", install_cli::USAGE);
        return;
    }
    if argv.iter().any(|arg| arg == "--smoke-test") {
        let test_restart_once = argv.iter().any(|arg| arg == "--test-restart-once");
        std::process::exit(smoke_test(
            supervise_seconds_from_args(&argv),
            test_restart_once,
        ));
    }
    if argv.iter().any(|arg| arg == "--print-core-command") {
        std::process::exit(print_core_command(&argv));
    }

    let paths = resolve_paths(data_dir_from_args(&argv).as_deref());
    let _single_instance = match SingleInstance::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[whalebridge-desktop] {error}");
            std::process::exit(2);
        }
    };
    let selection = match webview_policy::select_ui(&argv, cfg!(debug_assertions)) {
        Ok(selection) => selection,
        Err(error) => {
            eprintln!("[whalebridge-desktop] {error}");
            std::process::exit(2);
        }
    };
    let app_result = match selection.mode {
        webview_policy::UiMode::Legacy => run_native_ui(paths),
        webview_policy::UiMode::V2 => {
            #[cfg(windows)]
            { webview_ui::run_webview_ui(paths, selection.dev_url) }
            #[cfg(not(windows))]
            { Err("WebView2 UI is supported on Windows only".to_owned()) }
        }
    };
    if let Err(error) = app_result {
        let _ = rfd::MessageDialog::new()
            .set_title("CetaMesh 启动失败")
            .set_description(&error)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
        eprintln!("[whalebridge-desktop] {error}");
        std::process::exit(1);
    }
}
