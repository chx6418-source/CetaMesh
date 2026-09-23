#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_launch;
mod desktop_paths;
mod install_cli;
mod installer;
mod migrate;
mod supervisor;

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_launch::{CoreLaunchSpec, ResolveOptions};
use desktop_paths::{probe_config, resolve_data_dir, DesktopPaths};
use supervisor::{Status, Supervisor, SupervisorConfig};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const MAIN_WINDOW_LABEL: &str = "main";
const STATUS_PAGE: &str = "status.html";
const TRAY_ID: &str = "whalebridge-tray";
const INSTALLER_WINDOW_LABEL: &str = "installer";
const INSTALLER_PAGE: &str = "installer.html";

fn current_exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 解析 Core 启动方式（阶段 4 固化契约，阶段 6 用它真正拉起 worker）。
fn resolve_core(exe_dir: &Path) -> Result<CoreLaunchSpec, String> {
    let override_command = env::var("WHALEBRIDGE_CORE_EXE").ok();
    let override_mode = env::var("WHALEBRIDGE_CORE_MODE").ok();
    let repo_root = env::var("WHALEBRIDGE_REPO_ROOT").ok();
    core_launch::resolve_core_launch(ResolveOptions {
        exe_dir,
        override_command: override_command.as_deref(),
        override_mode: override_mode.as_deref(),
        repo_root: repo_root.as_deref(),
        // 数据目录由壳在 spawn 时显式注入 worker 环境（见 supervisor::spawn_worker），
        // 这里不再重复放进 launch.env，避免两处都写导致不一致。
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

/// 解析 `--data-dir <path>` / `--data-dir=<path>`。
fn data_dir_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into);
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            return args.next();
        }
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            return Some(value.to_owned());
        }
    }
    None
}

/// 同时写 stdout 和壳日志：release 构建是 GUI 子系统（没有 stdout），
/// 自检/诊断模式的输出必须也能从 logs\desktop-shell.log 读到。
fn emit(data_dir: &Path, line: &str) {
    println!("{line}");
    supervisor::write_shell_log(data_dir, line);
}

/// 打印解析结果后退出：供发布前检查和自动化测试观察选路与端口解析结果。
/// 注意要接受 `--data-dir`：这个诊断常被用来确认"换成某个数据目录后会用什么配置"。
fn print_core_command(explicit_data_dir: Option<&str>) -> i32 {
    let paths = resolve_paths(explicit_data_dir);
    let probe = probe_config(&paths.data_dir);
    match resolve_core(&current_exe_dir()) {
        Ok(spec) => {
            let args = spec
                .args
                .iter()
                .map(|arg| format!("{arg:?}"))
                .collect::<Vec<_>>()
                .join(", ");
            let envs = spec
                .env
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(" ");
            let lines = vec![
                format!("mode={}", spec.mode.as_str()),
                format!("program={}", spec.program.display()),
                format!("args=[{args}]"),
                format!("env=[{envs}]"),
                format!("data_dir={}", paths.data_dir.display()),
                format!("portable={}", paths.portable),
                format!("config={}", probe.config_file.display()),
                format!("console_port={}", probe.port),
            ];
            for line in lines {
                emit(&paths.data_dir, &line);
            }
            if let Some(warning) = probe.warning {
                emit(&paths.data_dir, &format!("config_warning={warning}"));
            }
            0
        }
        Err(message) => {
            eprintln!("[whalebridge-desktop] {message}");
            3
        }
    }
}

fn console_url_from_args<I, S>(args: I) -> Result<Url, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into).peekable();
    let mut requested = env::var("WHALEBRIDGE_CONSOLE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}/", desktop_paths::DEFAULT_CONSOLE_PORT));

    while let Some(arg) = args.next() {
        if arg == "--console-url" {
            requested = args
                .next()
                .ok_or_else(|| "--console-url 缺少 URL 参数".to_owned())?;
        } else if let Some(value) = arg.strip_prefix("--console-url=") {
            requested = value.to_owned();
        }
    }

    let url = Url::parse(&requested).map_err(|error| format!("控制台 URL 无效：{error}"))?;
    if !is_loopback_http_url(&url) {
        return Err(
            "桌面窗口只允许连接本机 http://127.0.0.1 或 http://localhost 控制台".to_owned(),
        );
    }
    Ok(url)
}

