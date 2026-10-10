//! 用系统默认浏览器打开官方页面（反馈入口用）。
//!
//! 为什么单独成一个模块：整个桌面壳只允许两处"启动外部程序"——打开日志目录、打开官方页面。
//! 把后者隔离在这里，架构守卫（scripts/test-desktop-architecture.mjs）就能单独盯住它，
//! URL 校验也只有一处实现。
//!
//! 红线：
//!   - 只接受 `https://` 绝对地址：不猜协议、不放行 `http`/`file`/自定义协议；
//!   - 主机部分存在、不含凭据（`user:pass@`）、不含反斜杠/空白/控制字符；
//!   - 长度有界。URL 本身由 Core 依据随安装包分发的发行配置构造
//!     （`src/product/feedback-links.js`），这里再校验一次，避免任何一层被绕过。
//!   - 失败一律返回错误，由 UI 显示"无法打开浏览器，请稍后访问 CetaMesh 官方网站。"，
//!     **绝不影响软件其它功能**。

/// 打开失败时给用户看的话（产品给定原文）。
pub const OPEN_FAILURE_MESSAGE: &str = "无法打开浏览器，请稍后访问 CetaMesh 官方网站。";

const MAX_URL_CHARS: usize = 600;

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
    fn opening_an_invalid_url_fails_without_launching_anything() {
        // 校验不通过时必须直接报错（绝不 spawn），UI 据此显示产品文案。
        assert!(open_in_default_browser("http://example.com").is_err());
        assert!(open_in_default_browser("not a url").is_err());
    }
}
