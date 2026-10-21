//! 旧数据迁移：发现候选目录、核对可迁移内容、备份后复制、失败回滚。
//!
//! 规则（工作簿 §8）：
//! - 自动扫描只**发现候选**，不做静默覆盖；
//! - 迁移前显示来源与目标，并对目标做备份；
//! - JSON 必须先解析验证再迁移；
//! - 敏感配置不写进日志；
//! - 旧目录保留，绝不删除；
//! - 外部工具路径（ffmpeg 等）不存在时只警告，不自动改写。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::installer::{Effect, InstallLayout, Plan};

/// 可迁移项：相对数据目录的路径。
pub const MIGRATABLE_FILES: &[&str] = &[
    "config.json",
    "state/mode.json",
    "state/current-role.json",
    "state/sessions.json",
    "state/slang.json",
    "state/slang-session.json",
    "state/social-v2.json",
    "state/social-v2-cards.json",
    "state/stickers.json",
    "state/feedback.json",
    "state/console-token",
    "state/agent-token",
    "state/local-service-detection.json",
];

/// 用户角色目录：逐个 .md 迁移，同名不覆盖。
pub const MIGRATABLE_DIRS: &[&str] = &["roles"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub root: PathBuf,
    pub has_config: bool,
    pub state_files: usize,
    pub role_files: usize,
    pub looks_like_repo: bool,
    /// 判定为候选的原因（写进报告，便于人工确认）
    pub reason: String,
}

/// 扫描候选数据目录。只读，不修改任何东西。
pub fn discover_candidates(paths: &[PathBuf]) -> Vec<Candidate> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for path in paths {
        let key = path.display().to_string().to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let has_config = path.join("config.json").is_file();
        let state_dir = path.join("state");
        let mut state_files = 0;
        if let Ok(entries) = fs::read_dir(&state_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if MIGRATABLE_FILES
                    .iter()
                    .any(|item| item.ends_with(&format!("/{name}")))
                {
                    state_files += 1;
                }
            }
        }
        let role_files = fs::read_dir(path.join("roles"))
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".md"))
                    .count()
            })
            .unwrap_or(0);
        let looks_like_repo =
            path.join("src").join("bridge.js").is_file() || path.join("package.json").is_file();
        if !has_config && state_files == 0 && role_files == 0 {
            continue;
        }
        let reason = if looks_like_repo {
            format!(
                "源码仓库形态（config.json: {has_config}，state 文件: {state_files}，角色: {role_files}）"
            )
        } else {
            format!(
                "数据目录形态（config.json: {has_config}，state 文件: {state_files}，角色: {role_files}）"
            )
        };
        out.push(Candidate {
            root: path.clone(),
            has_config,
            state_files,
            role_files,
            looks_like_repo,
            reason,
        });
    }
    out
}

/// 校验 JSON 是否可解析（迁移前必须通过；带 BOM 也接受）。
pub fn validate_json(path: &Path) -> Result<(), String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str::<serde_json::Value>(text)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// 配置里指向本机外部工具的路径：不存在时只警告（不自动改写）。
pub fn external_tool_warnings(config_file: &Path) -> Vec<String> {
    let mut warnings = Vec::new();
    let Ok(text) = fs::read_to_string(config_file) else {
        return warnings;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}'))
    else {
        return warnings;
    };
    let candidates = [
        ("fileSend.ffmpegPath", value.pointer("/fileSend/ffmpegPath")),
        (
            "ttsLocal.refAudioPath",
            value.pointer("/ttsLocal/refAudioPath"),
        ),
        (
            "snowluma.launcherPath",
            value.pointer("/snowluma/launcherPath"),
        ),
        ("snowluma.homeDir", value.pointer("/snowluma/homeDir")),
        ("dsh.homeDir", value.pointer("/dsh/homeDir")),
        ("dsh.executable", value.pointer("/dsh/executable")),
        ("sessionCwd", value.pointer("/sessionCwd")),
    ];
    for (key, item) in candidates {
        if let Some(text) = item.and_then(|item| item.as_str()) {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !Path::new(trimmed).exists() {
                warnings.push(format!(
                    "配置项 {key} 指向的路径不存在：{trimmed}（未自动改写）"
                ));
            }
        }
    }
    if let Some(list) = value
        .pointer("/fileSend/localDirs")
        .and_then(|item| item.as_array())
    {
        for item in list {
            if let Some(text) = item.as_str() {
                if !text.trim().is_empty() && !Path::new(text).exists() {
                    warnings.push(format!(
                        "fileSend.localDirs 中的路径不存在：{text}（未自动改写）"
                    ));
                }
            }
        }
    }
    warnings
}

