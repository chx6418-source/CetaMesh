//! 产品级 Chat 页的状态与 Core 响应解析（阶段 03）。
//!
//! 状态经由 NativeUi 的 worker 线程拉取（chat.* IPC 方法族），本模块只做
//! 数据持有与解析，不直接访问 Core。usage 为 Provider 真实回传，缺失时
//! 显示"未知"，不伪造。

use serde_json::{Value, json};
use std::time::Instant;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatSessionConfig {
    pub provider: String,
    pub model: String,
    pub reasoning: String,
    pub mode: String,
}

#[derive(Clone, Debug)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub archived: bool,
    pub config: ChatSessionConfig,
}

#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub error: Option<String>,
    pub cancelled: bool,
    pub usage: Option<String>,
}

/// 一条在途回合的展示状态（轮询 chat.status 得到）。
#[derive(Clone, Debug)]
pub struct ChatTurn {
    pub state: String,
    pub display_text: String,
    pub error: Option<String>,
    pub usage: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ChatUi {
    pub sessions: Vec<ChatSession>,
    pub sessions_loaded: bool,
    pub active_id: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub history_loaded: bool,
    pub turn: Option<ChatTurn>,
    /// 上一轮询是否见到在途回合：区分"无回合"与"回合刚结束"。
    pub had_turn: bool,
    /// send/retry/continue 已受理但尚未经轮询确认到在途回合。
    pub expecting_turn: bool,
    /// 删除确认：第一次点击后置位，再次点击才执行。
    pub confirm_delete: bool,
    pub input: String,
    pub attachments: Vec<(String, String)>,
    pub renaming: Option<(String, String)>,
    pub catalog: Option<Value>,
    pub notice: Option<String>,
    pub last_poll: Option<Instant>,
}

impl ChatUi {
    pub fn active_session(&self) -> Option<&ChatSession> {
        let id = self.active_id.as_ref()?;
        self.sessions.iter().find(|session| &session.id == id)
    }

    pub fn active_config(&self) -> ChatSessionConfig {
        self.active_session()
            .map(|session| session.config.clone())
            .unwrap_or_default()
    }

    pub fn notice_or_empty(&self) -> &str {
        self.notice.as_deref().unwrap_or("")
    }