fn is_loopback_http_url(url: &Url) -> bool {
    if url.scheme() != "http" {
        return false;
    }
    matches!(
        url.host_str()
            .map(|host| host.to_ascii_lowercase())
            .as_deref(),
        Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
    )
}

/// 应用自身的内部页面（状态页等）由 Tauri 自定义协议提供：
/// Windows 上是 `http://tauri.localhost/...`，其它平台是 `tauri://localhost/...`。
/// 这些**必须**算作内部导航，否则会被当成外部链接甩给系统浏览器，窗口里反而一片空白。
fn is_app_internal_url(url: &Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    if url.scheme() == "about" && url.as_str() == "about:blank" {
        return true;
    }
    url.scheme() == "http"
        && url
            .host_str()
            .map(|host| host.eq_ignore_ascii_case("tauri.localhost"))
            .unwrap_or(false)
}

fn is_allowed_navigation(url: &Url, console_origin: &Url) -> bool {
    if is_app_internal_url(url) {
        return true;
    }
    is_loopback_http_url(url)
        && url.host_str() == console_origin.host_str()
        && url.port_or_known_default() == console_origin.port_or_known_default()
}

fn webview_data_dir() -> PathBuf {
    if let Ok(base) = env::var("WHALEBRIDGE_DATA_DIR") {
        if !base.trim().is_empty() {
            return PathBuf::from(base).join("webview2");
        }
    }
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("WhaleBridge")
        .join("webview2")
}

/// 交给系统浏览器打开，并留痕（误把自家页面当外链时可在壳日志里发现）。
fn open_external_url(url: &Url, data_dir: Option<&Path>) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    if let Some(dir) = data_dir {
        supervisor::write_shell_log(dir, &format!("[external] 交给系统浏览器打开：{url}"));
    }
    let _ = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url.as_str())
        .spawn();
}

