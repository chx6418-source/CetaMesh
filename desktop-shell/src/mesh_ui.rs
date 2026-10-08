//! CetaMesh Desktop —— Devices / Mesh 产品区（阶段 11）。
//!
//! 由 Desktop 的 Devices 页面展示现有 Mesh 与 Channel 功能。
//! 展示：Device / Role / Trust / Transport / Last seen / Capabilities / Status / Last error，
//! 以及本节点的 Device Identity、Node Role、Pending Approval 与 Channel Adapter 状态。
//!
//! 与 memory_ui / task_ui 同一约定：只维护状态并返回 Core 调用意图（MeshAction），
//! 真正下发 IPC 的是 native_ui。mesh 与 channel 分属两个 Area，因此同一帧可以各发一条。

use eframe::egui;
use crate::native_ui::native_palette;
use serde_json::{Map, Value, json};


/// 规范能力清单来自 src/mesh/types.js 的 NODE_CAPABILITIES；这里只做 UI 下拉的镜像。
const KNOWN_CAPABILITIES: [&str; 7] = [
    "mesh.presence", "mesh.manifest", "chat.session", "memory.query",
    "task.manage", "workspace.files", "extension.invoke",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MeshArea {
    Mesh,
    Channel,
}

pub struct MeshAction {
    pub area: MeshArea,
    pub method: &'static str,
    pub params: Value,
}

impl MeshAction {
    fn mesh(method: &'static str, params: Value) -> Self {
        Self { area: MeshArea::Mesh, method, params }
    }
    fn channel(method: &'static str, params: Value) -> Self {
        Self { area: MeshArea::Channel, method, params }
    }
}

#[derive(Clone, Debug, Default)]
pub struct MeshStatus {
    pub node_id: String,
    pub name: String,
    pub role: String,
    pub protocol_version: u64,
    pub core_ready: bool,
    pub peer_count: u64,
    pub trusted_count: u64,
    pub online_count: u64,
    pub pending_approvals: u64,
    pub deferred_transports: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PeerRow {
    pub node_id: String,
    pub name: String,
    pub role: String,
    pub trust: String,
    pub transport: String,
    pub presence: String,
    pub status: String,
    pub last_seen_at: u64,
    pub last_error: String,
    pub grants: Vec<String>,
    pub advertised: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ApprovalRow {
    pub request_id: String,
    pub from: String,
    pub capability: String,
    pub state: String,
    pub at: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ChannelRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub state: String,
    pub status: String,
    pub last_error: String,
    pub core_dependency: bool,
}

fn str_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}
fn u64_of(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}
fn list_of(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
        .unwrap_or_default()
}

pub fn parse_status(value: &Value) -> Option<MeshStatus> {
    let status = value.get("status")?;
    Some(MeshStatus {
        node_id: str_of(status, "nodeId"),
        name: str_of(status, "name"),
        role: str_of(status, "role"),
        protocol_version: u64_of(status, "protocolVersion"),
        core_ready: status.get("coreReady").and_then(Value::as_bool).unwrap_or(false),
        peer_count: u64_of(status, "peerCount"),
        trusted_count: u64_of(status, "trustedCount"),
        online_count: u64_of(status, "onlineCount"),
        pending_approvals: u64_of(status, "pendingApprovals"),
        deferred_transports: list_of(status, "deferredTransports"),
    })
}

pub fn parse_peers(value: &Value) -> Vec<PeerRow> {
    value
        .get("peers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| PeerRow {
                    node_id: str_of(item, "nodeId"),
                    name: str_of(item, "name"),
                    role: str_of(item, "role"),
                    trust: str_of(item, "trust"),
                    transport: str_of(item, "transport"),
                    presence: str_of(item, "presence"),
                    status: str_of(item, "status"),
                    last_seen_at: u64_of(item, "lastSeenAt"),
                    last_error: item.get("lastError").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    grants: list_of(item, "grants"),
                    advertised: list_of(item, "advertised"),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_approvals(value: &Value) -> Vec<ApprovalRow> {
    value
        .get("approvals")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| ApprovalRow {
                    request_id: str_of(item, "requestId"),
                    from: str_of(item, "from"),
                    capability: str_of(item, "capability"),
                    state: str_of(item, "state"),
                    at: u64_of(item, "at"),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_channels(value: &Value) -> Vec<ChannelRow> {
    value
        .get("channels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| ChannelRow {
                    id: str_of(item, "id"),
                    name: str_of(item, "name"),
                    kind: str_of(item, "kind"),
                    state: str_of(item, "state"),
                    status: str_of(item, "status"),
                    last_error: item.get("lastError").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    core_dependency: item.get("coreDependency").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn format_time(ms: u64) -> String {
    if ms == 0 {
        return "—".to_owned();
    }
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{:04}-{:02}-{:02} {:02}:{:02}", year, month, day, rem / 3600, (rem % 3600) / 60)
}

fn trust_color(trust: &str) -> egui::Color32 {
    match trust {
        "trusted" => native_palette().success,
        "blocked" => native_palette().error,
        _ => native_palette().warning,
    }
}

pub struct MeshUi {
    pub loaded: bool,
    requested: bool,
    pub status: Option<MeshStatus>,
    pub peers: Vec<PeerRow>,
    pub approvals: Vec<ApprovalRow>,
    pub channels: Vec<ChannelRow>,
    pub core_gated_by_channels: Option<bool>,
    pub invite: Option<(String, u64)>,
    pub grant_peer: String,
    pub grant_capability: String,
    pub notice: Option<String>,
    pub error: Option<String>,
}

impl Default for MeshUi {
    fn default() -> Self {
        Self {
            loaded: false,
            requested: false,
            status: None,
            peers: Vec::new(),
            approvals: Vec::new(),
            channels: Vec::new(),
            core_gated_by_channels: None,
            invite: None,
            grant_peer: String::new(),
            grant_capability: "mesh.presence".to_owned(),
            notice: None,
            error: None,
        }
    }
}

impl MeshUi {
    /// 应用一次 Core 返回。返回 true 表示需要重新拉取快照。
    pub fn apply(&mut self, value: &Value) -> bool {
        self.error = None;
        if value.get("status").is_some() {
            self.status = parse_status(value);
            self.peers = parse_peers(value);
            if value.get("approvals").is_some() {
                self.approvals = parse_approvals(value);
            }
            self.loaded = true;
            return false;
        }
        if value.get("channels").is_some() {
            self.channels = parse_channels(value);
            self.core_gated_by_channels = value
                .get("independence")
                .and_then(|item| item.get("coreGatedByChannels"))
                .and_then(Value::as_bool);
            return false;
        }
        if value.get("approvals").is_some() {
            self.approvals = parse_approvals(value);
            return false;
        }
        if value.get("code").is_some() {
            self.invite = Some((str_of(value, "code"), u64_of(value, "expiresAt")));
            self.notice = Some("邀请码已生成，交给对端完成配对。".to_owned());
            return false;
        }
        if value.get("peer").is_some() || value.get("removed").is_some() || value.get("adapter").is_some() {
            self.notice = Some("操作已提交，正在刷新…".to_owned());
            return true;
        }
        if value.get("approval").is_some() {
            self.notice = Some("审批已处理，正在刷新…".to_owned());
            return true;
        }
        false
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    fn filter_params(&self) -> Value {
        Value::Object(Map::new())
    }

    /// 渲染 Devices / Mesh 区域，返回本帧要下发的调用意图。
    pub fn show(&mut self, ui: &mut egui::Ui) -> Vec<MeshAction> {
        let mut actions: Vec<MeshAction> = Vec::new();

        if !self.requested {
            self.requested = true;
            actions.push(MeshAction::mesh("mesh.snapshot", self.filter_params()));
            actions.push(MeshAction::channel("channel.list", json!({})));
        }

        ui.heading("Devices / Mesh");
        ui.label(
            egui::RichText::new("Desktop 是独立的 CetaMesh Node：信任一个设备不等于授权它调用能力。")
                .color(native_palette().muted),
        );
        if let Some(error) = &self.error {
            ui.colored_label(native_palette().error, error.as_str());
        }

        // ── 本节点身份 ────────────────────────────────────────────────────
        if let Some(status) = self.status.clone() {
            crate::theme::card_compact(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(format!("本节点 {}", status.name)).strong());
                        ui.weak(format!("role {}", status.role));
                        ui.weak(format!("protocol v{}", status.protocol_version));
                        ui.colored_label(if status.core_ready { native_palette().success } else { native_palette().error },
                            if status.core_ready { "Core ready" } else { "Core not ready" });
                    });
                    ui.weak(format!("Device Identity: {}", status.node_id));
                    ui.horizontal_wrapped(|ui| {
                        ui.weak(format!("对端 {}（已信任 {}，在线 {}）", status.peer_count, status.trusted_count, status.online_count));
                        ui.weak(format!("待审批 {}", status.pending_approvals));
                        if !status.deferred_transports.is_empty() {
                            ui.colored_label(native_palette().warning, format!("跨设备传输未实现：{}", status.deferred_transports.join(", ")));
                        }
                    });
                });
        } else {
            ui.weak("正在读取节点状态…");
        }

        // ── Channel Adapter（QQ 属于通道接入，不参与 Core readiness） ──────
        if !self.channels.is_empty() {
            ui.add_space(8.0);
            ui.label(egui::RichText::new("Channel Adapter").strong());
            if self.core_gated_by_channels == Some(false) {
                ui.weak("不变量：Channel 生命周期不参与 Core readiness（Channel Adapter 已明确放回接入层）。");
            }
            egui::Grid::new("mesh_channel_grid").striped(true).num_columns(5).show(ui, |ui| {
                ui.strong("通道");
                ui.strong("类型");
                ui.strong("状态");
                ui.strong("Core 依赖");
                ui.strong("Last error");
                ui.end_row();
                for channel in self.channels.clone() {
                    ui.label(channel.name.as_str());
                    ui.label(channel.kind.as_str());
                    ui.colored_label(if channel.status == "online" { native_palette().success } else { native_palette().muted }, channel.status.as_str());
                    ui.label(if channel.core_dependency { "是" } else { "否" });
                    ui.label(if channel.last_error.is_empty() { "—" } else { channel.last_error.as_str() });
                    ui.end_row();
                }
            });
        }

        // ── 配对 ──────────────────────────────────────────────────────────
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            if ui.button("生成配对邀请码").clicked() {
                actions.push(MeshAction::mesh("mesh.invite.create", json!({})));
            }
            if let Some((code, expires_at)) = self.invite.clone() {
                ui.label(egui::RichText::new(code).color(native_palette().accent).strong());
                ui.weak(format!("有效期至 {}", format_time(expires_at)));
            }
            if ui.button("刷新").clicked() {
                actions.push(MeshAction::mesh("mesh.snapshot", json!({})));
                actions.push(MeshAction::channel("channel.list", json!({})));
            }
        });
        if let Some(notice) = &self.notice {
            ui.weak(notice.as_str());
        }

        // ── 对端列表 ──────────────────────────────────────────────────────
        ui.add_space(8.0);
        ui.label(egui::RichText::new(format!("Peers（{}）", self.peers.len())).strong());
        if self.peers.is_empty() {
            ui.weak("还没有已配对的对端。");
        }
        let mut want_grant_peer: Option<String> = None;
        for peer in self.peers.clone() {
            crate::theme::card_compact(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(peer.name.as_str()).strong());
                        ui.weak(peer.node_id.as_str());
                        ui.weak(format!("role {}", peer.role));
                        ui.colored_label(trust_color(&peer.trust), peer.trust.as_str());
                        ui.weak(format!("transport {}", peer.transport));
                        ui.weak(format!("status {}", peer.status));
                        ui.weak(format!("last seen {}", format_time(peer.last_seen_at)));
                    });
                    ui.horizontal_wrapped(|ui| {
                        ui.weak(format!("已授权：{}", if peer.grants.is_empty() { "无".to_owned() } else { peer.grants.join("、") }));
                        ui.weak(format!("对端声明：{}", if peer.advertised.is_empty() { "无".to_owned() } else { peer.advertised.join("、") }));
                    });
                    if !peer.last_error.is_empty() {
                        ui.colored_label(native_palette().warning, format!("Last error：{}", peer.last_error));
                    }
                    ui.horizontal_wrapped(|ui| {
                        if peer.trust != "trusted" && ui.button("信任").clicked() {
                            actions.push(MeshAction::mesh("mesh.trust", json!({ "nodeId": peer.node_id })));
                        }
                        if peer.trust != "blocked" && ui.button("拉黑").clicked() {
                            actions.push(MeshAction::mesh("mesh.block", json!({ "nodeId": peer.node_id })));
                        }
                        if ui.button("断开").clicked() {
                            actions.push(MeshAction::mesh("mesh.disconnect", json!({ "nodeId": peer.node_id })));
                        }
                        if ui.button("撤销信任（清空授权）").clicked() {
                            actions.push(MeshAction::mesh("mesh.trust.remove", json!({ "nodeId": peer.node_id })));
                        }
                        if ui.button("授予…").clicked() {
                            want_grant_peer = Some(peer.node_id.clone());
                        }
                    });
                });
        }
        if let Some(node_id) = want_grant_peer {
            self.grant_peer = node_id;
        }

        // ── 授权（Trusted != Authorized） ────────────────────────────────
        if !self.peers.is_empty() {
            ui.horizontal_wrapped(|ui| {
                ui.label("授权能力给");
                egui::ComboBox::from_id_salt("mesh_grant_peer")
                    .selected_text(if self.grant_peer.is_empty() { "选择对端".to_owned() } else { self.grant_peer.clone() })
                    .show_ui(ui, |ui| {
                        for peer in &self.peers {
                            ui.selectable_value(&mut self.grant_peer, peer.node_id.clone(), peer.name.clone());
                        }
                    });
                egui::ComboBox::from_id_salt("mesh_grant_capability")
                    .selected_text(self.grant_capability.clone())
                    .show_ui(ui, |ui| {
                        for capability in KNOWN_CAPABILITIES {
                            ui.selectable_value(&mut self.grant_capability, capability.to_owned(), capability);
                        }
                    });
                let ready = !self.grant_peer.is_empty();
                if ui.add_enabled(ready, egui::Button::new("授予")).clicked() {
                    actions.push(MeshAction::mesh("mesh.grant", json!({
                        "nodeId": self.grant_peer,
                        "capabilities": [self.grant_capability],
                    })));
                }
                if ui.add_enabled(ready, egui::Button::new("收回")).clicked() {
                    actions.push(MeshAction::mesh("mesh.revoke", json!({
                        "nodeId": self.grant_peer,
                        "capabilities": [self.grant_capability],
                    })));
                }
            });
        }

        // ── 待审批的远程能力请求 ──────────────────────────────────────────
        let pending: Vec<ApprovalRow> = self.approvals.iter().filter(|a| a.state == "pending").cloned().collect();
        if !pending.is_empty() {
            ui.add_space(8.0);
            ui.label(egui::RichText::new(format!("待审批的远程能力请求（{}）", pending.len())).strong());
            ui.weak("受信任且已授权的对端，调用需审批的能力时仍需你逐次批准。");
            for approval in pending {
                ui.group(|ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(egui::RichText::new(approval.capability.as_str()).strong());
                        ui.weak(format!("来自 {}", approval.from));
                        ui.weak(format_time(approval.at));
                    });
                    ui.horizontal(|ui| {
                        if ui.button("批准").clicked() {
                            actions.push(MeshAction::mesh("mesh.approval.decide", json!({
                                "requestId": approval.request_id, "decision": "approve"
                            })));
                        }
                        if ui.button("拒绝").clicked() {
                            actions.push(MeshAction::mesh("mesh.approval.decide", json!({
                                "requestId": approval.request_id, "decision": "reject"
                            })));
                        }
                    });
                });
            }
        }

        actions
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_approvals, parse_channels, parse_peers, parse_status};
    use serde_json::json;

    #[test]
    fn parses_snapshot_into_status_peers_and_approvals() {
        let value = json!({
            "status": {
                "nodeId": "node_abc", "name": "Desktop", "role": "desktop", "protocolVersion": 1,
                "coreReady": true, "peerCount": 2, "trustedCount": 1, "onlineCount": 1,
                "pendingApprovals": 1, "deferredTransports": ["pipe", "tcp", "relay"]
            },
            "peers": [
                {
                    "nodeId": "node_peer", "name": "Peer", "role": "mobile", "trust": "trusted",
                    "transport": "loopback", "presence": "online", "status": "online",
                    "lastSeenAt": 1700000000000u64, "lastError": null,
                    "grants": ["mesh.presence"], "advertised": ["mesh.manifest"]
                }
            ],
            "approvals": [
                { "requestId": "r1", "from": "node_peer", "capability": "memory.query", "state": "pending", "at": 1700000000000u64 }
            ]
        });
        let status = parse_status(&value).expect("status");
        assert_eq!(status.node_id, "node_abc");
        assert_eq!(status.role, "desktop");
        assert!(status.core_ready);
        assert_eq!(status.deferred_transports.len(), 3);
        let peers = parse_peers(&value);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].trust, "trusted");
        assert_eq!(peers[0].grants, vec!["mesh.presence".to_string()]);
        assert_eq!(peers[0].last_seen_at, 1_700_000_000_000);
        assert!(peers[0].last_error.is_empty());
        let approvals = parse_approvals(&value);
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].request_id, "r1");
        assert!(parse_status(&json!({})).is_none());
    }

    #[test]
    fn parses_channels_and_independence_flag() {
        let value = json!({
            "channels": [
                { "id": "qq", "name": "QQ", "kind": "channel-adapter", "state": "error",
                  "status": "error", "lastError": "SnowLuma 未运行", "coreDependency": false }
            ],
            "independence": { "coreGatedByChannels": false }
        });
        let channels = parse_channels(&value);
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, "qq");
        assert_eq!(channels[0].kind, "channel-adapter");
        assert!(!channels[0].core_dependency);
        assert_eq!(channels[0].last_error, "SnowLuma 未运行");
        assert!(parse_channels(&json!({})).is_empty());
    }

    #[test]
    fn tolerates_missing_optional_sections() {
        let value = json!({ "status": { "nodeId": "node_x", "coreReady": true } });
        assert!(parse_peers(&value).is_empty());
        assert!(parse_approvals(&value).is_empty());
        let status = parse_status(&value).expect("status");
        assert_eq!(status.peer_count, 0);
        assert!(status.name.is_empty());
    }
}
