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

/// 统一设备配对（阶段 12）：手机扫码连接本机。
///
/// Core 契约（mesh.pairing.*，worker 侧实现）：
/// - `mesh.pairing.start` `{}` → { sessionId, invitation, qr: { size, rows }, deviceName,
///   nodeId, endpoint, expiresAt, ttlMs, tlsPin, securityNote }
/// - `mesh.pairing.status` `{}` → { active, sessionId, expiresAt, consumedBy, peerNodeId }
/// - `mesh.pairing.cancel` `{}` → { cancelled }
/// - `mesh.snapshot` 顶层新增 `pairing`（与 status 同形）。
///
/// `invitation` 是必须原样可复制的文本（令牌在其中），只允许复制、绝不渲染为可见文本；
/// QR 才是把 invitation 交给手机的通道。
#[derive(Clone, Debug, Default)]
pub struct PairingView {
    pub session_id: String,
    pub invitation: String,
    pub qr_size: usize,
    pub qr_rows: Vec<String>,
    pub device_name: String,
    pub node_id: String,
    pub endpoint: String,
    pub expires_at: u64,
    pub ttl_ms: u64,
    pub tls_pin: String,
    pub security_note: String,
}

#[derive(Clone, Debug, Default)]
pub struct ConsumedPeer {
    pub node_id: String,
    pub name: String,
    pub device_id: String,
}

#[derive(Clone, Debug, Default)]
pub struct PairingStatus {
    pub active: bool,
    pub session_id: Option<String>,
    pub expires_at: Option<u64>,
    pub consumed_by: Option<ConsumedPeer>,
    pub peer_node_id: Option<String>,
}

fn str_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}
fn opt_str_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
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

/// 解析 `mesh.pairing.start` 的结果（顶层 sessionId + invitation 是它的指纹；
/// snapshot 的 pairing 是嵌套对象，不会被误判）。缺字段一律降级为空值，不返回 None。
pub fn parse_pairing_view(value: &Value) -> Option<PairingView> {
    if value.get("qr").is_none() && value.get("sessionId").is_none() {
        return None;
    }
    let invitation = str_of(value, "invitation");
    let session_id = str_of(value, "sessionId");
    if session_id.is_empty() || invitation.is_empty() {
        return None;
    }
    let qr = value.get("qr");
    let qr_rows = qr.map(|qr| list_of(qr, "rows")).unwrap_or_default();
    let declared_size = qr.and_then(|qr| qr.get("size")).and_then(Value::as_u64).unwrap_or(0) as usize;
    let qr_size = if declared_size == 0 { qr_rows.len() } else { declared_size };
    Some(PairingView {
        session_id,
        invitation,
        qr_size,
        qr_rows,
        device_name: str_of(value, "deviceName"),
        node_id: str_of(value, "nodeId"),
        endpoint: str_of(value, "endpoint"),
        expires_at: u64_of(value, "expiresAt"),
        ttl_ms: u64_of(value, "ttlMs"),
        tls_pin: str_of(value, "tlsPin"),
        security_note: str_of(value, "securityNote"),
    })
}

fn parse_consumed_peer(value: &Value) -> Option<ConsumedPeer> {
    if !value.is_object() {
        return None;
    }
    Some(ConsumedPeer {
        node_id: str_of(value, "nodeId"),
        name: str_of(value, "name"),
        device_id: str_of(value, "deviceId"),
    })
}

/// 解析 `pairing` 状态：既接受 snapshot 的 `pairing` 子对象，也接受 `mesh.pairing.status`
/// 的顶层结果。`pairing` 缺失或为 null → None（旧 worker 的 snapshot 依旧可解析）；
/// 顶层形态以 `active` 键识别，避免把不含 pairing 的 snapshot 误判成“有会话”。
pub fn parse_pairing_status(value: &Value) -> Option<PairingStatus> {
    let source = match value.get("pairing") {
        Some(nested) => nested,
        None => {
            if value.get("active").is_none() {
                return None;
            }
            value
        }
    };
    if !source.is_object() {
        return None;
    }
    Some(PairingStatus {
        active: source.get("active").and_then(Value::as_bool).unwrap_or(false),
        session_id: opt_str_of(source, "sessionId"),
        expires_at: source.get("expiresAt").and_then(Value::as_u64),
        consumed_by: source.get("consumedBy").and_then(parse_consumed_peer),
        peer_node_id: opt_str_of(source, "peerNodeId"),
    })
}

