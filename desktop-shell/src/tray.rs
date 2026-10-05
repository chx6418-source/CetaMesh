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

const TRAY_ID: &str = "cetamesh-desktop-tray";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayCommand {
    ShowWindow,
    HideWindow,
    RestartCore,
    ExitRequested,
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
        wake: eframe::egui::Context,
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

        spawn_show_signal_listener(Arc::clone(&hwnd), wake.clone(), data_dir.clone());

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
                        wake.request_repaint();
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
                            wake.request_repaint();
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
#[cfg(windows)]
fn spawn_show_signal_listener(
    hwnd: Arc<AtomicIsize>,
    wake: eframe::egui::Context,
    data_dir: PathBuf,
) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};

    let mut name: Vec<u16> = std::ffi::OsStr::new("Local\\CetaMesh.Desktop.ShowWindow")
        .encode_wide()
        .collect();
    name.push(0);
    let _ = std::thread::Builder::new()
        .name("cetamesh-show-signal".to_owned())
        .spawn(move || {
            // SAFETY: NUL-terminated UTF-16 name, default attributes, auto-reset, unsignaled.
            let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
            if event.is_null() {
                return;
            }
            loop {
                // SAFETY: waiting on an event handle created by this thread; infinite timeout.
                let result = unsafe { WaitForSingleObject(event, INFINITE) };
                if result == WAIT_OBJECT_0 {
                    show_window_handle(hwnd.load(Ordering::Relaxed));
                    crate::supervisor::write_shell_log(
                        &data_dir,
                        "[ui] 再次启动应用：从托盘恢复显示主窗口",
                    );
                    wake.request_repaint();
                }
            }
        });
}

#[cfg(not(windows))]
fn spawn_show_signal_listener(
    _hwnd: Arc<AtomicIsize>,
    _wake: eframe::egui::Context,
    _data_dir: PathBuf,
) {
}

/// Deterministic fallback so the tray still appears even if the resource icon cannot be loaded.
fn fallback_icon() -> Option<Icon> {
    const SIZE: u32 = 32;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let border = x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2;
            if border {
                rgba.extend_from_slice(&[255, 255, 255, 255]);
            } else {
                rgba.extend_from_slice(&[23, 126, 115, 255]);
            }
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).ok()
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