fn open_path(target: &Path) {
    let _ = Command::new("explorer.exe").arg(target).spawn();
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 状态页展示的内容：以初始化脚本注入全局变量，页面自行渲染。
fn status_payload(
    status: &Status,
    console_port: u16,
    log_file: &Path,
    note: &str,
) -> serde_json::Value {
    serde_json::json!({
        "state": match status {
            Status::Starting => "starting",
            Status::Ready { .. } => "ready",
            Status::Restarting { .. } => "restarting",
            Status::Stopped { .. } => "stopped",
            Status::GivenUp { .. } => "given_up",
        },
        "summary": status.summary(),
        "detail": note,
        "needsAttention": status.needs_attention(),
        "consolePort": console_port,
        "logFile": log_file.to_string_lossy(),
    })
}

fn build_window(
    app: &AppHandle,
    url: WebviewUrl,
    console_port: u16,
    script: Option<String>,
    data_dir: std::path::PathBuf,
) -> tauri::Result<()> {
    let log_dir = data_dir.clone();
    let popup_log_dir = data_dir;
    let navigation_origin = Url::parse(&format!("http://127.0.0.1:{console_port}/"))
        .unwrap_or_else(|_| Url::parse("http://127.0.0.1/").expect("fallback url"));
    let popup_origin = navigation_origin.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, url)
        .title("鲸桥 WhaleBridge")
        .inner_size(1240.0, 820.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .resizable(true)
        .data_directory(webview_data_dir())
        .on_navigation(move |url| {
            if is_allowed_navigation(url, &navigation_origin) {
                true
            } else {
                open_external_url(url, Some(&log_dir));
                false
            }
        })
        .on_new_window(move |url, _features| {
            if is_allowed_navigation(&url, &popup_origin) {
                tauri::webview::NewWindowResponse::Allow
            } else {
                open_external_url(&url, Some(&popup_log_dir));
                tauri::webview::NewWindowResponse::Deny
            }
        });
    if let Some(script) = script {
        builder = builder.initialization_script(&script);
    }
    builder.build()?;
    Ok(())
}

/// 无窗口自检：只跑进程监管，供自动化测试验证启动/健康/重启/停止契约。
/// `--supervise-seconds <N>` 让它在就绪后继续监管 N 秒，便于外部触发 /api/restart 观察重启。
fn smoke_test(supervise: Duration) -> i32 {
    let paths = resolve_paths(None);
    let probe = probe_config(&paths.data_dir);
    let launch = match resolve_core(&current_exe_dir()) {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("[whalebridge-desktop] {error}");
            return 3;
        }
    };
    supervisor::write_shell_log(
        &paths.data_dir,
        &format!(
            "[smoke] data_dir={} port={} core={}",
            paths.data_dir.display(),
            probe.port,
            launch.program.display()
        ),
    );
    let supervisor = Supervisor::start(SupervisorConfig {
        launch,
        data_dir: paths.data_dir.clone(),
        console_port: probe.port,
        ipc_pipe: None,
        health_timeout: supervisor::DEFAULT_HEALTH_TIMEOUT,
    });

    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last: Option<Status> = None;
    let mut last_pid: Option<u32> = None;
    let mut reached_ready = false;
    let report = |status: &Status, last: &mut Option<Status>, last_pid: &mut Option<u32>, pid: Option<u32>| {
        if last.as_ref() != Some(status) {
            emit(&paths.data_dir, &format!("status={}", status.summary()));
            *last = Some(status.clone());
        }
        if *last_pid != pid {
            if let Some(pid) = pid {
                emit(&paths.data_dir, &format!("worker_pid={pid}"));
            }
            *last_pid = pid;
        }
    };
    while Instant::now() < deadline {
        let status = supervisor.status();
        report(&status, &mut last, &mut last_pid, supervisor.child_pid());
        if status.is_ready() {
            reached_ready = true;
            break;
        }
        if status.needs_attention() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    emit(&paths.data_dir, &format!("reached_ready={reached_ready}"));
    emit(
        &paths.data_dir,
        &format!(
            "worker_pid={}",
            supervisor
                .child_pid()
                .map(|pid| pid.to_string())
                .unwrap_or_default()
        ),
    );
    emit(&paths.data_dir, &format!("console_port={}", probe.port));
    emit(&paths.data_dir, &format!("data_dir={}", paths.data_dir.display()));
    emit(&paths.data_dir, &format!("spawn_count={}", supervisor.spawn_count()));

    // 继续监管：外部可以在这段时间里请求重启，观察 worker 换 pid。
    if reached_ready && !supervise.is_zero() {
        let until = Instant::now() + supervise;
        while Instant::now() < until {
            let status = supervisor.status();
            report(&status, &mut last, &mut last_pid, supervisor.child_pid());
            std::thread::sleep(Duration::from_millis(150));
        }
        emit(
            &paths.data_dir,
            &format!("spawn_count_after_supervise={}", supervisor.spawn_count()),
        );
    }

    let started = Instant::now();
    supervisor.shutdown();
    emit(
        &paths.data_dir,
        &format!("shutdown_ms={}", started.elapsed().as_millis()),
    );
    if reached_ready { 0 } else { 4 }
}

fn supervise_seconds_from_args<I, S>(args: I) -> Duration
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into);
    while let Some(arg) = args.next() {
        if arg == "--supervise-seconds" {
            if let Some(value) = args.next() {
                if let Ok(seconds) = value.parse::<u64>() {
                    return Duration::from_secs(seconds.min(300));
                }
            }
        } else if let Some(value) = arg.strip_prefix("--supervise-seconds=") {
            if let Ok(seconds) = value.parse::<u64>() {
                return Duration::from_secs(seconds.min(300));
            }
        }
    }
    Duration::ZERO
}

struct InstallerState {
    shell_exe: PathBuf,
    payload_core: PathBuf,
    payload_archive: Option<PathBuf>,
    staging_dir: PathBuf,
}

