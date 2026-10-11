//! 安装器命令行：`WhaleBridge.exe --install | --repair | --uninstall | --migrate`。
//!
//! 默认值来自真实系统（%ProgramFiles%、开始菜单、桌面、HKCU 卸载项），但每个根目录都能通过
//! 参数覆盖，因此自动化测试可以在临时目录里跑完整生命周期，不会污染用户系统。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::installer::{
    CORE_EXE_NAME, InstallLayout, InstallManifest, InstallOptions, Payload, Plan, SHELL_EXE_NAME,
    UninstallOptions, apply_plan, find_existing_install, plan_install, plan_repair, plan_uninstall,
};
use crate::migrate::{
    MigrateOptions, default_source_candidates, discover_candidates, plan_migrate,
};
use crate::supervisor::hidden;

pub const USAGE: &str = r#"CetaMesh 安装器

用法：
  WhaleBridge.exe --install            安装（已安装则升级）
  WhaleBridge.exe --repair             修复安装（保留数据与配置）
  WhaleBridge.exe --uninstall          卸载（默认保留用户数据）
  WhaleBridge.exe --migrate --from <旧目录>   迁移旧数据到当前数据目录
  WhaleBridge.exe --install --dry-run  只打印计划，不写任何文件

通用选项：
  --install-dir <目录>        安装目录（默认当前已安装目录，否则 %ProgramFiles%\WhaleBridge）
  --data-dir <目录>           用户数据目录（默认 %LOCALAPPDATA%\WhaleBridge）
  --start-menu-dir <目录>     开始菜单 Programs 目录
  --desktop-dir <目录>        桌面目录
  --registry-key <键>         卸载注册表项（默认 HKCU\...\Uninstall\WhaleBridge）
  --payload-core <目录>       Core 产物目录（默认 exe 同目录的 payload\ 或 ..\dist\core）
  --no-desktop-shortcut       不创建桌面快捷方式
  --no-dsh-integration        不注册 DSH 集成
  --dsh-profile <profile>     DSH profile（默认 web）
  --stop-core                 覆盖安装前先结束占用安装目录的进程（DSH 的 MCP 子进程），装完请重启 DSH
  --dry-run, -n               只打印计划
  --force                     迁移时允许覆盖已存在的目标文件
  --remove-data               卸载时同时删除用户数据目录（危险）
  --remove-dsh-integration    卸载时移除 DSH 集成（只删本应用记录的内容）

内部选项（由卸载器/安装向导/自动化测试使用，不建议手工调用）：
  --wait-pid <pid>            等待该进程退出后再动手（用于替换正在运行的 exe）
  --from <目录>               迁移来源目录
  --detect-install            只探测既有安装并输出 JSON（不写文件）"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallCommand {
    Install,
    Repair,
    Uninstall,
    Migrate,
    /// 只探测既有安装（供安装向导与自动化测试；不写任何文件）。
    DetectInstall,
}

#[derive(Debug, Clone)]
pub struct InstallCli {
    pub command: InstallCommand,
    pub layout: InstallLayout,
    pub payload_core: PathBuf,
    pub dsh_integration: bool,
    pub dsh_profile: String,
    pub dry_run: bool,
    pub force: bool,
    pub remove_data: bool,
    pub remove_dsh_integration: bool,
    /// 覆盖安装前先结束占用安装目录的进程（DSH 的 MCP 子进程）。
    pub stop_core: bool,
    pub wait_pid: Option<u32>,
    pub from: Option<PathBuf>,
    pub version: String,
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == name {
            return iter.next().cloned();
        }
        if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
            return Some(value.to_owned());
        }
    }
    None
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

