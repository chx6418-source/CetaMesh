//! 鲸桥 Core 启动方式的解析：桌面壳需要知道该启动哪一个「核心」以及用什么参数。
//!
//! 两种模式：
//! - 发布（packaged）：启动与桌面壳同目录、或同目录 `resources/` 下的 `WhaleBridgeCore.exe`。
//!   这是正式交付形态，目标机器不需要安装 Node.js。
//! - 开发（development）：启动 `node <仓库>/src/core-entry.js`，保留源码直接运行的调试方式。
//!
//! 本模块只做解析，不负责启动、健康检查和重启退避——那是阶段 6 的职责。阶段 4 先固定
//! 「选哪个可执行文件、带什么参数、注入哪些环境变量」这一契约，并用单元测试锁住。

use std::path::{Path, PathBuf};

pub const CORE_EXE_NAME: &str = "WhaleBridgeCore.exe";
pub const DEV_ENTRY_DIR: &str = "src";
pub const DEV_ENTRY_FILE: &str = "core-entry.js";
/// 从桌面壳 exe 所在目录向上查找仓库根的最大层数（target/debug → target → 仓库根）。
const MAX_WALK_UP: usize = 6;

/// 逐段拼接，避免 "src/core-entry.js" 作为单个组件保留正斜杠导致路径比较不一致。
fn dev_entry_path(root: &Path) -> PathBuf {
    root.join(DEV_ENTRY_DIR).join(DEV_ENTRY_FILE)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreMode {
    Packaged,
    Development,
}

impl CoreMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreMode::Packaged => "packaged",
            CoreMode::Development => "development",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "packaged" | "release" | "sea" => Ok(CoreMode::Packaged),
            "development" | "dev" | "source" => Ok(CoreMode::Development),
            other => Err(format!(
                "未知的 Core 运行模式：{other}（可选 packaged / development）"
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreLaunchSpec {
    pub mode: CoreMode,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// 追加到子进程环境变量的键值对（其余环境继承桌面壳）。
    pub env: Vec<(String, String)>,
}

pub struct ResolveOptions<'a> {
    /// 桌面壳自身 exe 所在目录。
    pub exe_dir: &'a Path,
    /// 显式指定的 Core 可执行文件（`--core-command` / `WHALEBRIDGE_CORE_EXE`）。
    pub override_command: Option<&'a str>,
    /// 强制模式（`--core-mode` / `WHALEBRIDGE_CORE_MODE`）。
    pub override_mode: Option<&'a str>,
    /// 开发模式仓库根（`WHALEBRIDGE_REPO_ROOT`）。
    pub repo_root: Option<&'a str>,
    /// 要注入 Core 的可写数据目录（`WHALEBRIDGE_DATA_DIR`）。
    pub data_dir: Option<&'a str>,
    /// 路径存在性判断，注入以便测试无需真实文件系统。
    pub exists: &'a dyn Fn(&Path) -> bool,
}

fn packaged_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    vec![
        exe_dir.join(CORE_EXE_NAME),
        exe_dir.join("resources").join(CORE_EXE_NAME),
    ]
}

/// 从 exe 所在目录逐级向上查找开发模式入口 `src/core-entry.js`。
fn discover_repo_root(exe_dir: &Path, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut current = Some(exe_dir.to_path_buf());
    for _ in 0..=MAX_WALK_UP {
        let dir = current?;
        if exists(&dev_entry_path(&dir)) {
            return Some(dir);
        }
        current = dir.parent().map(Path::to_path_buf);
    }
    None
}

/// 解析 Core 启动方式。
///
/// 优先级：
/// 1. `--core-mode` 强制模式；
/// 2. `--core-command` 显式指定可执行文件（未指定模式时按文件名推断：`.exe` 视为发布模式）；
/// 3. 发布模式：桌面壳同目录或 `resources/` 下的 `WhaleBridgeCore.exe`；
/// 4. 开发模式：`node <仓库根>/src/core-entry.js`。
pub fn resolve_core_launch(options: ResolveOptions<'_>) -> Result<CoreLaunchSpec, String> {
    let exe_dir = options.exe_dir;
    let forced_mode = match options.override_mode {
        Some(value) if !value.trim().is_empty() => Some(CoreMode::parse(value)?),
        _ => None,
    };
    let override_command = options
        .override_command
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    let packaged = packaged_candidates(exe_dir)
        .into_iter()
        .find(|candidate| (options.exists)(candidate));

    let mode = match (forced_mode, &override_command) {
        (Some(mode), _) => mode,
        (None, Some(command)) => {
            let is_exe = command
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
            if is_exe {
                CoreMode::Packaged
            } else {
                CoreMode::Development
            }
        }
        (None, None) => {
            if packaged.is_some() {
                CoreMode::Packaged
            } else {
                CoreMode::Development
            }
        }
    };

    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(dir) = options
        .data_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.push(("WHALEBRIDGE_DATA_DIR".to_owned(), dir.to_owned()));
    }

    match mode {
        CoreMode::Packaged => {
            let program = override_command.or(packaged).ok_or_else(|| {
                format!(
                    "发布模式未找到 {CORE_EXE_NAME}：请把它放在桌面壳同目录或 resources\\ 下，\
                         或用 --core-command 指定路径"
                )
            })?;
            if !(options.exists)(&program) {
                return Err(format!(
                    "指定的 Core 可执行文件不存在：{}",
                    program.display()
                ));
            }
            // 打包模式下不设置 WHALEBRIDGE_RESOURCE_DIR：Core 会自行发现同目录的 resources\。
            Ok(CoreLaunchSpec {
                mode,
                program,
                args: vec!["--worker".to_owned()],
                env,
            })
        }
        CoreMode::Development => {
            let repo_root = options
                .repo_root
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| discover_repo_root(exe_dir, options.exists));
            let entry = repo_root
                .as_ref()
                .map(|root| dev_entry_path(root))
                .filter(|candidate| (options.exists)(candidate))
                .ok_or_else(|| {
                    "开发模式未找到 src/core-entry.js：请用 WHALEBRIDGE_REPO_ROOT 指定仓库根，\
                     或用 --core-command 指定入口"
                        .to_owned()
                })?;
            if let Some(root) = &repo_root {
                env.push((
                    "WHALEBRIDGE_RESOURCE_DIR".to_owned(),
                    root.to_string_lossy().into_owned(),
                ));
            }
            let program = override_command.unwrap_or_else(|| PathBuf::from("node"));
            Ok(CoreLaunchSpec {
                mode,
                program,
                args: vec![entry.to_string_lossy().into_owned(), "--worker".to_owned()],
                env,
            })
        }
    }
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

    fn base_options<'a>(
        exe_dir: &'a Path,
        exists: &'a dyn Fn(&Path) -> bool,
    ) -> ResolveOptions<'a> {
        ResolveOptions {
            exe_dir,
            override_command: None,
            override_mode: None,
            repo_root: None,
            data_dir: None,
            exists,
        }
    }

    #[test]
    fn mode_parsing_accepts_aliases_and_rejects_unknown() {
        assert_eq!(CoreMode::parse("packaged").unwrap(), CoreMode::Packaged);
        assert_eq!(CoreMode::parse("SEA").unwrap(), CoreMode::Packaged);
        assert_eq!(CoreMode::parse("dev").unwrap(), CoreMode::Development);
        assert!(CoreMode::parse("nope").is_err());
    }

    #[test]
    fn prefers_packaged_core_next_to_shell() {
        let exists = exists_in(&["C:\\app\\WhaleBridgeCore.exe"]);
        let spec = resolve_core_launch(base_options(Path::new("C:\\app"), &exists)).unwrap();
        assert_eq!(spec.mode, CoreMode::Packaged);
        assert_eq!(spec.program, PathBuf::from("C:\\app\\WhaleBridgeCore.exe"));
        assert_eq!(spec.args, vec!["--worker".to_owned()]);
        // 打包模式不得注入资源目录：由 Core 自行发现同目录 resources\。
        assert!(spec.env.is_empty());
    }

    #[test]
    fn finds_packaged_core_under_resources() {
        let exists = exists_in(&["C:\\app\\resources\\WhaleBridgeCore.exe"]);
        let spec = resolve_core_launch(base_options(Path::new("C:\\app"), &exists)).unwrap();
        assert_eq!(spec.mode, CoreMode::Packaged);
        assert_eq!(
            spec.program,
            PathBuf::from("C:\\app\\resources\\WhaleBridgeCore.exe")
        );
    }

    #[test]
    fn falls_back_to_development_entry_from_target_directory() {
        // 典型布局：<repo>/desktop-shell/target/debug/whalebridge-desktop.exe
        let exists = exists_in(&["C:\\repo\\src\\core-entry.js"]);
        let spec = resolve_core_launch(base_options(
            Path::new("C:\\repo\\desktop-shell\\target\\debug"),
            &exists,
        ))
        .unwrap();
        assert_eq!(spec.mode, CoreMode::Development);
        assert_eq!(spec.program, PathBuf::from("node"));
        assert_eq!(spec.args, vec!["C:\\repo\\src\\core-entry.js", "--worker"]);
        assert_eq!(
            spec.env,
            vec![("WHALEBRIDGE_RESOURCE_DIR".to_owned(), "C:\\repo".to_owned())]
        );
    }

    #[test]
    fn packaged_wins_over_development_when_both_exist() {
        let exists = exists_in(&[
            "C:\\repo\\WhaleBridgeCore.exe",
            "C:\\repo\\src\\core-entry.js",
        ]);
        let spec = resolve_core_launch(base_options(Path::new("C:\\repo"), &exists)).unwrap();
        assert_eq!(spec.mode, CoreMode::Packaged);
    }

    #[test]
    fn explicit_command_overrides_discovery() {
        let exists = exists_in(&["C:\\repo\\WhaleBridgeCore.exe", "D:\\custom\\core.exe"]);
        let options = ResolveOptions {
            override_command: Some("D:\\custom\\core.exe"),
            ..base_options(Path::new("C:\\repo"), &exists)
        };
        let spec = resolve_core_launch(options).unwrap();
        assert_eq!(spec.mode, CoreMode::Packaged);
        assert_eq!(spec.program, PathBuf::from("D:\\custom\\core.exe"));
    }

    #[test]
    fn forced_mode_overrides_discovery() {
        let exists = exists_in(&[
            "C:\\repo\\WhaleBridgeCore.exe",
            "C:\\repo\\src\\core-entry.js",
        ]);
        let options = ResolveOptions {
            override_mode: Some("development"),
            ..base_options(Path::new("C:\\repo"), &exists)
        };
        let spec = resolve_core_launch(options).unwrap();
        assert_eq!(spec.mode, CoreMode::Development);
        assert_eq!(spec.program, PathBuf::from("node"));
    }

    #[test]
    fn dev_mode_without_entry_is_an_error_with_guidance() {
        let error =
            resolve_core_launch(base_options(Path::new("C:\\nowhere"), &never)).unwrap_err();
        assert!(error.contains("core-entry.js"), "{error}");
    }

    #[test]
    fn packaged_mode_without_binary_is_an_error_with_guidance() {
        let options = ResolveOptions {
            override_mode: Some("packaged"),
            ..base_options(Path::new("C:\\app"), &never)
        };
        let error = resolve_core_launch(options).unwrap_err();
        assert!(error.contains(CORE_EXE_NAME), "{error}");
    }

    #[test]
    fn data_dir_is_injected_for_both_modes() {
        let exists = exists_in(&[
            "C:\\app\\WhaleBridgeCore.exe",
            "C:\\repo\\src\\core-entry.js",
        ]);
        let packaged = resolve_core_launch(ResolveOptions {
            data_dir: Some("C:\\data"),
            ..base_options(Path::new("C:\\app"), &exists)
        })
        .unwrap();
        assert_eq!(
            packaged.env,
            vec![("WHALEBRIDGE_DATA_DIR".to_owned(), "C:\\data".to_owned())]
        );

        let development = resolve_core_launch(ResolveOptions {
            data_dir: Some("C:\\data"),
            override_mode: Some("development"),
            ..base_options(Path::new("C:\\repo"), &exists)
        })
        .unwrap();
        assert!(
            development
                .env
                .contains(&("WHALEBRIDGE_DATA_DIR".to_owned(), "C:\\data".to_owned()))
        );
    }

    #[test]
    fn repo_root_override_skips_directory_walking() {
        let exists = exists_in(&["D:\\elsewhere\\src\\core-entry.js"]);
        let options = ResolveOptions {
            repo_root: Some("D:\\elsewhere"),
            ..base_options(Path::new("C:\\app"), &exists)
        };
        let spec = resolve_core_launch(options).unwrap();
        assert_eq!(spec.mode, CoreMode::Development);
        assert_eq!(
            spec.args,
            vec!["D:\\elsewhere\\src\\core-entry.js", "--worker"]
        );
    }

    #[test]
    fn unknown_forced_mode_is_rejected() {
        let options = ResolveOptions {
            override_mode: Some("hybrid"),
            ..base_options(Path::new("C:\\app"), &never)
        };
        assert!(resolve_core_launch(options).unwrap_err().contains("hybrid"));
    }
}
