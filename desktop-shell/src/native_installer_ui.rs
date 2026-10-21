//! 原生 eframe 安装向导（CetaMesh Setup 产品化 v1）。
//!
//! 页面：欢迎 → 安装位置 → 安装选项 → 安装过程 → 完成。单窗口分步布局，固定使用
//! CetaMesh Setup Theme（Paper 基座 + 强制减少动态），与桌面壳的正式视觉体系一致。
//!
//! 职责边界（不重写安装系统）：
//! - 实际安装仍由本程序的 `--install` CLI 和 installer 引擎完成（计划 / 快照 / 回滚不变）；
//! - 本文件负责：路径校验与浏览、选项、进度阶段、错误呈现与诊断、运行中应用的友好关闭；
//! - 所有子进程经 `supervisor::hidden`（CREATE_NO_WINDOW，无控制台窗口），执行全程写入
//!   安装日志文件（`%TEMP%\CetaMesh-Setup-*.log`），"不显示黑框"不等于"不记录错误"。
//! - 路径作为进程参数传递，不拼接进可执行命令字符串（保持既有安全约定）。

use std::collections::VecDeque;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use eframe::egui;

use crate::installer::{self, CORE_EXE_NAME, ExistingInstall, SHELL_EXE_NAME};
use crate::supervisor::hidden;
use crate::ui_prefs::{ReduceMotion, ThemePreference};

const WINDOW_TITLE: &str = "CetaMesh 安装程序";
const ARCHIVE_EXPAND_SCRIPT: &str = "Expand-Archive -LiteralPath $env:WHALEBRIDGE_INSTALL_ARCHIVE -DestinationPath $env:WHALEBRIDGE_INSTALL_PAYLOAD";

/// 用户可读的安装阶段（顺序即进度顺序；进度不造假：阶段 + 不确定进度条）。
const STAGE_PREPARE: &str = "准备安装文件";
const STAGE_COPY: &str = "安装应用文件";
const STAGE_SHORTCUT: &str = "创建快捷方式";
const STAGE_REGISTRY: &str = "注册系统信息";
const STAGE_FINALIZE: &str = "完成配置";
const STAGES: [&str; 5] = [
    STAGE_PREPARE,
    STAGE_COPY,
    STAGE_SHORTCUT,
    STAGE_REGISTRY,
    STAGE_FINALIZE,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WizardStep {
    Welcome,
    Location,
    Options,
    Progress,
    Finish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallPhase {
    Idle,
    Extracting,
    Installing,
}

enum WorkerEvent {
    Phase(InstallPhase, String),
    Stage(&'static str),
    Output(String),
    /// 检测到安装位置内有正在运行的 CetaMesh 进程：请 UI 询问用户是否关闭后继续。
    NeedsClose(usize),
    Finished(Result<(), String>),
}

enum PickerEvent {
    Picked(Option<PathBuf>),
}

fn clear_finished_worker(receiver: &mut Option<mpsc::Receiver<WorkerEvent>>, finished: bool) {
    if finished {
        receiver.take();
    }
}

// ------------------------------------------------------------------ 路径校验

/// 安装位置校验结果（纯逻辑，可单测；文件系统探测在 `validate_install_dir` 内完成）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PathCheck {
    Ready,
    Empty,
    NotAbsolute,
    OverlapsInstaller,
    NotWritable,
    NotEnoughSpace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PathValidation {
    pub check: PathCheck,
    pub message: String,
    pub required_bytes: u64,
    pub available_bytes: Option<u64>,
}

impl PathValidation {
    pub(crate) fn ready(&self) -> bool {
        self.check == PathCheck::Ready
    }
}

fn format_bytes(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= 1024 * MIB {
        format!("{:.1} GB", bytes as f64 / (1024.0 * MIB as f64))
    } else if bytes >= MIB {
        format!("{} MB", bytes / MIB)
    } else {
        format!("{} KB", bytes / 1024)
    }
}

/// 校验用户输入的安装目录：即时反馈，绝不等到安装到一半才报错。
pub(crate) fn validate_install_dir(
    input: &str,
    installer_dir: &Path,
    required_bytes: u64,
    available_bytes: Option<u64>,
) -> PathValidation {
    let value = input.trim();
    let mut validation = PathValidation {
        check: PathCheck::Empty,
        message: "请填写安装位置。".to_owned(),
        required_bytes,
        available_bytes,
    };
    if value.is_empty() {
        return validation;
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        validation.check = PathCheck::NotAbsolute;
        validation.message = "请填写完整的绝对路径（例如 D:\\应用\\CetaMesh）。".to_owned();
        return validation;
    }
    if paths_overlap(&path, installer_dir) {
        validation.check = PathCheck::OverlapsInstaller;
        validation.message = "安装位置不能位于安装程序所在目录中，请选择其他位置。".to_owned();
        return validation;
    }
    if let (Some(available), required) = (available_bytes, required_bytes) {
        if required > 0 && available < required {
            validation.check = PathCheck::NotEnoughSpace;
            validation.message = format!(
                "磁盘空间不足：需要约 {}，可用 {}。",
                format_bytes(required),
                format_bytes(available)
            );
            return validation;
        }
    }
    if !path_writable(&path) {
        validation.check = PathCheck::NotWritable;
        validation.message =
            "目录不可写：请换一个位置，或以管理员身份运行安装程序。".to_owned();
        return validation;
    }
    validation.check = PathCheck::Ready;
    validation.message = "可以安装".to_owned();
    validation
}

/// 探测目录可写性：可创建（或其父目录可创建）并能写入临时文件。
fn path_writable(path: &Path) -> bool {
    if fs::create_dir_all(path).is_err() {
        return false;
    }
    let probe = path.join(format!(".cetamesh-write-probe-{}", std::process::id()));
    match fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 目标所在卷的可用空间（Windows：取最近存在祖先卷的剩余空间）。
#[cfg(windows)]
fn available_space_bytes(path: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut probe = path.to_path_buf();
    loop {
        if probe.exists() {
            break;
        }
        if !probe.pop() {
            return None;
        }
    }
    let mut wide: Vec<u16> = probe.as_os_str().to_string_lossy().encode_utf16().collect();
    wide.push(0);
    let mut free: u64 = 0;
    // SAFETY: NUL-terminated wide path; we pass a valid out-pointer for free bytes and null
    // for the optional totals; all pointers stay valid for the call.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 { None } else { Some(free) }
}

#[cfg(not(windows))]
fn available_space_bytes(_path: &Path) -> Option<u64> {
    None
}

/// 安装所需的磁盘空间：桌面壳 exe + payload 全部文件（+ 可选压缩包）。
fn payload_required_bytes(shell_exe: &Path, payload_core: &Path, archive: Option<&Path>) -> u64 {
    let mut total = fs::metadata(shell_exe).map(|meta| meta.len()).unwrap_or(0);
    if let Some(archive) = archive {
        total += fs::metadata(archive).map(|meta| meta.len()).unwrap_or(0);
    }
    fn walk(dir: &Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, total);
            } else if let Ok(meta) = entry.metadata() {
                *total += meta.len();
            }
        }
    }
    walk(payload_core, &mut total);
    total
}

/// 把 `[stage]` 行映射为用户可读阶段。
fn stage_label(line: &str) -> Option<&'static str> {
    let detail = line.strip_prefix("[stage] ")?;
    if detail.starts_with("复制") {
        Some(STAGE_COPY)
    } else if detail.starts_with("替换目录") {
        Some(STAGE_COPY)
    } else if detail.starts_with("创建快捷方式") {
        Some(STAGE_SHORTCUT)
    } else if detail.starts_with("写注册表") || detail.starts_with("删注册表") {
        Some(STAGE_REGISTRY)
    } else if detail.starts_with("写入") {
        Some(STAGE_FINALIZE)
    } else if detail.starts_with("执行") {
        Some(STAGE_REGISTRY)
    } else {
        Some(STAGE_FINALIZE)
    }
}