/// 解析命令行；返回 None 表示"不是安装器命令"（继续走桌面应用逻辑）。
pub fn parse(args: &[String]) -> Result<Option<InstallCli>, String> {
    let command = if has_flag(args, "--install") {
        Some(InstallCommand::Install)
    } else if has_flag(args, "--repair") {
        Some(InstallCommand::Repair)
    } else if has_flag(args, "--uninstall") {
        Some(InstallCommand::Uninstall)
    } else if has_flag(args, "--migrate") {
        Some(InstallCommand::Migrate)
    } else if has_flag(args, "--detect-install") {
        Some(InstallCommand::DetectInstall)
    } else {
        None
    };
    let Some(command) = command else {
        return Ok(None);
    };

    let exe_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));

    let program_files = env_path("ProgramFiles")
        .or_else(|| env_path("ProgramFiles(x86)"))
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
    let install_dir = arg_value(args, "--install-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            default_install_dir(&exe_dir, &program_files, env_path("LOCALAPPDATA").as_deref())
        });

    let data_dir = crate::desktop_paths::resolve_data_dir(
        arg_value(args, "--data-dir").as_deref(),
        env::var("WHALEBRIDGE_DATA_DIR").ok().as_deref(),
        &exe_dir,
        env_path("LOCALAPPDATA").as_deref(),
        &|candidate: &Path| candidate.exists(),
    )
    .data_dir;

    let start_menu_dir = arg_value(args, "--start-menu-dir")
        .map(PathBuf::from)
        .or_else(|| {
            env_path("APPDATA").map(|base| {
                base.join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
            })
        })
        .unwrap_or_else(|| {
            PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")
        });

    let desktop_dir = arg_value(args, "--desktop-dir")
        .map(PathBuf::from)
        .or_else(|| env_path("USERPROFILE").map(|base| base.join("Desktop")))
        .unwrap_or_else(|| PathBuf::from("C:\\Users\\Public\\Desktop"));

    let registry_key = arg_value(args, "--registry-key")
        .unwrap_or_else(|| crate::installer::UNINSTALL_KEY.to_owned());

    let payload_core = arg_value(args, "--payload-core")
        .map(PathBuf::from)
        .unwrap_or_else(|| default_payload_core(&exe_dir));

    Ok(Some(InstallCli {
        command,
        layout: InstallLayout {
            install_dir,
            data_dir,
            start_menu_dir,
            desktop_dir,
            registry_key,
            create_desktop_shortcut: !has_flag(args, "--no-desktop-shortcut"),
        },
        payload_core,
        dsh_integration: !has_flag(args, "--no-dsh-integration"),
        dsh_profile: arg_value(args, "--dsh-profile").unwrap_or_else(|| "web".to_owned()),
        dry_run: has_flag(args, "--dry-run") || has_flag(args, "-n"),
        force: has_flag(args, "--force"),
        remove_data: has_flag(args, "--remove-data"),
        remove_dsh_integration: has_flag(args, "--remove-dsh-integration"),
        stop_core: has_flag(args, "--stop-core"),
        wait_pid: arg_value(args, "--wait-pid").and_then(|value| value.parse::<u32>().ok()),
        from: arg_value(args, "--from").map(PathBuf::from),
        version: product_version(&exe_dir),
    }))
}

/// 已安装的主程序通过快捷方式启动卸载/修复时，应以自身旁边的安装清单确定目录。
/// 全新安装（发布包放任意目录）默认 per-user `%LOCALAPPDATA%\Programs\CetaMesh`：
/// 免管理员权限、不触发 UAC，与安装向导的默认值保持一致；无法确定 LOCALAPPDATA 时
/// 退回旧的 Program Files 默认。
fn default_install_dir(exe_dir: &Path, program_files: &Path, local_app_data: Option<&Path>) -> PathBuf {
    if InstallManifest::read(exe_dir).is_some() {
        return exe_dir.to_path_buf();
    }
    if let Some(local) = local_app_data {
        return local.join("Programs").join("CetaMesh");
    }
    program_files.join("CetaMesh")
}

/// payload 位置：优先 exe 同目录的 payload\（安装包解压布局），其次开发布局 dist\core，最后 exe 同目录。
fn default_payload_core(exe_dir: &Path) -> PathBuf {
    let staged = exe_dir.join("payload");
    if staged.join(CORE_EXE_NAME).is_file() {
        return staged;
    }
    let dev = exe_dir
        .parent()
        .map(|parent| parent.join("dist").join("core"))
        .unwrap_or_default();
    if dev.join(CORE_EXE_NAME).is_file() {
        return dev;
    }
    exe_dir.to_path_buf()
}

fn product_version(exe_dir: &Path) -> String {
    for candidate in [
        exe_dir.join("resources").join("product.json"),
        exe_dir
            .join("payload")
            .join("resources")
            .join("product.json"),
        exe_dir.join("runtime-manifest.json"),
        exe_dir.join("payload").join("runtime-manifest.json"),
    ] {
        if let Ok(text) = fs::read_to_string(&candidate) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(version) = value.get("version").and_then(|item| item.as_str()) {
                    return version.to_owned();
                }
            }
        }
    }
    "0.0.0".to_owned()
}

fn now_iso() -> String {
    // 不引入时间库：用系统时间的秒数生成一个稳定可排序的时间戳。
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    format!("epoch:{seconds}")
}