fn epoch_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 会话无 chrono/time 依赖，只有 UTC 的 format_time；因此这里额外给出剩余分钟数。
/// `expires_at` 缺失时退化为 `ttl_ms` 的时长描述。
fn pairing_expiry_label(expires_at: u64, ttl_ms: u64) -> String {
    if expires_at == 0 {
        return if ttl_ms > 0 {
            format!("{} 分钟内有效", ttl_ms / 60_000)
        } else {
            "—".to_owned()
        };
    }
    let now = epoch_ms_now();
    if expires_at <= now {
        return format!("{}（已过期）", format_time(expires_at));
    }
    let minutes = (expires_at - now) / 60_000;
    if minutes == 0 {
        format!("{}（剩余不足 1 分钟）", format_time(expires_at))
    } else {
        format!("{}（剩余 {} 分钟）", format_time(expires_at), minutes)
    }
}

/// 把 `qr.size` × `qr.size` 的 '0'/'1' 模块矩阵画成可扫描位图：
/// 白底（含 4 模块静默区）覆盖整个分配区域，'1' 模块用黑色实心小矩形填充。
fn show_qr_code(ui: &mut egui::Ui, view: &PairingView) {
    let size = view.qr_size;
    if size == 0 || view.qr_rows.is_empty() {
        ui.weak("二维码暂不可用：Core 未返回模块矩阵，可用「复制配对邀请」手工导入。");
        return;
    }
    let module = ((300.0 / (size as f32 + 8.0)).floor()).clamp(3.0, 8.0);
    let quiet = module * 4.0;
    let side = module * size as f32 + quiet * 2.0;
    let (rect, _response) = ui.allocate_exact_size(egui::vec2(side, side), egui::Sense::hover());
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, egui::CornerRadius::ZERO, egui::Color32::WHITE);
    for (row_index, row) in view.qr_rows.iter().take(size).enumerate() {
        for (column_index, module_bit) in row.bytes().take(size).enumerate() {
            if module_bit != b'1' {
                continue;
            }
            let offset = egui::vec2(
                quiet + column_index as f32 * module,
                quiet + row_index as f32 * module,
            );
            painter.rect_filled(
                egui::Rect::from_min_size(rect.min + offset, egui::Vec2::splat(module)),
                egui::CornerRadius::ZERO,
                egui::Color32::BLACK,
            );
        }
    }
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
    /// 旧 `mesh.invite.create` 结果（服务方法保留给 CLI/测试；UI 不再展示该流程）。
    pub invite: Option<(String, u64)>,
    pub pairing: Option<PairingStatus>,
    pub pairing_view: Option<PairingView>,
    pairing_polled_at: f64,
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
            pairing: None,
            pairing_view: None,
            pairing_polled_at: f64::NEG_INFINITY,
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
            self.pairing = parse_pairing_status(value);
            self.reconcile_pairing();
            self.loaded = true;
            return false;
        }
        // mesh.pairing.start 的结果：以 invitation 与 sessionId 识别，snapshot 不会走到这里。
        if let Some(view) = parse_pairing_view(value) {
            self.pairing = Some(PairingStatus {
                active: true,
                session_id: Some(view.session_id.clone()),
                expires_at: Some(view.expires_at),
                consumed_by: None,
                peer_node_id: None,
            });
            self.pairing_view = Some(view);
            self.notice = Some("配对邀请已生成，请用手机扫描二维码。".to_owned());
            return false;
        }
        // mesh.pairing.status 的结果：既有顶层形态（active/sessionId/...），也兼容嵌套的
        // `pairing` 对象（snapshot 的 pairing 已在上面的 status 分支处理）。
        if value.get("pairing").is_some() || value.get("active").is_some() {
            self.pairing = parse_pairing_status(value);
            self.reconcile_pairing();
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
        if let Some(cancelled) = value.get("cancelled").and_then(Value::as_bool) {
            self.pairing_view = None;
            self.pairing = None;
            self.notice = Some(if cancelled { "配对邀请已取消。".to_owned() } else { "当前没有进行中的配对邀请。".to_owned() });
            return true;
        }
        false
    }

    /// 会话状态变化后决定二维码视图的去留：被手机消费 → 连接成功；不再活跃 → 失效。
    fn reconcile_pairing(&mut self) {
        let Some(pairing) = self.pairing.clone() else {
            return;
        };
        if let Some(consumer) = pairing.consumed_by {
            let connected = self.pairing_view.is_some();
            self.pairing_view = None;
            self.notice = Some(if connected {
                format!("手机已连接：{}，二维码已收起。", consumer.name)
            } else {
                format!("手机已连接：{}", consumer.name)
            });
            return;
        }
        if !pairing.active && self.pairing_view.is_some() {
            self.pairing_view = None;
            self.notice = Some("配对邀请已失效或被取消。".to_owned());
        }
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
        // 二维码在屏时低频轮询会话状态（3 秒节流），这样手机扫码后无需手动刷新。
        if self.pairing_view.is_some() {
            let now = ui.ctx().input(|input| input.time);
            if now - self.pairing_polled_at >= 3.0 {
                self.pairing_polled_at = now;
                actions.push(MeshAction::mesh("mesh.pairing.status", json!({})));
            }
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
            egui::Frame::new()
                .fill(native_palette().surface_alt)
                .stroke(egui::Stroke::new(1.0, native_palette().border))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(12, 10))
                .show(ui, |ui| {
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

        // ── 配对（统一设备配对：手机扫码连接本机） ────────────────────────
        ui.add_space(8.0);
        ui.label(egui::RichText::new("配对").strong());
        ui.horizontal_wrapped(|ui| {
            if ui.button("连接手机").clicked() {
                actions.push(MeshAction::mesh("mesh.pairing.start", json!({})));
            }
            if ui.button("刷新").clicked() {
                actions.push(MeshAction::mesh("mesh.snapshot", json!({})));
                actions.push(MeshAction::channel("channel.list", json!({})));
            }
        });

        if let Some(view) = self.pairing_view.clone() {
            let mut copy_invitation: Option<String> = None;
            let mut cancel_pairing = false;
            egui::Frame::new()
                .fill(native_palette().surface_alt)
                .stroke(egui::Stroke::new(1.0, native_palette().border))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(12, 10))
                .show(ui, |ui| {
                    ui.label(egui::RichText::new(format!("用手机扫码连接「{}」", view.device_name)).strong());
                    show_qr_code(ui, &view);
                    ui.horizontal_wrapped(|ui| {
                        ui.weak(format!("设备名称：{}", view.device_name));
                        if !view.node_id.is_empty() {
                            ui.weak(format!("本机 node {}", view.node_id));
                        }
                    });
                    ui.weak(format!("局域网地址：{}", view.endpoint));
                    ui.weak(format!("配对有效期至 {}", pairing_expiry_label(view.expires_at, view.ttl_ms)));
                    if !view.tls_pin.is_empty() {
                        ui.weak(format!("证书指纹（应与手机端显示一致）：{}", view.tls_pin));
                    }
                    if !view.security_note.is_empty() {
                        ui.colored_label(native_palette().warning, format!("安全说明：{}", view.security_note));
                    }
                    ui.horizontal_wrapped(|ui| {
                        if ui.button("复制配对邀请").clicked() {
                            copy_invitation = Some(view.invitation.clone());
                        }
                        if ui.button("取消").clicked() {
                            cancel_pairing = true;
                        }
                    });
                });
            if let Some(invitation) = copy_invitation {
                ui.ctx().copy_text(invitation);
                self.notice = Some("配对邀请已复制，可粘贴给手机端导入。".to_owned());
            }
            if cancel_pairing {
                actions.push(MeshAction::mesh("mesh.pairing.cancel", json!({})));
                self.pairing_view = None;
                self.notice = Some("已取消配对邀请。".to_owned());
            }
        } else if let Some(pairing) = self.pairing.clone() {
            if pairing.active {
                // 例如应用重启后 Core 仍有进行中的会话，但本窗口没有 invitation/二维码内容。
                ui.horizontal_wrapped(|ui| {
                    ui.colored_label(native_palette().warning, "配对邀请进行中（本窗口未持有二维码，需重新发起才能扫码）。");
                    if let Some(session_id) = &pairing.session_id {
                        ui.weak(format!("会话 {session_id}"));
                    }
                    if let Some(peer) = &pairing.peer_node_id {
                        ui.weak(format!("对端 {peer}"));
                    }
                    if let Some(expires_at) = pairing.expires_at {
                        ui.weak(format!("有效期至 {}", format_time(expires_at)));
                    }
                    if ui.button("取消邀请").clicked() {
                        actions.push(MeshAction::mesh("mesh.pairing.cancel", json!({})));
                    }
                });
            }
        }

        if let Some(consumer) = self.pairing.as_ref().and_then(|pairing| pairing.consumed_by.as_ref()) {
            ui.horizontal_wrapped(|ui| {
                ui.colored_label(native_palette().success, format!("手机已连接：{}", consumer.name));
                if !consumer.node_id.is_empty() {
                    ui.weak(format!("node {}", consumer.node_id));
                }
                if !consumer.device_id.is_empty() {
                    ui.weak(format!("device {}", consumer.device_id));
                }
            });
        } else if self.pairing_view.is_none() && !self.pairing.as_ref().map(|pairing| pairing.active).unwrap_or(false) {
            ui.weak("点击「连接手机」生成二维码，手机扫码即可连接本机。");
        }
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
            egui::Frame::new()
                .fill(native_palette().surface_alt)
                .stroke(egui::Stroke::new(1.0, native_palette().border))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(12, 10))
                .show(ui, |ui| {
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
    use super::{
        MeshUi, pairing_expiry_label, parse_approvals, parse_channels, parse_pairing_status,
        parse_pairing_view, parse_peers, parse_status,
    };
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
        // 旧 worker 的 snapshot 没有 pairing 键 → 静默降级为 None。
        assert!(parse_pairing_status(&value).is_none());
        assert!(parse_pairing_status(&json!({ "pairing": null })).is_none());
        assert!(parse_pairing_view(&value).is_none());
    }

    #[test]
    fn parses_pairing_start_result() {
        let invitation = "{\"protocol\":\"cetamesh\",\"version\":1,\"token\":\"secret-token\"}";
        let value = json!({
            "sessionId": "pair_1a2b3c4d5e6f7788",
            "invitation": invitation,
            "qr": { "size": 3, "rows": ["101", "011", "110"] },
            "deviceName": "CetaMesh Desktop",
            "nodeId": "node_abcd",
            "endpoint": "https://192.168.1.23:49731",
            "expiresAt": 1791500000000u64,
            "ttlMs": 300000u64,
            "tlsPin": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "securityNote": "配对邀请 5 分钟内有效且只能使用一次；仅接受证书指纹匹配的手机；请核对手机屏幕上显示的设备名。"
        });
        let view = parse_pairing_view(&value).expect("pairing view");
        assert_eq!(view.session_id, "pair_1a2b3c4d5e6f7788");
        assert_eq!(view.invitation, invitation);
        assert!(view.invitation.contains("secret-token"), "invitation is copied verbatim, never rendered");
        assert_eq!(view.qr_size, 3);
        assert_eq!(view.qr_rows, vec!["101".to_string(), "011".to_string(), "110".to_string()]);
        assert_eq!(view.device_name, "CetaMesh Desktop");
        assert_eq!(view.node_id, "node_abcd");
        assert_eq!(view.endpoint, "https://192.168.1.23:49731");
        assert_eq!(view.expires_at, 1_791_500_000_000);
        assert_eq!(view.ttl_ms, 300_000);
        assert_eq!(view.tls_pin.len(), 64);
        assert!(view.security_note.contains("只能使用一次"));
        // snapshot 结果不能被误认成 start 结果。
        assert!(parse_pairing_view(&json!({ "status": { "nodeId": "node_x" } })).is_none());
    }

    #[test]
    fn parses_snapshot_pairing_consumed_by_and_clears_qr() {
        let started = json!({
            "sessionId": "pair_1a2b3c4d5e6f7788",
            "invitation": "{\"protocol\":\"cetamesh\",\"version\":1}",
            "qr": { "size": 2, "rows": ["10", "01"] },
            "deviceName": "CetaMesh Desktop",
            "expiresAt": 1791500000000u64
        });
        let snapshot = json!({
            "status": { "nodeId": "node_desktop", "coreReady": true },
            "pairing": {
                "active": false,
                "sessionId": "pair_1a2b3c4d5e6f7788",
                "expiresAt": 1791500000000u64,
                "consumedBy": { "nodeId": "node_phone", "name": "Pixel 9", "deviceId": "dev_phone" },
                "peerNodeId": "node_phone"
            }
        });
        let pairing = parse_pairing_status(&snapshot).expect("pairing status");
        assert!(!pairing.active);
        assert_eq!(pairing.session_id.as_deref(), Some("pair_1a2b3c4d5e6f7788"));
        assert_eq!(pairing.expires_at, Some(1_791_500_000_000));
        let consumed = pairing.consumed_by.expect("consumedBy");
        assert_eq!(consumed.name, "Pixel 9");
        assert_eq!(consumed.device_id, "dev_phone");
        assert_eq!(pairing.peer_node_id.as_deref(), Some("node_phone"));

        // 完整流程：start → 二维码在屏；snapshot 报告 consumedBy → 二维码收起 + 成功提示。
        let mut ui = MeshUi::default();
        assert!(!ui.apply(&started));
        assert!(ui.pairing_view.is_some());
        assert_eq!(ui.pairing.as_ref().map(|p| p.active), Some(true));
        assert!(!ui.apply(&snapshot));
        assert!(ui.pairing_view.is_none());
        let notice = ui.notice.clone().unwrap_or_default();
        assert!(notice.contains("手机已连接") && notice.contains("Pixel 9"), "notice was {notice}");

        // 取消结果清空会话并触发一次快照刷新。
        let mut ui = MeshUi::default();
        ui.apply(&started);
        assert!(ui.apply(&json!({ "cancelled": true })));
        assert!(ui.pairing_view.is_none());
        assert!(ui.pairing.is_none());
    }

    #[test]
    fn pairing_start_without_qr_still_yields_copyable_invitation() {
        let value = json!({ "sessionId": "pair_ff", "invitation": "{\"protocol\":\"cetamesh\"}" });
        let view = parse_pairing_view(&value).expect("pairing view");
        assert_eq!(view.qr_size, 0);
        assert!(view.qr_rows.is_empty());
        assert_eq!(view.expires_at, 0);
        assert_eq!(pairing_expiry_label(0, 0), "—");
        assert_eq!(pairing_expiry_label(0, 300_000), "5 分钟内有效");
        assert_eq!(pairing_expiry_label(1, 0), "1970-01-01 00:00（已过期）");
    }

    #[test]
    fn renders_pairing_qr_frame_without_visible_token() {
        use eframe::egui;

        fn collect_text(shape: &egui::Shape, out: &mut String) {
            match shape {
                egui::Shape::Text(text) => out.push_str(text.galley.text()),
                egui::Shape::Vec(shapes) => {
                    for shape in shapes {
                        collect_text(shape, out);
                    }
                }
                _ => {}
            }
        }

        /// 统计纯黑实心矩形：即二维码模块（白底静默区单独一个白色矩形）。
        fn count_black_modules(shape: &egui::Shape) -> u32 {
            match shape {
                egui::Shape::Rect(rect) => u32::from(rect.fill == egui::Color32::BLACK),
                egui::Shape::Vec(shapes) => shapes.iter().map(count_black_modules).sum(),
                _ => 0,
            }
        }

        let ctx = egui::Context::default();
        let mut mesh = MeshUi::default();
        mesh.apply(&json!({
            "sessionId": "pair_1a2b3c4d",
            "invitation": "{\"protocol\":\"cetamesh\",\"token\":\"secret-token\"}",
            "qr": { "size": 3, "rows": ["101", "011", "110"] },
            "deviceName": "CetaMesh Desktop",
            "nodeId": "node_abcd",
            "endpoint": "https://192.168.1.23:49731",
            "expiresAt": 0u64,
            "ttlMs": 300_000u64,
            "securityNote": "只能使用一次。"
        }));
        let mut methods: Vec<String> = Vec::new();
        for _ in 0..2 {
            let output = ctx.run_ui(egui::RawInput::default(), |ui| {
                let actions = mesh.show(ui);
                methods.extend(actions.into_iter().map(|action| action.method.to_owned()));
            });
            let mut text = String::new();
            let mut dark_modules = 0u32;
            for clipped in &output.shapes {
                collect_text(&clipped.shape, &mut text);
                dark_modules += count_black_modules(&clipped.shape);
            }
            output.drop_without_applying_deltas();
            assert_eq!(dark_modules, 6, "3x3 测试矩阵有 6 个暗模块，必须逐个画成黑色实心矩形");
            assert!(text.contains("复制配对邀请"), "copy button must be offered");
            assert!(text.contains("设备名称：CetaMesh Desktop"));
            assert!(text.contains("192.168.1.23"), "endpoint shown: {text}");
            assert!(!text.contains("secret-token"), "invitation token must never be rendered as text");
            assert!(!text.contains("pair_1a2b3c4d"), "session id must not leak into visible text");
        }
        // 二维码在屏时按 3 秒节流轮询会话状态；第一帧即触发一次。
        assert!(methods.iter().filter(|method| method.as_str() == "mesh.pairing.status").count() == 1, "{methods:?}");
        assert!(methods.iter().any(|method| method == "mesh.snapshot"));
        assert!(mesh.pairing_view.is_some());
    }
}
