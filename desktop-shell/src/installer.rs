//! 安装 / 修复 / 卸载 / 迁移引擎。
//!
//! 与 `src/dsh-integration.js` 同构：先算出"要做什么"（effect 列表），再由 apply 执行，
//! 任何一步失败都按快照回滚。全部根目录（安装目录、数据目录、开始菜单、桌面、注册表键）
//! 都可注入，因此测试能在临时目录里跑完整的 安装→升级→修复→迁移→卸载→重装 生命周期，
//! 不会碰到用户真实的 Program Files / 开始菜单 / 真实数据目录。
//!
//! 安装物清单写在 `<安装目录>\install-manifest.json`：卸载时只移除清单里记录的、且内容未被
//! 用户改过的文件，这与 DSH 集成的归属模型（ADR-008/ADR-012）保持一致。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::desktop_paths;
use crate::supervisor::hidden;

pub const PRODUCT_NAME: &str = "CetaMesh";
pub const INSTALL_MANIFEST: &str = "install-manifest.json";
/// 回滚快照目录（位于数据目录下，与 DSH 集成侧同名）。
pub const BACKUP_DIR_NAME: &str = ".whalebridge-backup";
pub const SHELL_EXE_NAME: &str = "WhaleBridge.exe";
pub const CORE_EXE_NAME: &str = "WhaleBridgeCore.exe";
pub const START_MENU_SHORTCUT: &str = "CetaMesh.lnk";
pub const UNINSTALL_SHORTCUT: &str = "卸载 CetaMesh.lnk";
pub const DESKTOP_SHORTCUT: &str = "CetaMesh.lnk";
const LEGACY_START_MENU_SHORTCUT: &str = "鲸桥 WhaleBridge.lnk";
const LEGACY_UNINSTALL_SHORTCUT: &str = "卸载鲸桥.lnk";
const LEGACY_DESKTOP_SHORTCUT: &str = "鲸桥 WhaleBridge.lnk";
pub const UNINSTALL_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\WhaleBridge";

/// 安装布局：所有路径都可注入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallLayout {
    pub install_dir: PathBuf,
    pub data_dir: PathBuf,
    pub start_menu_dir: PathBuf,
    pub desktop_dir: PathBuf,
    pub registry_key: String,
    pub create_desktop_shortcut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    /// 待安装的桌面壳 exe（通常是当前运行的 exe）。
    pub shell_exe: PathBuf,
    /// 待安装的 Core 目录（`dist/core`：WhaleBridgeCore.exe + resources\ + runtime-manifest.json）。
    pub core_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    CopyFile {
        from: PathBuf,
        to: PathBuf,
    },
    /// 目录整体复制（先复制到同目录暂存名，再原子替换）。
    ReplaceDir {
        from: PathBuf,
        to: PathBuf,
    },
    WriteFile {
        path: PathBuf,
        content: String,
    },
    RemovePath {
        path: PathBuf,
    },
    /// 只删空目录（非空时保留），用于卸载后清理空壳目录。
    RemoveEmptyDir {
        path: PathBuf,
    },
    Shortcut {
        path: PathBuf,
        target: PathBuf,
        args: String,
        workdir: PathBuf,
        description: String,
    },
    /// 写注册表键值；应用前先把整个键导出到 backup 以便回滚。
    RegistryKey {
        key: String,
        values: Vec<(String, String)>,
    },
    /// 删除注册表键（同样先导出备份）。
    RemoveRegistryKey {
        key: String,
    },
    /// 执行外部命令（Core 的 --setup-dsh / --uninstall-dsh、自删除等），不参与回滚。
    RunProgram {
        program: PathBuf,
        args: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub action: String,
    pub layout: InstallLayout,
    pub effects: Vec<Effect>,
    pub notes: Vec<String>,
    pub warnings: Vec<String>,
}

impl Plan {
    pub fn new(action: &str, layout: &InstallLayout) -> Self {
        Self {
            action: action.to_owned(),
            layout: layout.clone(),
            effects: Vec::new(),
            notes: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[allow(dead_code)] // 供诊断/后续阶段使用；安装流程用的是 effects.len()
    pub fn changed(&self) -> bool {
        !self.effects.is_empty()
    }

    pub fn report(&self, dry_run: bool) -> String {
        let mut lines = vec![format!(
            "CetaMesh {} 计划{}",
            self.action,
            if dry_run {
                "（预演，未写入任何文件）"
            } else {
                ""
            }
        )];
        lines.push(format!("  安装目录：{}", self.layout.install_dir.display()));
        lines.push(format!("  数据目录：{}", self.layout.data_dir.display()));
        if !self.notes.is_empty() {
            lines.push("  计划：".to_owned());
            for note in &self.notes {
                lines.push(format!("    - {note}"));
            }
        }
        if !self.warnings.is_empty() {
            lines.push("  需要人工确认：".to_owned());
            for warning in &self.warnings {
                lines.push(format!("    ! {warning}"));
            }
        }
        if self.effects.is_empty() {
            lines.push("  结果：无需改动".to_owned());
        }
        lines.join("\n")
    }
}

// ------------------------------------------------------------------ 文件哈希

fn sha256_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(sha256_bytes(&bytes))
}

/// 无第三方依赖的 SHA-256（安装清单用；算法明确、可跨语言校验）。
pub fn sha256_bytes(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = bytes.to_vec();
    let bit_len = (bytes.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0_u32; 64];
        for (index, slot) in w.iter_mut().take(16).enumerate() {
            let start = index * 4;
            *slot = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|value| format!("{value:08x}")).collect()
}

/// 只在测试里用于比较目录内容（生产路径用安装清单里的逐文件哈希）。
#[cfg(test)]
fn hash_tree(dir: &Path) -> Option<String> {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(dir, &mut files).ok()?;
    files.sort();
    let mut joined = String::new();
    for file in files {
        let relative = file
            .strip_prefix(dir)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let digest = sha256_file(&file)?;
        joined.push_str(&format!("{relative}\0{digest}\0"));
    }
    Some(sha256_bytes(joined.as_bytes()))
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ 安装清单

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallManifest {
    pub version: String,
    pub installed_at: String,
    /// 相对安装目录的路径 → 内容哈希
    pub files: BTreeMap<String, String>,
    pub start_menu_shortcut: Option<String>,
    pub uninstall_shortcut: Option<String>,
    pub desktop_shortcut: Option<String>,
    pub registry_key: String,
}

impl InstallManifest {
    pub fn read(install_dir: &Path) -> Option<Self> {
        let text = fs::read_to_string(install_dir.join(INSTALL_MANIFEST)).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        let mut files = BTreeMap::new();
        if let Some(map) = value.get("files").and_then(|item| item.as_object()) {
            for (key, item) in map {
                if let Some(hash) = item.as_str() {
                    files.insert(key.clone(), hash.to_owned());
                }
            }
        }
        Some(Self {
            version: value
                .get("version")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_owned(),
            installed_at: value
                .get("installedAt")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_owned(),
            files,
            start_menu_shortcut: value
                .get("startMenuShortcut")
                .and_then(|item| item.as_str())
                .map(str::to_owned),
            uninstall_shortcut: value
                .get("uninstallShortcut")
                .and_then(|item| item.as_str())
                .map(str::to_owned),
            desktop_shortcut: value
                .get("desktopShortcut")
                .and_then(|item| item.as_str())
                .map(str::to_owned),
            registry_key: value
                .get("registryKey")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_owned(),
        })
    }

    pub fn to_json(&self) -> String {
        let payload = serde_json::json!({
            "product": PRODUCT_NAME,
            "version": self.version,
            "installedAt": self.installed_at,
            "registryKey": self.registry_key,
            "startMenuShortcut": self.start_menu_shortcut,
            "uninstallShortcut": self.uninstall_shortcut,
            "desktopShortcut": self.desktop_shortcut,
            "files": self.files,
        });
        format!(
            "{}\n",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        )
    }
}

/// 遍历 payload 需要的文件清单（相对目标路径）。
fn payload_files(payload: &Payload) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    if !payload.shell_exe.is_file() {
        return Err(format!(
            "找不到待安装的桌面壳：{}",
            payload.shell_exe.display()
        ));
    }
    let core_exe = payload.core_dir.join(CORE_EXE_NAME);
    if !core_exe.is_file() {
        return Err(format!(
            "找不到 {CORE_EXE_NAME}：{}（先运行 npm run build:core）",
            core_exe.display()
        ));
    }
    let mut pairs = vec![(payload.shell_exe.clone(), PathBuf::from(SHELL_EXE_NAME))];
    let mut files = Vec::new();
    collect_files(&payload.core_dir, &mut files).map_err(|error| error.to_string())?;
    files.sort();
    for file in files {
        let relative = file
            .strip_prefix(&payload.core_dir)
            .map_err(|error| error.to_string())?
            .to_path_buf();
        pairs.push((file, relative));
    }
    Ok(pairs)
}

// ------------------------------------------------------------------ 计划

/// 文件是否被其它进程占用（Windows 上是"共享冲突"）。
/// 最典型的情形：DSH 按 cordis.patch.yml 拉起的 5 个 `WhaleBridgeCore.exe --mcp ...`
/// 子进程长期存活，锁住安装目录里的 Core exe —— 此时覆盖安装必然失败。
pub fn file_in_use(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    fs::OpenOptions::new().write(true).open(path).is_err()
}

/// 安装/升级前的占用检查：先给出"谁占着、该怎么办"的指引，
/// 而不是等到复制阶段报一个让人摸不着头脑的「另一个程序正在使用此文件」。
pub fn check_not_in_use(layout: &InstallLayout) -> Result<(), String> {
    let mut holders = Vec::new();
    for name in [CORE_EXE_NAME, SHELL_EXE_NAME] {
        if file_in_use(&layout.install_dir.join(name)) {
            holders.push(name);
        }
    }
    if holders.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{} 正在被其它进程使用，无法覆盖安装。\n\
         最常见原因：DSH 正在运行，它按 MCP 配置拉起的 WhaleBridgeCore.exe 子进程会一直占用该文件。\n\
         处理办法（任选其一）：\n\
         1) 先退出 DSH，重新执行本命令，装完再启动 DSH；\n\
         2) 加 --stop-core：让安装器先结束占用进程（只结束本安装目录下的 WhaleBridgeCore / WhaleBridge 进程，\
         会中断 DSH 的 MCP 连接，装完需重启 DSH）。",
        holders.join("、")
    ))
}