fn arg_path(args: &[String], name: &str) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == name {
            return iter.next().map(PathBuf::from);
        }
        if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
            return Some(PathBuf::from(value));
        }
    }
    None
}

fn is_installer_ui(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--installer-ui")
}

fn parse_registry_install_location(text: &str) -> Option<PathBuf> {
    text.lines().find_map(|line| {
        let (name, value) = line.trim().split_once("REG_SZ")?;
        if !name.trim().eq_ignore_ascii_case("InstallLocation") {
            return None;
        }
        let value = value.trim();
        (!value.is_empty()).then(|| PathBuf::from(value))
    })
}

fn existing_install_dir(path: PathBuf) -> Option<PathBuf> {
    (path.is_dir() && path.join(installer::SHELL_EXE_NAME).is_file()).then_some(path)
}

fn registered_install_dir() -> Option<PathBuf> {
    let mut command = Command::new("reg.exe");
    command.args(["query", installer::UNINSTALL_KEY, "/v", "InstallLocation"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    existing_install_dir(parse_registry_install_location(&text)?)
}

fn default_install_dir() -> PathBuf {
    if let Some(path) = registered_install_dir() {
        return path;
    }
    if let Some(program_files) = env::var_os("ProgramFiles")
        .or_else(|| env::var_os("ProgramFiles(x86)"))
        .map(PathBuf::from)
        .and_then(|path| existing_install_dir(path.join("WhaleBridge")))
    {
        return program_files;
    }
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("Programs")
        .join("WhaleBridge")
}

fn path_key(path: &Path) -> String {
    let value = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    if value.len() > 3 {
        value.trim_end_matches('\\').to_owned()
    } else {
        value
    }
}

fn is_path_within(parent: &str, child: &str) -> bool {
    if parent == child {
        return true;
    }
    let prefix = if parent.ends_with('\\') {
        parent.to_owned()
    } else {
        format!("{parent}\\")
    };
    child.starts_with(&prefix)
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = path_key(left);
    let right = path_key(right);
    is_path_within(&left, &right) || is_path_within(&right, &left)
}

#[tauri::command]
fn installer_install(
    state: tauri::State<'_, InstallerState>,
    install_dir: String,
) -> Result<String, String> {
    let install_dir = PathBuf::from(install_dir.trim());
    if !install_dir.is_absolute() {
        return Err("请选择完整的安装路径。".to_owned());
    }
    if paths_overlap(&install_dir, &state.staging_dir) {
        return Err("安装路径不能位于安装程序的临时目录中，请选择其他位置。".to_owned());
    }
    if !state.payload_core.join(installer::CORE_EXE_NAME).is_file() {
        if let Some(archive) = &state.payload_archive {
            if !archive.is_file() {
                return Err("安装文件不完整，请重新下载 WhaleBridge 安装程序后重试。".to_owned());
            }
            let script = format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                archive.to_string_lossy().replace('\'', "''"),
                state.payload_core.to_string_lossy().replace('\'', "''")
            );
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let output = command
                .output()
                .map_err(|error| format!("无法展开安装文件：{error}"))?;
            if !output.status.success() {
                let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(if detail.is_empty() {
                    "无法展开安装文件，请重新下载 WhaleBridge 安装程序后重试。".to_owned()
                } else {
                    format!("无法展开安装文件：{detail}")
                });
            }
        }
    }
    if !state.payload_core.join(installer::CORE_EXE_NAME).is_file()
        || !state.payload_core.join("resources").is_dir()
    {
        return Err("安装文件不完整，请重新下载 WhaleBridge 安装程序后重试。".to_owned());
    }

    let output = Command::new(&state.shell_exe)
        .arg("--install")
        .arg("--install-dir")
        .arg(&install_dir)
        .arg("--payload-core")
        .arg(&state.payload_core)
        .output()
        .map_err(|error| format!("无法启动安装：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = format!("{stdout}{stderr}").trim().to_owned();
    if output.status.success() {
        Ok(if detail.is_empty() {
            "鲸桥已安装完成。".to_owned()
        } else {
            detail
        })
    } else if detail.is_empty() {
        Err(format!("安装失败（退出代码 {:?}）。", output.status.code()))
    } else {
        Err(detail)
    }
}

#[tauri::command]
fn installer_launch(install_dir: String) -> Result<(), String> {
    let install_dir = PathBuf::from(install_dir.trim());
    let executable = install_dir.join(installer::SHELL_EXE_NAME);
    if !executable.is_file() {
        return Err(format!("找不到已安装的鲸桥程序：{}", executable.display()));
    }
    Command::new(&executable)
        .current_dir(&install_dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动鲸桥：{error}"))
}

#[tauri::command]
fn installer_close(app: tauri::AppHandle) {
    app.exit(0);
}

fn run_installer_ui(payload_core: PathBuf, payload_archive: Option<PathBuf>) {
    let shell_exe = env::current_exe().unwrap_or_else(|_| PathBuf::from(installer::SHELL_EXE_NAME));
    let staging_dir = shell_exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(env::temp_dir);
    let default_dir = default_install_dir();
    let initial_script = format!(
        "window.WB_INSTALLER_DEFAULT_DIR = {};",
        serde_json::to_string(&default_dir.to_string_lossy()).unwrap_or_else(|_| "\"\"".to_owned())
    );
    let state = InstallerState { shell_exe, payload_core, payload_archive, staging_dir };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![installer_install, installer_launch, installer_close])
        .setup(move |app| {
            let webview_dir = env::temp_dir().join(format!(
                "WhaleBridgeInstallerWebView2-{}",
                std::process::id()
            ));
            WebviewWindowBuilder::new(
                app,
                INSTALLER_WINDOW_LABEL,
                WebviewUrl::App(INSTALLER_PAGE.into()),
            )
            .title("鲸桥 WhaleBridge 安装程序")
            .inner_size(760.0, 540.0)
            .min_inner_size(700.0, 500.0)
            .center()
            .resizable(false)
            .data_directory(webview_dir)
            .initialization_script(&initial_script)
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("WhaleBridge installer failed")
        .run(|_, _| {});
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    // 单文件安装包先静默解压到临时目录，再用 WhaleBridge 自己的 Tauri 外壳展示品牌一致的安装页。
    if is_installer_ui(&argv) {
        let exe_dir = current_exe_dir();
        let resolve_arg_path = |name: &str| {
            arg_path(&argv, name).map(|path| {
                if path.is_absolute() { path } else { exe_dir.join(path) }
            })
        };
        let payload_archive = resolve_arg_path("--payload-archive");
        let payload_core = resolve_arg_path("--payload-core")
            .unwrap_or_else(|| exe_dir.join("payload"));
        run_installer_ui(payload_core, payload_archive);
        return;
    }
    // 安装/修复/卸载/迁移：不走 GUI，直接执行后退出。
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
        std::process::exit(0);
    }
    if argv.iter().any(|arg| arg == "--print-core-command") {
        let explicit = data_dir_from_args(argv.clone());
        std::process::exit(print_core_command(explicit.as_deref()));
    }
    if argv.iter().any(|arg| arg == "--smoke-test") {
        std::process::exit(smoke_test(supervise_seconds_from_args(argv.clone())));
    }

    let explicit_data_dir = data_dir_from_args(argv.clone());
    let paths = resolve_paths(explicit_data_dir.as_deref());
    let probe = probe_config(&paths.data_dir);
    let launch = match resolve_core(&current_exe_dir()) {
        Ok(spec) => spec,
        Err(message) => {
            eprintln!("[whalebridge-desktop] {message}");
            std::process::exit(3);
        }
    };
    let console_url = console_url_from_args(argv).unwrap_or_else(|message| {
        eprintln!("[whalebridge-desktop] {message}");
        std::process::exit(2);
    });

    let config_warning = probe.warning.clone();
    supervisor::write_shell_log(
        &paths.data_dir,
        &format!(
            "[start] data_dir={} port={} core={} config_warning={}",
            paths.data_dir.display(),
            probe.port,
            launch.program.display(),
            config_warning.clone().unwrap_or_default()
        ),
    );

    let console_port = probe.port;
    let supervisor = Arc::new(Supervisor::start(SupervisorConfig {
        launch,
        data_dir: paths.data_dir.clone(),
        console_port,
        ipc_pipe: None,
        health_timeout: supervisor::DEFAULT_HEALTH_TIMEOUT,
    }));

    let state = AppState {
        supervisor: Arc::clone(&supervisor),
        data_dir: paths.data_dir.clone(),
        console_url,
        shutdown_started: Mutex::new(false),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            // 先把窗口建起来显示启动状态，就绪后再切到控制台，避免长时间没有任何界面。
            let script = format!(
                "window.__WHALEBRIDGE_STATUS__ = {};",
                status_payload(
                    &Status::Starting,
                    console_port,
                    &desktop_paths::worker_log_file(&paths.data_dir),
                    config_warning
                        .as_deref()
                        .unwrap_or("正在等待本地控制台就绪…"),
                )
            );
            build_window(
                &handle,
                WebviewUrl::App(STATUS_PAGE.into()),
                console_port,
                Some(script),
                paths.data_dir.clone(),
            )?;

            // 后台跟踪状态：就绪 → 切到控制台；需要人工处理 → 留在状态页。
            let supervisor = Arc::clone(&supervisor);
            let data_dir = paths.data_dir.clone();
            std::thread::spawn(move || {
                let mut last_summary = String::new();
                loop {
                    let status = supervisor.status();
                    let summary = status.summary();
                    if summary != last_summary {
                        last_summary = summary.clone();
                        push_status(&handle, &status, console_port, &data_dir);
                        supervisor::write_shell_log(
                            &data_dir,
                            &format!("[status] {summary}"),
                        );
                    }
                    if status.is_ready() {
                        navigates_to_console(&handle, console_port);
                        return;
                    }
                    if status.needs_attention() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 = 隐藏到托盘（托盘菜单里有"显示主窗口"和"退出"）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("WhaleBridge desktop shell failed")
        .run(move |app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let mut started = state.shutdown_started.lock().expect("shutdown flag");
                    if !*started {
                        *started = true;
                        // 必须**同步**停止：以前把 shutdown 丢给一个线程，进程可能在它跑完之前就退出，
                        // 于是 Core 变成孤儿（实测攒出过 5 个）。
                        // shutdown() 本身有界：丢弃 stdin 后最多等 5 秒，再按本子进程 taskkill。
                        state.supervisor.shutdown();
                        supervisor::write_shell_log(&state.data_dir, "[exit] worker 已停止");
                    }
                }
            }
        });
}

fn push_status(handle: &AppHandle, status: &Status, console_port: u16, data_dir: &Path) {
    let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let payload = status_payload(
        status,
        console_port,
        &desktop_paths::worker_log_file(data_dir),
        "",
    );
    let script = format!(
        "if (window.__wbSetStatus) {{ window.__wbSetStatus({payload}); }} else {{ window.__WHALEBRIDGE_STATUS__ = {payload}; }}"
    );
    let _ = window.eval(&script);
}

fn navigates_to_console(handle: &AppHandle, port: u16) {
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(state) = handle.try_state::<AppState>() {
        supervisor::write_shell_log(
            &state.data_dir,
            &format!("[navigate] 控制台已就绪，窗口切换到 http://127.0.0.1:{port}/"),
        );
    }
}

struct AppState {
    supervisor: Arc<Supervisor>,
    data_dir: PathBuf,
    console_url: Url,
    shutdown_started: Mutex<bool>,
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "在系统浏览器中打开", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启桥接", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &browser, &restart, &logs, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("鲸桥 WhaleBridge")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "browser" => {
                if let Some(state) = app.try_state::<AppState>() {
                    open_external_url(&state.console_url.clone(), Some(&state.data_dir.clone()));
                }
            }
            "restart" => {
                if let Some(state) = app.try_state::<AppState>() {
                    supervisor::write_shell_log(&state.data_dir, "[tray] 用户请求重启桥接");
                    state.supervisor.request_restart();
                }
            }
            "logs" => {
                if let Some(state) = app.try_state::<AppState>() {
                    open_path(&desktop_paths::log_dir(&state.data_dir));
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn console() -> Url {
        Url::parse("http://127.0.0.1:3100/").expect("console url")
    }

    #[test]
    fn installer_rejects_staging_directory_and_its_parents() {
        assert!(paths_overlap(
            Path::new(r"C:\Users\Alice\AppData\Local\Temp\IXP123"),
            Path::new(r"C:\Users\Alice\AppData\Local\Temp\IXP123\payload")
        ));
        assert!(paths_overlap(
            Path::new(r"C:\Users\Alice\AppData\Local\Temp"),
            Path::new(r"C:\Users\Alice\AppData\Local\Temp\IXP123")
        ));
        assert!(!paths_overlap(
            Path::new(r"C:\Users\Alice\AppData\Local\Temp\WhaleBridge"),
            Path::new(r"C:\Users\Alice\AppData\Local\Temp\IXP123")
        ));
        assert!(!paths_overlap(
            Path::new(r"C:\Program Files\App"),
            Path::new(r"C:\Program Files\Application")
        ));
    }

    #[test]
    fn parses_registered_install_location_with_spaces() {
        let output = "HKEY_CURRENT_USER\\Software\\...\\WhaleBridge\r\n    InstallLocation    REG_SZ    C:\\Program Files\\WhaleBridge\r\n";
        assert_eq!(
            parse_registry_install_location(output),
            Some(PathBuf::from(r"C:\Program Files\WhaleBridge"))
        );
        assert_eq!(parse_registry_install_location("ERROR: The system was unable to find the specified registry key or value."), None);
    }

    #[test]
    fn accepts_loopback_console_urls() {
        for value in [
            "http://127.0.0.1:3100/",
            "http://localhost:3100/console",
            "http://[::1]:3100/",
        ] {
            assert!(is_loopback_http_url(&Url::parse(value).unwrap()), "{value}");
        }
    }

    #[test]
    fn rejects_non_loopback_or_non_http_urls() {
        for value in [
            "https://127.0.0.1:3100/",
            "http://192.168.1.2:3100/",
            "https://example.com/",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(!is_loopback_http_url(&Url::parse(value).unwrap()), "{value}");
        }
    }

    #[test]
    fn navigation_is_limited_to_console_origin_and_own_pages() {
        assert!(is_allowed_navigation(
            &Url::parse("http://127.0.0.1:3100/dsh-monitor.html").unwrap(),
            &console(),
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("http://127.0.0.1:3080/").unwrap(),
            &console(),
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("https://example.com/").unwrap(),
            &console(),
        ));
    }

    /// 回归测试：自家状态页走 Tauri 自定义协议，**必须**算内部导航。
    /// 曾经漏掉这一条，导致状态页被当成外部链接甩给系统浏览器，窗口里一片空白。
    #[test]
    fn own_status_page_is_internal_not_external() {
        for value in [
            "http://tauri.localhost/status.html",
            "tauri://localhost/status.html",
            "about:blank",
        ] {
            let url = Url::parse(value).unwrap();
            assert!(is_app_internal_url(&url), "应视为应用内部页面：{value}");
            assert!(
                is_allowed_navigation(&url, &console()),
                "内部页面必须放行，不能被甩给系统浏览器：{value}"
            );
        }
        // 但真正的外部地址仍然要被挡下并交给浏览器
        for value in ["https://example.com/", "http://127.0.0.1:9/"] {
            let url = Url::parse(value).unwrap();
            assert!(!is_allowed_navigation(&url, &console()), "外部地址不应在窗口内导航：{value}");
        }
    }

    #[test]
    fn command_line_override_must_stay_local() {
        let local = console_url_from_args(["--console-url", "http://localhost:43100/"])
            .expect("local override");
        assert_eq!(local.port(), Some(43100));

        let remote = console_url_from_args(["--console-url=https://example.com/"]);
        assert!(remote.is_err());
    }
}