// ------------------------------------------------------------------ 启动

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
    let data_dir = resolve_data_dir(&shell_dir);

    // 既有安装检测：注册表 InstallLocation → 安装包所在目录 → 默认目录。
    let default_dir = crate::default_install_dir();
    let existing = installer::find_existing_install(installer::UNINSTALL_KEY, &shell_dir, &default_dir);
    let initial_dir = existing
        .as_ref()
        .map(|found| found.install_dir.clone())
        .unwrap_or(default_dir);
    let current_version = product_version(&payload_core, &shell_dir);
    let required_bytes = payload_required_bytes(&shell_exe, &payload_core, payload_archive.as_deref());

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_icon(eframe::icon_data::from_png_bytes(include_bytes!("../icons/128x128.png"))
                .expect("bundled CetaMesh installer icon"))
            .with_inner_size([720.0, 560.0])
            .with_min_inner_size([680.0, 520.0])
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
                initial_dir,
                data_dir,
                existing,
                current_version,
                required_bytes,
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
    if staged.join(CORE_EXE_NAME).is_file() {
        return staged;
    }
    let development = shell_dir
        .parent()
        .map(|parent| parent.join("dist").join("core"))
        .unwrap_or_default();
    if development.join(CORE_EXE_NAME).is_file() {
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

/// 安装包版本：优先 payload 里的 product.json / runtime-manifest.json。
fn product_version(payload_core: &Path, shell_dir: &Path) -> String {
    for candidate in [
        payload_core.join("resources").join("product.json"),
        payload_core.join("runtime-manifest.json"),
        shell_dir.join("resources").join("product.json"),
        shell_dir.join("payload").join("resources").join("product.json"),
    ] {
        if let Ok(text) = fs::read_to_string(&candidate) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(version) = value.get("version").and_then(|item| item.as_str()) {
                    return version.to_owned();
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_owned()
}

// ------------------------------------------------------------------ 应用状态

struct InstallerApp {
    shell_exe: PathBuf,
    shell_dir: PathBuf,
    payload_core: PathBuf,
    payload_archive: Option<PathBuf>,
    data_dir: PathBuf,
    install_dir: String,
    existing: Option<ExistingInstall>,
    current_version: String,
    required_bytes: u64,
    step: WizardStep,
    desktop_shortcut: bool,
    launch_after: bool,
    dsh_integration: bool,
    validation: Option<PathValidation>,
    validated_input: String,
    picker_open: bool,
    picker_rx: Option<mpsc::Receiver<PickerEvent>>,
    phase: InstallPhase,
    status: String,
    stages_seen: Vec<&'static str>,
    current_stage: Option<&'static str>,
    error: Option<String>,
    finished_ok: bool,
    cancelled: bool,
    show_details: bool,
    cancel_requested: bool,
    cancel_token: Option<Arc<AtomicU8>>,
    close_answer: Option<mpsc::Sender<bool>>,
    close_prompt: Option<usize>,
    event_rx: Option<mpsc::Receiver<WorkerEvent>>,
    output: VecDeque<String>,
    log_path: PathBuf,
    centered: bool,
    copied_notice: Option<SystemTime>,
}

impl InstallerApp {
    #[allow(clippy::too_many_arguments)]
    fn new(
        shell_exe: PathBuf,
        shell_dir: PathBuf,
        payload_core: PathBuf,
        payload_archive: Option<PathBuf>,
        install_dir: PathBuf,
        data_dir: PathBuf,
        existing: Option<ExistingInstall>,
        current_version: String,
        required_bytes: u64,
    ) -> Self {
        let log_path = env::temp_dir().join(format!(
            "CetaMesh-Setup-{}-{}.log",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or_default()
        ));
        let upgrade = existing.is_some();
        let mut app = Self {
            shell_exe,
            shell_dir,
            payload_core,
            payload_archive,
            data_dir,
            install_dir: install_dir.to_string_lossy().into_owned(),
            existing,
            current_version,
            required_bytes,
            step: WizardStep::Welcome,
            desktop_shortcut: true,
            launch_after: true,
            dsh_integration: true,
            validation: None,
            validated_input: String::new(),
            picker_open: false,
            picker_rx: None,
            phase: InstallPhase::Idle,
            status: if upgrade {
                "检测到既有安装：将更新到新版本。".to_owned()
            } else {
                "检查安装位置后即可开始。".to_owned()
            },
            stages_seen: Vec::new(),
            current_stage: None,
            error: None,
            finished_ok: false,
            cancelled: false,
            show_details: false,
            cancel_requested: false,
            cancel_token: None,
            close_answer: None,
            close_prompt: None,
            event_rx: None,
            output: VecDeque::new(),
            log_path,
            centered: false,
            copied_notice: None,
        };
        app.log(&format!(
            "CetaMesh Setup 日志 {}（安装程序 {}）",
            app.current_version,
            env!("CARGO_PKG_VERSION")
        ));
        app
    }

    fn log(&mut self, line: &str) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    fn active(&self) -> bool {
        matches!(self.phase, InstallPhase::Extracting | InstallPhase::Installing)
    }

    fn worker_running(&self) -> bool {
        self.event_rx.is_some()
    }

    fn refresh_validation(&mut self) {
        self.validated_input = self.install_dir.clone();
        let available = available_space_bytes(Path::new(self.install_dir.trim()));
        self.validation = Some(validate_install_dir(
            &self.install_dir,
            &self.shell_dir,
            self.required_bytes,
            available,
        ));
    }

    fn validation_missing(&self) -> bool {
        self.validation.is_none() || self.validated_input != self.install_dir
    }

    fn begin_pick_folder(&mut self, ctx: &egui::Context) {
        if self.picker_open {
            return;
        }
        let (tx, rx) = mpsc::channel();
        self.picker_rx = Some(rx);
        self.picker_open = true;
        let start = {
            let current = self.install_dir.trim();
            let path = PathBuf::from(current);
            if path.is_dir() {
                path
            } else {
                path.parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| self.shell_dir.clone())
            }
        };
        thread::spawn(move || {
            let picked = rfd::FileDialog::new()
                .set_title("选择 CetaMesh 安装位置")
                .set_directory(&start)
                .pick_folder();
            let _ = tx.send(PickerEvent::Picked(picked));
        });
        ctx.request_repaint();
    }

    fn drain_picker(&mut self) {
        let Some(receiver) = &self.picker_rx else {
            return;
        };
        match receiver.try_recv() {
            Ok(PickerEvent::Picked(Some(path))) => {
                self.install_dir = path.to_string_lossy().into_owned();
                self.picker_open = false;
                self.picker_rx = None;
                self.refresh_validation();
            }
            Ok(PickerEvent::Picked(None)) => {
                // 用户取消选择：保留原值。
                self.picker_open = false;
                self.picker_rx = None;
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => {
                self.picker_open = false;
                self.picker_rx = None;
            }
        }
    }

    fn begin_install(&mut self, ctx: &egui::Context) {
        let install_dir = PathBuf::from(self.install_dir.trim());
        self.step = WizardStep::Progress;
        self.phase = if self.core_payload_ready() {
            InstallPhase::Installing
        } else {
            InstallPhase::Extracting
        };
        self.stages_seen.clear();
        self.current_stage = Some(STAGE_PREPARE);
        self.status = "正在准备安装文件…".to_owned();
        self.error = None;
        self.finished_ok = false;
        self.cancelled = false;
        self.output.clear();
        self.cancel_requested = false;

        let (event_tx, event_rx) = mpsc::channel();
        let (close_tx, close_rx) = mpsc::channel();
        // 0 = 可安全取消（尚未运行安装 CLI），1 = 安装 CLI 已获准启动，2 = 已取消。
        let cancel_token = Arc::new(AtomicU8::new(0));
        self.cancel_token = Some(cancel_token.clone());
        self.close_answer = Some(close_tx);
        self.event_rx = Some(event_rx);

        let work = InstallWork {
            shell_exe: self.shell_exe.clone(),
            payload_core: self.payload_core.clone(),
            payload_archive: self.payload_archive.clone(),
            install_dir,
            data_dir: self.data_dir.clone(),
            desktop_shortcut: self.desktop_shortcut,
            dsh_integration: self.dsh_integration,
            cancel_token,
        };
        let exit_dir = self.shell_dir.clone();
        thread::spawn(move || {
            let result = execute_install(work, &event_tx, &close_rx, &exit_dir);
            let _ = event_tx.send(WorkerEvent::Finished(result));
        });
        self.log(&format!("开始安装到 {}", self.install_dir.trim()));
        ctx.request_repaint();
    }

    fn core_payload_ready(&self) -> bool {
        self.payload_core
            .join(CORE_EXE_NAME)
            .is_file()
            && self.payload_core.join("resources").is_dir()
    }

    fn drain_events(&mut self) {
        let Some(receiver) = &self.event_rx else {
            return;
        };
        let mut lines = Vec::new();
        let mut finished = false;
        while let Ok(event) = receiver.try_recv() {
            match event {
                WorkerEvent::Phase(phase, status) => {
                    self.phase = phase;
                    self.status = status.clone();
                    lines.push(status);
                }
                WorkerEvent::Stage(stage) => {
                    if self.current_stage != Some(stage) {
                        self.current_stage = Some(stage);
                        if !self.stages_seen.contains(&stage) {
                            self.stages_seen.push(stage);
                        }
                    }
                }
                WorkerEvent::Output(line) => {
                    if let Some(stage) = stage_label(&line) {
                        if self.current_stage != Some(stage) {
                            self.current_stage = Some(stage);
                            if !self.stages_seen.contains(&stage) {
                                self.stages_seen.push(stage);
                            }
                        }
                    }
                    self.output.push_back(line.clone());
                    while self.output.len() > 400 {
                        self.output.pop_front();
                    }
                    lines.push(line);
                }
                WorkerEvent::NeedsClose(count) => {
                    self.close_prompt = Some(count);
                    self.status = "需要先关闭正在运行的 CetaMesh。".to_owned();
                }
                WorkerEvent::Finished(result) => {
                    finished = true;
                    self.phase = InstallPhase::Idle;
                    self.cancel_token = None;
                    self.close_answer = None;
                    self.close_prompt = None;
                    match result {
                        Ok(()) => {
                            self.finished_ok = true;
                            self.status = "安装完成".to_owned();
                            self.step = WizardStep::Finish;
                            lines.push("安装完成".to_owned());
                        }
                        Err(error) if error == "__CANCELLED__" => {
                            self.cancelled = true;
                            self.status = "已取消安装".to_owned();
                            self.step = WizardStep::Finish;
                            lines.push("已取消安装；未对系统做任何改动".to_owned());
                        }
                        Err(error) => {
                            let rolled_back = error.contains("回滚");
                            self.status = if rolled_back {
                                "安装未完成，已恢复到安装前状态。".to_owned()
                            } else {
                                "安装未完成。".to_owned()
                            };
                            self.error = Some(error.clone());
                            self.step = WizardStep::Progress;
                            lines.push(format!("安装失败：{error}"));
                        }
                    }
                }
            }
        }
        for line in lines {
            self.log(&line);
        }
        clear_finished_worker(&mut self.event_rx, finished);
    }

    fn answer_close_prompt(&mut self, proceed: bool, ctx: &egui::Context) {
        if let Some(sender) = self.close_answer.take() {
            let _ = sender.send(proceed);
        }
        self.close_prompt = None;
        if proceed {
            self.phase = InstallPhase::Installing;
            self.status = "正在关闭 CetaMesh 并继续安装…".to_owned();
        } else {
            self.status = "已取消。".to_owned();
        }
        ctx.request_repaint();
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
        let executable = install_dir.join(SHELL_EXE_NAME);
        if !executable.is_file() {
            self.error = Some(format!("找不到已安装的 CetaMesh 程序：{}", executable.display()));
            return;
        }
        match std::process::Command::new(&executable)
            .current_dir(&install_dir)
            .spawn()
        {
            Ok(_) => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            Err(error) => {
                self.error = Some(format!("无法启动 CetaMesh：{error}"));
            }
        }
    }

    fn diagnostics(&self) -> String {
        let mut text = String::new();
        text.push_str(&format!("CetaMesh Setup {} 诊断信息\n", env!("CARGO_PKG_VERSION")));
        text.push_str(&format!("目标版本：{}\n", self.current_version));
        text.push_str(&format!("安装位置：{}\n", self.install_dir.trim()));
        text.push_str(&format!("数据目录：{}\n", self.data_dir.display()));
        text.push_str(&format!("安装程序：{}\n", self.shell_dir.display()));
        if let Some(error) = &self.error {
            text.push_str(&format!("错误：{error}\n"));
        }
        text.push_str("最近输出：\n");
        for line in &self.output {
            text.push_str(line);
            text.push('\n');
        }
        text
    }

    // ------------------------------------------------------------- 页面

    fn show_brand(&self, ui: &mut egui::Ui) {
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.heading(egui::RichText::new("CetaMesh").strong());
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new("Intelligent Collaboration")
                    .color(crate::theme::tokens().text_3.to_color32())
                    .size(12.0),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let (step, total) = match self.step {
                    WizardStep::Welcome => (1, 4),
                    WizardStep::Location => (2, 4),
                    WizardStep::Options => (3, 4),
                    WizardStep::Progress => (4, 4),
                    WizardStep::Finish => (4, 4),
                };
                ui.label(
                    egui::RichText::new(format!("第 {step} 步 / 共 {total} 步"))
                        .color(crate::theme::tokens().text_3.to_color32())
                        .size(12.0),
                );
            });
        });
        ui.label(
            egui::RichText::new("连接模型、Agent、工具、记忆和设备的智能协作网络")
                .color(crate::theme::tokens().text_3.to_color32())
                .size(13.0),
        );
        ui.add_space(14.0);
    }

    fn show_step_indicator(&self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            for (index, label) in ["欢迎", "安装位置", "安装选项", "安装"].iter().enumerate() {
                let active = match self.step {
                    WizardStep::Welcome => index == 0,
                    WizardStep::Location => index == 1,
                    WizardStep::Options => index == 2,
                    WizardStep::Progress | WizardStep::Finish => index == 3,
                };
                let color = if active {
                    crate::theme::tokens().accent.to_color32()
                } else {
                    crate::theme::tokens().text_3.to_color32()
                };
                ui.label(egui::RichText::new(*label).color(color).size(12.5));
                if index < 3 {
                    ui.label(
                        egui::RichText::new("›")
                            .color(crate::theme::tokens().text_3.to_color32())
                            .size(12.5),
                    );
                }
            }
        });
        ui.add_space(10.0);
    }

    fn show_welcome(&mut self, ui: &mut egui::Ui) {
        crate::theme::card(ui, |ui| {
            ui.set_min_width(ui.available_width());
            match &self.existing {
                Some(found) => {
                    ui.label(
                        egui::RichText::new(format!("更新 CetaMesh {}", self.current_version))
                            .strong()
                            .size(17.0),
                    );
                    ui.add_space(6.0);
                    ui.label(format!(
                        "已安装版本：{}",
                        if found.version.is_empty() {
                            "未知"
                        } else {
                            &found.version
                        }
                    ));
                    ui.label(format!("即将更新到：{}", self.current_version));
                    ui.label(format!("安装位置：{}", found.install_dir.display()));
                    ui.add_space(6.0);
                    ui.label(
                        egui::RichText::new("将保留个人数据与配置；安装位置沿用既有安装。")
                            .color(crate::theme::tokens().text_3.to_color32()),
                    );
                }
                None => {
                    ui.label(
                        egui::RichText::new(format!("CetaMesh {}", self.current_version))
                            .strong()
                            .size(17.0),
                    );
                    ui.add_space(6.0);
                    ui.label("安装 CetaMesh 桌面应用：连接模型、Agent、工具、记忆和设备。");
                    ui.label(format!(
                        "安装大约需要 {} 磁盘空间。",
                        format_bytes(self.required_bytes)
                    ));
                    ui.label("支持 Windows 10 / 11（x64）；安装到当前用户目录，无需管理员权限。");
                }
            }
        });
        ui.add_space(10.0);
        ui.label(
            egui::RichText::new("本次安装不会删除或覆盖任何个人数据。")
                .color(crate::theme::tokens().text_3.to_color32())
                .size(12.5),
        );
    }

    fn show_location(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.validation_missing() {
            self.refresh_validation();
        }
        crate::theme::card(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(egui::RichText::new("安装到：").strong());
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                let browse_width = 86.0;
                ui.add(
                    egui::TextEdit::singleline(&mut self.install_dir)
                        .desired_width((ui.available_width() - browse_width - 8.0).max(160.0))
                        .hint_text("安装位置（完整路径）"),
                );
                let browse = ui.add_enabled(!self.picker_open, egui::Button::new("浏览…"));
                if browse.clicked() {
                    self.begin_pick_folder(ctx);
                }
            });
            if self.picker_open {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("正在打开文件夹选择器…");
                });
            }
            ui.add_space(8.0);
            if let Some(validation) = &self.validation {
                let (color, prefix) = match validation.check {
                    PathCheck::Ready => (egui::Color32::from_rgb(46, 125, 70), "✓"),
                    PathCheck::Empty => (crate::theme::tokens().text_3.to_color32(), "·"),
                    _ => (egui::Color32::from_rgb(178, 106, 0), "⚠"),
                };
                ui.colored_label(color, format!("{prefix} {}", validation.message));
                if let (Some(available), required) = (validation.available_bytes, validation.required_bytes)
                {
                    if required > 0 {
                        ui.label(
                            egui::RichText::new(format!(
                                "所需空间：{}　可用空间：{}",
                                format_bytes(required),
                                format_bytes(available)
                            ))
                            .color(crate::theme::tokens().text_3.to_color32())
                            .size(12.5),
                        );
                    }
                }
            }
            if let Some(found) = &self.existing {
                if Path::new(self.install_dir.trim()) != found.install_dir {
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(format!(
                            "提示：已安装的 CetaMesh 位于 {}；改到新位置会安装一份新的，不会迁移既有数据。",
                            found.install_dir.display()
                        ))
                        .color(egui::Color32::from_rgb(178, 106, 0))
                        .size(12.5),
                    );
                }
            }
        });
    }

    fn show_options(&mut self, ui: &mut egui::Ui) {
        crate::theme::card(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(egui::RichText::new("安装选项").strong());
            ui.add_space(6.0);
            ui.checkbox(&mut self.desktop_shortcut, "创建桌面快捷方式");
            ui.horizontal(|ui| {
                let mut start_menu = true;
                ui.add_enabled(false, egui::Checkbox::new(&mut start_menu, "添加到开始菜单"));
                ui.label(
                    egui::RichText::new("（含卸载入口，始终创建）")
                        .color(crate::theme::tokens().text_3.to_color32())
                        .size(12.0),
                );
            });
            ui.checkbox(&mut self.launch_after, "安装完成后启动 CetaMesh");
        });
        ui.add_space(8.0);
        crate::theme::card(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.collapsing("高级选项", |ui| {
                ui.label("数据目录（保留个人配置、state 与日志）");
                ui.label(
                    egui::RichText::new(self.data_dir.display().to_string())
                        .monospace()
                        .size(12.5),
                );
                ui.add_space(4.0);
                ui.checkbox(&mut self.dsh_integration, "注册 DSH 集成（可稍后用 --repair 重试）");
            });
        });
    }

    fn show_progress(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        crate::theme::card(ui, |ui| {
            ui.set_min_width(ui.available_width());
            if let Some(error) = self.error.clone() {
                ui.label(
                    egui::RichText::new("安装未完成")
                        .strong()
                        .size(16.0)
                        .color(egui::Color32::from_rgb(176, 48, 70)),
                );
                ui.add_space(4.0);
                ui.label("无法完成 CetaMesh 安装。安装引擎已按快照回滚，个人数据未被删除。");
                ui.add_space(6.0);
                ui.label(egui::RichText::new(&self.status).strong());
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    if ui.button("重试").clicked() {
                        self.begin_install(ctx);
                    }
                    if ui.button("查看详细信息").clicked() {
                        self.show_details = !self.show_details;
                    }
                    if ui.button("复制诊断信息").clicked() {
                        ctx.copy_text(self.diagnostics());
                        self.copied_notice = Some(SystemTime::now());
                    }
                    if ui.button("关闭").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                });
                if self.copied_notice.is_some() {
                    ui.label(
                        egui::RichText::new("诊断信息已复制到剪贴板。")
                            .color(crate::theme::tokens().text_3.to_color32())
                            .size(12.0),
                    );
                }
                ui.add_space(2.0);
                ui.label(
                    egui::RichText::new(format!("日志：{}", self.log_path.display()))
                        .color(crate::theme::tokens().text_3.to_color32())
                        .size(12.0),
                );
                if self.show_details {
                    ui.add_space(6.0);
                    let mut text = error.clone();
                    text.push('\n');
                    for line in &self.output {
                        text.push_str(line);
                        text.push('\n');
                    }
                    egui::ScrollArea::vertical()
                        .max_height(160.0)
                        .stick_to_bottom(true)
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::multiline(&mut text.as_str())
                                    .desired_width(f32::INFINITY)
                                    .code_editor(),
                            );
                        });
                }
            } else {
                ui.label(egui::RichText::new("正在安装 CetaMesh").strong().size(16.0));
                ui.add_space(8.0);
                ui.add(egui::ProgressBar::new(0.0).animate(true));
                ui.add_space(10.0);
                // 阶段清单：已完成打勾、当前高亮、未到灰显（不造假进度）。
                for stage in STAGES {
                    let seen = self.stages_seen.contains(&stage);
                    let current = self.current_stage == Some(stage);
                    let (mark, color) = if current {
                        ("●", crate::theme::tokens().accent.to_color32())
                    } else if seen {
                        ("✓", egui::Color32::from_rgb(46, 125, 70))
                    } else {
                        ("○", crate::theme::tokens().text_3.to_color32())
                    };
                    ui.label(egui::RichText::new(format!("{mark} {stage}")).color(color));
                }
                ui.add_space(8.0);
                ui.label(
                    egui::RichText::new(&self.status)
                        .color(crate::theme::tokens().text_3.to_color32())
                        .size(12.5),
                );
                if self.phase == InstallPhase::Extracting {
                    if ui
                        .add_enabled(!self.cancel_requested, egui::Button::new("取消安装"))
                        .clicked()
                    {
                        self.request_cancel();
                    }
                } else {
                    ui.label(
                        egui::RichText::new("正在完成安装，请勿关闭窗口。")
                            .color(crate::theme::tokens().text_3.to_color32())
                            .size(12.5),
                    );
                }
                if self.show_details {
                    ui.add_space(6.0);
                    egui::ScrollArea::vertical()
                        .max_height(120.0)
                        .stick_to_bottom(true)
                        .show(ui, |ui| {
                            for line in &self.output {
                                ui.label(egui::RichText::new(line).monospace().size(11.5));
                            }
                        });
                } else {
                    ui.add_space(2.0);
                    if ui
                        .button(egui::RichText::new("查看详细信息").size(12.0))
                        .clicked()
                    {
                        self.show_details = true;
                    }
                }
            }
        });
    }

    fn show_finish(&mut self, ui: &mut egui::Ui) {
        crate::theme::card(ui, |ui| {
            ui.set_min_width(ui.available_width());
            if self.finished_ok {
                ui.label(
                    egui::RichText::new("CetaMesh 已安装")
                        .strong()
                        .size(17.0)
                        .color(egui::Color32::from_rgb(46, 125, 70)),
                );
                ui.add_space(6.0);
                ui.label(format!("版本：{}", self.current_version));
                ui.label(format!("安装位置：{}", self.install_dir.trim()));
                ui.add_space(8.0);
                ui.checkbox(&mut self.launch_after, "启动 CetaMesh");
            } else if self.cancelled {
                ui.label(egui::RichText::new("已取消安装").strong().size(17.0));
                ui.add_space(6.0);
                ui.label("未对系统做任何改动。");
            }
        });
    }

    fn show_close_prompt(&mut self, ctx: &egui::Context) {
        let Some(count) = self.close_prompt else {
            return;
        };
        egui::Window::new("CetaMesh 正在运行")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .show(ctx, |ui| {
                ui.label(format!(
                    "检测到 {count} 个正在运行的 CetaMesh 进程。"
                ));
                ui.label("安装程序需要先关闭应用才能继续（会先请求应用正常退出）。");
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if ui.button("关闭并继续").clicked() {
                        let ctx = ui.ctx().clone();
                        self.answer_close_prompt(true, &ctx);
                    }
                    if ui.button("取消").clicked() {
                        let ctx = ui.ctx().clone();
                        self.answer_close_prompt(false, &ctx);
                    }
                });
            });
    }

    fn show_nav(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            match self.step {
                WizardStep::Welcome => {
                    if ui.button("取消").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("继续").clicked() {
                            self.step = WizardStep::Location;
                            self.refresh_validation();
                        }
                    });
                }
                WizardStep::Location => {
                    if ui.button("后退").clicked() {
                        self.step = WizardStep::Welcome;
                    }
                    if ui.button("取消").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let ready = self
                            .validation
                            .as_ref()
                            .map(PathValidation::ready)
                            .unwrap_or(false)
                            && !self.picker_open;
                        if ui.add_enabled(ready, egui::Button::new("继续")).clicked() {
                            self.step = WizardStep::Options;
                        }
                    });
                }
                WizardStep::Options => {
                    if ui.button("后退").clicked() {
                        self.step = WizardStep::Location;
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("安装").clicked() {
                            self.begin_install(ctx);
                        }
                    });
                }
                WizardStep::Progress => {
                    if self.error.is_some() || self.cancelled {
                        return;
                    }
                    ui.label(
                        egui::RichText::new("安装期间请保持窗口打开")
                            .color(crate::theme::tokens().text_3.to_color32())
                            .size(12.0),
                    );
                }
                WizardStep::Finish => {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("完成").clicked() {
                            if self.finished_ok && self.launch_after {
                                self.launch_installed(ctx);
                            } else {
                                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                            }
                        }
                    });
                }
            }
        });
    }
}