/// 目标文件是否只是"安装器生成的占位配置"（与随包附带的 config.example.json 逐字节相同）。
/// 这类文件不是用户内容，迁移时允许被真实配置直接替换——否则"先安装再迁移"会因为
/// "默认不覆盖"而把占位配置留下，用户看到的是空令牌的配置却以为迁移成功了。
///
/// 示例文件的位置按两个候选找：`<安装目录>\resources\` 与**运行中 exe 同目录**的 `resources\`。
/// 后者很重要：普通用户只会敲 `--migrate --from <旧目录>`，不会带 `--install-dir`，
/// 此时只有 exe 同目录这条路径能找到示例文件。
fn is_shipped_placeholder(target: &Path, layout: &InstallLayout) -> bool {
    let mut candidates = vec![
        layout
            .install_dir
            .join("resources")
            .join("config.example.json"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("config.example.json"));
        }
    }
    let Ok(current) = fs::read(target) else {
        return false;
    };
    candidates.iter().any(|example| {
        fs::read(example)
            .map(|shipped| shipped == current)
            .unwrap_or(false)
    })
}

pub struct MigrateOptions {
    pub source: PathBuf,
    /// 目标已存在同名文件时是否覆盖（默认不覆盖）。
    pub overwrite: bool,
}

/// 生成迁移计划：默认不覆盖任何已存在的目标文件。
pub fn plan_migrate(layout: &InstallLayout, options: &MigrateOptions) -> Result<Plan, String> {
    let source = &options.source;
    if !source.is_dir() {
        return Err(format!("迁移来源不是目录：{}", source.display()));
    }
    let mut plan = Plan::new("迁移", layout);
    plan.notes
        .push(format!("来源（只读，迁移后保留）：{}", source.display()));

    if source == &layout.data_dir {
        plan.notes.push("来源与目标相同，无需迁移".to_owned());
        return Ok(plan);
    }

    let mut planned = 0;
    for relative in MIGRATABLE_FILES {
        let from = source.join(relative);
        if !from.is_file() {
            continue;
        }
        if relative.ends_with(".json") {
            if let Err(error) = validate_json(&from) {
                plan.warnings
                    .push(format!("{relative} 不是合法 JSON，已跳过（{error}）"));
                continue;
            }
        }
        let to = layout.data_dir.join(relative);
        if to.is_file() && !options.overwrite {
            if is_shipped_placeholder(&to, layout) {
                plan.effects.push(Effect::CopyFile { from, to });
                plan.notes
                    .push(format!("用真实配置替换安装器生成的占位 {relative}"));
                planned += 1;
                continue;
            }
            // 已有同名文件：默认保留目标（并说明来源里也有一份）
            plan.notes
                .push(format!("保留已存在的 {relative}（来源里也有一份，未覆盖）"));
            continue;
        }
        plan.effects.push(Effect::CopyFile { from, to });
        planned += 1;
    }
    if planned > 0 {
        plan.notes.push(format!("迁移 {planned} 个文件到数据目录"));
    }

    for dir in MIGRATABLE_DIRS {
        let from_dir = source.join(dir);
        if !from_dir.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&from_dir).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if !name_text.ends_with(".md") || name_text == "README.md" {
                continue;
            }
            let to = layout.data_dir.join(dir).join(&name);
            if to.is_file() && !options.overwrite {
                plan.notes.push(format!("保留已存在的 {dir}/{name_text}"));
                continue;
            }
            plan.effects.push(Effect::CopyFile {
                from: entry.path(),
                to,
            });
        }
    }

    let source_config = source.join("config.json");
    if source_config.is_file() {
        plan.warnings.extend(external_tool_warnings(&source_config));
        // 敏感项提示（不打印内容）
        if let Ok(text) = fs::read_to_string(&source_config) {
            if let Ok(value) =
                serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}'))
            {
                for key in ["/consoleToken", "/snowluma/accessToken"] {
                    if value
                        .pointer(key)
                        .and_then(|item| item.as_str())
                        .map(str::trim)
                        .is_some_and(|item| !item.is_empty())
                    {
                        plan.notes
                            .push(format!("来源配置包含 {key}（内容不写入日志）"));
                    }
                }
            }
        }
    }

    if plan.effects.is_empty() {
        plan.notes.push("没有需要迁移的内容".to_owned());
    } else {
        plan.notes
            .push("迁移后请检查配置里的绝对路径（尤其是 DSH/SnowLuma/ffmpeg）".to_owned());
    }
    Ok(plan)
}

