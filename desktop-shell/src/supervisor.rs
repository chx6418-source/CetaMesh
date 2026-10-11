//! Core worker 的进程监管：启动、健康检查、监控、退避重启、优雅退出。
//!
//! 设计要点：
//! - **只用进程句柄**：只管理自己拉起的那个子进程，绝不按进程名/命令行模糊查杀
//!   （`src/bridge.js` 的 `/api/shutdown` 在托管模式下已不再做全局 start.bat 清理）。
//! - **孤儿守卫双保险**：worker 在 `WHALEBRIDGE_SUPERVISED=1` 下把 stdin 当父进程存活凭据，
//!   壳退出时丢弃 stdin 句柄即可让 worker 自行优雅退出；超时未退再 `taskkill /PID <自身子进程>`。
//! - **退出码契约**（与 `src/bridge.js` 一致）：0/2 不重启，10 立即重启，其它按退避重启。
//! - 启动、健康、重启决策都是纯函数或可注入的，便于在无 GUI 环境下测试。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::core_launch::CoreLaunchSpec;

/// 首次异常退出后的等待时间。
pub const BACKOFF_BASE: Duration = Duration::from_secs(5);
/// 连续失败时的退避序列上限。
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// 连续失败达到该次数后放弃自动重启，交由 UI 提示用户。
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// 稳定运行超过该时长即认为这次启动成功，失败计数清零。
pub const STABLE_UPTIME: Duration = Duration::from_secs(60);
/// 等待控制台可用的默认上限（main.rs 与自检共用）。
pub const DEFAULT_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
pub const IPC_FRAME_MAX_BYTES: usize = 1024 * 1024;

/// 退出码约定（与 src/bridge.js 保持一致，测试锁定）。
pub const EXIT_OK: i32 = 0;
pub const EXIT_ALREADY_RUNNING: i32 = 2;
pub const EXIT_RESTART_REQUESTED: i32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartAction {
    /// 用户要求停止，或被其它实例占用：不重启。
    Stop,
    /// 立即重启（/api/restart）。
    RestartNow,
    /// 退避后重启。
    RestartAfter(Duration),
    /// 连续失败过多，停止自动重启。
    GiveUp,
}

/// 连续失败次数 → 退避时长：5s、10s、20s、30s（封顶）。
pub fn backoff_delay(consecutive_failures: u32) -> Duration {
    let step = consecutive_failures.saturating_sub(1).min(3);
    let delay = BACKOFF_BASE * 2_u32.pow(step);
    if delay > BACKOFF_MAX {
        BACKOFF_MAX
    } else {
        delay
    }
}

/// 退出码 + 连续失败次数 → 重启决策（纯函数，由单元测试锁定）。
pub fn decide_restart(exit_code: i32, consecutive_failures: u32) -> RestartAction {
    match exit_code {
        EXIT_OK | EXIT_ALREADY_RUNNING => RestartAction::Stop,
        EXIT_RESTART_REQUESTED => RestartAction::RestartNow,
        _ => {
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                RestartAction::GiveUp
            } else {
                RestartAction::RestartAfter(backoff_delay(consecutive_failures))
            }
        }
    }
}

/// 稳定运行满 STABLE_UPTIME 后，失败计数清零。
pub fn failures_after_run(previous: u32, ran_for: Duration) -> u32 {
    if ran_for >= STABLE_UPTIME {
        0
    } else {
        previous
    }
}

/// 对 `127.0.0.1:port` 发一次最小 HTTP GET；只要能读到 HTTP 状态行就算健康
/// （401/404 都说明控制台已经在响应，不必带令牌）。
pub fn probe_http(port: u16, timeout: Duration) -> bool {
    let address = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut iter) => match iter.next() {
            Some(address) => address,
            None => return false,
        },
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&address, timeout) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nUser-Agent: WhaleBridgeDesktop\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0_u8; 64];
    match stream.read(&mut buffer) {
        Ok(read) if read > 0 => buffer[..read].starts_with(b"HTTP/"),
        _ => false,
    }
}

/// 轮询等待控制台可用；`should_abort` 用于在 worker 已经退出时提前结束等待。
pub fn wait_for_health(
    port: u16,
    timeout: Duration,
    mut should_abort: impl FnMut() -> bool,
) -> Result<Duration, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if should_abort() {
            return Err("worker 在控制台就绪前退出".to_owned());
        }
        if probe_http(port, Duration::from_millis(800)) {
            return Ok(started.elapsed());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!("等待控制台就绪超时（{}s）", timeout.as_secs()))
}

