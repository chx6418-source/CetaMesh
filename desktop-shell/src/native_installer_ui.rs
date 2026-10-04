//! 原生 eframe 安装向导。
//!
//! 只承载安装 UI；实际安装仍由本程序的 `--install` CLI 和 installer 引擎完成。
//! 路径作为进程参数/环境变量传递，不拼接进可执行命令字符串。

use std::collections::VecDeque;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use eframe::egui;

const WINDOW_TITLE: &str = "CetaMesh 安装程序";
const ARCHIVE_EXPAND_SCRIPT: &str = "Expand-Archive -LiteralPath $env:WHALEBRIDGE_INSTALL_ARCHIVE -DestinationPath $env:WHALEBRIDGE_INSTALL_PAYLOAD";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallPhase {
    Idle,
    Extracting,
    Installing,
}

enum WorkerEvent {
    Phase(InstallPhase, String),
    Output(String),
    Finished(Result<(), String>),
}

/// 启动原生安装向导。`payload_core` 和 `payload_archive` 可来自命令行参数；相对路径按
/// 当前安装包所在目录解析。未提供 Core 目录时，按发布包布局查找 `payload` / `dist/core`。
pub fn run_installer_ui(
    payload_core: Option<PathBuf>,
    payload_archive: Option<PathBuf>,
) -> Result<(), String> {
    let shell_exe = env::current_exe().map_err(|error| format!("无法定位安装程序：{error}"))?;
    let shell_dir = shell_exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(env::temp_dir);
    let payload_core = resolve_payload_core(payload_core, &shell_dir);
    let payload_archive = payload_archive.map(|path| resolve_from_dir(path, &shell_dir));
    let default_install_dir = crate::default_install_dir();
    let data_dir = resolve_data_dir(&shell_dir);

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([760.0, 580.0])
            .with_min_inner_size([680.0, 500.0])
            .with_resizable(false),
        ..Default::default()
    };
    eframe::run_native(
        WINDOW_TITLE,
        options,
        Box::new(move |creation_context| {
            let _detected_fonts = egui_system_fonts::add_auto(
                &creation_context.egui_ctx,
                egui_system_fonts::FontStyle::Sans,
            );
            Ok(Box::new(InstallerApp::new(
                shell_exe,
                shell_dir,
                payload_core,
                payload_archive,
                default_install_dir,
                data_dir,
            )))
        }),
    )
    .map_err(|error| format!("安装窗口启动失败：{error}"))
}

