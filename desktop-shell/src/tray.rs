//! Windows system tray integration for the native CetaMesh shell.
//!
//! The tray owns one menu with explicit actions: show / hide the main window, live Core status,
//! "task needs attention", restart Core, open the log directory, and quit (which is the only
//! action that stops Core). Closing the window never reaches this menu by accident: the UI hides
//! to the tray instead, so running Tasks keep going.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};

use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::supervisor::Supervisor;

pub type WakeCallback = Arc<dyn Fn() + Send + Sync>;

const TRAY_ID: &str = "cetamesh-desktop-tray";

/// Test-only instance namespace. `WHALEBRIDGE_INSTANCE_SUFFIX` keeps a test shell from colliding
/// with the user's installed app (single-instance mutex and show-window event). Production runs
/// leave the variable unset, so names stay exactly as before.
pub(crate) fn instance_suffix() -> String {
    let raw = std::env::var("WHALEBRIDGE_INSTANCE_SUFFIX").unwrap_or_default();
    let sanitized: String = raw
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '-' || *value == '_')
        .take(32)
        .collect();
    if sanitized.is_empty() {
        String::new()
    } else {
        format!(".{sanitized}")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayCommand {
    ShowWindow,
    HideWindow,
    RestartCore,
    ExitRequested,
    /// 安装程序通过命名事件请求退出（区别于用户点托盘菜单）；UI 走同一套退出清理。
    ExitRequestedByInstaller,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayStatus {
    pub core: String,
    pub attention: Option<String>,
}

impl TrayStatus {
    pub fn attention_active(&self) -> bool {
        self.attention.is_some()
    }
}

/// Owns the tray icon for the whole app lifetime. Dropping it removes the icon.
pub struct TrayHandle {
    _tray: TrayIcon,
    core_item: MenuItem,
    attention_item: MenuItem,
    commands: Receiver<TrayCommand>,
    hwnd: Arc<AtomicIsize>,
    visible: Arc<AtomicBool>,
    last_status: Mutex<Option<TrayStatus>>,
}

impl TrayHandle {
    pub fn new(
        supervisor: Arc<Supervisor>,
        data_dir: PathBuf,
        wake: WakeCallback,
    ) -> Result<Self, String> {
        let show = MenuItem::with_id("show", "显示主窗口", true, None);
        let hide = MenuItem::with_id("hide", "隐藏到托盘", true, None);
        let core_item = MenuItem::with_id("core-status", "Core：正在启动…", false, None);
        let attention_item = MenuItem::with_id("task-attention", "任务：无需要处理", false, None);
        let restart = MenuItem::with_id("restart", "重启 Core", true, None);
        let logs = MenuItem::with_id("logs", "打开日志目录", true, None);
        let quit = MenuItem::with_id("quit", "退出 CetaMesh（停止 Core 与任务）", true, None);
        let first_separator = PredefinedMenuItem::separator();
        let second_separator = PredefinedMenuItem::separator();
        let third_separator = PredefinedMenuItem::separator();
        let menu = Menu::with_items(&[
            &show,
            &hide,
            &first_separator,
            &core_item,
            &attention_item,
            &second_separator,
            &restart,
            &logs,
            &third_separator,
            &quit,
        ])
        .map_err(|error| format!("创建托盘菜单失败：{error}"))?;

        let mut builder = TrayIconBuilder::new()
            .with_id(TRAY_ID)
            .with_menu(Box::new(menu))
            .with_tooltip("CetaMesh Desktop")
            .with_menu_on_left_click(false);
        if let Some(icon) = embedded_icon().or_else(fallback_icon) {
            builder = builder.with_icon(icon);
        }
        let tray = builder
            .build()
            .map_err(|error| format!("创建系统托盘图标失败：{error}"))?;
        crate::supervisor::write_shell_log(
            &data_dir,
            "[tray] 系统托盘已创建（显示 / 隐藏 / 状态 / 需要处理 / 重启 / 日志 / 退出）",
        );

        let (commands_tx, commands) = channel::<TrayCommand>();
        let hwnd = Arc::new(AtomicIsize::new(0));
        let visible = Arc::new(AtomicBool::new(true));

        spawn_show_signal_listener(
            Arc::clone(&hwnd),
            wake.clone(),
            data_dir.clone(),
            commands_tx.clone(),
        );

        // Menu actions are forwarded to the UI thread; the two actions that must work even while
        // the window is hidden (restart Core, open logs) are executed here directly.
        {
            let commands_tx = commands_tx.clone();
            let wake = wake.clone();
            let hwnd = Arc::clone(&hwnd);
            let supervisor = Arc::clone(&supervisor);
            let data_dir = data_dir.clone();
            std::thread::Builder::new()
                .name("cetamesh-tray-menu".to_owned())
                .spawn(move || {
                    while let Ok(event) = MenuEvent::receiver().recv() {
                        match event.id().as_ref() {
                            "show" => {
                                show_window_handle(hwnd.load(Ordering::Relaxed));
                                let _ = commands_tx.send(TrayCommand::ShowWindow);
                            }
                            "hide" => {
                                let _ = commands_tx.send(TrayCommand::HideWindow);
                            }
                            "attention" => {
                                show_window_handle(hwnd.load(Ordering::Relaxed));
                                let _ = commands_tx.send(TrayCommand::ShowWindow);
                            }
                            "restart" => {
                                crate::supervisor::write_shell_log(
                                    &data_dir,
                                    "[tray] 用户请求重启 Core",
                                );
                                supervisor.request_restart();
                                let _ = commands_tx.send(TrayCommand::RestartCore);
                            }
                            "logs" => {
                                let directory = crate::desktop_paths::log_dir(&data_dir);
                                crate::supervisor::write_shell_log(
                                    &data_dir,
                                    &format!("[tray] 打开日志目录 {}", directory.display()),
                                );
                                let _ = Command::new("explorer.exe").arg(&directory).spawn();
                            }
                            "quit" => {
                                // Bring the window back first so the confirmation dialog is visible
                                // and the user always sees what is being stopped.
                                show_window_handle(hwnd.load(Ordering::Relaxed));
                                let _ = commands_tx.send(TrayCommand::ExitRequested);
                            }
                            _ => {}
                        }
                        wake();
                    }
                })
                .map_err(|error| format!("启动托盘菜单线程失败：{error}"))?;
        }

        // Left click toggles window visibility; right click opens the menu (tray-icon default).
        {
            let commands_tx = commands_tx.clone();
            let wake = wake.clone();
            let hwnd = Arc::clone(&hwnd);
            let visible = Arc::clone(&visible);
            std::thread::Builder::new()
                .name("cetamesh-tray-click".to_owned())
                .spawn(move || {
                    while let Ok(event) = TrayIconEvent::receiver().recv() {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if visible.load(Ordering::Relaxed) {
                                let _ = commands_tx.send(TrayCommand::HideWindow);
                            } else {
                                show_window_handle(hwnd.load(Ordering::Relaxed));
                                let _ = commands_tx.send(TrayCommand::ShowWindow);
                            }
                            wake();
                        }
                    }
                })
                .map_err(|error| format!("启动托盘点击线程失败：{error}"))?;
        }

        Ok(Self {
            _tray: tray,
            core_item,
            attention_item,
            commands,
            hwnd,
            visible,
            last_status: Mutex::new(None),
        })
    }

    /// Capture the native window handle once eframe exposes it (first UI frame).
    pub fn attach_window(&self, hwnd: isize) {
        if hwnd != 0 {
            self.hwnd.store(hwnd, Ordering::Relaxed);
        }
    }

    pub fn set_window_visible(&self, visible: bool) {
        self.visible.store(visible, Ordering::Relaxed);
    }

    pub fn poll(&self) -> Vec<TrayCommand> {
        let mut commands = Vec::new();
        while let Ok(command) = self.commands.try_recv() {
            commands.push(command);
        }
        commands
    }

    /// Update the two live menu rows and the tooltip. No-op when nothing changed.
    pub fn update_status(&self, status: &TrayStatus) {
        let mut last = self.last_status.lock().expect("tray status lock");
        if last.as_ref() == Some(status) {
            return;
        }
        *last = Some(status.clone());
        drop(last);
        self.core_item.set_text(format!("Core：{}", status.core));
        match &status.attention {
            Some(detail) => {
                self.attention_item.set_text(format!("需要处理：{detail}"));
                self.attention_item.set_enabled(true);
            }
            None => {
                self.attention_item.set_text("任务：无需要处理");
                self.attention_item.set_enabled(false);
            }
        }
        let tooltip = match &status.attention {
            Some(detail) => {
                format!(
                    "CetaMesh Desktop — Core：{}｜需要处理：{detail}",
                    status.core
                )
            }
            None => format!("CetaMesh Desktop — Core：{}", status.core),
        };
        let _ = self._tray.set_tooltip(Some(tooltip));
    }
}

fn embedded_icon() -> Option<Icon> {
    Icon::from_resource(1, None).ok()
}

/// A second launch of the app signals this named event; the running instance restores its window
/// from the tray. The event object is created here (before `run_native` returns) so an earlier
/// signal is not lost.
///
/// The same listener owns `CetaMesh.Desktop.QuitRequest`: the CetaMesh installer signals it so a
/// running app can quit gracefully (stop Core, release file locks) before files are replaced,
/// instead of being force-killed. Without the event the installer falls back to a path-scoped
/// force stop after a timeout, so old app versions remain upgradeable.
#[cfg(windows)]
fn spawn_show_signal_listener(
    hwnd: Arc<AtomicIsize>,
    wake: WakeCallback,
    data_dir: PathBuf,
    commands_tx: std::sync::mpsc::Sender<TrayCommand>,
) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForMultipleObjects};

    let show_name = format!("Local\\CetaMesh.Desktop.ShowWindow{}", instance_suffix());
    let quit_name = format!("Local\\CetaMesh.Desktop.QuitRequest{}", instance_suffix());
    let mut show_name_utf16: Vec<u16> = std::ffi::OsStr::new(&show_name).encode_wide().collect();
    show_name_utf16.push(0);
    let mut quit_name_utf16: Vec<u16> = std::ffi::OsStr::new(&quit_name).encode_wide().collect();
    quit_name_utf16.push(0);
    let _ = std::thread::Builder::new()
        .name("cetamesh-show-signal".to_owned())
        .spawn(move || {
            // SAFETY: NUL-terminated UTF-16 names, default attributes, auto-reset, unsignaled.
            let show = unsafe { CreateEventW(std::ptr::null(), 0, 0, show_name_utf16.as_ptr()) };
            let quit = unsafe { CreateEventW(std::ptr::null(), 0, 0, quit_name_utf16.as_ptr()) };
            if show.is_null() || quit.is_null() {
                return;
            }
            let handles = [show, quit];
            loop {
                // SAFETY: waiting on two event handles created by this thread; infinite timeout.
                let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
                match result {
                    WAIT_OBJECT_0 => {
                        show_window_handle(hwnd.load(Ordering::Relaxed));
                        crate::supervisor::write_shell_log(
                            &data_dir,
                            "[ui] 再次启动应用：从托盘恢复显示主窗口",
                        );
                        wake();
                    }
                    value if value == WAIT_OBJECT_0 + 1 => {
                        // 安装程序请求关闭：先显示窗口，再按既有退出清理流程处理
                        // （有未完成任务时仍会弹出确认，由用户决定）。
                        show_window_handle(hwnd.load(Ordering::Relaxed));
                        crate::supervisor::write_shell_log(
                            &data_dir,
                            "[ui] 安装程序请求关闭应用（QuitRequest 事件）",
                        );
                        let _ = commands_tx.send(TrayCommand::ExitRequestedByInstaller);
                        wake();
                    }
                    WAIT_TIMEOUT => continue,
                    _ => break,
                }
            }
        });
}

