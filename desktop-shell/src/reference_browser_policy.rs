use serde_json::Value;
use std::net::IpAddr;
use url::{Host, Url};

pub fn allowed_url(input: &str) -> bool {
    if input.len() > 4096 || input.chars().any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\') { return false; }
    let Ok(url) = Url::parse(input) else { return false; };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some_and(|port| port != 443) { return false; }
    match url.host() {
        Some(Host::Domain(host)) => host.contains('.') && !host.ends_with('.') && !["localhost", "local", "internal", "home", "lan", "test", "invalid"].iter().any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}"))),
        Some(Host::Ipv4(ip)) => public_ip(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => public_ip(IpAddr::V6(ip)),
        None => false,
    }
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => { let o = ip.octets(); !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_broadcast() && !ip.is_unspecified() && !ip.is_multicast() && !ip.is_documentation() && o[0] != 0 && o[0] < 224 && !(o[0] == 100 && (64..=127).contains(&o[1])) && !(o[0] == 198 && (o[1] == 18 || o[1] == 19)) },
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() { Some(ip) => public_ip(IpAddr::V4(ip)), None => { let first = ip.segments()[0]; !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast() && (first & 0xfe00 != 0xfc00) && (first & 0xffc0 != 0xfe80) && (first & 0xe000 == 0x2000) && !(first == 0x2001 && ip.segments()[1] == 0xdb8) } },
    }
}
pub fn validate(method: &str, params: &Value) -> Result<(), String> {
    let obj = params.as_object().ok_or("查看面板参数无效。")?;
    let id = obj.get("targetId").and_then(Value::as_str).ok_or("缺少查看目标。")?;
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { return Err("查看目标无效。".into()); }
    let expected: &[&str] = match method {
        "app.previewBrowser.open" => &["targetId", "url", "bounds"],
        "app.previewBrowser.layout" => &["targetId", "bounds", "visible"],
        "app.previewBrowser.command" => &["targetId", "action"],
        _ => return Err("未知查看操作。".into()),
    };
    if obj.len() != expected.len() || expected.iter().any(|key| !obj.contains_key(*key)) { return Err("查看面板参数无效。".into()); }
    if method.ends_with(".open") && !obj.get("url").and_then(Value::as_str).is_some_and(allowed_url) { return Err("只允许查看有效的公网 HTTPS 网页。".into()); }
    if method.ends_with(".layout") && obj.get("visible").and_then(Value::as_bool).is_none() { return Err("查看面板可见状态无效。".into()); }
    if method.ends_with(".command") && !obj.get("action").and_then(Value::as_str).is_some_and(|action| matches!(action, "back" | "forward" | "reload" | "close")) { return Err("查看操作无效。".into()); }
    if let Some(bounds) = obj.get("bounds") {
        let bounds = bounds.as_object().ok_or("查看区域无效。")?;
        if bounds.len() != 5 { return Err("查看区域无效。".into()); }
        for key in ["x", "y", "width", "height", "scale"] {
            let value = bounds.get(key).and_then(Value::as_f64).ok_or("查看区域无效。")?;
            if !value.is_finite() || value < 0.0 || value > 32768.0 || (key == "scale" && !(0.25..=8.0).contains(&value)) { return Err("查看区域超出限制。".into()); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_browser_rejects_private_and_privileged_navigation() {
        assert!(allowed_url("https://developer.mozilla.org/en-US/"));
        assert!(allowed_url("https://example.com"));
        assert!(!allowed_url("https://localhost./"));
        assert!(!allowed_url("https://host.local./"));
        for url in ["http://example.com", "file:///C:/secret", "javascript:alert(1)", "https://cetamesh.localhost", "https://localhost", "https://127.0.0.1", "https://10.1.2.3", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[fc00::1]", "https://host.local", "https://user:pass@example.com", "https://example.com:3080", "https://2130706433", "https://127.1"] { assert!(!allowed_url(url), "{url}"); }
    }
    #[test]
    fn reference_browser_has_strict_commands_and_geometry() {
        let value = serde_json::json!({"targetId":"preview-1","url":"https://example.com","bounds":{"x":800,"y":100,"width":400,"height":600,"scale":1.25}});
        assert!(validate("app.previewBrowser.open", &value).is_ok());
        let mut extra = value.clone(); extra["path"] = Value::String("C:/".into());
        assert!(validate("app.previewBrowser.open", &extra).is_err());
        let mut invalid = value; invalid["bounds"]["x"] = Value::from(-1);
        assert!(validate("app.previewBrowser.open", &invalid).is_err());
        assert!(validate("app.previewBrowser.command", &serde_json::json!({"targetId":"preview-1","action":"evaluateScript"})).is_err());
    }
}