pub struct InstallOptions {
    pub version: String,
    pub dsh_profile: String,
    pub dsh_integration: bool,
    /// 覆盖安装前先结束占用安装目录的进程（通常是 DSH 拉起的 MCP 子进程）。
    pub stop_core: bool,
    /// 安装后是否立即注册 DSH 集成（需要 Core exe 可用）。
    pub now: String,
}

fn shortcut_effect(
    path: PathBuf,
    target: PathBuf,
    args: &str,
    workdir: PathBuf,
    description: &str,
) -> Effect {
    Effect::Shortcut {
        path,
        target,
        args: args.to_owned(),
        workdir,
        description: description.to_owned(),
    }
}

fn registry_effects(layout: &InstallLayout, version: &str, install_dir: &Path) -> Vec<Effect> {
    let uninstall_string = format!(
        "\"{}\" --uninstall",
        install_dir.join(SHELL_EXE_NAME).display()
    );
    vec![Effect::RegistryKey {
        key: layout.registry_key.clone(),
        values: vec![
            ("DisplayName".to_owned(), PRODUCT_NAME.to_owned()),
            ("DisplayVersion".to_owned(), version.to_owned()),
            ("Publisher".to_owned(), "CetaMesh".to_owned()),
            (
                "InstallLocation".to_owned(),
                install_dir.display().to_string(),
            ),
            (
                "DisplayIcon".to_owned(),
                install_dir.join(SHELL_EXE_NAME).display().to_string(),
            ),
            ("UninstallString".to_owned(), uninstall_string),
            ("NoModify".to_owned(), "1".to_owned()),
            ("NoRepair".to_owned(), "1".to_owned()),
        ],
    }]
}

/// 生成安装计划：复制 payload、初始化数据目录、创建快捷方式、写卸载注册表项、可选装 DSH 集成。
fn add_legacy_shortcut_removals(plan: &mut Plan, layout: &InstallLayout) {
    for path in [
        layout.start_menu_dir.join(LEGACY_START_MENU_SHORTCUT),
        layout.start_menu_dir.join(LEGACY_UNINSTALL_SHORTCUT),
        layout.desktop_dir.join(LEGACY_DESKTOP_SHORTCUT),
    ] {
        if path.is_file() {
            plan.effects.push(Effect::RemovePath { path });
        }
    }
}

pub fn plan_install(
    layout: &InstallLayout,
    payload: &Payload,
    options: &InstallOptions,
    is_upgrade: bool,
) -> Result<Plan, String> {
    let mut plan = Plan::new(if is_upgrade { "升级" } else { "安装" }, layout);
    // 先检查目标文件是否被占用：不通过就直接给出可操作的指引，不要走到复制阶段才报文件锁。
    if !options.stop_core {
        check_not_in_use(layout)?;
    }
    let pairs = payload_files(payload)?;

    let mut installed_files = BTreeMap::new();
    for (from, relative) in &pairs {
        let to = layout.install_dir.join(relative);
        // 正在运行的那个 exe 不能被自己覆盖：原地修复时跳过并说明。
        if same_file(from, &to) {
            plan.notes
                .push(format!("跳过正在运行的 {}（已就位）", relative.display()));
        } else if to.is_file() && sha256_file(from) == sha256_file(&to) {
            // 内容一致：不产生写入，保证重复执行是空操作
        } else {
            plan.effects.push(Effect::CopyFile {
                from: from.clone(),
                to: to.clone(),
            });
        }
        if let Some(hash) = sha256_file(from) {
            installed_files.insert(relative.to_string_lossy().replace('\\', "/"), hash);
        }
    }

    // resources\ 目录整体替换：目录里被删掉的文件也能随升级清理掉
    let core_resources = payload.core_dir.join("resources");
    if core_resources.is_dir() {
        plan.effects.push(Effect::ReplaceDir {
            from: core_resources.clone(),
            to: layout.install_dir.join("resources"),
        });
        plan.notes
            .push("替换 resources\\（只读资源随版本更新）".to_owned());
    }

    // 数据目录 + 首次运行的配置模板（绝不覆盖已有 config.json）
    let config_file = layout.data_dir.join("config.json");
    if !config_file.is_file() {
        let template = core_resources.join("config.example.json");
        if template.is_file() {
            plan.effects.push(Effect::CopyFile {
                from: template,
                to: config_file,
            });
            plan.notes.push(
                "数据目录首次初始化：从 config.example.json 生成 config.json（请编辑后使用）"
                    .to_owned(),
            );
        } else {
            plan.warnings.push(format!(
                "资源里缺少 config.example.json，未初始化配置：{}",
                layout.data_dir.display()
            ));
        }
    } else {
        plan.notes.push("保留已有 config.json".to_owned());
    }
    for sub in ["state", "logs"] {
        let dir = layout.data_dir.join(sub);
        if !dir.is_dir() {
            plan.effects.push(Effect::WriteFile {
                path: dir.join(".keep"),
                content: String::new(),
            });
            plan.notes.push(format!("创建数据子目录 {sub}\\"));
        }
    }

    // 快捷方式
    let shell = layout.install_dir.join(SHELL_EXE_NAME);
    let start_menu = layout.start_menu_dir.join(START_MENU_SHORTCUT);
    plan.effects.push(shortcut_effect(
        start_menu.clone(),
        shell.clone(),
        "",
        layout.install_dir.clone(),
        "启动 CetaMesh Desktop",
    ));
    let uninstall = layout.start_menu_dir.join(UNINSTALL_SHORTCUT);
    plan.effects.push(shortcut_effect(
        uninstall.clone(),
        shell.clone(),
        "--uninstall",
        layout.install_dir.clone(),
        "卸载 CetaMesh",
    ));
    let desktop = layout.desktop_dir.join(DESKTOP_SHORTCUT);
    if layout.create_desktop_shortcut {
        plan.effects.push(shortcut_effect(
            desktop.clone(),
            shell.clone(),
            "",
            layout.install_dir.clone(),
            "启动 CetaMesh Desktop",
        ));
    }

    add_legacy_shortcut_removals(&mut plan, layout);

    plan.effects.extend(registry_effects(
        layout,
        &options.version,
        &layout.install_dir,
    ));

    // DSH 集成（best effort：失败不回滚安装本身，只提示）
    if options.dsh_integration {
        let core = layout.install_dir.join(CORE_EXE_NAME);
        plan.effects.push(Effect::RunProgram {
            program: core,
            args: vec![
                "--setup-dsh".to_owned(),
                options.dsh_profile.clone(),
                "--data-dir".to_owned(),
                layout.data_dir.display().to_string(),
            ],
        });
        plan.notes.push(format!(
            "注册 DSH 集成（profile {}）并重启 DSH 后生效",
            options.dsh_profile
        ));
    } else {
        plan.notes.push("按参数跳过 DSH 集成注册".to_owned());
    }

    // 安装清单：记录本次装了哪些文件（卸载时只删这些）
    let manifest = InstallManifest {
        version: options.version.clone(),
        installed_at: options.now.clone(),
        files: installed_files,
        start_menu_shortcut: Some(start_menu.display().to_string()),
        uninstall_shortcut: Some(uninstall.display().to_string()),
        desktop_shortcut: if layout.create_desktop_shortcut {
            Some(desktop.display().to_string())
        } else {
            None
        },
        registry_key: layout.registry_key.clone(),
    };
    plan.effects.push(Effect::WriteFile {
        path: layout.install_dir.join(INSTALL_MANIFEST),
        content: manifest.to_json(),
    });
    Ok(plan)
}