/// 默认候选来源：旧仓库目录、便携数据目录、以及显式传入的路径。
pub fn default_source_candidates(
    env: &dyn Fn(&str) -> Option<String>,
    current_data_dir: &Path,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for key in ["WHALEBRIDGE_MIGRATE_FROM", "WHALEBRIDGE_REPO_ROOT"] {
        if let Some(value) = env(key).filter(|value| !value.trim().is_empty()) {
            out.push(PathBuf::from(value));
        }
    }
    out.push(current_data_dir.to_path_buf());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::{InstallLayout, apply_plan_with_backup};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wb-migrate-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn layout(root: &Path) -> InstallLayout {
        InstallLayout {
            install_dir: root.join("app"),
            data_dir: root.join("data"),
            start_menu_dir: root.join("start"),
            desktop_dir: root.join("desktop"),
            registry_key: "HKCU\\Software\\WhaleBridgeTest\\migrate".to_owned(),
            create_desktop_shortcut: false,
        }
    }

    fn seed_source(root: &Path) -> PathBuf {
        let source = root.join("old-repo");
        fs::create_dir_all(source.join("state")).unwrap();
        fs::create_dir_all(source.join("roles")).unwrap();
        fs::write(
            source.join("config.json"),
            b"{\"consolePort\":3100,\"consoleToken\":\"secret\",\"sessionCwd\":\"X:\\\\nope\"}",
        )
        .unwrap();
        fs::write(source.join("state").join("sessions.json"), b"{\"a\":1}").unwrap();
        fs::write(
            source.join("state").join("mode.json"),
            b"{\"mode\":\"reserved2\"}",
        )
        .unwrap();
        fs::write(source.join("state").join("broken.json"), b"{not json").unwrap();
        fs::write(source.join("roles").join("小鲸鱼.md"), b"role").unwrap();
        fs::write(source.join("roles").join("README.md"), b"readme").unwrap();
        source
    }

    #[test]
    fn discovers_source_and_plans_without_overwriting() {
        let root = temp_dir("plan");
        let source = seed_source(&root);
        let layout = layout(&root);

        let candidates = discover_candidates(&[source.clone()]);
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].has_config);
        assert_eq!(candidates[0].state_files, 2);

        let plan = plan_migrate(
            &layout,
            &MigrateOptions {
                source: source.clone(),
                overwrite: false,
            },
        )
        .unwrap();
        assert!(
            plan.effects.len() >= 4,
            "应计划迁移 config/state/roles：{:?}",
            plan.effects.len()
        );
        assert!(
            plan.notes
                .iter()
                .any(|note| note.contains("只读，迁移后保留"))
        );
        assert!(
            plan.warnings
                .iter()
                .any(|warning| warning.contains("sessionCwd")),
            "外部路径应告警"
        );
        assert!(
            plan.notes.iter().any(|note| note.contains("consoleToken")),
            "敏感项应提示且不打印内容"
        );
        // 畸形 JSON 不迁移
        assert!(!plan.effects.iter().any(|effect| matches!(effect, Effect::CopyFile { from, .. } if from.ends_with("broken.json"))));
        // README.md 不迁移
        assert!(!plan.effects.iter().any(
            |effect| matches!(effect, Effect::CopyFile { from, .. } if from.ends_with("README.md"))
        ));

        apply_plan_with_backup(&plan, &|_| {}, &root.join("backup")).unwrap();
        assert!(layout.data_dir.join("config.json").is_file());
        assert!(
            layout
                .data_dir
                .join("state")
                .join("sessions.json")
                .is_file()
        );
        assert!(layout.data_dir.join("roles").join("小鲸鱼.md").is_file());
        assert!(source.is_dir(), "旧目录必须保留");

        // 目标已有同名文件时不覆盖
        fs::write(
            layout.data_dir.join("config.json"),
            b"{\"consolePort\":9999}",
        )
        .unwrap();
        let second = plan_migrate(
            &layout,
            &MigrateOptions {
                source: source.clone(),
                overwrite: false,
            },
        )
        .unwrap();
        assert!(
            !second.effects.iter().any(|effect| matches!(effect, Effect::CopyFile { from, .. } if from.ends_with("config.json"))),
            "默认不得覆盖已存在的 config.json"
        );
        assert_eq!(
            fs::read_to_string(layout.data_dir.join("config.json")).unwrap(),
            "{\"consolePort\":9999}"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn same_source_and_target_is_a_noop() {
        let root = temp_dir("same");
        let layout = layout(&root);
        fs::create_dir_all(&layout.data_dir).unwrap();
        let plan = plan_migrate(
            &layout,
            &MigrateOptions {
                source: layout.data_dir.clone(),
                overwrite: false,
            },
        )
        .unwrap();
        assert!(plan.effects.is_empty());
    }

    #[test]
    fn missing_source_is_an_error() {
        let root = temp_dir("missing");
        let layout = layout(&root);
        assert!(
            plan_migrate(
                &layout,
                &MigrateOptions {
                    source: root.join("nope"),
                    overwrite: false
                }
            )
            .is_err()
        );
        fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod placeholder_tests {
    use super::*;
    use crate::installer::InstallLayout;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wb-migph-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn layout(root: &Path) -> InstallLayout {
        InstallLayout {
            install_dir: root.join("app"),
            data_dir: root.join("data"),
            start_menu_dir: root.join("start"),
            desktop_dir: root.join("desktop"),
            registry_key: r"HKCU\Software\WhaleBridgeTest\migph".to_owned(),
            create_desktop_shortcut: false,
        }
    }

    /// 安装器生成的占位 config.json（等于 config.example.json）必须能被真实配置替换；
    /// 用户自己写过的 config.json 仍然不能被覆盖。
    #[test]
    fn shipped_placeholder_config_is_replaced_but_user_config_is_kept() {
        let root = temp_dir("cfg");
        let layout = layout(&root);
        let example = layout
            .install_dir
            .join("resources")
            .join("config.example.json");
        fs::create_dir_all(example.parent().unwrap()).unwrap();
        fs::write(&example, "{\"consolePort\":3100}").unwrap();
        fs::create_dir_all(&layout.data_dir).unwrap();

        let source = root.join("old");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("config.json"),
            "{\"consolePort\":3100,\"consoleToken\":\"real\"}",
        )
        .unwrap();

        // 1) 目标是安装器写的占位配置 → 允许替换
        fs::write(
            layout.data_dir.join("config.json"),
            "{\"consolePort\":3100}",
        )
        .unwrap();
        let plan = plan_migrate(
            &layout,
            &MigrateOptions {
                source: source.clone(),
                overwrite: false,
            },
        )
        .unwrap();
        assert!(
            plan.effects.iter().any(|effect| matches!(effect, Effect::CopyFile { from, .. } if from.ends_with("config.json"))),
            "占位配置应被真实配置替换"
        );
        assert!(
            plan.notes.iter().any(|note| note.contains("占位")),
            "应说明替换了占位配置"
        );

        // 2) 目标是用户改过的配置 → 默认不覆盖
        fs::write(
            layout.data_dir.join("config.json"),
            "{\"consolePort\":4321}",
        )
        .unwrap();
        let guarded = plan_migrate(
            &layout,
            &MigrateOptions {
                source: source.clone(),
                overwrite: false,
            },
        )
        .unwrap();
        assert!(
            !guarded.effects.iter().any(|effect| matches!(effect, Effect::CopyFile { from, .. } if from.ends_with("config.json"))),
            "用户改过的配置不得被覆盖"
        );

        fs::remove_dir_all(&root).ok();
    }
}