#[cfg(not(windows))]
fn spawn_show_signal_listener(
    _hwnd: Arc<AtomicIsize>,
    _wake: WakeCallback,
    _data_dir: PathBuf,
    _commands_tx: std::sync::mpsc::Sender<TrayCommand>,
) {
}

/// Use the same whale asset if Windows cannot load the executable's icon resource.
fn fallback_icon() -> Option<Icon> {
    let image = eframe::icon_data::from_png_bytes(include_bytes!("../icons/32x32.png")).ok()?;
    Icon::from_rgba(image.rgba, image.width, image.height).ok()
}

#[cfg(windows)]
fn show_window_handle(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SW_RESTORE, SW_SHOW, SetForegroundWindow, ShowWindow,
    };
    if hwnd == 0 {
        return;
    }
    // SAFETY: `hwnd` was obtained from eframe's raw window handle and is only used while the
    // window is alive for the duration of this process.
    unsafe {
        ShowWindow(hwnd as _, SW_RESTORE);
        ShowWindow(hwnd as _, SW_SHOW);
        SetForegroundWindow(hwnd as _);
    }
}

#[cfg(not(windows))]
fn show_window_handle(_hwnd: isize) {}

#[cfg(test)]
mod tests {
    use super::TrayStatus;

    #[test]
    fn attention_status_only_reports_actionable_detail() {
        let quiet = TrayStatus {
            core: "已连接".to_owned(),
            attention: None,
        };
        assert!(!quiet.attention_active());
        let attention = TrayStatus {
            core: "已连接".to_owned(),
            attention: Some("2 个任务需要人介入".to_owned()),
        };
        assert!(attention.attention_active());
    }
}