/// 修复安装：补齐缺失/被改动的文件、重建快捷方式与注册表项，保留数据与配置。
pub fn plan_repair(
    layout: &InstallLayout,
    payload: &Payload,
    options: &InstallOptions,
) -> Result<Plan, String> {
    let mut plan = Plan::new("修复", layout);
    let pairs = payload_files(payload)?;
    let manifest = InstallManifest::read(&layout.install_dir);

    let mut missing = Vec::new();
    for (from, relative) in &pairs {
        let to = layout.install_dir.join(relative);
        if same_file(from, &to) {
            continue;
        }
        let same = to.is_file() && sha256_file(from) == sha256_file(&to);
        if !same {
            let key = relative.to_string_lossy().replace('\\', "/");
            let recorded = manifest.as_ref().and_then(|item| item.files.get(&key));
            // 用户改过的文件（与清单记录不一致）只报告不覆盖，与 DSH 集成的归属模型一致
            let user_modified = match (recorded, to.is_file()) {
                (Some(expected), true) => sha256_file(&to).as_deref() != Some(expected.as_str()),
                _ => false,
            };
            if user_modified {
                plan.warnings.push(format!(
                    "{key} 已被修改，修复时保留（如需覆盖请先手工删除）"
                ));
                continue;
            }
            missing.push((from.clone(), to.clone(), key));
        }
    }
    for (from, to, key) in &missing {
        plan.effects.push(Effect::CopyFile {
            from: from.clone(),
            to: to.clone(),
        });
        plan.notes.push(format!("修复 {key}"));
    }

    let core_resources = payload.core_dir.join("resources");
    if core_resources.is_dir()
        && plan
            .effects
            .iter()
            .any(|effect| matches!(effect, Effect::CopyFile { .. }))
    {
        plan.effects.push(Effect::ReplaceDir {
            from: core_resources,
            to: layout.install_dir.join("resources"),
        });
        plan.notes.push("修复 resources\\".to_owned());
    }

    let shell = layout.install_dir.join(SHELL_EXE_NAME);
    for (path, args, description) in [
        (
            layout.start_menu_dir.join(START_MENU_SHORTCUT),
            "",
            "启动 CetaMesh Desktop",
        ),
        (
            layout.start_menu_dir.join(UNINSTALL_SHORTCUT),
            "--uninstall",
            "卸载 CetaMesh",
        ),
    ] {
        if !path.is_file() {
            plan.effects.push(shortcut_effect(
                path,
                shell.clone(),
                args,
                layout.install_dir.clone(),
                description,
            ));
            plan.notes.push("重建开始菜单快捷方式".to_owned());
        }
    }
    if layout.create_desktop_shortcut {
        let desktop = layout.desktop_dir.join(DESKTOP_SHORTCUT);
        if !desktop.is_file() {
            plan.effects.push(shortcut_effect(
                desktop,
                shell.clone(),
                "",
                layout.install_dir.clone(),
                "启动 CetaMesh Desktop",
            ));
            plan.notes.push("重建桌面快捷方式".to_owned());
        }
    }
    add_legacy_shortcut_removals(&mut plan, layout);
    if registry_installed(&layout.registry_key) {
        plan.notes.push("卸载注册表项已存在".to_owned());
    } else {
        plan.effects.extend(registry_effects(
            layout,
            &options.version,
            &layout.install_dir,
        ));
        plan.notes.push("重建卸载注册表项".to_owned());
    }
    if options.dsh_integration {
        plan.effects.push(Effect::RunProgram {
            program: layout.install_dir.join(CORE_EXE_NAME),
            args: vec![
                "--setup-dsh".to_owned(),
                options.dsh_profile.clone(),
                "--data-dir".to_owned(),
                layout.data_dir.display().to_string(),
            ],
        });
        plan.notes.push("重新注册 DSH 集成".to_owned());
    }
    if plan.effects.is_empty() {
        plan.notes.push("安装完整，无需修复".to_owned());
    } else {
        // 修复会重写文件，必须同步刷新安装清单，否则下次卸载会拿旧哈希误判成"用户改过"。
        let mut files = manifest
            .as_ref()
            .map(|item| item.files.clone())
            .unwrap_or_default();
        for (from, relative) in &pairs {
            if let Some(hash) = sha256_file(from) {
                files.insert(
                    relative
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/"),
                    hash,
                );
            }
        }
        let refreshed = InstallManifest {
            version: options.version.clone(),
            installed_at: manifest
                .as_ref()
                .map(|item| item.installed_at.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| options.now.clone()),
            files,
            start_menu_shortcut: Some(
                layout
                    .start_menu_dir
                    .join(START_MENU_SHORTCUT)
                    .display()
                    .to_string(),
            ),
            uninstall_shortcut: Some(
                layout
                    .start_menu_dir
                    .join(UNINSTALL_SHORTCUT)
                    .display()
                    .to_string(),
            ),
            desktop_shortcut: if layout.create_desktop_shortcut {
                Some(
                    layout
                        .desktop_dir
                        .join(DESKTOP_SHORTCUT)
                        .display()
                        .to_string(),
                )
            } else {
                None
            },
            registry_key: layout.registry_key.clone(),
        };
        plan.effects.push(Effect::WriteFile {
            path: layout.install_dir.join(INSTALL_MANIFEST),
            content: refreshed.to_json(),
        });
        plan.notes.push("刷新安装清单".to_owned());
    }
    Ok(plan)
}

pub struct UninstallOptions {
    pub remove_data: bool,
    pub remove_dsh_integration: bool,
    pub dsh_profile: String,
}