fn resolve_from_dir(path: PathBuf, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn resolve_payload_core(explicit: Option<PathBuf>, shell_dir: &Path) -> PathBuf {
    if let Some(path) = explicit {
        return resolve_from_dir(path, shell_dir);
    }
    let staged = shell_dir.join("payload");
    if staged.join(crate::installer::CORE_EXE_NAME).is_file() {
        return staged;
    }
    let development = shell_dir
        .parent()
        .map(|parent| parent.join("dist").join("core"))
        .unwrap_or_default();
    if development.join(crate::installer::CORE_EXE_NAME).is_file() {
        development
    } else {
        shell_dir.to_path_buf()
    }
}

fn resolve_data_dir(shell_dir: &Path) -> PathBuf {
    let env_data_dir = env::var("WHALEBRIDGE_DATA_DIR").ok();
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    crate::desktop_paths::resolve_data_dir(
        None,
        env_data_dir.as_deref(),
        shell_dir,
        local_app_data.as_deref(),
        &|candidate| candidate.exists(),
    )
    .data_dir
}

struct InstallerApp {
    shell_exe: PathBuf,
    shell_dir: PathBuf,
    payload_core: PathBuf,
    payload_archive: Option<PathBuf>,
    install_dir: String,
    data_dir: PathBuf,
    confirm_open: bool,
    phase: InstallPhase,
    status: String,
    error: Option<String>,
    finished: bool,
    cancel_requested: bool,
    cancel_token: Option<Arc<AtomicU8>>,
    event_rx: Option<mpsc::Receiver<WorkerEvent>>,
    output: VecDeque<String>,
}

impl InstallerApp {
    fn new(
        shell_exe: PathBuf,
        shell_dir: PathBuf,
        payload_core: PathBuf,
        payload_archive: Option<PathBuf>,
        install_dir: PathBuf,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            shell_exe,
            shell_dir,
            payload_core,
            payload_archive,
            install_dir: install_dir.to_string_lossy().into_owned(),
            data_dir,
            confirm_open: false,
            phase: InstallPhase::Idle,
            status: "检查安装位置后即可开始。".to_owned(),
            error: None,
            finished: false,
            cancel_requested: false,
            cancel_token: None,
            event_rx: None,
            output: VecDeque::new(),
        }
    }

    fn active(&self) -> bool {
        matches!(
            self.phase,
            InstallPhase::Extracting | InstallPhase::Installing
        )
    }

    fn begin_install(&mut self, ctx: &egui::Context) {
        let install_dir = PathBuf::from(self.install_dir.trim());
        if !install_dir.is_absolute() {
            self.error = Some("请填写完整的安装路径。".to_owned());
            return;
        }
        if paths_overlap(&install_dir, &self.shell_dir) {
            self.error = Some("安装路径不能位于安装程序所在目录中，请选择其他位置。".to_owned());
            return;
        }

        let (event_tx, event_rx) = mpsc::channel();
        // 0 = 可安全取消（尚未运行安装 CLI），1 = 安装 CLI 已获准启动，2 = 已取消。
        let cancel_token = Arc::new(AtomicU8::new(0));
        self.cancel_token = Some(cancel_token.clone());
        self.event_rx = Some(event_rx);
        self.phase = if self.core_payload_ready() {
            InstallPhase::Installing
        } else {
            InstallPhase::Extracting
        };
        self.status = if self.phase == InstallPhase::Extracting {
            "正在准备安装文件…".to_owned()
        } else {
            "正在安装，请稍候…".to_owned()
        };
        self.error = None;
        self.output.clear();
        self.finished = false;
        self.cancel_requested = false;

        let work = InstallWork {
            shell_exe: self.shell_exe.clone(),
            payload_core: self.payload_core.clone(),
            payload_archive: self.payload_archive.clone(),
            install_dir,
            data_dir: self.data_dir.clone(),
            cancel_token,
        };
        thread::spawn(move || {
            let result = execute_install(work, &event_tx);
            let _ = event_tx.send(WorkerEvent::Finished(result));
        });
        ctx.request_repaint();
    }

    fn core_payload_ready(&self) -> bool {
        self.payload_core
            .join(crate::installer::CORE_EXE_NAME)
            .is_file()
            && self.payload_core.join("resources").is_dir()
    }

    fn drain_events(&mut self) {
        let Some(receiver) = &self.event_rx else {
            return;
        };
        while let Ok(event) = receiver.try_recv() {
            match event {
                WorkerEvent::Phase(phase, status) => {
                    self.phase = phase;
                    self.status = status;
                }
                WorkerEvent::Output(line) => {
                    self.output.push_back(line);
                    while self.output.len() > 160 {
                        self.output.pop_front();
                    }
                }
                WorkerEvent::Finished(result) => {
                    self.phase = InstallPhase::Idle;
                    self.finished = true;
                    self.cancel_token = None;
                    match result {
                        Ok(()) => {
                            self.status = "安装完成，可以启动 CetaMesh 了。".to_owned();
                            self.error = None;
                        }
                        Err(error) if error == "__CANCELLED__" => {
                            self.status = "已安全取消；未启动安装操作。".to_owned();
                            self.error = None;
                        }
                        Err(error) => {
                            self.status = "安装未完成。请检查路径和权限后重试。".to_owned();
                            self.error = Some(error);
                        }
                    }
                }
            }
        }
    }

    fn request_cancel(&mut self) {
        if self.phase == InstallPhase::Extracting {
            if let Some(token) = &self.cancel_token {
                if token
                    .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    self.cancel_requested = true;
                    self.status = "正在安全取消；当前只会停止准备临时安装文件…".to_owned();
                } else if token.load(Ordering::SeqCst) == 1 {
                    self.phase = InstallPhase::Installing;
                    self.status = "安装操作已开始；请等待其完成。".to_owned();
                }
            }
        }
    }

    fn launch_installed(&mut self, ctx: &egui::Context) {
        let install_dir = PathBuf::from(self.install_dir.trim());
        let executable = install_dir.join(crate::installer::SHELL_EXE_NAME);
        if !executable.is_file() {
            self.error = Some(format!("找不到已安装的 CetaMesh 程序：{}", executable.display()));
            return;
        }
        match Command::new(&executable).current_dir(&install_dir).spawn() {
            Ok(_) => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            Err(error) => {
                self.error = Some(format!("无法启动 CetaMesh：{error}"));
            }
        }
    }

    fn show_header(&self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.heading("CetaMesh");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label("Windows 原生安装向导");
            });
        });
        ui.label("设置安装位置，一键完成安装。个人数据会保留在单独的数据目录中。");
        ui.add_space(10.0);
    }

    fn show_main(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        self.show_header(ui);
        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(egui::RichText::new("安装设置").strong());
            ui.add_space(8.0);
            ui.label("安装位置（可修改）");
            ui.add_enabled_ui(!self.active() && !self.finished, |ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.install_dir)
                        .desired_width(f32::INFINITY),
                );
            });
            ui.add_space(8.0);
            ui.label("数据目录（保留个人配置、令牌与状态）");
            ui.add(egui::Label::new(
                egui::RichText::new(self.data_dir.display().to_string()).monospace(),
            ).wrap());
            ui.add_space(10.0);
            if self.active() {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label(&self.status);
                });
                if self.phase == InstallPhase::Extracting {
                    if ui
                        .add_enabled(!self.cancel_requested, egui::Button::new("取消安装"))
                        .clicked()
                    {
                        self.request_cancel();
                    }
                } else {
                    ui.label("安装操作已开始；为避免中断文件事务，请等待其完成。可用窗口关闭按钮不会强制终止安装。");
                }
            } else {
                ui.label(&self.status);
            }
        });

        if !self.output.is_empty() {
            ui.add_space(10.0);
            ui.label(egui::RichText::new("安装进度").strong());
            egui::Frame::group(ui.style()).show(ui, |ui| {
                egui::ScrollArea::vertical()
                    .max_height(175.0)
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        for line in &self.output {
                            ui.label(line);
                        }
                    });
            });
        }

        if let Some(error) = &self.error {
            ui.add_space(10.0);
            egui::Frame::group(ui.style()).show(ui, |ui| {
                ui.colored_label(egui::Color32::from_rgb(180, 48, 70), error);
            });
        }

        ui.with_layout(egui::Layout::bottom_up(egui::Align::RIGHT), |ui| {
            ui.horizontal(|ui| {
                if self.finished && self.error.is_none() && self.status.contains("安装完成") {
                    if ui.button("启动 CetaMesh").clicked() {
                        self.launch_installed(ctx);
                    }
                    if ui.button("完成").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                } else if !self.active() && !self.finished {
                    if ui.button("退出").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    if ui.button("立即安装").clicked() {
                        self.confirm_open = true;
                    }
                } else if self.finished && self.error.is_some() {
                    if ui.button("关闭").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    if ui.button("重试").clicked() {
                        self.confirm_open = true;
                    }
                } else if self.finished && self.status.contains("安全取消") {
                    if ui.button("关闭").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                }
            });
        });
    }

    fn show_confirmation(&mut self, ctx: &egui::Context) {
        if !self.confirm_open {
            return;
        }
        egui::Window::new("确认安装")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .show(ctx, |ui| {
                ui.label("将 CetaMesh 程序文件安装到以下位置：");
                ui.add(egui::Label::new(self.install_dir.trim()).wrap());
                ui.add_space(6.0);
                ui.label("个人数据将保留在：");
                ui.add(egui::Label::new(self.data_dir.display().to_string()).wrap());
                ui.add_space(8.0);
                ui.label("继续后会按安装计划创建或更新应用文件，并由现有安装引擎负责备份与回滚。个人数据目录不会作为安装目标。是否继续？");
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if ui.button("返回修改").clicked() {
                        self.confirm_open = false;
                    }
                    if ui.button("确认并安装").clicked() {
                        self.confirm_open = false;
                        self.begin_install(ctx);
                    }
                });
            });
    }
}