impl eframe::App for InstallerApp {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let _ = frame;
        let ctx = ui.ctx().clone();

        // CetaMesh Setup Theme：Paper 基座 + 强制减少动态（稳定 / 轻量 / 快）。
        let outcome = crate::theme::begin_frame(
            &ctx,
            ThemePreference::Paper,
            false,
            ReduceMotion::On,
            true,
        );
        if outcome.spec_changed {
            let spec = crate::theme::current();
            ctx.set_theme(if spec.dark {
                egui::Theme::Dark
            } else {
                egui::Theme::Light
            });
            ctx.set_global_style(crate::theme::style(&spec));
        }
        crate::theme::paint_background(&ctx);

        if !self.centered {
            self.centered = true;
            if let Some(monitor) = ctx.input(|input| input.viewport().monitor_size) {
                let size = ctx.input(|input| input.viewport().inner_rect.map(|rect| rect.size()));
                if let Some(size) = size {
                    let position = egui::pos2(
                        ((monitor.x - size.x) * 0.5).max(0.0),
                        ((monitor.y - size.y) * 0.5).max(0.0),
                    );
                    ctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(position));
                }
            }
        }

        self.drain_picker();
        self.drain_events();

        // Esc：安全取消 / 关闭；安装进行中不响应，防止误触。
        if ctx.input(|input| input.key_pressed(egui::Key::Escape))
            && !self.active()
            && self.close_prompt.is_none()
        {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        // Enter：在欢迎/完成页推进（输入框聚焦时不拦截）。
        if ctx.input(|input| input.key_pressed(egui::Key::Enter))
            && !ctx.egui_wants_keyboard_input()
            && self.close_prompt.is_none()
        {
            match self.step {
                WizardStep::Welcome => {
                    self.step = WizardStep::Location;
                    self.refresh_validation();
                }
                WizardStep::Finish => {
                    if self.finished_ok && self.launch_after {
                        self.launch_installed(&ctx);
                    } else {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                }
                _ => {}
            }
        }

        ui.add_space(10.0);
        self.show_brand(ui);
        self.show_step_indicator(ui);
        match self.step {
            WizardStep::Welcome => self.show_welcome(ui),
            WizardStep::Location => self.show_location(ui, &ctx),
            WizardStep::Options => self.show_options(ui),
            WizardStep::Progress => self.show_progress(ui, &ctx),
            WizardStep::Finish => self.show_finish(ui),
        }
        self.show_close_prompt(&ctx);
        self.show_nav(ui, &ctx);

        let close_requested = ctx.input(|input| input.viewport().close_requested());
        if close_requested && (self.active() || self.worker_running()) {
            if self.phase == InstallPhase::Extracting {
                self.request_cancel();
            }
            if self.close_prompt.is_some() {
                if let Some(sender) = self.close_answer.take() {
                    let _ = sender.send(false);
                }
                self.close_prompt = None;
            }
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        }
        if self.active() || self.worker_running() || self.picker_open {
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

// ------------------------------------------------------------------ 安装执行

struct InstallWork {
    shell_exe: PathBuf,
    payload_core: PathBuf,
    payload_archive: Option<PathBuf>,
    install_dir: PathBuf,
    data_dir: PathBuf,
    desktop_shortcut: bool,
    dsh_integration: bool,
    cancel_token: Arc<AtomicU8>,
}

/// 安装位置内正在运行的进程（按可执行文件路径精确匹配，绝不按名字模糊查杀）。
fn running_processes_under(dir: &Path) -> Vec<u32> {
    let target = dir
        .to_string_lossy()
        .to_lowercase()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_owned();
    if target.is_empty() {
        return Vec::new();
    }
    let script = format!(
        "@(Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -and \
         $_.ExecutablePath.ToLower().StartsWith('{}') }}).ProcessId",
        target.replace('\'', "''")
    );
    let output = hidden("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(result) => String::from_utf8_lossy(&result.stdout)
            .split_whitespace()
            .filter_map(|value| value.parse::<u32>().ok())
            .filter(|pid| *pid != std::process::id())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 请求运行中的 CetaMesh 优雅退出（命名事件，等价于托盘“退出”）。
/// 旧版本应用不监听该事件，此时靠超时后的有界强杀兜底。
fn signal_graceful_quit() {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

        let event_name = format!(
            "Local\\CetaMesh.Desktop.QuitRequest{}",
            crate::tray::instance_suffix()
        );
        let mut wide: Vec<u16> = std::ffi::OsStr::new(&event_name).encode_wide().collect();
        wide.push(0);
        // SAFETY: NUL-terminated UTF-16 name; default attributes; the handle is closed below.
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, wide.as_ptr()) };
        if !event.is_null() {
            // SAFETY: signaling an event handle we own.
            unsafe {
                SetEvent(event);
                CloseHandle(event);
            }
        }
    }
}

/// 有界强杀（仅本安装目录内的进程；隐藏执行）。
fn force_stop_processes(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "Stop-Process -Id {list} -Force -ErrorAction SilentlyContinue"
    );
    let _ = hidden("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn execute_install(
    work: InstallWork,
    events: &mpsc::Sender<WorkerEvent>,
    close_rx: &mpsc::Receiver<bool>,
    installer_dir: &Path,
) -> Result<(), String> {
    // 1) 运行中的 CetaMesh：先问用户，再优雅关闭，超时有界强杀。
    let running = running_processes_under(&work.install_dir);
    if !running.is_empty() {
        let _ = events.send(WorkerEvent::NeedsClose(running.len()));
        match close_rx.recv() {
            Ok(true) => {}
            _ => return Err("__CANCELLED__".to_owned()),
        }
        let _ = events.send(WorkerEvent::Phase(
            InstallPhase::Installing,
            "正在关闭 CetaMesh…".to_owned(),
        ));
        signal_graceful_quit();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = running_processes_under(&work.install_dir);
            if remaining.is_empty() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                force_stop_processes(&remaining);
                break;
            }
            std::thread::sleep(Duration::from_millis(400));
        }
        let _ = events.send(WorkerEvent::Output(
            "已请求关闭运行中的 CetaMesh，正在确认安装文件可替换…".to_owned(),
        ));
    }

    // 2) 准备 payload（必要时展开压缩包）。
    let mut payload_core = work.payload_core.clone();
    if !payload_core.join(CORE_EXE_NAME).is_file() {
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
    if !payload_core.join(CORE_EXE_NAME).is_file() || !payload_core.join("resources").is_dir() {
        return Err("安装文件不完整，请重新下载 CetaMesh 安装程序后重试。".to_owned());
    }
    if work
        .cancel_token
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("__CANCELLED__".to_owned());
    }

    // 3) 运行安装 CLI（隐藏控制台；stdout/stderr 进日志与详情）。
    send_phase(events, InstallPhase::Installing, "正在安装，请稍候…");
    let mut command = hidden(&work.shell_exe);
    command
        .arg("--install")
        .arg("--install-dir")
        .arg(&work.install_dir)
        .arg("--data-dir")
        .arg(&work.data_dir)
        .arg("--payload-core")
        .arg(&payload_core);
    if !work.desktop_shortcut {
        command.arg("--no-desktop-shortcut");
    }
    if !work.dsh_integration {
        command.arg("--no-dsh-integration");
    }
    // 引擎侧的兜底：仍有本安装目录的进程占用文件时由 --stop-core 收尾。
    command.arg("--stop-core");
    command
        .current_dir(installer_dir)
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
            // 只带最后几行，避免把整段输出塞进错误摘要（完整输出在“详细信息”）。
            let tail: Vec<String> = detail.lines().rev().take(6).map(str::to_owned).collect();
            let mut lines = tail.into_iter().rev().collect::<Vec<_>>();
            if lines.len() < detail.lines().count() {
                lines.insert(0, "（完整输出见“详细信息”与日志文件）".to_owned());
            }
            Err(lines.join("\n"))
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
        "CetaMeshSetupPayload-{process_id}-{nonce}-{attempt}"
    ))
}