pub fn run(cli: &InstallCli) -> i32 {
    let log = |message: &str| println!("{message}");
    match cli.command {
        InstallCommand::Install | InstallCommand::Repair => run_install(cli, log),
        InstallCommand::Uninstall => run_uninstall(cli, log),
        InstallCommand::Migrate => run_migrate(cli, log),
        InstallCommand::DetectInstall => run_detect_install(cli, log),
    }
}

/// 既有安装探测：输出 JSON（`installed` / `installDir` / `version` / `currentVersion`）。
/// 只读：不写文件、不改注册表。
fn run_detect_install(cli: &InstallCli, log: impl Fn(&str)) -> i32 {
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let existing = find_existing_install(&cli.layout.registry_key, &exe_dir, &cli.layout.install_dir);
    let payload = match existing {
        Some(found) => serde_json::json!({
            "installed": true,
            "installDir": found.install_dir.display().to_string(),
            "version": found.version,
            "currentVersion": cli.version,
        }),
        None => serde_json::json!({ "installed": false, "currentVersion": cli.version }),
    };
    log(&payload.to_string());
    0
}

fn run_install(cli: &InstallCli, log: impl Fn(&str)) -> i32 {
    let payload = Payload {
        shell_exe: current_exe_or_self(),
        core_dir: cli.payload_core.clone(),
    };
    // --stop-core：先结束占用安装目录的进程（只按本安装目录下的可执行路径匹配），
    // 典型场景是 DSH 通过 MCP 拉起的 5 个 WhaleBridgeCore.exe 子进程。
    if cli.stop_core {
        let stopped = stop_install_dir_processes(&cli.layout.install_dir, &log);
        log(&format!(
            "--stop-core：已结束 {stopped} 个占用进程（装完请重启 DSH）"
        ));
    }
    let options = InstallOptions {
        version: cli.version.clone(),
        dsh_profile: cli.dsh_profile.clone(),
        dsh_integration: cli.dsh_integration,
        stop_core: cli.stop_core,
        now: now_iso(),
    };
    let existing = InstallManifest::read(&cli.layout.install_dir);
    let is_upgrade = cli.command == InstallCommand::Install && existing.is_some();
    if let Some(record) = &existing {
        log(&format!(
            "已检测到已安装版本 {} → {}",
            if record.version.is_empty() {
                "未知"
            } else {
                &record.version
            },
            cli.version
        ));
    }
    let plan = if cli.command == InstallCommand::Repair {
        plan_repair(&cli.layout, &payload, &options)
    } else {
        plan_install(&cli.layout, &payload, &options, is_upgrade)
    };
    let plan = match plan {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("[whalebridge-installer] {error}");
            return 1;
        }
    };
    log(&plan.report(cli.dry_run));
    if cli.dry_run {
        return 0;
    }
    finish(&plan, log, &cli.layout)
}