/// Ping the versioned Core UI pipe. The supervisor owns the pipe name and passes it only to
/// its child; this probe is used for readiness, not for any externally reachable API.
pub fn probe_ipc(pipe_name: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut pipe = loop {
        match OpenOptions::new().read(true).write(true).open(pipe_name) {
            Ok(pipe) => break pipe,
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
                if Instant::now() >= deadline {
                    return Err(format!("connect to UI IPC pipe: {error}"));
                }
            }
            Err(error) => return Err(format!("connect to UI IPC pipe: {error}")),
        }
    };
    // A connected but stalled peer must not wedge Supervisor's worker forever while it waits
    // for the response frame. Windows named-pipe nonblocking mode lets us enforce the same
    // deadline after connection that we already enforce while opening the pipe.
    #[cfg(windows)]
    if let Err(error) = set_pipe_nonblocking(&pipe) {
        return Err(format!("configure UI IPC pipe as nonblocking: {error}"));
    }
    let ready = read_ipc_frame_until(&mut pipe, deadline)
        .map_err(|error| format!("read core.ready event: {error}"))?;
    let ready = serde_json::from_slice::<serde_json::Value>(&ready)
        .map_err(|error| format!("decode core.ready event: {error}"))?;
    if ready.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || ready.get("event").and_then(serde_json::Value::as_str) != Some("core.ready")
    {
        return Err(format!("unexpected UI IPC ready event: {ready}"));
    }
    let request = serde_json::json!({
        "version": 1,
        "id": "supervisor-ready",
        "method": "core.ping",
        "params": {}
    });
    let request_bytes =
        serde_json::to_vec(&request).map_err(|error| format!("encode Core IPC ping: {error}"))?;
    write_ipc_frame(&mut pipe, &request_bytes)
        .map_err(|error| format!("write Core IPC ping: {error}"))?;
    let response = read_ipc_frame_until(&mut pipe, deadline)
        .map_err(|error| format!("read Core IPC ping response: {error}"))?;
    let value = serde_json::from_slice::<serde_json::Value>(&response)
        .map_err(|error| format!("decode Core IPC ping response: {error}"))?;
    if value.get("version").and_then(serde_json::Value::as_u64) == Some(1)
        && value.get("id").and_then(serde_json::Value::as_str) == Some("supervisor-ready")
        && value.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && value
            .pointer("/result/status")
            .and_then(serde_json::Value::as_str)
            == Some("pong")
    {
        Ok(())
    } else {
        Err(format!("invalid Core IPC ping response: {value}"))
    }
}

pub fn wait_for_ipc(
    pipe_name: &str,
    timeout: Duration,
    mut should_abort: impl FnMut() -> bool,
) -> Result<Duration, String> {
    let started = Instant::now();
    let mut last_error = "pipe not ready".to_owned();
    while started.elapsed() < timeout {
        if should_abort() {
            return Err("Core 在 IPC 握手前退出".to_owned());
        }
        match probe_ipc(pipe_name, Duration::from_millis(800)) {
            Ok(()) => return Ok(started.elapsed()),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "等待 Core IPC 就绪超时（{}s）：{}",
        timeout.as_secs(),
        last_error
    ))
}

fn write_ipc_frame(writer: &mut impl Write, payload: &[u8]) -> std::io::Result<()> {
    if payload.len() > IPC_FRAME_MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "IPC request exceeds 1 MiB",
        ));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "IPC frame too large"))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

fn read_ipc_frame_until(reader: &mut File, deadline: Instant) -> std::io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    read_exact_ipc_until(reader, &mut header, deadline)?;
    let length = u32::from_le_bytes(header) as usize;
    if length > IPC_FRAME_MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "IPC response exceeds 1 MiB",
        ));
    }
    let mut payload = vec![0; length];
    read_exact_ipc_until(reader, &mut payload, deadline)?;
    Ok(payload)
}

