//! 通过系统默认处理程序打开经过验证的官方链接和 Task Artifact。
//!
//! 为什么单独成一个模块：把外部启动边界集中在这里，架构守卫
//!（scripts/test-desktop-architecture.mjs）可以单独检查它。官方链接与 Artifact
//! 分别校验 HTTPS 和本地 canonical 文件路径 / 扩展名。
//!
//! 红线：
//!   - 只接受 `https://` 绝对地址：不猜协议、不放行 `http`/`file`/自定义协议；
//!   - 主机部分存在、不含凭据（`user:pass@`）、不含反斜杠/空白/控制字符；
//!   - 长度有界。URL 本身由 Core 依据随安装包分发的发行配置构造
//!     （`src/product/feedback-links.js`），这里再校验一次，避免任何一层被绕过。
//!   - Task Artifact 必须来自 Core 返回的 canonical 本地路径，并且扩展名位于显式白名单；
//!     所有权与 Workspace containment 已由 Core 的 Artifact resolver 裁决。
//!   - 失败一律返回错误，由 UI 显示"无法打开浏览器，请稍后访问 CetaMesh 官方网站。"，
//!     **绝不影响软件其它功能**。

use std::path::{Path, PathBuf};

/// 打开失败时给用户看的话（产品给定原文）。
pub const OPEN_FAILURE_MESSAGE: &str = "无法打开浏览器，请稍后访问 CetaMesh 官方网站。";

const MAX_URL_CHARS: usize = 600;
const MAX_ARTIFACT_PATH_CHARS: usize = 4096;
const ALLOWED_ARTIFACT_EXTENSIONS: &[&str] = &["csv", "jpeg", "jpg", "md", "pdf", "png", "txt"];

/// URL 是否允许交给系统浏览器打开。
pub fn is_openable_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS {
        return false;
    }
    let Some(rest) = trimmed.strip_prefix("https://") else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if host.is_empty() {
        return false;
    }
    // 拒绝凭据、反斜杠（Windows 路径写法）、端口里的怪字符与任何空白/控制字符。
    if host.contains('@') || host.contains('\\') {
        return false;
    }
    !trimmed
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control())
}

/// 交给系统默认浏览器。`explorer.exe <url>` 是 Windows 上打开 URL 默认处理程序的既有方式，
/// 也是本壳允许的唯一进程启动形式（架构守卫会断言这一点）。
pub fn open_in_default_browser(url: &str) -> Result<(), String> {
    if !is_openable_url(url) {
        return Err("URL 未通过校验，已拒绝打开".to_owned());
    }
    std::process::Command::new("explorer.exe")
        .arg(url.trim())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("{OPEN_FAILURE_MESSAGE}（{error}）"))
}

fn canonical_openable_artifact(path: &str, extension: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > MAX_ARTIFACT_PATH_CHARS || path.contains('\0') {
        return None;
    }
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.is_file() {
        return None;
    }
    let actual_extension = canonical.extension()?.to_str()?.to_ascii_lowercase();
    let requested_extension = extension.strip_prefix('.').unwrap_or(extension).to_ascii_lowercase();
    if !ALLOWED_ARTIFACT_EXTENSIONS.contains(&actual_extension.as_str()) || actual_extension != requested_extension {
        return None;
    }
    Some(canonical)
}

/// Re-check the Core result at the native dispatch boundary before handing it to Windows.
pub fn is_openable_artifact(path: &str, extension: &str) -> bool {
    canonical_openable_artifact(path, extension).is_some()
}

pub fn open_artifact(path: &str, extension: &str) -> Result<(), String> {
    let canonical = canonical_openable_artifact(path, extension)
        .ok_or_else(|| "Artifact 未通过本地文件和扩展名校验，已拒绝打开".to_owned())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(canonical)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开此交付物（{error}）"))
    }
    #[cfg(not(windows))]
    {
        let _ = canonical;
        Err("Artifact 只能由 Windows 桌面主机打开".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_urls_are_openable() {
        assert!(is_openable_url("https://cetamesh.example.com/feedback?type=bug&version=1.0.0"));
        assert!(is_openable_url("  https://example.com/security  "));

        // 协议白名单
        assert!(!is_openable_url("http://example.com/feedback"));
        assert!(!is_openable_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("ms-settings:privacy"));
        // 空/缺主机
        assert!(!is_openable_url(""));
        assert!(!is_openable_url("https:///feedback"));
        assert!(!is_openable_url("https://"));
    }

    #[test]
    fn credentials_and_control_characters_are_rejected() {
        assert!(!is_openable_url("https://user:pass@example.com/feedback"));
        assert!(!is_openable_url("https://example.com/feedback\nhttps://evil.example"));
        assert!(!is_openable_url("https://example.com/feedback with space"));
        assert!(!is_openable_url("https://example.com\\evil"));
    }

    #[test]
    fn url_length_is_bounded() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS));
        assert!(!is_openable_url(&long));
    }

    #[test]
    fn artifact_open_requires_a_local_file_and_allowlisted_matching_extension() {
        let path = std::env::temp_dir().join(format!("cetamesh-artifact-{}.txt", std::process::id()));
        std::fs::write(&path, "artifact").unwrap();
        let local = path.to_string_lossy().into_owned();
        assert!(is_openable_artifact(&local, ".txt"));
        assert!(!is_openable_artifact(&local, ".exe"));
        assert!(!is_openable_artifact(&local, ".pdf"));
        assert!(!is_openable_artifact("https://example.test/file.txt", ".txt"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn opening_an_invalid_url_fails_without_launching_anything() {
        // 校验不通过时必须直接报错（绝不 spawn），UI 据此显示产品文案。
        assert!(open_in_default_browser("http://example.com").is_err());
        assert!(open_in_default_browser("not a url").is_err());
    }
}