/// 结束"可执行文件位于本安装目录内"的进程。只按路径精确匹配，绝不按进程名模糊查杀，
/// 因此不会误伤用户用 BAT/VBS 跑的同名程序或其它目录的副本。
fn stop_install_dir_processes(install_dir: &Path, log: &impl Fn(&str)) -> usize {
    let target = install_dir.to_string_lossy().to_lowercase();
    let script = format!(
        "$p = Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -and \
         $_.ExecutablePath.ToLower().StartsWith('{}') }}; \
         $p | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}; \
         @($p).Count",
        target.replace('\'', "''")
    );
    let output = hidden("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
    match output {
        Ok(result) => {
            let count = String::from_utf8_lossy(&result.stdout)
                .trim()
                .parse::<usize>()
                .unwrap_or(0);
            if count > 0 {
                log(&format!(
                    "  已结束 {count} 个来自 {} 的进程",
                    install_dir.display()
                ));
            }
            count
        }
        Err(error) => {
            log(&format!(
                "  结束占用进程失败（{error}）；请手动退出 DSH 后重试"
            ));
            0
        }
    }
}

fn run_uninstall(cli: &InstallCli, log: impl Fn(&str)) -> i32 {
    let self_exe = current_exe_or_self();
    let inside_install_dir = self_exe
        .parent()
        .map(|parent| same_dir(parent, &cli.layout.install_dir))
        .unwrap_or(false);

    // 从安装目录里运行的卸载器无法删除自己：复制到临时目录，由副本等待本进程退出后再动手。
    if inside_install_dir && cli.wait_pid.is_none() {
        match relocate_and_reexec(cli, &self_exe) {
            Ok(helper) => {
                log(&format!("已启动卸载助手：{}", helper.display()));
                log("本进程退出后由助手完成卸载。");
                return 0;
            }
            Err(error) => {
                eprintln!("[whalebridge-installer] 无法创建卸载助手：{error}");
                return 1;
            }
        }
    }

    if let Some(pid) = cli.wait_pid {
        wait_for_pid_exit(pid, Duration::from_secs(15));
    }

    let plan = plan_uninstall(
        &cli.layout,
        &UninstallOptions {
            remove_data: cli.remove_data,
            remove_dsh_integration: cli.remove_dsh_integration,
            dsh_profile: cli.dsh_profile.clone(),
        },
    );
    log(&plan.report(cli.dry_run));
    if cli.dry_run {
        return 0;
    }
    if cli.remove_data {
        log("  警告：--remove-data 会永久删除配置、state 与令牌，且不备份。");
    }
    let code = finish_with_retry(&plan, log, &cli.layout, cli.wait_pid.is_some(), false);
    schedule_self_delete(&current_exe_or_self());
    code
}

fn run_migrate(cli: &InstallCli, log: impl Fn(&str)) -> i32 {
    let Some(source) = cli.from.clone() else {
        // 只发现候选、不做任何修改：避免"静默迁移"用户没指定过的目录。
        let env_lookup = |key: &str| env::var(key).ok();
        let discovered = discover_candidates(&default_source_candidates(
            &env_lookup,
            &cli.layout.data_dir,
        ));
        log("候选迁移来源（只发现，不修改任何东西）：");
        if discovered.is_empty() {
            log("  （没有发现候选）");
            log("可用 --migrate --from <目录> 显式指定来源。");
            return 1;
        }
        for candidate in &discovered {
            log(&format!(
                "  - {}：{}",
                candidate.root.display(),
                candidate.reason
            ));
        }
        log("请用 --migrate --from <目录> 指定要迁移的来源；加 --dry-run 可先看计划。");
        return 0;
    };

    let plan = match plan_migrate(
        &cli.layout,
        &MigrateOptions {
            source,
            overwrite: cli.force,
        },
    ) {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("[whalebridge-installer] {error}");
            return 1;
        }
    };
    log(&plan.report(cli.dry_run));
    if cli.dry_run {
        return 0;
    }
    finish(&plan, log, &cli.layout)
}

fn finish(plan: &Plan, log: impl Fn(&str), layout: &InstallLayout) -> i32 {
    finish_with_retry(plan, log, layout, false, true)
}

