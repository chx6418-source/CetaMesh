//! 桌面壳自己的路径与配置解析：数据目录、控制台端口、日志路径。
//!
//! 与 `src/app-paths.js` 的打包分支保持同一套优先级，避免壳和 worker 对"数据目录在哪"
//! 产生分歧：`--data-dir` > `WHALEBRIDGE_DATA_DIR` > exe 同目录 `portable.flag` >
//! `%LOCALAPPDATA%\WhaleBridge`。

use std::fs;
use std::path::{Path, PathBuf};

/// 与 `src/bridge.js` 的 `file.consolePort ?? 3100` 保持一致。
pub const DEFAULT_CONSOLE_PORT: u16 = 3100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    pub portable: bool,
}

/// 解析数据目录。`exists` 注入以便测试不依赖真实文件系统。
pub fn resolve_data_dir(
    explicit: Option<&str>,
    env_data_dir: Option<&str>,
    exe_dir: &Path,
    local_app_data: Option<&Path>,
    exists: &dyn Fn(&Path) -> bool,
) -> DesktopPaths {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return DesktopPaths {
            data_dir: PathBuf::from(value),
            portable: false,
        };
    }
    if let Some(value) = env_data_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return DesktopPaths {
            data_dir: PathBuf::from(value),
            portable: false,
        };
    }
    if exists(&exe_dir.join("portable.flag")) {
        return DesktopPaths {
            data_dir: exe_dir.join("data"),
            portable: true,
        };
    }
    let base = local_app_data
        .map(Path::to_path_buf)
        .unwrap_or_else(|| exe_dir.to_path_buf());
    DesktopPaths {
        data_dir: base.join("WhaleBridge"),
        portable: false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigProbe {
    pub config_file: PathBuf,
    pub port: u16,
    /// 配置缺失或无法解析时的说明（不阻断启动：worker 会自行挂错误页，壳随后展示它）。
    pub warning: Option<String>,
}

/// 读取 `config.json` 的 `consolePort`。文件缺失/损坏时返回默认端口并附带说明。
pub fn probe_config(data_dir: &Path) -> ConfigProbe {
    let config_file = data_dir.join("config.json");
    let text = match fs::read_to_string(&config_file) {
        Ok(text) => text,
        Err(error) => {
            return ConfigProbe {
                config_file,
                port: DEFAULT_CONSOLE_PORT,
                warning: Some(format!("读取配置失败：{error}")),
            };
        }
    };
    // Windows 下常见 UTF-8 BOM 会令 JSON 解析失败（与 bridge 的 readJsonSafe 同样处理）。
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => {
            let port = value
                .get("consolePort")
                .and_then(|item| item.as_u64())
                .filter(|port| *port > 0 && *port <= u16::MAX as u64)
                .map(|port| port as u16)
                .unwrap_or(DEFAULT_CONSOLE_PORT);
            ConfigProbe {
                config_file,
                port,
                warning: None,
            }
        }
        Err(error) => ConfigProbe {
            config_file,
            port: DEFAULT_CONSOLE_PORT,
            warning: Some(format!("配置解析失败：{error}")),
        },
    }
}

pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

pub fn worker_log_file(data_dir: &Path) -> PathBuf {
    log_dir(data_dir).join("worker.log")
}

pub fn shell_log_file(data_dir: &Path) -> PathBuf {
    log_dir(data_dir).join("desktop-shell.log")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn exists_in<'a>(paths: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        let set: BTreeSet<String> = paths.iter().map(|item| item.to_string()).collect();
        move |candidate: &Path| set.contains(&candidate.to_string_lossy().into_owned())
    }

    fn never(_: &Path) -> bool {
        false
    }

    #[test]
    fn explicit_data_dir_wins_over_everything() {
        let exists = exists_in(&["C:\\app\\portable.flag"]);
        let resolved = resolve_data_dir(
            Some("D:\\explicit"),
            Some("E:\\env"),
            Path::new("C:\\app"),
            Some(Path::new("C:\\Users\\me\\AppData\\Local")),
            &exists,
        );
        assert_eq!(resolved.data_dir, PathBuf::from("D:\\explicit"));
        assert!(!resolved.portable);
    }

    #[test]
    fn env_data_dir_beats_portable_flag() {
        let exists = exists_in(&["C:\\app\\portable.flag"]);
        let resolved = resolve_data_dir(
            None,
            Some("E:\\env"),
            Path::new("C:\\app"),
            Some(Path::new("C:\\Users\\me\\AppData\\Local")),
            &exists,
        );
        assert_eq!(resolved.data_dir, PathBuf::from("E:\\env"));
    }

    #[test]
    fn portable_flag_uses_exe_directory_data() {
        let exists = exists_in(&["C:\\app\\portable.flag"]);
        let resolved = resolve_data_dir(
            None,
            None,
            Path::new("C:\\app"),
            Some(Path::new("C:\\Users\\me\\AppData\\Local")),
            &exists,
        );
        assert_eq!(resolved.data_dir, PathBuf::from("C:\\app\\data"));
        assert!(resolved.portable);
    }

    #[test]
    fn default_data_dir_is_local_app_data() {
        let resolved = resolve_data_dir(
            None,
            None,
            Path::new("C:\\app"),
            Some(Path::new("C:\\Users\\me\\AppData\\Local")),
            &never,
        );
        assert_eq!(
            resolved.data_dir,
            PathBuf::from("C:\\Users\\me\\AppData\\Local\\WhaleBridge")
        );
        assert!(!resolved.portable);
    }

    #[test]
    fn blank_overrides_are_ignored() {
        let resolved = resolve_data_dir(
            Some("   "),
            Some(""),
            Path::new("C:\\app"),
            Some(Path::new("C:\\Local")),
            &never,
        );
        assert_eq!(resolved.data_dir, PathBuf::from("C:\\Local\\WhaleBridge"));
    }

    #[test]
    fn console_port_is_read_from_config() {
        let dir = std::env::temp_dir().join(format!("wb-paths-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        fs::write(&file, "{\"consolePort\": 4321}").unwrap();
        let probe = probe_config(&dir);
        assert_eq!(probe.port, 4321);
        assert!(probe.warning.is_none());

        // 带 BOM 也要能读
        fs::write(&file, "\u{feff}{\"consolePort\": 4322}").unwrap();
        assert_eq!(probe_config(&dir).port, 4322);

        // 缺字段 → 默认端口
        fs::write(&file, "{}").unwrap();
        assert_eq!(probe_config(&dir).port, DEFAULT_CONSOLE_PORT);

        // 损坏 → 默认端口 + 说明
        fs::write(&file, "{oops").unwrap();
        let broken = probe_config(&dir);
        assert_eq!(broken.port, DEFAULT_CONSOLE_PORT);
        assert!(broken.warning.is_some());

        // 缺失 → 默认端口 + 说明
        fs::remove_file(&file).unwrap();
        let missing = probe_config(&dir);
        assert_eq!(missing.port, DEFAULT_CONSOLE_PORT);
        assert!(missing.warning.unwrap().contains("读取配置失败"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn log_paths_live_under_data_dir() {
        let data = Path::new("C:\\data");
        assert_eq!(
            worker_log_file(data),
            PathBuf::from("C:\\data\\logs\\worker.log")
        );
        assert_eq!(
            shell_log_file(data),
            PathBuf::from("C:\\data\\logs\\desktop-shell.log")
        );
    }
}