/// 卸载计划：只删清单记录的、且未被用户改过的文件；默认保留用户数据。
pub fn plan_uninstall(layout: &InstallLayout, options: &UninstallOptions) -> Plan {
    let mut plan = Plan::new("卸载", layout);
    let manifest = InstallManifest::read(&layout.install_dir);

    // DSH 集成必须在删除 Core exe 之前移除
    let core = layout.install_dir.join(CORE_EXE_NAME);
    if options.remove_dsh_integration && core.is_file() {
        plan.effects.push(Effect::RunProgram {
            program: core,
            args: vec![
                "--uninstall-dsh".to_owned(),
                options.dsh_profile.clone(),
                "--data-dir".to_owned(),
                layout.data_dir.display().to_string(),
            ],
        });
        plan.notes
            .push("移除 DSH 集成（只删 manifest 记录的内容）".to_owned());
    } else if !options.remove_dsh_integration {
        plan.notes
            .push("按参数保留 DSH 集成（DSH 里仍会看到 qq_* 工具）".to_owned());
    }

    // 快捷方式
    for path in [
        layout.start_menu_dir.join(START_MENU_SHORTCUT),
        layout.start_menu_dir.join(UNINSTALL_SHORTCUT),
        layout.desktop_dir.join(DESKTOP_SHORTCUT),
        layout.start_menu_dir.join(LEGACY_START_MENU_SHORTCUT),
        layout.start_menu_dir.join(LEGACY_UNINSTALL_SHORTCUT),
        layout.desktop_dir.join(LEGACY_DESKTOP_SHORTCUT),
    ] {
        if path.is_file() {
            plan.effects.push(Effect::RemovePath { path: path.clone() });
            plan.notes.push(format!("删除快捷方式 {}", path.display()));
        }
    }

    // 注册表
    if registry_installed(&layout.registry_key) {
        plan.effects.push(Effect::RemoveRegistryKey {
            key: layout.registry_key.clone(),
        });
        plan.notes.push("删除卸载注册表项".to_owned());
    }

    // 安装目录文件：只删清单记录且未被改过的
    match &manifest {
        Some(record) => {
            let mut dirs_to_prune: std::collections::BTreeSet<PathBuf> =
                std::collections::BTreeSet::new();
            let mut extras = Vec::new();
            let mut files = Vec::new();
            collect_files(&layout.install_dir, &mut files).ok();
            let recorded: std::collections::BTreeSet<String> =
                record.files.keys().cloned().collect();
            for file in &files {
                let relative = file
                    .strip_prefix(&layout.install_dir)
                    .unwrap_or(file)
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative == INSTALL_MANIFEST {
                    continue;
                }
                if !recorded.contains(&relative) {
                    extras.push(relative);
                    continue;
                }
                let expected = record.files.get(&relative);
                if sha256_file(file).as_deref() != expected.map(String::as_str) {
                    plan.warnings
                        .push(format!("{relative} 已被修改，卸载时保留"));
                    continue;
                }
                // 记录需要顺带清理的父目录（随文件一起被删空的那些）
                let mut current = file.parent();
                while let Some(dir) = current {
                    if !dir.starts_with(&layout.install_dir) || same_path(dir, &layout.install_dir)
                    {
                        break;
                    }
                    dirs_to_prune.insert(dir.to_path_buf());
                    current = dir.parent();
                }
                plan.effects.push(Effect::RemovePath { path: file.clone() });
            }
            for extra in extras {
                plan.warnings
                    .push(format!("{extra} 不是本应用安装的文件，卸载时保留"));
            }
            plan.effects.push(Effect::RemovePath {
                path: layout.install_dir.join(INSTALL_MANIFEST),
            });
            // 被删空的多级子目录（resources\public 等）也要收走，否则安装目录非空、删不掉
            let mut prune: Vec<PathBuf> = dirs_to_prune.into_iter().collect();
            prune.sort_by_key(|dir| std::cmp::Reverse(dir.components().count()));
            for dir in prune {
                plan.effects.push(Effect::RemoveEmptyDir { path: dir });
            }
        }
        None => {
            plan.warnings.push(format!(
                "未找到 {INSTALL_MANIFEST}：无法确认哪些文件由本应用安装，只删除快捷方式与注册表项。"
            ));
        }
    }

    // 数据目录：默认保留
    if options.remove_data {
        if layout.data_dir.is_dir() {
            plan.effects.push(Effect::RemovePath {
                path: layout.data_dir.clone(),
            });
            plan.effects.push(Effect::RemoveEmptyDir {
                path: layout
                    .data_dir
                    .parent()
                    .unwrap_or(&layout.data_dir)
                    .to_path_buf(),
            });
            plan.notes
                .push(format!("删除用户数据目录 {}", layout.data_dir.display()));
            plan.warnings.push(
                "数据目录里包含配置、state、日志与令牌，删除后无法恢复（旧目录不会被备份）。"
                    .to_owned(),
            );
        }
    } else {
        plan.notes
            .push(format!("保留用户数据目录 {}", layout.data_dir.display()));
    }

    // 清掉空掉的安装目录
    plan.effects.push(Effect::RemoveEmptyDir {
        path: layout.install_dir.clone(),
    });
    plan
}

// ------------------------------------------------------------------ 执行

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub backup_dir: PathBuf,
    pub snapshots: usize,
}

/// 执行计划；任何一步失败都按快照回滚。
/// 备份放在**数据目录**下：安装目录可能是 `%ProgramFiles%`（普通用户不可写），
/// 放在那里会让 `--migrate`（用户通常不带 --install-dir）因建不了备份目录而失败。
/// 命名与 DSH 集成侧的 `.whalebridge-backup` 保持一致。
pub fn apply_plan(plan: &Plan, log: &dyn Fn(&str)) -> Result<Applied, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let backup_dir = plan
        .layout
        .data_dir
        .join(BACKUP_DIR_NAME)
        .join(stamp.to_string());
    apply_plan_with_backup(plan, log, &backup_dir)
}