impl eframe::App for InstallerApp {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let _ = frame;
        self.drain_events();
        let ctx = ui.ctx().clone();
        ui.add_space(10.0);
        self.show_main(ui, &ctx);
        self.show_confirmation(&ctx);

        let close_requested = ctx.input(|input| input.viewport().close_requested());
        if close_requested && self.active() {
            if self.phase == InstallPhase::Extracting {
                self.request_cancel();
            }
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        }
        if self.active() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }
    }
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = path_key(left);
    let right = path_key(right);
    is_path_within(&left, &right) || is_path_within(&right, &left)
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

struct InstallWork {
    shell_exe: PathBuf,
    payload_core: PathBuf,
    payload_archive: Option<PathBuf>,
    install_dir: PathBuf,
    data_dir: PathBuf,
    cancel_token: Arc<AtomicU8>,
}

fn execute_install(work: InstallWork, events: &mpsc::Sender<WorkerEvent>) -> Result<(), String> {
    let mut payload_core = work.payload_core.clone();
    if !payload_core.join(crate::installer::CORE_EXE_NAME).is_file() {
        let archive = work
            .payload_archive
            .as_ref()
            .filter(|path| path.is_file())
            .ok_or_else(|| "安装文件不完整，请重新下载 CetaMesh 安装程序后重试。".to_owned())?;
        let staging = create_payload_staging_dir()?;
        send_phase(events, InstallPhase::Extracting, "正在准备安装文件…");
        expand_archive(archive, &staging)?;
        if work.cancel_token.load(Ordering::SeqCst) == 2 {
            return Err("__CANCELLED__".to_owned());
        }
        payload_core = staging;
    }
    if !payload_core.join(crate::installer::CORE_EXE_NAME).is_file()
        || !payload_core.join("resources").is_dir()
    {
        return Err("安装文件不完整，请重新下载 CetaMesh 安装程序后重试。".to_owned());
    }
    if work
        .cancel_token
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("__CANCELLED__".to_owned());
    }

    send_phase(events, InstallPhase::Installing, "正在安装，请稍候…");
    let mut command = Command::new(&work.shell_exe);
    command
        .arg("--install")
        .arg("--install-dir")
        .arg(&work.install_dir)
        .arg("--data-dir")
        .arg(&work.data_dir)
        .arg("--payload-core")
        .arg(&payload_core)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output_tail = Arc::new(Mutex::new(VecDeque::new()));
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动安装：{error}"))?;
    let stdout_thread = relay_output(child.stdout.take(), events.clone(), output_tail.clone());
    let stderr_thread = relay_output(child.stderr.take(), events.clone(), output_tail.clone());
    let status = wait_for_child(&mut child)?;
    if let Some(reader) = stdout_thread {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_thread {
        let _ = reader.join();
    }
    if status.success() {
        Ok(())
    } else {
        let detail = output_tail
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        if detail.trim().is_empty() {
            Err(format!("安装失败（退出代码 {:?}）。", status.code()))
        } else {
            Err(detail)
        }
    }
}