fn read_exact_ipc_until(
    reader: &mut File,
    mut output: &mut [u8],
    deadline: Instant,
) -> std::io::Result<()> {
    while !output.is_empty() {
        match reader.read(output) {
            // With PIPE_NOWAIT, a read can report zero bytes while the Node accept
            // callback has not yet been scheduled to write `core.ready`. Treat that
            // as no data and keep polling until the same bounded readiness deadline.
            // A disconnected peer will consequently time out rather than wedge the
            // Supervisor worker indefinitely.
            Ok(0) => {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "IPC response timed out",
                    ));
                }
                thread::sleep(
                    Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Ok(read) => output = &mut output[read..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            #[cfg(windows)]
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == Some(232) =>
            {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "IPC response timed out",
                    ));
                }
                thread::sleep(
                    Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline && !output.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "IPC response timed out",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn set_pipe_nonblocking(pipe: &File) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    unsafe extern "system" {
        fn SetNamedPipeHandleState(
            named_pipe: *mut c_void,
            mode: *const u32,
            max_collection_count: *const u32,
            collect_data_timeout: *const u32,
        ) -> i32;
    }

    const PIPE_NOWAIT: u32 = 0x0000_0001;
    let mode = PIPE_NOWAIT;
    // SAFETY: the handle is a live File handle opened from a Windows named pipe, and all
    // optional pointer arguments are null as permitted by SetNamedPipeHandleState.
    let ok = unsafe {
        SetNamedPipeHandleState(
            pipe.as_raw_handle().cast(),
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// 正在等待启动。
    Starting,
    /// 控制台已就绪，附带本次启动耗时。
    Ready { startup_ms: u128 },
    /// worker 已退出且不再重启。`needs_attention` 表示需要用户处理。
    Stopped {
        exit_code: i32,
        reason: String,
        needs_attention: bool,
    },
    /// 即将重启，附带等待时长与说明。
    Restarting { delay: Duration, exit_code: i32 },
    /// 连续失败过多，停止自动重启。
    GivenUp { exit_code: i32, failures: u32 },
}

impl Status {
    pub fn is_ready(&self) -> bool {
        matches!(self, Status::Ready { .. })
    }

    pub fn summary(&self) -> String {
        match self {
            Status::Starting => "正在启动桥接…".to_owned(),
            Status::Ready { startup_ms } => format!("控制台已就绪（{} ms）", startup_ms),
            Status::Stopped {
                exit_code, reason, ..
            } => format!("桥接已停止（退出码 {exit_code}）：{reason}"),
            Status::Restarting { delay, exit_code } => {
                format!(
                    "桥接退出（退出码 {exit_code}），{} 秒后重启",
                    delay.as_secs()
                )
            }
            Status::GivenUp {
                exit_code,
                failures,
            } => {
                format!("桥接连续 {failures} 次异常退出（最后退出码 {exit_code}），已停止自动重启")
            }
        }
    }

    /// 需要用户介入（配置错误、端口冲突、反复崩溃）→ 桌面窗口应展示错误说明。
    pub fn needs_attention(&self) -> bool {
        match self {
            Status::Stopped {
                needs_attention, ..
            } => *needs_attention,
            Status::GivenUp { .. } => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorCommand {
    Restart,
    Shutdown,
}

pub struct SupervisorConfig {
    pub launch: CoreLaunchSpec,
    pub data_dir: PathBuf,
    pub console_port: u16,
    pub ipc_pipe: Option<String>,
    pub health_timeout: Duration,
}

/// 进程监管句柄：所有跨线程共享状态都收敛在这里。
/// 内部全部是可共享的句柄，因此 `Arc<Supervisor>` 的任意克隆都能安全地请求停止。
pub struct Supervisor {
    commands: Sender<SupervisorCommand>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child_pid: Arc<Mutex<Option<u32>>>,
    status: Arc<Mutex<Status>>,
    spawn_count: Arc<Mutex<u32>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    pub fn start(config: SupervisorConfig) -> Self {
        let (commands_tx, commands_rx) = mpsc::channel();
        let stdin = Arc::new(Mutex::new(None));
        let child_pid = Arc::new(Mutex::new(None));
        let status = Arc::new(Mutex::new(Status::Starting));
        let spawn_count = Arc::new(Mutex::new(0));
        let worker = WorkerHandles {
            stdin: Arc::clone(&stdin),
            child_pid: Arc::clone(&child_pid),
            spawn_count: Arc::clone(&spawn_count),
        };
        let thread_status = Arc::clone(&status);
        let thread = thread::spawn(move || {
            run_supervisor(config, commands_rx, thread_status, worker);
        });
        Self {
            commands: commands_tx,
            stdin,
            child_pid,
            status,
            spawn_count,
            thread: Mutex::new(Some(thread)),
        }
    }

    pub fn status(&self) -> Status {
        self.status.lock().expect("status mutex").clone()
    }

    pub fn child_pid(&self) -> Option<u32> {
        *self.child_pid.lock().expect("pid mutex")
    }

    /// 累计成功拉起的次数（自检与诊断用；重启后 +1）。
    pub fn spawn_count(&self) -> u32 {
        *self.spawn_count.lock().expect("spawn count mutex")
    }

    pub fn request_restart(&self) {
        let _ = self.commands.send(SupervisorCommand::Restart);
    }

    /// 退出应用：请求关闭 → 丢弃 stdin（触发 worker 孤儿守卫）→ 等待监管线程收尾。
    /// 重复调用是安全的（第二次直接返回）。
    pub fn shutdown(&self) {
        let _ = self.commands.send(SupervisorCommand::Shutdown);
        drop(self.stdin.lock().expect("stdin mutex").take());
        let handle = self.thread.lock().expect("thread mutex").take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

struct WorkerHandles {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child_pid: Arc<Mutex<Option<u32>>>,
    spawn_count: Arc<Mutex<u32>>,
}

fn run_supervisor(
    config: SupervisorConfig,
    commands: Receiver<SupervisorCommand>,
    status: Arc<Mutex<Status>>,
    handles: WorkerHandles,
) {
    let mut failures: u32 = 0;
    let mut pending_restart = false;

    loop {
        let mut child = match spawn_worker(&config) {
            Ok(child) => child,
            Err(error) => {
                set_status(
                    &status,
                    Status::Stopped {
                        exit_code: -1,
                        reason: error,
                        needs_attention: true,
                    },
                );
                if !sleep_interruptible(BACKOFF_MAX, &commands, &mut pending_restart) {
                    return;
                }
                continue;
            }
        };
        let pid = child.id();
        *handles.child_pid.lock().expect("pid mutex") = Some(pid);
        *handles.spawn_count.lock().expect("spawn count mutex") += 1;
        // 只保留写端：壳退出时丢弃它，worker 的孤儿守卫随即触发。
        if let Some(stdin) = child.stdin.take() {
            *handles.stdin.lock().expect("stdin mutex") = Some(stdin);
        }
        let started = Instant::now();
        set_status(&status, Status::Starting);

        let health = if let Some(pipe_name) = config.ipc_pipe.as_deref() {
            wait_for_ipc(pipe_name, config.health_timeout, || {
                matches!(child.try_wait(), Ok(Some(_)))
            })
        } else {
            wait_for_health(config.console_port, config.health_timeout, || {
                matches!(child.try_wait(), Ok(Some(_)))
            })
        };

        match health {
            Ok(startup) => set_status(
                &status,
                Status::Ready {
                    startup_ms: startup.as_millis(),
                },
            ),
            Err(error) => set_status(
                &status,
                Status::Stopped {
                    exit_code: -1,
                    reason: error,
                    needs_attention: true,
                },
            ),
        }

        // 监控：等待子进程退出，其间响应壳发来的命令。
        let mut shutdown_requested = false;
        let exit_code = loop {
            if let Some(command) = take_command(&commands) {
                match command {
                    SupervisorCommand::Shutdown => {
                        shutdown_requested = true;
                        stop_child(&handles, &mut child, &status);
                    }
                    SupervisorCommand::Restart => {
                        pending_restart = true;
                        stop_child(&handles, &mut child, &status);
                    }
                }
            }
            if let Ok(Some(exit)) = child.try_wait() {
                break exit.code().unwrap_or(-1);
            }
            thread::sleep(Duration::from_millis(150));
        };

        *handles.child_pid.lock().expect("pid mutex") = None;
        *handles.stdin.lock().expect("stdin mutex") = None;
        let ran_for = started.elapsed();

        if shutdown_requested {
            set_status(
                &status,
                Status::Stopped {
                    exit_code,
                    reason: "已退出".to_owned(),
                    needs_attention: false,
                },
            );
            return;
        }

        let action = if pending_restart && exit_code != EXIT_ALREADY_RUNNING {
            pending_restart = false;
            RestartAction::RestartNow
        } else {
            pending_restart = false;
            decide_restart(exit_code, failures.saturating_add(1))
        };

        match action {
            RestartAction::Stop => {
                let (reason, needs_attention) = explain_stop(exit_code);
                set_status(
                    &status,
                    Status::Stopped {
                        exit_code,
                        reason,
                        needs_attention,
                    },
                );
                return;
            }
            RestartAction::GiveUp => {
                set_status(
                    &status,
                    Status::GivenUp {
                        exit_code,
                        failures,
                    },
                );
                return;
            }
            RestartAction::RestartNow => {
                failures = failures_after_run(failures, ran_for);
                set_status(
                    &status,
                    Status::Restarting {
                        delay: Duration::ZERO,
                        exit_code,
                    },
                );
            }
            RestartAction::RestartAfter(delay) => {
                failures = failures_after_run(failures, ran_for) + 1;
                set_status(&status, Status::Restarting { delay, exit_code });
                if !sleep_interruptible(delay, &commands, &mut pending_restart) {
                    return;
                }
            }
        }
    }
}

fn explain_stop(exit_code: i32) -> (String, bool) {
    match exit_code {
        EXIT_OK => ("已按请求停止".to_owned(), false),
        EXIT_ALREADY_RUNNING => (
            "已有实例在运行，或控制台端口被其它程序占用".to_owned(),
            true,
        ),
        _ => (format!("桥接异常退出（退出码 {exit_code}）"), true),
    }
}

fn set_status(status: &Arc<Mutex<Status>>, next: Status) {
    *status.lock().expect("status mutex") = next;
}

fn take_command(commands: &Receiver<SupervisorCommand>) -> Option<SupervisorCommand> {
    match commands.try_recv() {
        Ok(command) => Some(command),
        Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => None,
    }
}

/// 等待一段时间，期间保持对命令的响应；返回 false 表示收到关闭请求。
fn sleep_interruptible(
    delay: Duration,
    commands: &Receiver<SupervisorCommand>,
    pending_restart: &mut bool,
) -> bool {
    let deadline = Instant::now() + delay;
    while Instant::now() < deadline {
        if let Some(command) = take_command(commands) {
            match command {
                SupervisorCommand::Shutdown => return false,
                SupervisorCommand::Restart => *pending_restart = true,
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    true
}

/// Windows 上创建"不分配控制台窗口"的子进程。
///
/// 关键：Core 是控制台子系统程序（Node SEA 就是 node.exe），而 release 的桌面壳是 GUI 子系统
/// 程序。GUI 程序启动控制台程序时 Windows 会**新建一个控制台窗口**——不做处理就会在每次启动时
/// 弹出一个黑窗（标题是 exe 路径）。debug 构建里壳自身有控制台、子进程继承它，所以这个问题
/// 只在 release 构建暴露。
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 安装器子进程审计（测试钩子，默认零开销）：`WHALEBRIDGE_INSTALLER_SPAWN_LOG` 指向文件时，
/// 每次经 [`hidden`] 的 spawn 追加一行 JSON。安装器「无控制台窗口」回归测试据此断言
/// 每个控制台子进程（reg.exe / powershell.exe / WhaleBridgeCore.exe / taskkill.exe…）都被隐藏。
/// 生产运行不设置该环境变量时不写任何文件。
pub fn record_spawn(program: &std::ffi::OsStr, hidden: bool) {
    let Ok(path) = std::env::var("WHALEBRIDGE_INSTALLER_SPAWN_LOG") else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    let program_text = program.to_string_lossy().replace('\\', "/").replace('"', "'");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{{\"program\":\"{program_text}\",\"hidden\":{hidden}}}"
        );
    }
}

pub fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let program = program.as_ref();
    record_spawn(program, true);
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn spawn_worker(config: &SupervisorConfig) -> Result<Child, String> {
    fs::create_dir_all(&config.data_dir)
        .map_err(|error| format!("创建数据目录失败 {}：{error}", config.data_dir.display()))?;
    let log_path = crate::desktop_paths::worker_log_file(&config.data_dir);
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建日志目录失败 {}：{error}", parent.display()))?;
    }
    // 直接让子进程写文件，避免管道背压；append 模式保证重启不丢历史。
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| {
            format!(
                "打开 worker 日志失败 {}：{error}。通常是另一个 CetaMesh 实例或旧的 Core 进程仍在运行并占用日志：请在任务管理器结束旧的 WhaleBridge / WhaleBridgeCore 进程后重试。",
                log_path.display()
            )
        })?;
    let log_err = log
        .try_clone()
        .map_err(|error| format!("复制日志句柄失败：{error}"))?;

    let mut command = hidden(&config.launch.program);
    command
        .args(&config.launch.args)
        .current_dir(&config.data_dir)
        .env("WHALEBRIDGE_DATA_DIR", &config.data_dir)
        .env("WHALEBRIDGE_SUPERVISED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    for (key, value) in &config.launch.env {
        command.env(key, value);
    }
    if let Some(pipe_name) = config.ipc_pipe.as_deref() {
        command.env("WHALEBRIDGE_UI_PIPE", pipe_name);
    }
    command.spawn().map_err(|error| {
        format!(
            "启动 Core 失败 {}：{error}",
            config.launch.program.display()
        )
    })
}

/// 优雅停止：丢弃 stdin（触发孤儿守卫），超时再只针对本子进程强杀。
fn stop_child(handles: &WorkerHandles, child: &mut Child, status: &Arc<Mutex<Status>>) {
    drop(handles.stdin.lock().expect("stdin mutex").take());
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    set_status(status, Status::Starting);
    let pid = child.id();
    let _ = hidden("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.wait();
}

pub fn write_shell_log(data_dir: &Path, message: &str) {
    let path = crate::desktop_paths::shell_log_file(data_dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{message}");
    }
}

#[allow(dead_code)]
fn touch(_: &File) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn backoff_escalates_then_caps() {
        assert_eq!(backoff_delay(1), Duration::from_secs(5));
        assert_eq!(backoff_delay(2), Duration::from_secs(10));
        assert_eq!(backoff_delay(3), Duration::from_secs(20));
        assert_eq!(backoff_delay(4), Duration::from_secs(30));
        assert_eq!(backoff_delay(9), Duration::from_secs(30));
    }

    #[test]
    fn exit_codes_follow_the_locked_contract() {
        assert_eq!(decide_restart(EXIT_OK, 1), RestartAction::Stop);
        assert_eq!(decide_restart(EXIT_ALREADY_RUNNING, 1), RestartAction::Stop);
        assert_eq!(
            decide_restart(EXIT_RESTART_REQUESTED, 3),
            RestartAction::RestartNow
        );
        assert_eq!(
            decide_restart(1, 1),
            RestartAction::RestartAfter(Duration::from_secs(5))
        );
        assert_eq!(
            decide_restart(1, 2),
            RestartAction::RestartAfter(Duration::from_secs(10))
        );
        assert_eq!(
            decide_restart(1, MAX_CONSECUTIVE_FAILURES),
            RestartAction::GiveUp
        );
    }

    #[test]
    fn failure_counter_resets_after_stable_run() {
        assert_eq!(failures_after_run(3, Duration::from_secs(5)), 3);
        assert_eq!(failures_after_run(3, STABLE_UPTIME), 0);
    }

    #[test]
    fn status_reports_attention_only_for_actionable_states() {
        assert!(!Status::Starting.needs_attention());
        assert!(!Status::Ready { startup_ms: 12 }.needs_attention());
        assert!(
            !Status::Stopped {
                exit_code: 0,
                reason: "已按请求停止".to_owned(),
                needs_attention: false
            }
            .needs_attention()
        );
        assert!(
            Status::Stopped {
                exit_code: 2,
                reason: "已有实例".to_owned(),
                needs_attention: true
            }
            .needs_attention()
        );
        assert!(
            Status::GivenUp {
                exit_code: 1,
                failures: 5
            }
            .needs_attention()
        );
    }

    #[test]
    fn health_probe_accepts_any_http_answer() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 512];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
            }
        });
        assert!(
            probe_http(port, Duration::from_millis(800)),
            "401 也算健康（控制台在响应）"
        );
        let _ = handle.join();
    }

    #[test]
    fn health_probe_rejects_closed_port() {
        // 先占一个端口再释放，得到一个几乎必然没人监听的端口号。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!probe_http(port, Duration::from_millis(300)));
    }

    #[test]
    fn wait_for_health_aborts_when_worker_died() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = wait_for_health(port, Duration::from_secs(10), || true).unwrap_err();
        assert!(error.contains("退出"), "{error}");
    }

    #[test]
    fn wait_for_health_times_out_with_message() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = wait_for_health(port, Duration::from_millis(600), || false).unwrap_err();
        assert!(error.contains("超时"), "{error}");
    }
}