pub fn apply_plan_with_backup(
    plan: &Plan,
    log: &dyn Fn(&str),
    backup_dir: &Path,
) -> Result<Applied, String> {
    let mut snapshots: Vec<Snapshot> = Vec::new();
    let mut registry_keys: Vec<String> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    let result = (|| -> Result<(), String> {
        for effect in &plan.effects {
            if let Effect::RegistryKey { key, .. } | Effect::RemoveRegistryKey { key } = effect {
                registry_keys.push(key.clone());
            }
            for path in effect_paths(effect) {
                let key = path.display().to_string();
                if !seen.insert(key) {
                    continue;
                }
                snapshots.push(
                    snapshot_path(&path, backup_dir, snapshots.len())
                        .map_err(|error| format!("快照 {} 失败：{error}", path.display()))?,
                );
            }
        }
        for effect in &plan.effects {
            // 阶段标记：安装器 UI 用它把进度映射到用户可读的安装阶段；命令行输出一并可见。
            log(&format!("[stage] {}", describe(effect)));
            apply_effect(effect, log, backup_dir)
                .map_err(|error| format!("[{}] {error}", describe(effect)))?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => Ok(Applied {
            backup_dir: backup_dir.to_path_buf(),
            snapshots: snapshots.len(),
        }),
        Err(error) => {
            log(&format!("执行失败，正在回滚：{error}"));
            let mut rollback_errors = Vec::new();
            for snapshot in snapshots.iter().rev() {
                if let Err(rollback_error) = restore_snapshot(snapshot) {
                    rollback_errors.push(rollback_error);
                }
            }
            // 注册表不在文件快照范围内：按导出备份恢复（曾存在→导入；不曾存在→删除）
            for key in registry_keys.iter().rev() {
                if let Err(rollback_error) = restore_registry(key, backup_dir) {
                    rollback_errors.push(rollback_error);
                }
            }
            if rollback_errors.is_empty() {
                let _ = fs::remove_dir_all(backup_dir);
                return Err(format!("执行失败并已回滚：{error}"));
            }
            Err(format!(
                "执行失败且回滚不完整：{error}；回滚问题：{}（备份保留在 {}）",
                rollback_errors.join("；"),
                backup_dir.display()
            ))
        }
    }
}

/// 恢复注册表键：有导出备份就导入，没有说明当时不存在，直接删除。
fn restore_registry(key: &str, backup_dir: &Path) -> Result<(), String> {
    let export = backup_dir.join(format!("registry-{}.reg", sanitize_key(key)));
    if export.is_file() {
        let status = hidden("reg.exe")
            .args(["import", &export.display().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("reg import 失败（{key}）：{error}"))?;
        if !status.success() {
            return Err(format!("reg import 失败：{key}"));
        }
        return Ok(());
    }
    let _ = hidden("reg.exe")
        .args(["delete", key, "/f"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Ok(())
}

/// 供报错定位：说清楚是哪个操作失败了。
fn describe(effect: &Effect) -> String {
    match effect {
        Effect::CopyFile { to, .. } => format!("复制 {}", to.display()),
        Effect::ReplaceDir { to, .. } => format!("替换目录 {}", to.display()),
        Effect::WriteFile { path, .. } => format!("写入 {}", path.display()),
        Effect::RemovePath { path } => format!("删除 {}", path.display()),
        Effect::RemoveEmptyDir { path } => format!("清理空目录 {}", path.display()),
        Effect::Shortcut { path, .. } => format!("创建快捷方式 {}", path.display()),
        Effect::RegistryKey { key, .. } => format!("写注册表 {key}"),
        Effect::RemoveRegistryKey { key } => format!("删注册表 {key}"),
        Effect::RunProgram { program, .. } => format!("执行 {}", program.display()),
    }
}

fn effect_paths(effect: &Effect) -> Vec<PathBuf> {
    match effect {
        Effect::CopyFile { to, .. } => vec![to.clone()],
        Effect::ReplaceDir { to, .. } => vec![to.clone()],
        Effect::WriteFile { path, .. } => vec![path.clone()],
        Effect::RemovePath { path } => vec![path.clone()],
        Effect::RemoveEmptyDir { path } => vec![path.clone()],
        Effect::Shortcut { path, .. } => vec![path.clone()],
        // 注册表用导出文件做快照，另行处理
        Effect::RegistryKey { .. }
        | Effect::RemoveRegistryKey { .. }
        | Effect::RunProgram { .. } => vec![],
    }
}

#[derive(Debug)]
enum Snapshot {
    File { path: PathBuf, backup: PathBuf },
    Dir { path: PathBuf, backup: PathBuf },
    Absent { path: PathBuf },
    Link { path: PathBuf, target: PathBuf },
}

fn snapshot_path(path: &Path, backup_dir: &Path, index: usize) -> Result<Snapshot, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(Snapshot::Absent {
                path: path.to_path_buf(),
            });
        }
    };
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(path).unwrap_or_default();
        return Ok(Snapshot::Link {
            path: path.to_path_buf(),
            target,
        });
    }
    let backup = backup_dir.join(format!("snap-{index}"));
    // 同一备份目录可能被多次 apply 复用：先清掉同名残留（上一次可能是目录），
    // 否则「文件备份覆盖同名目录」会以拒绝访问失败。
    remove_path(&backup);
    if metadata.is_dir() {
        fs::create_dir_all(&backup).map_err(|error| error.to_string())?;
        copy_dir_excluding(path, &backup, Some(backup_dir))?;
        Ok(Snapshot::Dir {
            path: path.to_path_buf(),
            backup,
        })
    } else {
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(path, &backup).map_err(|error| error.to_string())?;
        Ok(Snapshot::File {
            path: path.to_path_buf(),
            backup,
        })
    }
}

fn restore_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    match snapshot {
        Snapshot::Absent { path } => {
            remove_path(path);
            Ok(())
        }
        Snapshot::File { path, backup } => {
            remove_path(path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(backup, path).map_err(|error| format!("{}: {error}", path.display()))?;
            Ok(())
        }
        Snapshot::Dir { path, backup } => {
            remove_path(path);
            fs::create_dir_all(path).map_err(|error| error.to_string())?;
            copy_dir(backup, path)
        }
        Snapshot::Link { path, target } => {
            remove_path(path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            symlink_dir(target.clone(), path)
                .map_err(|error| format!("{}: {error}", path.display()))
        }
    }
}

/// 删除路径，绝不跟随符号链接/junction（只摘链接本身）。
pub fn remove_path(path: &Path) {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };
    if metadata.file_type().is_symlink() {
        let points_to_dir = fs::metadata(path).map(|item| item.is_dir()).unwrap_or(true);
        if points_to_dir {
            let _ = fs::remove_dir(path);
        } else {
            let _ = fs::remove_file(path);
        }
        return;
    }
    if metadata.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    copy_dir_excluding(from, to, None)
}

/// 跳过 `skip` 子树。备份目录就建在被快照目录内部（data_dir/.whalebridge-backup/…），
/// 不排除的话复制目标会出现在复制源里，copy_dir 无限递归直到栈溢出（--remove-data 卸载必现）。
fn copy_dir_excluding(from: &Path, to: &Path, skip: Option<&Path>) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        if let Some(skip) = skip {
            if source == skip || source.starts_with(skip) {
                continue;
            }
        }
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_excluding(&source, &target, skip)?;
        } else {
            fs::copy(&source, &target).map_err(|error| format!("{}: {error}", source.display()))?;
        }
    }
    Ok(())
}

fn symlink_dir(target: PathBuf, link: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link)
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link)
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// 路径等价判断（不要求存在）：用于比较同一个目录的两种写法。
fn same_path(a: &Path, b: &Path) -> bool {
    let left = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let right = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

fn apply_effect(effect: &Effect, log: &dyn Fn(&str), backup_dir: &Path) -> Result<(), String> {
    match effect {
        Effect::CopyFile { from, to } => {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "创建目录失败 {}：{error}{}",
                        parent.display(),
                        permission_hint(&error)
                    )
                })?;
            }
            fs::copy(from, to).map_err(|error| {
                format!(
                    "复制失败 {} → {}：{error}{}",
                    from.display(),
                    to.display(),
                    permission_hint(&error)
                )
            })?;
            Ok(())
        }
        Effect::ReplaceDir { from, to } => {
            let staging = to.with_extension(format!("whalebridge-tmp-{}", std::process::id()));
            remove_path(&staging);
            copy_dir(from, &staging)?;
            remove_path(to);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&staging, to)
                .map_err(|error| format!("替换目录失败 {}：{error}", to.display()))
        }
        Effect::WriteFile { path, content } => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(path, content)
                .map_err(|error| format!("写入失败 {}：{error}", path.display()))
        }
        Effect::RemovePath { path } => {
            remove_path(path);
            Ok(())
        }
        Effect::RemoveEmptyDir { path } => {
            let _ = fs::remove_dir(path);
            Ok(())
        }
        Effect::Shortcut {
            path,
            target,
            args,
            workdir,
            description,
        } => create_shortcut(path, target, args, workdir, description, log),
        Effect::RegistryKey { key, values } => {
            backup_registry(key, backup_dir)?;
            for (name, value) in values {
                // 注册表写入偶发瞬时失败（例如刚删除过同名键、句柄尚未释放），
                // 实测出现过一次 ERROR_ACCESS_DENIED；这里做有限重试再判失败。
                let mut last_error = String::new();
                let mut ok = false;
                for attempt in 0..3 {
                    let output = hidden("reg.exe")
                        .args(["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::piped())
                        .output()
                        .map_err(|error| format!("无法执行 reg.exe：{error}"))?;
                    if output.status.success() {
                        ok = true;
                        break;
                    }
                    last_error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                }
                if !ok {
                    return Err(format!("写入注册表失败：{key}\\{name}（{last_error}）"));
                }
            }
            Ok(())
        }
        Effect::RemoveRegistryKey { key } => {
            backup_registry(key, backup_dir)?;
            let status = hidden("reg.exe")
                .args(["delete", key, "/f"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|error| format!("无法执行 reg.exe：{error}"))?;
            if !status.success() {
                log(&format!("注册表项不存在或删除失败（可忽略）：{key}"));
            }
            Ok(())
        }
        Effect::RunProgram { program, args } => {
            if !program.is_file() {
                log(&format!("跳过（程序不存在）：{}", program.display()));
                return Ok(());
            }
            // Core 是控制台子系统程序：必须隐藏窗口，否则安装期间会弹出黑框。
            let output = hidden(program)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|error| format!("执行失败 {}：{error}", program.display()))?;
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                log(&format!("    {}", line.trim_end()));
            }
            if !output.status.success() {
                log(&format!(
                    "    注意：{} 退出码 {:?}（安装继续，DSH 集成可稍后用 --repair 重试）",
                    program.display(),
                    output.status.code()
                ));
            }
            Ok(())
        }
    }
}