fn expand_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    let mut command = hidden("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ARCHIVE_EXPAND_SCRIPT,
        ])
        .env("WHALEBRIDGE_INSTALL_ARCHIVE", archive)
        .env("WHALEBRIDGE_INSTALL_PAYLOAD", destination)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
                if let Some(stage) = stage_label(&line) {
                    let _ = events.send(WorkerEvent::Stage(stage));
                    continue;
                }
                let _ = events.send(WorkerEvent::Output(line));
            }
        })
    })
}

fn wait_for_child(child: &mut std::process::Child) -> Result<std::process::ExitStatus, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_payload_paths_are_resolved_without_shell_interpolation() {
        let base = Path::new(r"C:\Program Files\CetaMesh");
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

    #[test]
    fn finished_worker_releases_receiver_so_installer_can_close() {
        let (_sender, receiver) = mpsc::channel();
        let mut active = Some(receiver);
        clear_finished_worker(&mut active, false);
        assert!(active.is_some(), "an active install must retain its worker channel");
        clear_finished_worker(&mut active, true);
        assert!(active.is_none(), "Finished must release the channel and unblock window close");
    }

    #[test]
    fn stage_labels_cover_installer_effect_lines() {
        assert_eq!(stage_label("[stage] 复制 D:\\app\\WhaleBridge.exe"), Some(STAGE_COPY));
        assert_eq!(
            stage_label("[stage] 替换目录 D:\\app\\resources"),
            Some(STAGE_COPY)
        );
        assert_eq!(
            stage_label("[stage] 创建快捷方式 C:\\Menu\\CetaMesh.lnk"),
            Some(STAGE_SHORTCUT)
        );
        assert_eq!(stage_label("[stage] 写注册表 HKCU\\Test"), Some(STAGE_REGISTRY));
        assert_eq!(stage_label("[stage] 执行 D:\\app\\WhaleBridgeCore.exe"), Some(STAGE_REGISTRY));
        assert_eq!(
            stage_label("[stage] 写入 D:\\app\\install-manifest.json"),
            Some(STAGE_FINALIZE)
        );
        assert_eq!(stage_label("普通输出行"), None);
    }

    #[test]
    fn validation_rejects_empty_relative_and_overlapping_paths() {
        let installer_dir = Path::new(r"C:\Users\u\Downloads");
        let empty = validate_install_dir("", installer_dir, 100, None);
        assert_eq!(empty.check, PathCheck::Empty);
        assert!(!empty.ready());

        let relative = validate_install_dir(r"apps\CetaMesh", installer_dir, 100, None);
        assert_eq!(relative.check, PathCheck::NotAbsolute);

        let overlap = validate_install_dir(
            r"C:\Users\u\Downloads\sub",
            installer_dir,
            100,
            None,
        );
        assert_eq!(overlap.check, PathCheck::OverlapsInstaller);

        let inside = validate_install_dir(r"C:\Users\u", installer_dir, 100, None);
        assert_eq!(inside.check, PathCheck::OverlapsInstaller);
    }

    #[test]
    fn validation_reports_disk_space_and_accepts_writable_directory() {
        let root = std::env::temp_dir().join(format!(
            "cetamesh-setup-validate-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        let target = root.join("应用 CetaMesh Dir");
        let too_big = validate_install_dir(
            &target.to_string_lossy(),
            &root.join("installer"),
            10 * 1024 * 1024 * 1024,
            Some(1024),
        );
        assert_eq!(too_big.check, PathCheck::NotEnoughSpace);

        let ok = validate_install_dir(
            &target.to_string_lossy(),
            &root.join("installer"),
            1024,
            Some(10 * 1024 * 1024 * 1024),
        );
        assert_eq!(ok.check, PathCheck::Ready, "{}", ok.message);
        assert!(target.is_dir(), "校验本身会创建目录（与真实安装一致）");
        assert!(
            fs::read_dir(&target).unwrap().next().is_none(),
            "写探测文件必须被清理"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn byte_formatting_is_human_readable() {
        assert_eq!(format_bytes(512 * 1024), "512 KB");
        assert_eq!(format_bytes(50 * 1024 * 1024), "50 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }
}