    pub fn reset(&mut self) {
        self.messages.clear();
        self.history_loaded = false;
        self.turn = None;
        self.had_turn = false;
        self.expecting_turn = false;
        self.confirm_delete = false;
        self.attachments.clear();
        self.renaming = None;
    }
}

pub fn parse_sessions(value: &Value) -> Result<Vec<ChatSession>, String> {
    let list = value
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core 返回的会话列表缺失或无效。".to_owned())?;
    let mut sessions = Vec::new();
    for item in list {
        let config = item.get("config");
        sessions.push(ChatSession {
            id: string_field(item, "id")?,
            title: item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("新会话")
                .to_owned(),
            updated_at: item
                .get("updatedAt")
                .and_then(Value::as_i64)
                .ok_or_else(|| "会话缺少 updatedAt。".to_owned())?,
            archived: item.get("archived").and_then(Value::as_bool).unwrap_or(false),
            config: ChatSessionConfig {
                provider: config
                    .and_then(|c| c.get("provider"))
                    .and_then(Value::as_str)
                    .unwrap_or("dsh")
                    .to_owned(),
                model: config
                    .and_then(|c| c.get("model"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                reasoning: config
                    .and_then(|c| c.get("reasoning"))
                    .and_then(Value::as_str)
                    .unwrap_or("max")
                    .to_owned(),
                mode: config
                    .and_then(|c| c.get("mode"))
                    .and_then(Value::as_str)
                    .unwrap_or("chat")
                    .to_owned(),
            },
        });
    }
    Ok(sessions)
}

pub fn parse_history(value: &Value) -> Result<Vec<ChatMessage>, String> {
    let list = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Core 返回的对话历史缺失或无效。".to_owned())?;
    let mut messages = Vec::new();
    for item in list {
        let usage = item.get("usage").filter(|usage| usage.is_object());
        messages.push(ChatMessage {
            id: string_field(item, "id")?,
            role: string_field(item, "role")?,
            text: item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            error: item
                .get("error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            cancelled: item.get("cancelled").and_then(Value::as_bool).unwrap_or(false),
            usage: usage.map(|usage| compact_value(usage)),
        });
    }
    Ok(messages)
}

pub fn parse_turn(value: &Value) -> Option<ChatTurn> {
    let turn = value.get("turn").filter(|item| !item.is_null())?;
    Some(ChatTurn {
        state: turn.get("state").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
        display_text: turn
            .get("displayText")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        error: turn.get("error").and_then(Value::as_str).map(ToOwned::to_owned),
        usage: turn
            .get("usage")
            .filter(|usage| usage.is_object())
            .map(compact_value),
    })
}

pub fn parse_catalog(value: &Value) -> (Vec<(String, String)>, Option<String>) {
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = entry.get("id").and_then(Value::as_str)?;
                    let label = entry.get("label").and_then(Value::as_str).unwrap_or(id);
                    Some((id.to_owned(), label.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    (models, value.get("error").and_then(Value::as_str).map(ToOwned::to_owned))
}

fn string_field(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("记录缺少 {field} 字段。"))
}

fn compact_value(value: &Value) -> String {
    // usage 的紧凑展示：逐字段"名称=值"；未知字段原样透传，不补造任何数字。
    let object = match value.as_object() {
        Some(object) if !object.is_empty() => object,
        _ => return "未知".to_owned(),
    };
    let parts: Vec<String> = object
        .iter()
        .map(|(key, item)| match item.as_f64() {
            Some(number) if number.fract() == 0.0 => format!("{key}={}", number as i64),
            Some(number) => format!("{key}={number}"),
            None => format!("{key}={}", json!(item)),
        })
        .collect();
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::{ChatUi, parse_catalog, parse_history, parse_sessions, parse_turn};
    use serde_json::json;

    #[test]
    fn parses_sessions_history_turn_and_catalog() {
        let sessions = parse_sessions(&json!({
            "sessions": [
                {"id": "s1", "title": "项目", "updatedAt": 10, "archived": false,
                 "config": {"provider": "dsh", "model": "deepseek-flash", "reasoning": "max", "mode": "chat"}}
            ]
        }))
        .expect("sessions parse");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "项目");
        assert_eq!(sessions[0].config.model, "deepseek-flash");

        let history = parse_history(&json!({
            "messages": [
                {"id": "m1", "role": "user", "text": "你好"},
                {"id": "m2", "role": "assistant", "text": "回答", "usage": {"inputTokens": 5, "outputTokens": 2}},
                {"id": "m3", "role": "assistant", "text": "半截", "cancelled": true},
                {"id": "m4", "role": "assistant", "text": "坏", "error": "模型服务中断"}
            ]
        }))
        .expect("history parse");
        assert_eq!(history.len(), 4);
        assert_eq!(history[1].usage.as_deref(), Some("inputTokens=5 · outputTokens=2"));
        assert!(history[2].cancelled);
        assert_eq!(history[3].error.as_deref(), Some("模型服务中断"));

        let turn = parse_turn(&json!({
            "turn": {"state": "streaming", "displayText": "部分", "error": null, "usage": null}
        }))
        .expect("turn parse");
        assert_eq!(turn.state, "streaming");
        assert_eq!(turn.display_text, "部分");
        assert!(parse_turn(&json!({"turn": null})).is_none());

        let (models, error) = parse_catalog(&json!({
            "models": [{"id": "deepseek-flash", "label": "DeepSeek-V41-Flash", "provider": "deepseek-official"}],
            "error": null
        }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].0, "deepseek-flash");
        assert!(error.is_none());

        let (models, error) = parse_catalog(&json!({"models": [], "error": "settings/describe: 传输失败"}));
        assert!(models.is_empty());
        assert!(error.is_some());
    }

    #[test]
    fn active_config_falls_back_to_defaults_without_session() {
        let chat = ChatUi::default();
        assert_eq!(chat.active_config().model, "");
        assert_eq!(chat.notice_or_empty(), "");
    }
}