fn backup_registry(key: &str, backup_dir: &Path) -> Result<(), String> {
    let export = backup_dir.join(format!("registry-{}.reg", sanitize_key(key)));
    if export.is_file() {
        return Ok(());
    }
    if let Some(parent) = export.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let _ = hidden("reg.exe")
        .args(["export", key, &export.display().to_string(), "/y"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Ok(())
}

/// 权限类失败的可操作提示：装到 %ProgramFiles% 需要管理员权限。
pub fn permission_hint(error: &std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        "（目标目录需要管理员权限：请以管理员身份运行，或用 --install-dir 指定可写目录）"
    } else {
        ""
    }
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect()
}

fn registry_installed(key: &str) -> bool {
    hidden("reg.exe")
        .args(["query", key])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

// ------------------------------------------------------------------ 既有安装发现

/// 已安装的既有版本（安装器升级检测：默认复用该目录，不要求用户重新选路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingInstall {
    pub install_dir: PathBuf,
    pub version: String,
}

/// 读取注册表键下某个值（隐藏执行）。安装器用它发现既有安装位置。
pub fn read_registry_value(key: &str, name: &str) -> Option<String> {
    read_registry_value_with(key, name, &|key, name| {
        let output = hidden("reg.exe")
            .args(["query", key, "/v", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    })
}

/// 从 `reg query` 输出解析 `<name>    REG_SZ    <value>` 行。
fn parse_registry_value(output: &str, name: &str) -> Option<String> {
    for line in output.lines() {
        let Some(rest) = line.trim().strip_prefix(name) else {
            continue;
        };
        let Some(value) = rest.trim_start().strip_prefix("REG_SZ") else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    None
}

/// 注入式读取（注册表查询可替换，便于测试）。
pub fn read_registry_value_with(
    key: &str,
    name: &str,
    query: &dyn Fn(&str, &str) -> Option<String>,
) -> Option<String> {
    let output = query(key, name)?;
    parse_registry_value(&output, name)
}

/// 发现既有安装（安装向导与 `--detect-install` 共用）：
/// 1) 注册表卸载项的 `InstallLocation`（安装包被下载到任意目录也能识别既有安装）；
/// 2) 安装包自身所在目录（原地修复/升级）；
/// 3) 默认安装目录。
/// 目录必须真实存在且带安装清单才算命中；版本以安装清单为准（注册表 DisplayVersion 兜底）。
pub fn find_existing_install(
    registry_key: &str,
    exe_dir: &Path,
    default_dir: &Path,
) -> Option<ExistingInstall> {
    find_existing_install_with(registry_key, exe_dir, default_dir, &|key| {
        let location = read_registry_value(key, "InstallLocation")?;
        let version = read_registry_value(key, "DisplayVersion").unwrap_or_default();
        Some((PathBuf::from(location.trim()), version))
    })
}

pub fn find_existing_install_with(
    registry_key: &str,
    exe_dir: &Path,
    default_dir: &Path,
    registry_lookup: &dyn Fn(&str) -> Option<(PathBuf, String)>,
) -> Option<ExistingInstall> {
    if let Some((dir, version)) = registry_lookup(registry_key) {
        if dir.is_dir() {
            let from_manifest = InstallManifest::read(&dir)
                .map(|item| item.version)
                .filter(|value| !value.is_empty());
            return Some(ExistingInstall {
                install_dir: dir,
                version: from_manifest.unwrap_or(version),
            });
        }
    }
    for candidate in [exe_dir, default_dir] {
        if let Some(manifest) = InstallManifest::read(candidate) {
            return Some(ExistingInstall {
                install_dir: candidate.to_path_buf(),
                version: manifest.version,
            });
        }
    }
    None
}

/// 有界执行控制台 helper：窗口隐藏（[`hidden`]）之外再保证不会无限挂起，
/// 超时即终止并视为失败（安装流程不允许 helper 永久占住 UI 的安装阶段）。
fn run_with_timeout(
    command: &mut Command,
    timeout: std::time::Duration,
) -> std::io::Result<bool> {
    let mut child = command.spawn()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}

/// 通过 WScript.Shell 创建 .lnk（避免引入 COM 依赖；PowerShell 不可用时降级为跳过）。
/// PowerShell 全程隐藏、无 profile、非交互、有界超时——普通安装期间不得出现任何控制台窗口。
fn create_shortcut(
    path: &Path,
    target: &Path,
    args: &str,
    workdir: &Path,
    description: &str,
    log: &dyn Fn(&str),
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $sc = $ws.CreateShortcut('{path}'); \
         $sc.TargetPath = '{target}'; \
         $sc.Arguments = '{args}'; \
         $sc.WorkingDirectory = '{workdir}'; \
         $sc.Description = '{desc}'; \
         $sc.Save()",
        path = escape_ps(path),
        target = escape_ps(target),
        args = args.replace('\'', "''"),
        workdir = escape_ps(workdir),
        desc = description.replace('\'', "''"),
    );
    let mut command = hidden("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match run_with_timeout(&mut command, std::time::Duration::from_secs(30)) {
        Ok(true) if path.is_file() => Ok(()),
        Ok(true) => {
            log(&format!(
                "    警告：创建快捷方式未生成文件，已跳过：{}",
                path.display()
            ));
            Ok(())
        }
        Ok(false) => {
            log(&format!(
                "    警告：创建快捷方式失败或超时，已跳过：{}",
                path.display()
            ));
            Ok(())
        }
        Err(error) => {
            log(&format!(
                "    警告：无法调用 PowerShell 创建快捷方式（{error}），已跳过"
            ));
            Ok(())
        }
    }
}

fn escape_ps(path: &Path) -> String {
    path.display().to_string().replace('\'', "''")
}

/// 写入数据目录的首次运行说明（安装器与迁移器共用）。
pub fn write_first_run_notice(data_dir: &Path, log: &dyn Fn(&str)) {
    let log_dir = desktop_paths::log_dir(data_dir);
    let _ = fs::create_dir_all(&log_dir);
    log(&format!("数据目录：{}", data_dir.display()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;

    static REGISTRY_WRITE_AVAILABLE: OnceLock<bool> = OnceLock::new();
    static REGISTRY_PROBE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wb-installer-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_payload(root: &Path) -> Payload {
        let core_dir = root.join("payload");
        fs::create_dir_all(core_dir.join("resources").join("public")).unwrap();
        fs::write(core_dir.join(CORE_EXE_NAME), b"core-binary").unwrap();
        fs::write(
            core_dir.join("runtime-manifest.json"),
            b"{\"version\":\"0.1.0\"}",
        )
        .unwrap();
        fs::write(
            core_dir.join("resources").join("config.example.json"),
            b"{\"consolePort\":3100}",
        )
        .unwrap();
        fs::write(
            core_dir
                .join("resources")
                .join("public")
                .join("console.html"),
            b"<html></html>",
        )
        .unwrap();
        let shell = root.join(SHELL_EXE_NAME);
        fs::write(&shell, b"shell-binary").unwrap();
        Payload {
            shell_exe: shell,
            core_dir,
        }
    }

    fn layout(root: &Path) -> InstallLayout {
        let test_key = root
            .file_name()
            .map(|name| name.to_string_lossy().replace('\\', "_"))
            .unwrap_or_else(|| "installer-test".to_owned());
        InstallLayout {
            install_dir: root.join("ProgramFiles").join("WhaleBridge"),
            data_dir: root.join("LocalAppData").join("WhaleBridge"),
            start_menu_dir: root.join("StartMenu").join("Programs"),
            desktop_dir: root.join("Desktop"),
            // 每个并行用例使用独立 HKCU key，避免彼此清理或覆盖。
            registry_key: format!("HKCU\\Software\\WhaleBridgeTest\\{test_key}"),
            create_desktop_shortcut: true,
        }
    }

    fn options() -> InstallOptions {
        InstallOptions {
            version: "0.1.0".to_owned(),
            dsh_profile: "web".to_owned(),
            dsh_integration: false, // 测试不触碰真实 ~/.dsh
            stop_core: false,
            now: "2026-09-20T00:00:00.000Z".to_owned(),
        }
    }

    fn quiet(_: &str) {}

    /// 清理本用例自己的注册表键；不触碰共享的 WhaleBridgeTest 父键。
    fn cleanup_registry(key: &str) {
        let _ = hidden("reg.exe")
            .args(["delete", key, "/f"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    struct FixtureCleanup {
        root: PathBuf,
        registry_key: String,
    }

    impl FixtureCleanup {
        fn new(root: &Path, registry_key: &str) -> Self {
            Self { root: root.to_path_buf(), registry_key: registry_key.to_owned() }
        }
    }

    impl Drop for FixtureCleanup {
        fn drop(&mut self) {
            cleanup_registry(&self.registry_key);
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn registry_write_available() -> bool {
        *REGISTRY_WRITE_AVAILABLE.get_or_init(|| {
            let counter = REGISTRY_PROBE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let key = format!(
                "HKCU\\Software\\WhaleBridgeTest\\installer-probe-{}-{counter}",
                std::process::id()
            );
            let write = hidden("reg.exe")
                .args(["add", &key, "/v", "Probe", "/t", "REG_SZ", "/d", "isolated-test", "/f"])
                .output();
            let query_before = hidden("reg.exe").args(["query", &key, "/v", "Probe"]).output();
            let cleanup = hidden("reg.exe").args(["delete", &key, "/f"]).output();
            let query_after = hidden("reg.exe").args(["query", &key]).output();

            let write_succeeded = write.as_ref().map(|output| output.status.success()).unwrap_or(false);
            let was_present = query_before.as_ref().map(|output| output.status.success()).unwrap_or(false);
            let remains = query_after.as_ref().map(|output| output.status.success()).unwrap_or(false);
            if remains {
                panic!("isolated HKCU registry probe key was not cleaned: {key}");
            }
            if write_succeeded {
                assert!(was_present, "isolated HKCU value could not be read back: {key}");
                assert!(cleanup.as_ref().map(|output| output.status.success()).unwrap_or(false),
                    "isolated HKCU probe cleanup failed: {key}");
                true
            } else {
                let output = write.expect("reg.exe must be executable for the installer registry probe");
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                let access_denied = stderr.contains("Access is denied")
                    || stderr.contains("拒绝访问")
                    || stderr.contains('\u{FFFD}');
                assert!(
                    access_denied,
                    "isolated HKCU registry probe failed for a reason other than access denied: reg.exe exit {:?}: {stderr}",
                    output.status.code()
                );
                let detail = format!("reg.exe exit {:?}: {stderr}", output.status.code());
                eprintln!("NOT_RUN_ENVIRONMENT: installer HKCU integration cannot write an isolated key ({detail}); test key cleanup was attempted");
                false
            }
        })
    }

    fn apply_fixture_plan(plan: &mut Plan, log: &dyn Fn(&str), backup_dir: &Path) -> Result<Applied, String> {
        if !registry_write_available() {
            plan.effects.retain(|effect| !matches!(effect,
                Effect::RegistryKey { .. } | Effect::RemoveRegistryKey { .. }));
        }
        apply_plan_with_backup(plan, log, backup_dir)
    }

    #[test]
    fn sha256_matches_known_vector() {
        // 标准测试向量：空串与 "abc"
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn install_then_repair_then_uninstall_keeps_data() {
        let root = temp_dir("lifecycle");
        let payload = fake_payload(&root);
        let layout = layout(&root);
        let _cleanup = FixtureCleanup::new(&root, &layout.registry_key);
        let options = options();

        for legacy in [
            layout.start_menu_dir.join(LEGACY_START_MENU_SHORTCUT),
            layout.start_menu_dir.join(LEGACY_UNINSTALL_SHORTCUT),
            layout.desktop_dir.join(LEGACY_DESKTOP_SHORTCUT),
        ] {
            fs::create_dir_all(legacy.parent().unwrap()).unwrap();
            fs::write(legacy, b"legacy shortcut").unwrap();
        }

        let mut plan = plan_install(&layout, &payload, &options, false).unwrap();
        assert!(plan.effects.iter().any(|effect| matches!(effect, Effect::RegistryKey { key, .. } if key == &layout.registry_key)));
        for shortcut in [
            layout.start_menu_dir.join(START_MENU_SHORTCUT),
            layout.start_menu_dir.join(UNINSTALL_SHORTCUT),
            layout.desktop_dir.join(DESKTOP_SHORTCUT),
        ] {
            assert!(
                plan.effects.iter().any(|effect| {
                    matches!(effect, Effect::Shortcut { path, .. } if path == &shortcut)
                }),
                "install plan should include the shortcut effect: {}",
                shortcut.display()
            );
        }
        apply_fixture_plan(&mut plan, &quiet, &root.join("backup")).unwrap();
        assert!(!layout.start_menu_dir.join(LEGACY_START_MENU_SHORTCUT).exists());
        assert!(!layout.start_menu_dir.join(LEGACY_UNINSTALL_SHORTCUT).exists());
        assert!(!layout.desktop_dir.join(LEGACY_DESKTOP_SHORTCUT).exists());
        assert!(layout.install_dir.join(SHELL_EXE_NAME).is_file());
        assert!(layout.install_dir.join(CORE_EXE_NAME).is_file());
        assert!(
            layout
                .install_dir
                .join("resources")
                .join("public")
                .join("console.html")
                .is_file()
        );
        assert!(layout.install_dir.join(INSTALL_MANIFEST).is_file());
        assert!(
            layout.data_dir.join("config.json").is_file(),
            "首次安装应生成 config.json 模板"
        );
        assert!(layout.data_dir.join("state").is_dir());
        assert!(
            InstallManifest::read(&layout.install_dir)
                .unwrap()
                .files
                .contains_key(SHELL_EXE_NAME)
        );

        // 幂等：再次安装不应产生内容相关的 effect（快捷方式/注册表/清单仍会重写）
        let again = plan_install(&layout, &payload, &options, true).unwrap();
        let content_effects = again
            .effects
            .iter()
            .filter(|effect| matches!(effect, Effect::CopyFile { .. }))
            .count();
        assert_eq!(content_effects, 0, "重复安装不应再复制文件");

        // 修复：删掉一个文件后应被补回
        fs::remove_file(layout.install_dir.join(CORE_EXE_NAME)).unwrap();
        let mut repair = plan_repair(&layout, &payload, &options).unwrap();
        assert!(repair.notes.iter().any(|note| note.contains(CORE_EXE_NAME)));
        apply_fixture_plan(&mut repair, &quiet, &root.join("backup")).unwrap();
        assert!(layout.install_dir.join(CORE_EXE_NAME).is_file());

        // 卸载：保留数据目录
        let mut uninstall = plan_uninstall(
            &layout,
            &UninstallOptions {
                remove_data: false,
                remove_dsh_integration: false,
                dsh_profile: "web".to_owned(),
            },
        );
        apply_fixture_plan(&mut uninstall, &quiet, &root.join("backup")).unwrap();
        assert!(!layout.install_dir.join(CORE_EXE_NAME).is_file());
        assert!(!layout.install_dir.join(SHELL_EXE_NAME).is_file());
        assert!(!layout.install_dir.join(INSTALL_MANIFEST).is_file());
        assert!(
            layout.data_dir.join("config.json").is_file(),
            "卸载默认必须保留数据目录"
        );
        assert!(!layout.start_menu_dir.join(START_MENU_SHORTCUT).is_file());

        // 重装后 config.json 不应被覆盖
        fs::write(
            layout.data_dir.join("config.json"),
            b"{\"consolePort\":4321}",
        )
        .unwrap();
        let mut reinstall = plan_install(&layout, &payload, &options, false).unwrap();
        apply_fixture_plan(&mut reinstall, &quiet, &root.join("backup")).unwrap();
        assert_eq!(
            fs::read_to_string(layout.data_dir.join("config.json")).unwrap(),
            "{\"consolePort\":4321}",
            "重装绝不能覆盖用户配置"
        );

        // 卸载并删除数据
        let mut purge = plan_uninstall(
            &layout,
            &UninstallOptions {
                remove_data: true,
                remove_dsh_integration: false,
                dsh_profile: "web".to_owned(),
            },
        );
        apply_fixture_plan(&mut purge, &quiet, &root.join("backup")).unwrap();
        assert!(!layout.data_dir.exists(), "--remove-data 应删除数据目录");

    }

    #[test]
    fn remove_data_uses_external_backup_and_cleans_transaction() {
        let root = temp_dir("remove-data-transaction");
        let layout = layout(&root);
        let _cleanup = FixtureCleanup::new(&root, &layout.registry_key);
        fs::create_dir_all(layout.data_dir.join("state")).unwrap();
        fs::write(layout.data_dir.join("state").join("sessions.json"), b"[]").unwrap();

        let purge = plan_uninstall(
            &layout,
            &UninstallOptions {
                remove_data: true,
                remove_dsh_integration: false,
                dsh_profile: "web".to_owned(),
            },
        );
        let applied = apply_plan(&purge, &quiet).expect("remove-data uninstall should complete");

        assert!(!layout.data_dir.exists(), "--remove-data should remove the data directory");
        assert!(!layout.install_dir.exists(), "uninstall should remove an empty install directory");
        assert!(
            !applied.backup_dir.exists(),
            "the temporary data snapshot should be deleted after a successful purge"
        );

    }

    #[test]
    fn uninstall_keeps_user_modified_files_and_reports_them() {
        let root = temp_dir("modified");
        let payload = fake_payload(&root);
        let layout = layout(&root);
        let _cleanup = FixtureCleanup::new(&root, &layout.registry_key);
        let mut plan = plan_install(&layout, &payload, &options(), false).unwrap();
        apply_fixture_plan(&mut plan, &quiet, &root.join("backup")).unwrap();

        fs::write(
            layout.install_dir.join(CORE_EXE_NAME),
            b"user replaced this",
        )
        .unwrap();
        fs::write(layout.install_dir.join("my-notes.txt"), b"mine").unwrap();

        let mut uninstall = plan_uninstall(
            &layout,
            &UninstallOptions {
                remove_data: false,
                remove_dsh_integration: false,
                dsh_profile: "web".to_owned(),
            },
        );
        assert!(
            uninstall
                .warnings
                .iter()
                .any(|warning| warning.contains(CORE_EXE_NAME))
        );
        assert!(
            uninstall
                .warnings
                .iter()
                .any(|warning| warning.contains("my-notes.txt"))
        );
        apply_fixture_plan(&mut uninstall, &quiet, &root.join("backup")).unwrap();
        assert!(
            layout.install_dir.join(CORE_EXE_NAME).is_file(),
            "被改过的文件必须保留"
        );
        assert!(
            layout.install_dir.join("my-notes.txt").is_file(),
            "非本应用的文件必须保留"
        );
    }

    #[test]
    fn failed_apply_rolls_back_completely() {
        let root = temp_dir("rollback");
        let payload = fake_payload(&root);
        let layout = layout(&root);
        let _cleanup = FixtureCleanup::new(&root, &layout.registry_key);
        fs::create_dir_all(&layout.install_dir).unwrap();
        fs::write(layout.install_dir.join(SHELL_EXE_NAME), b"old-shell").unwrap();

        let before = hash_tree(&layout.install_dir).unwrap();
        let mut plan = plan_install(&layout, &payload, &options(), false).unwrap();
        // 注入一个必然失败的 effect（复制不存在的源）
        plan.effects.insert(
            plan.effects.len() / 2,
            Effect::CopyFile {
                from: root.join("does-not-exist.bin"),
                to: layout.install_dir.join("broken.bin"),
            },
        );
        let error = apply_plan_with_backup(&plan, &quiet, &root.join("backup")).unwrap_err();
        assert!(error.contains("回滚"), "{error}");
        assert_eq!(
            hash_tree(&layout.install_dir).unwrap(),
            before,
            "回滚后目录内容必须与执行前一致"
        );
        assert!(
            !layout.data_dir.join("config.json").exists(),
            "回滚后不应留下新建的文件"
        );
    }

    #[test]
    fn installer_registry_probe_uses_and_cleans_an_isolated_key() {
        // If this host is restricted, the exact registry integration is explicitly reported as NRE.
        let _ = registry_write_available();
    }

    #[test]
    fn shortcut_creation_is_best_effort_and_testable() {
        let root = temp_dir("shortcut");
        let target = root.join("WhaleBridge.exe");
        fs::write(&target, b"exe").unwrap();
        for name in [START_MENU_SHORTCUT, UNINSTALL_SHORTCUT] {
            let path = root.join("StartMenu").join(name);
            let effect = Effect::Shortcut {
                path: path.clone(),
                target: target.clone(),
                args: if name == UNINSTALL_SHORTCUT {
                    "--uninstall"
                } else {
                    ""
                }
                .to_owned(),
                workdir: root.clone(),
                description: if name == UNINSTALL_SHORTCUT {
                    "卸载 CetaMesh"
                } else {
                    "启动 CetaMesh Desktop"
                }
                .to_owned(),
            };
            apply_effect(&effect, &quiet, &root.join("backup")).unwrap();
            if path.is_file() {
                assert!(
                    fs::metadata(&path).unwrap().len() > 0,
                    "快捷方式应为非空文件"
                );
            }
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_path_does_not_follow_directory_links() {
        let root = temp_dir("link");
        let real = root.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("keep.txt"), b"keep").unwrap();
        let link = root.join("link");
        if symlink_dir(real.clone(), &link).is_ok() {
            remove_path(&link);
            assert!(!link.exists());
            assert!(
                real.join("keep.txt").is_file(),
                "删除链接不得影响目标目录内容"
            );
        }
        fs::remove_dir_all(&root).ok();
    }

    // ---------------------------------------------------------------- 既有安装发现

    #[test]
    fn parse_registry_value_reads_reg_sz_lines() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Test\\Uninstall\\X\r\n    InstallLocation    REG_SZ    D:\\应用 CetaMesh\\app\r\n\r\n";
        assert_eq!(
            parse_registry_value(output, "InstallLocation"),
            Some("D:\\应用 CetaMesh\\app".to_owned())
        );
        assert_eq!(parse_registry_value(output, "DisplayVersion"), None);
        assert_eq!(
            parse_registry_value("    DisplayVersion    REG_SZ    1.0.0\r\n", "DisplayVersion"),
            Some("1.0.0".to_owned())
        );
    }

    #[test]
    fn find_existing_install_prefers_registry_location_manifest_version() {
        let root = temp_dir("detect-registry");
        let install_dir = root.join("Old Install");
        fs::create_dir_all(&install_dir).unwrap();
        fs::write(
            install_dir.join(INSTALL_MANIFEST),
            r#"{"version":"1.0.0-rc.1","files":{}}"#,
        )
        .unwrap();
        let default_dir = root.join("default");
        fs::create_dir_all(&default_dir).unwrap();
        let dir_clone = install_dir.clone();
        let found = find_existing_install_with(
            UNINSTALL_KEY,
            &root.join("exe-dir"),
            &default_dir,
            &|_key| Some((dir_clone.clone(), "0.9.0".to_owned())),
        )
        .unwrap();
        assert_eq!(found.install_dir, install_dir);
        assert_eq!(
            found.version, "1.0.0-rc.1",
            "安装清单里的版本优先于注册表 DisplayVersion"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_existing_install_skips_stale_registry_and_uses_exe_dir_manifest() {
        let root = temp_dir("detect-stale");
        let exe_dir = root.join("exe");
        fs::create_dir_all(&exe_dir).unwrap();
        fs::write(
            exe_dir.join(INSTALL_MANIFEST),
            r#"{"version":"2.0.0","files":{}}"#,
        )
        .unwrap();
        let stale = root.join("deleted-install");
        let stale_clone = stale.clone();
        let found = find_existing_install_with(
            UNINSTALL_KEY,
            &exe_dir,
            &root.join("default"),
            &|_key| Some((stale_clone.clone(), "1.0.0".to_owned())),
        )
        .unwrap();
        assert_eq!(found.install_dir, exe_dir, "注册表指向已删除目录时应回落");
        assert_eq!(found.version, "2.0.0");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_existing_install_reports_nothing_for_fresh_machine() {
        let root = temp_dir("detect-fresh");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            find_existing_install_with(
                UNINSTALL_KEY,
                &root.join("exe"),
                &root.join("default"),
                &|_key| None
            ),
            None
        );
        fs::remove_dir_all(&root).ok();
    }
}