/// 卸载助手可能在等待原进程退出，这里再给文件锁一点时间并重试。
/// `touch_data` 只在安装/修复/迁移时为 true——卸载后不能再创建数据目录，否则
/// `--remove-data` 会刚删完又被日志提示重建出来。
fn finish_with_retry(
    plan: &Plan,
    log: impl Fn(&str),
    layout: &InstallLayout,
    retry: bool,
    touch_data: bool,
) -> i32 {
    let attempts = if retry { 12 } else { 1 };
    for attempt in 1..=attempts {
        match apply_plan(plan, &log) {
            Ok(applied) => {
                log(&format!(
                    "完成：{} 项改动（备份：{}）",
                    plan.effects.len(),
                    applied.backup_dir.display()
                ));
                if touch_data {
                    crate::installer::write_first_run_notice(&layout.data_dir, &log);
                }
                return 0;
            }
            Err(error) => {
                if attempt == attempts {
                    eprintln!("[whalebridge-installer] {error}");
                    return 1;
                }
                log(&format!("  重试 {attempt}/{attempts}：{error}"));
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    1
}

fn current_exe_or_self() -> PathBuf {
    env::current_exe().unwrap_or_else(|_| PathBuf::from(SHELL_EXE_NAME))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// 把自身复制到临时目录并重新执行当前命令，附带 --wait-pid 让助手等待本进程退出。
fn relocate_and_reexec(cli: &InstallCli, self_exe: &Path) -> Result<PathBuf, String> {
    let helper = env::temp_dir().join(format!("whalebridge-uninstall-{}.exe", std::process::id()));
    fs::copy(self_exe, &helper).map_err(|error| format!("复制自身失败：{error}"))?;
    let mut command = hidden(&helper);
    command
        .arg("--uninstall")
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .arg("--install-dir")
        .arg(&cli.layout.install_dir)
        .arg("--data-dir")
        .arg(&cli.layout.data_dir)
        .arg("--start-menu-dir")
        .arg(&cli.layout.start_menu_dir)
        .arg("--desktop-dir")
        .arg(&cli.layout.desktop_dir)
        .arg("--registry-key")
        .arg(&cli.layout.registry_key)
        .arg("--dsh-profile")
        .arg(&cli.dsh_profile);
    if cli.remove_data {
        command.arg("--remove-data");
    }
    if cli.remove_dsh_integration {
        command.arg("--remove-dsh-integration");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动卸载助手失败：{error}"))?;
    Ok(helper)
}

/// 轮询等待进程退出（避免立刻删除仍被占用的 exe）。
fn wait_for_pid_exit(pid: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let output = hidden("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        match output {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                if !text.contains(&pid.to_string()) {
                    return;
                }
            }
            Err(_) => return,
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// 助手自身也要删除：交给一个脱离的 PowerShell 在进程退出后执行。
/// 刻意不用 cmd 的 del：Rust 对嵌套引号的转义（反斜杠加引号）不是 cmd 的语法，
/// 命令会被截断、文件删不掉（实测会在 %TEMP% 留下若干 MB 的助手副本）。
fn schedule_self_delete(self_exe: &Path) {
    let in_temp = env::temp_dir()
        .canonicalize()
        .ok()
        .zip(
            self_exe
                .parent()
                .and_then(|parent| parent.canonicalize().ok()),
        )
        .map(|(temp, parent)| temp == parent)
        .unwrap_or(false);
    if !in_temp {
        return;
    }
    let path_text = self_exe.display().to_string();
    // 路径由我们自己生成（%TEMP%\whalebridge-uninstall-<pid>.exe）。含单引号时直接放弃自删，
    // 绝不把未转义的文本拼进 PowerShell 脚本。
    if path_text.contains('\'') {
        return;
    }
    let script = format!(
        "Start-Sleep -Milliseconds 1200; Remove-Item -LiteralPath '{path_text}' -Force -ErrorAction SilentlyContinue"
    );
    let _ = hidden("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        env::temp_dir().join(format!(
            "whalebridge-install-cli-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn default_install_dir_uses_manifest_for_installed_shell() {
        let root = temp_dir("installed");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(crate::installer::INSTALL_MANIFEST),
            r#"{"version":"1.2.3","files":{}}"#,
        )
        .unwrap();

        assert_eq!(
            default_install_dir(&root, Path::new("C:\\Program Files"), None),
            root
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn default_install_dir_prefers_per_user_cetamesh_for_fresh_installs() {
        let root = temp_dir("unstaged");
        fs::create_dir_all(&root).unwrap();

        assert_eq!(
            default_install_dir(
                &root,
                Path::new("C:\\Program Files"),
                Some(Path::new("C:\\Users\\u\\AppData\\Local"))
            ),
            PathBuf::from("C:\\Users\\u\\AppData\\Local\\Programs\\CetaMesh"),
            "全新安装默认 per-user（免 UAC）且目录品牌为 CetaMesh"
        );
        assert_eq!(
            default_install_dir(&root, Path::new("C:\\Program Files"), None),
            PathBuf::from("C:\\Program Files\\CetaMesh"),
            "无法确定 LOCALAPPDATA 时退回 Program Files\\CetaMesh"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parse_recognises_installer_commands() {
        assert!(
            parse(&["--worker".to_owned()]).unwrap().is_none(),
            "普通模式不应被当作安装器"
        );
        let cli = parse(&[
            "--install".to_owned(),
            "--install-dir".to_owned(),
            "D:\\app".to_owned(),
            "--no-dsh-integration".to_owned(),
            "--dry-run".to_owned(),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(cli.command, InstallCommand::Install);
        assert_eq!(cli.layout.install_dir, PathBuf::from("D:\\app"));
        assert!(!cli.dsh_integration);
        assert!(cli.dry_run);

        let uninstall = parse(&[
            "--uninstall".to_owned(),
            "--remove-data".to_owned(),
            "--wait-pid=42".to_owned(),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(uninstall.command, InstallCommand::Uninstall);
        assert!(uninstall.remove_data);
        assert_eq!(uninstall.wait_pid, Some(42));

        let migrate = parse(&[
            "--migrate".to_owned(),
            "--from".to_owned(),
            "E:\\old".to_owned(),
            "--force".to_owned(),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(migrate.command, InstallCommand::Migrate);
        assert_eq!(migrate.from, Some(PathBuf::from("E:\\old")));
        assert!(migrate.force);
    }
}