fn create_payload_staging_dir() -> Result<PathBuf, String> {
    let base = env::temp_dir();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    for attempt in 0..32_u32 {
        let candidate = staging_dir_candidate(&base, std::process::id(), nonce, attempt);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建临时安装目录：{error}")),
        }
    }
    Err("无法分配唯一的临时安装目录，请稍后重试。".to_owned())
}

fn staging_dir_candidate(base: &Path, process_id: u32, nonce: u128, attempt: u32) -> PathBuf {
    base.join(format!(
        "WhaleBridgeInstallerPayload-{process_id}-{nonce}-{attempt}"
    ))
}

fn expand_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ARCHIVE_EXPAND_SCRIPT,
        ])
        .env("WHALEBRIDGE_INSTALL_ARCHIVE", archive)
        .env("WHALEBRIDGE_INSTALL_PAYLOAD", destination)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("无法展开安装文件：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if detail.is_empty() {
            "无法展开安装文件，请重新下载 CetaMesh 安装程序后重试。".to_owned()
        } else {
            format!("无法展开安装文件：{detail}")
        })
    }
}

fn relay_output(
    stream: Option<impl std::io::Read + Send + 'static>,
    events: mpsc::Sender<WorkerEvent>,
    tail: Arc<Mutex<VecDeque<String>>>,
) -> Option<thread::JoinHandle<()>> {
    stream.map(|stream| {
        thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Ok(mut lines) = tail.lock() {
                    lines.push_back(line.clone());
                    while lines.len() > 80 {
                        lines.pop_front();
                    }
                }
                let _ = events.send(WorkerEvent::Output(line));
            }
        })
    })
}

fn wait_for_child(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("读取安装进度失败：{error}")),
        }
    }
}

fn send_phase(events: &mpsc::Sender<WorkerEvent>, phase: InstallPhase, status: &str) {
    let _ = events.send(WorkerEvent::Phase(phase, status.to_owned()));
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_payload_paths_are_resolved_without_shell_interpolation() {
        let base = Path::new(r"C:\Program Files\WhaleBridge");
        assert_eq!(
            resolve_from_dir(PathBuf::from(r"payload\core"), base),
            base.join(r"payload\core")
        );
        assert_eq!(
            resolve_from_dir(PathBuf::from(r"D:\payload"), base),
            PathBuf::from(r"D:\payload")
        );
        assert!(!ARCHIVE_EXPAND_SCRIPT.contains("WHALEBRIDGE_INSTALL_ARCHIVE'"));
        assert!(!ARCHIVE_EXPAND_SCRIPT.contains("WHALEBRIDGE_INSTALL_PAYLOAD'"));
    }

    #[test]
    fn staging_directory_name_is_unique_per_invocation() {
        let base = Path::new(r"C:\Temp");
        let first = staging_dir_candidate(base, 17, 123, 0);
        let second = staging_dir_candidate(base, 17, 123, 1);
        assert_ne!(first, second);
    }
}
