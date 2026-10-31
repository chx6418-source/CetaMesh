//! Shell-side diagnostic adapter. It reuses the supervised Core RPC and the
//! release configuration; it is not another task/log/permission subsystem.
//! A failed Core must not take away the local report or official feedback link.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64,Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde_json::{Value, json};
use crate::ipc_client::IpcClient;
use crate::supervisor::{Status, Supervisor};

const MAX_BYTES: usize = 64 * 1024;
const MAX_REPORTS: usize = 20;
const MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

pub struct NativeDiagnostics {
    directory: PathBuf,
    feedback: Option<String>,
    latest: Mutex<Option<Value>>,
    checking: Mutex<()>,
    generation:AtomicU64,
}

pub fn valid_report_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i,b)| {
        if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

fn new_id() -> String {
    let mut random = [0_u8;16];
    getrandom::fill(&mut random).expect("OS randomness required for report identity");
    random[6] = (random[6] & 15) | 64;
    random[8] = (random[8] & 63) | 128;
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn iso_time(now: SystemTime) -> String {
    let seconds = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = seconds / 86400;
    let z = days as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2)/153;
    let day = doy - (153*mp+2)/5 + 1;
    let month = mp + if mp < 10 {3} else {-9};
    let year = y + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", seconds/3600%24,seconds/60%60,seconds%60)
}

fn metadata(value: &Value, max: usize) -> Value {
    value.as_str().filter(|text| !text.is_empty() && text.len() <= max
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b)))
        .map(|s| Value::String(s.to_owned())).unwrap_or(Value::Null)
}

fn timestamp(value:&Value)->Value {
    value.as_str().filter(|s|s.len()>=20&&s.len()<=32&&s.contains('T')&&s.ends_with('Z')
        &&s.bytes().all(|b|b.is_ascii_digit()||b"TZ:-.".contains(&b))).map(|s|json!(s)).unwrap_or(Value::Null)
}

/// Fixed code-based copy is used on the shell fallback. Arbitrary child stderr,
/// config values, paths, chats and model messages have no route into a report.
fn check(id: &str, status: &str, code: &str, timed_out: bool, ms: u128) -> Value {
    let (reason, remediation) = match code {
        "STARTUP_CHECKS_PENDING" => ("正在等待 Core 完成有界启动检查。", "等待检查完成；超时后可重新检查。"),
        "CORE_RPC_UNAVAILABLE" => ("Core 的已认证 RPC 无法响应。", "保留诊断报告，检查 Core 安装与安全软件状态；不要恢复被隔离文件。"),
        "CORE_RPC_TIMEOUT" => ("等待 Core RPC 响应超时。", "稍后重新检查；不要重复执行结果未知的任务。"),
        "CORE_PROCESS_UNAVAILABLE" => ("Core 未正常运行，正常工作模式已阻止。", "检查安装文件与启动日志，保留原始数据；修复后重启应用并重新检查。"),
        "SHELL_PRESENTATION_UNAVAILABLE" => ("原生界面未能创建，正常工作模式已阻止。", "检查受信任的 UI 资源和 Microsoft WebView2 Runtime；保留诊断报告，不运行隔离产物。"),
        "CORE_REPORT_INVALID" => ("Core 诊断契约无效或未得到检查结果。", "使用同一候选版本的 Shell 与 Core，导出报告反馈开发者。"),
        "CORE_VERSION_MISMATCH" => ("Desktop Shell 与 Core 产品版本不一致。", "安装来自同一候选构建的 Shell、Core 和 UI；不要混用版本。"),
        "CORE_RPC_VERIFIED" => ("原生 UI 已完成经过身份验证的 Core RPC 与协议握手。", "无需处理。"),
        "CORE_VERSION_VERIFIED" => ("Desktop Shell 与 Core 产品版本一致。", "无需处理。"),
        "REPORT_STORE_UNAVAILABLE" => ("本机诊断报告无法持久化。", "检查本机可用空间和诊断目录权限，当前报告仍可查看与复制。"),
        "CORE_IPC_HANDSHAKE_FAILED" => ("Core IPC 版本或握手契约不兼容。", "使用同一候选版本的 Shell 与 Core，导出报告反馈开发者。"),
        "CHECK_OK" | "STORAGE_VALID" | "DATA_IPC_VALID" => ("实际只读检查已通过。", "无需处理。"),
        "CHECK_FAILED" => ("该基础服务未通过只读契约检查。", "保留原始数据，导出诊断并反馈开发者；修复后重新检查。"),
        "CHECK_TIMEOUT" | "CHECK_BUDGET_EXHAUSTED" => ("检查超时或已用尽本次总检查时间。", "稍后重新检查；超时不代表操作从未执行。"),
        "STORAGE_INVALID" => ("关键存储无法安全读取，正常执行已阻止。", "不要删除或初始化原始数据。保留备份并反馈开发者，修复后从托盘菜单显式重启 Core。"),
        "CORE_COMPOSITION_FAILED" => ("Core 基础服务未能安全初始化。", "保留原始数据，导出诊断报告；修复后从托盘菜单显式重启 Core。"),
        "RECONCILIATION_REQUIRED" => ("存在需要核对的执行状态或未确认副作用。", "进入对应任务核对真实状态，确认前不要重复派发。"),
        "LOCAL_LIFECYCLE_ONLY" => ("本次仅核对本地生命周期，未创建会话或执行任务。", "使用该功能前还会重新检查实际能力与授权。"),
        "SESSION_PROBE_NOT_RUN" | "MODEL_REQUEST_NOT_RUN" => ("未创建 Agent 会话或发起付费模型请求。", "按需配置并授权后使用；本次启动检查不会执行模型请求。"),
        "MCP_STOPPED" | "MCP_NOT_CONFIGURED" => ("MCP 未配置或未运行，该功能暂不可用。", "在插件中心检查 MCP 配置与连接，主程序仍可使用。"),
        "MCP_DISCOVERY_ONLY" => ("只读核对 MCP 注册与发现状态，未执行工具。", "工具调用时仍会检查具体权限与执行状态。"),
        "REMOTE_API_NOT_RUN" => ("未执行远程平台写入或额外联网请求。", "在对应连接页面按需检查权限和实际服务状态。"),
        "QQ_STOPPED" | "QQ_NOT_CONFIGURED" => ("QQ 或仿生聊天未就绪，该功能暂不可用。", "在插件中心检查账号、网关和 Agent 状态；启动检查不会自动发送消息。"),
        "QQ_READ_ONLY_READY" => ("QQ 只读连接与身份查询完成，未发送消息。", "消息发送仍须通过目标白名单与能力审批。"),
        "BROWSER_EXECUTION_NOT_RUN" => ("未执行浏览器自动化操作。", "需要时在授权范围内启动浏览器工具。"),
        "ENVIRONMENT_NOT_RUN" => ("未创建虚拟机或执行环境测试。", "环境验收需镜像、资源和独立授权，当前不标记为通过。"),
        "DATA_IPC_INVALID" => ("Core 数据 IPC 未通过实际通信契约检查。", "停止正常执行，导出诊断并检查当前候选构建；不要重复未知副作用。"),
        _ => ("检查结果由 Core 的受控诊断契约提供。", "查看该模块的错误代码；修复后重新检查。"),
    };
    json!({"id":id,"stage":"transport","status":status,"code":code,"reason":reason,"remediation":remediation,"timedOut":timed_out,"durationMs":ms.min(30_000)})
}

fn trusted_feedback(config: &Value) -> Option<String> {
    let base = config.pointer("/feedback/baseUrl").and_then(Value::as_str)
        .or_else(|| config.pointer("/productLinks/officialUrls/website").and_then(Value::as_str))
        .or_else(|| config.get("website").and_then(Value::as_str))?;
    let path = config.pointer("/productLinks/paths/bug").and_then(Value::as_str)
        .or_else(|| config.pointer("/feedback/paths/bug").and_then(Value::as_str))?;
    if base.len() > 600 || !path.starts_with('/') || path.starts_with("//") || path.len() > 200
        || path.chars().any(|c| c.is_whitespace() || c.is_control() || "?#\\".contains(c)) { return None; }
    let mut url = url::Url::parse(base).ok()?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return None; }
    url.set_path(&format!("{}{}",url.path().trim_end_matches('/'),path));
    url.set_query(None); url.set_fragment(None);
    crate::external_link::is_openable_url(url.as_str()).then(||url.to_string())
}

fn bounded_read(file: &Path) -> Option<Value> {
    let meta=fs::symlink_metadata(file).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_BYTES as u64 { return None; }
    let mut bytes=Vec::new();
    fs::File::open(file).ok()?.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len()>MAX_BYTES {return None;}
    serde_json::from_slice(&bytes).ok()
}

fn directory_safe(directory:&Path)->bool {
    directory.ancestors().all(|p|match fs::symlink_metadata(p){
        Ok(meta)=>meta.is_dir()&&!meta.file_type().is_symlink(),
        Err(e)=>e.kind()==std::io::ErrorKind::NotFound,
    })
}

fn config_path() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("WHALEBRIDGE_REPO_ROOT") {return PathBuf::from(root).join("release-config.json");}
    crate::current_exe_dir().join("resources").join("release-config.json")
}

fn base_report(trigger: &str, code: &str, pending: bool) -> Value {
    // Disk metadata is untrusted too; only fixed report origins may be exported.
    let trigger=match trigger {"startup"=>"startup","manual"=>"manual",_=>"runtime"};
    let build=bounded_read(&crate::current_exe_dir().join("build-info.json")).unwrap_or(Value::Null);
    json!({"schemaVersion":1,"id":new_id(),"generatedAt":iso_time(SystemTime::now()),"trigger":trigger,"status":"BLOCKED",
        "product":shell_product(&build),
        "checks":[check("shell.rpc","BLOCKED",code,code=="CORE_RPC_TIMEOUT",0)],"unconfirmedEffects":null,
        "feedback":{"url":null,"configured":false},"retention":{"maxReports":MAX_REPORTS,"maxAgeDays":14,"maxBytes":MAX_BYTES},
        "persisted":false,"pending":pending})
}

fn shell_product(build:&Value)->Value {
    let commit=build["commit"].as_str().filter(|s|s.len()>=7&&s.len()<=64&&s.bytes().all(|b|b.is_ascii_hexdigit()));
    json!({"version":env!("CARGO_PKG_VERSION"),"shellVersion":env!("CARGO_PKG_VERSION"),"identitySource":"shell",
        "build":{"buildId":metadata(&build["buildId"],80),"commit":commit,"buildTime":timestamp(&build["buildTime"])},
        "runtime":{"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"node":null}})
}

/// Validate before accepting a report from Core or the local history. Unknown
/// top-level fields are discarded, never copied into an export.
fn project_report(input:&Value, trigger:&str) -> Option<Value> {
    if input["schemaVersion"]!=1 || !valid_report_id(input["id"].as_str()?)
        || !matches!(input["status"].as_str()?,"PASS"|"DEGRADED"|"BLOCKED") {return None;}
    let source=input["checks"].as_array()?;
    if source.is_empty() || source.len()>64 {return None;}
    let mut report=base_report(trigger,"CORE_REPORT_INVALID",false);
    report["id"]=input["id"].clone();
    let generated=input["generatedAt"].as_str()?;
    if generated.len()>32 || !generated.bytes().all(|b|b.is_ascii_digit()||b"TtZz:-.+".contains(&b)) {return None;}
    report["generatedAt"]=Value::String(generated.to_owned());
    let mut rows=Vec::new();
    for row in source {
        let code=metadata(&row["code"],64); let id=metadata(&row["id"],80);
        let status=row["status"].as_str()?;
        if code.is_null()||id.is_null()||!matches!(status,"PASS"|"DEGRADED"|"BLOCKED"|"NOT_RUN") {return None;}
        let mut projected=check(id.as_str()?,status,code.as_str()?,row["timedOut"]==true,row["durationMs"].as_u64().unwrap_or(0) as u128);
        if matches!(row["stage"].as_str(),Some("storage"|"core"|"extensions"|"transport")) {projected["stage"]=row["stage"].clone();}
        // Core emits deterministic allowlisted copy. Do not copy messages from
        // unknown fields or serialized error objects; fixed code copy remains.
        rows.push(projected);
    }
    report["checks"]=Value::Array(rows);
    let checks=report["checks"].as_array()?;
    if (checks.iter().any(|r|r["status"]=="BLOCKED") && input["status"]!="BLOCKED")
        || (checks.iter().any(|r|r["status"]=="DEGRADED") && input["status"]=="PASS") {return None;}
    report["status"]=input["status"].clone();
    report["product"]["identitySource"]=json!(if input["product"]["identitySource"]=="shell"{"shell"}else{"core"});
    report["unconfirmedEffects"]=if input["unconfirmedEffects"].is_boolean(){input["unconfirmedEffects"].clone()}else{Value::Null};
    for field in ["version","shellVersion"] {report["product"][field]=metadata(&input["product"][field],80);}
    report["product"]["shellVersion"]=json!(env!("CARGO_PKG_VERSION"));
    for field in ["buildId","commit"] {report["product"]["build"][field]=metadata(&input["product"]["build"][field],80);}
    report["product"]["build"]["buildTime"]=timestamp(&input["product"]["build"]["buildTime"]);
    for field in ["platform","arch","node","osVersion"] {report["product"]["runtime"][field]=metadata(&input["product"]["runtime"][field],80);}
    report["summary"]=json!(if report["status"]=="BLOCKED"{"核心通信、安全或数据检查未通过，正常工作模式已阻止。"}else if report["status"]=="DEGRADED"{"核心可用，部分可选功能暂不可用；请查看检查项。"}else{"核心只读检查通过；真实执行仍按各功能的授权与状态决定。"});
    Some(report)
}

impl NativeDiagnostics {
    pub fn new(data_dir:&Path) -> Self {
        let feedback=bounded_read(&config_path()).and_then(|v|trusted_feedback(&v));
        Self {directory:data_dir.join("state").join("diagnostics-shell"),feedback,latest:Mutex::new(None),checking:Mutex::new(()),generation:AtomicU64::new(0)}
    }
    pub fn allows_work(&self) -> bool {
        self.latest.lock().ok().and_then(|r|r.as_ref().map(|v|matches!(v["status"].as_str(),Some("PASS"|"DEGRADED")))).unwrap_or(false)
    }
    pub fn invalidate(&self) {
        if let Ok(mut current)=self.latest.lock(){self.generation.fetch_add(1,Ordering::AcqRel);*current=None;}
    }
    pub fn generation(&self)->u64 {self.generation.load(Ordering::Acquire)}
    pub fn pending_state(&self)->Value {
        json!({"report":self.finish(base_report("runtime","STARTUP_CHECKS_PENDING",true),false),"coreAvailable":false,"nativeGeneration":self.generation()})
    }
    fn finish_for_generation(&self,report:Value,persist:bool,generation:u64)->Value {self.finish_inner(report,persist,Some(generation))}
    fn finish(&self,report:Value,persist:bool)->Value {
        self.finish_inner(report,persist,None)
    }
    fn finish_inner(&self,mut report:Value,persist:bool,generation:Option<u64>)->Value {
        // Generation validation and cache publication share the same lock as
        // invalidate(). A late reply from an old Core cannot reopen the gate.
        let mut latest=self.latest.lock().ok();
        if generation.is_some_and(|expected|expected!=self.generation()) {
            let mut pending=base_report("runtime","STARTUP_CHECKS_PENDING",true);
            pending["feedback"]=json!({"url":self.feedback,"configured":self.feedback.is_some()});
            return pending;
        }
        report["feedback"]=json!({"url":self.feedback,"configured":self.feedback.is_some()});
        report["summary"]=json!(format!("CetaMesh {} · {} · {}",report["status"].as_str().unwrap_or("BLOCKED"),
            report["generatedAt"].as_str().unwrap_or(""),report["checks"].as_array().map(|v|v.len()).unwrap_or(0)));
        if persist {
            // Stable check results share one stored report; 30s health polls do
            // not churn the history or evict the original failure evidence.
            if let Some(current)=latest.as_ref().and_then(|v|v.as_ref()) {
                let stable_checks=|r:&Value|r["checks"].as_array().map(|rows|rows.iter().map(|v|json!({"id":v["id"],"status":v["status"],"code":v["code"],"timedOut":v["timedOut"]})).collect::<Vec<_>>());
                if report["trigger"]!="manual" && current["status"]==report["status"]
                    && stable_checks(&current)==stable_checks(&report) && current["product"]==report["product"]
                    && current["unconfirmedEffects"]==report["unconfirmedEffects"] {
                    return current.clone();
                }
            }
            // The shell report includes additional real transport evidence; it
            // has its own identity instead of overwriting the Core's report.
            report["id"]=json!(new_id());
            report["persisted"]=json!(true);
            if self.persist(&report).is_err(){report["persisted"]=json!(false);}
            if let Some(current)=latest.as_mut(){**current=Some(report.clone());}
        }
        report
    }
    pub fn status(&self,api:&IpcClient,supervisor:&Supervisor,manual:bool)->Value {
        let generation=self.generation();
        let _guard=match self.checking.try_lock(){Ok(g)=>g,Err(_)=>{
            let cached=self.latest.lock().ok().and_then(|v|v.clone());
            return json!({"report":cached.unwrap_or_else(||self.finish(base_report("runtime","STARTUP_CHECKS_PENDING",true),false)),"coreAvailable":supervisor.status().is_ready()&&self.allows_work(),"nativeGeneration":generation});
        }};
        let state=supervisor.status();
        if !state.is_ready(){
            let pending=matches!(state,Status::Starting|Status::Restarting{..});
            let code=if pending{"STARTUP_CHECKS_PENDING"}else if supervisor.child_pid().is_some(){
                if matches!(&state,Status::Stopped{reason,..}if reason.contains("超时")||reason.contains("timed out")){"CORE_RPC_TIMEOUT"}else{"CORE_IPC_HANDSHAKE_FAILED"}
            }else{"CORE_PROCESS_UNAVAILABLE"};
            let report=self.finish_for_generation(base_report(if manual{"manual"}else{"startup"},code,pending),!pending,generation);
            return json!({"report":report,"coreAvailable":false,"nativeGeneration":generation});
        }
        let started=std::time::Instant::now();
        let response=api.request_with_timeout(if manual{"ui.diagnostics.run"}else{"ui.diagnostics.status"},json!({}),Duration::from_secs(if manual{18}else{2}));
        if matches!(&response,Ok(value)if value.get("report")==Some(&Value::Null)) {
            return json!({"report":self.finish_for_generation(base_report("startup","STARTUP_CHECKS_PENDING",true),false,generation),"coreAvailable":true,"nativeGeneration":generation});
        }
        let (mut report,available)=match response {
            Ok(value)=>match project_report(&value["report"],if manual{"manual"}else if value["report"]["trigger"]=="startup"{"startup"}else{"runtime"}) {
                Some(report)=>(report,true),None=>(base_report("runtime","CORE_REPORT_INVALID",false),false)
            },
            Err(error)=>{
                let text=error.to_ascii_lowercase();
                let timeout=text.contains("timed out")||text.contains("timeout");
                let handshake=text.contains("protocol")||text.contains("version")||text.contains("ready event")||text.contains("invalid core ipc");
                (base_report("runtime",if timeout{"CORE_RPC_TIMEOUT"}else if handshake{"CORE_IPC_HANDSHAKE_FAILED"}else{"CORE_RPC_UNAVAILABLE"},false),false)
            }
        };
        if available {
            let version_matches=report["product"]["version"].as_str()==Some(env!("CARGO_PKG_VERSION"));
            let checks=report["checks"].as_array_mut().expect("projected checks");
            checks.retain(|r|r["id"]!="shell.rpc"&&r["id"]!="shell.version");
            checks.push(check("shell.rpc","PASS","CORE_RPC_VERIFIED",false,started.elapsed().as_millis()));
            checks.push(check("shell.version",if version_matches{"PASS"}else{"BLOCKED"},if version_matches{"CORE_VERSION_VERIFIED"}else{"CORE_VERSION_MISMATCH"},false,0));
            if !version_matches{report["status"]=json!("BLOCKED");}
        }
        let report=self.finish_for_generation(report,true,generation);
        json!({"report":report,"coreAvailable":available,"nativeGeneration":generation})
    }
    fn persist(&self,report:&Value)->Result<(),()> {
        let bytes=serde_json::to_vec_pretty(report).map_err(|_|())?;
        if bytes.len()>MAX_BYTES{return Err(());}
        if !directory_safe(&self.directory){return Err(());}
        fs::create_dir_all(&self.directory).map_err(|_|())?;
        if fs::symlink_metadata(&self.directory).map_err(|_|())?.file_type().is_symlink(){return Err(());}
        let id=report["id"].as_str().filter(|v|valid_report_id(v)).ok_or(())?;
        let final_file=self.directory.join(format!("{id}.json"));
        let temporary=self.directory.join(format!("{id}.tmp"));
        let result=(||{
            let mut file=OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_|())?;
            file.write_all(&bytes).map_err(|_|())?;file.sync_all().map_err(|_|())?;
            fs::rename(&temporary,&final_file).map_err(|_|())
        })();
        if result.is_err(){let _=fs::remove_file(&temporary);return result;}
        self.prune();Ok(())
    }
    fn files(&self)->Vec<(PathBuf,SystemTime)> {
        let mut files=Vec::new();
        if !directory_safe(&self.directory){return files;}
        if let Ok(entries)=fs::read_dir(&self.directory){for entry in entries.flatten(){
            let p=entry.path();
            if !p.file_stem().and_then(|s|s.to_str()).is_some_and(valid_report_id)||p.extension().and_then(|s|s.to_str())!=Some("json"){continue;}
            if let Ok(meta)=fs::symlink_metadata(&p){if meta.is_file()&&!meta.file_type().is_symlink(){files.push((p,meta.modified().unwrap_or(UNIX_EPOCH)));}}
        }}
        files.sort_by(|a,b|b.1.cmp(&a.1));files
    }
    fn prune(&self){for (index,(file,time)) in self.files().into_iter().enumerate(){
        if index>=MAX_REPORTS||SystemTime::now().duration_since(time).unwrap_or_default()>MAX_AGE{let _=fs::remove_file(file);}
    }}
    pub fn history(&self)->Value {
        self.prune();
        let reports:Vec<Value>=self.files().into_iter().take(MAX_REPORTS).filter_map(|(p,_)|bounded_read(&p).and_then(|v|project_report(&v,v["trigger"].as_str().unwrap_or("runtime"))))
            .map(|r|json!({"id":r["id"],"generatedAt":r["generatedAt"],"status":r["status"],"trigger":r["trigger"],"persisted":true})).collect();
        json!({"reports":reports})
    }
    pub fn read(&self,id:&str)->Result<Value,String> {
        if !valid_report_id(id){return Err("诊断报告标识无效。".into());}
        if !directory_safe(&self.directory){return Err("诊断目录无法安全读取。".into());}
        let input=bounded_read(&self.directory.join(format!("{id}.json"))).ok_or("诊断报告不可用。")?;
        let mut report=project_report(&input,input["trigger"].as_str().unwrap_or("runtime")).ok_or("诊断报告契约无效。")?;
        report["feedback"]=json!({"url":self.feedback,"configured":self.feedback.is_some()});report["persisted"]=json!(true);
        Ok(json!({"report":report}))
    }
    pub fn export(&self,id:&str)->Result<Value,String> {
        let report=self.report_for_export(id)?;
        let Some(file)=rfd::FileDialog::new().set_title("导出本机诊断报告（不会上传）")
            .set_file_name(format!("CetaMesh-diagnostics-{id}.json")).add_filter("JSON 诊断报告",&["json"]).save_file() else {
                return Ok(json!({"exported":false,"cancelled":true}));
            };
        // This is a user-selected export, never a renderer-supplied path.
        let bytes=serde_json::to_vec_pretty(&report).map_err(|_|"报告编码失败。")?;
        fs::write(file,bytes).map_err(|_|"无法导出诊断报告，请选择可写位置。")?;
        Ok(json!({"exported":true}))
    }
    fn report_for_export(&self,id:&str)->Result<Value,String> {
        if !valid_report_id(id){return Err("诊断报告标识无效。".into());}
        if let Some(report)=self.latest.lock().ok().and_then(|v|v.clone()).filter(|v|v["id"]==id) {
            return Ok(report);
        }
        Ok(self.read(id)?["report"].clone())
    }
    pub fn feedback(&self)->Value {
        let opened=self.feedback.as_ref().is_some_and(|url|crate::external_link::open_in_default_browser(url).is_ok());
        json!({"opened":opened,"url":self.feedback})
    }
}

/// Last-resort native dialog: usable even when WebView2 or the UI assets cannot
/// be created. It never needs Core, browser connectivity or an executable sample.
pub fn show_native_startup_failure(data_dir:&Path) {
    let diagnostics=NativeDiagnostics::new(data_dir);
    let report=diagnostics.finish(base_report("startup","SHELL_PRESENTATION_UNAVAILABLE",false),true);
    let url=diagnostics.feedback.as_deref().unwrap_or("官方反馈页面尚未配置。随安装包的发行配置中没有可验证的地址。");
    let description=format!("错误代码：SHELL_PRESENTATION_UNAVAILABLE\n原生窗口或 WebView2 无法创建。请检查受信任的 UI 资源与 WebView2 Runtime。\n本机诊断报告：{}（不会自动上传）\n官方反馈地址：{url}",if report["persisted"]==true{"已保存"}else{"无法保存，可在此导出"});
    let result=rfd::MessageDialog::new().set_title("CetaMesh 启动诊断")
        .set_description(description).set_buttons(rfd::MessageButtons::YesNoCancelCustom("反馈开发者".into(),"导出诊断报告".into(),"关闭".into())).show();
    match result {
        rfd::MessageDialogResult::Custom(action)if action=="反馈开发者"=>{
            if diagnostics.feedback()["opened"]!=true {let _=rfd::MessageDialog::new().set_title("反馈开发者").set_description(format!("无法打开浏览器。诊断报告保留在本机，未上传任何数据。\n{url}")).show();}
        },
        rfd::MessageDialogResult::Custom(action)if action=="导出诊断报告"=>{
            if let Some(id)=report["id"].as_str(){let _=diagnostics.export(id);}
        },_=>{}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn poisoned_disk_trigger_never_enters_display_or_export(){
        let mut report=base_report("startup","CORE_PROCESS_UNAVAILABLE",false);
        report["trigger"]=json!("PRIVATE_CHAT_TRIGGER_CANARY");
        let safe=project_report(&report,report["trigger"].as_str().unwrap()).unwrap();
        assert_eq!(safe["trigger"],"runtime");
        assert!(!safe.to_string().contains("PRIVATE_CHAT_TRIGGER_CANARY"));
    }
    #[test] fn history_summary_preserves_manual_check_origin(){
        let root=std::env::temp_dir().join(format!("cetamesh-diagnostic-{}",new_id()));
        let adapter=NativeDiagnostics::new(&root);
        adapter.finish(base_report("manual","CORE_PROCESS_UNAVAILABLE",false),true);
        assert_eq!(adapter.history()["reports"][0]["trigger"],"manual");
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn inconsistent_success_cannot_override_a_blocked_module(){
        let mut r=base_report("startup","CORE_PROCESS_UNAVAILABLE",false);
        r["status"]=json!("PASS");
        assert!(project_report(&r,"startup").is_none(),"inconsistent aggregate must fail closed");
    }
    #[test] fn current_report_can_be_exported_when_local_persistence_failed(){
        let root=std::env::temp_dir().join(format!("cetamesh-diagnostic-{}",new_id()));
        let adapter=NativeDiagnostics::new(&root);
        let r=base_report("startup","CORE_PROCESS_UNAVAILABLE",false);let id=r["id"].as_str().unwrap().to_owned();
        *adapter.latest.lock().unwrap()=Some(r);
        assert_eq!(adapter.report_for_export(&id).unwrap()["persisted"],false);
        assert!(!root.exists());
    }
    #[test] fn unconfirmed_effect_change_is_not_hidden_by_stable_health_codes(){
        let root=std::env::temp_dir().join(format!("cetamesh-diagnostic-{}",new_id()));
        let adapter=NativeDiagnostics::new(&root);
        let mut original=base_report("runtime","CORE_PROCESS_UNAVAILABLE",false);original["unconfirmedEffects"]=json!(false);
        let saved=adapter.finish(original.clone(),true);
        original["unconfirmedEffects"]=json!(true);
        let updated=adapter.finish(original,true);
        assert_eq!(updated["unconfirmedEffects"],true);
        assert_ne!(saved["id"],updated["id"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn previous_core_response_cannot_reopen_gate_after_generation_invalidation(){
        let root=std::env::temp_dir().join(format!("cetamesh-diagnostic-{}",new_id()));
        let adapter=NativeDiagnostics::new(&root);
        let captured=adapter.generation();
        let mut old=base_report("runtime","CORE_RPC_VERIFIED",false);old["status"]=json!("PASS");old["checks"][0]["status"]=json!("PASS");
        adapter.invalidate();
        let reply=adapter.finish_for_generation(old,true,captured);
        assert_eq!(reply["status"],"BLOCKED");
        assert!(!adapter.allows_work());
        assert!(!root.exists(),"stale health must not be persisted as a new valid checkpoint");
    }
    #[test] fn fixed_report_has_no_caller_error_or_secrets(){
        let r=base_report("startup","CORE_PROCESS_UNAVAILABLE",false);let text=r.to_string();
        assert_eq!(r["status"],"BLOCKED");assert_eq!(r["unconfirmedEffects"],Value::Null);
        assert!(!text.contains("C:/"));assert!(valid_report_id(r["id"].as_str().unwrap()));
    }
    #[test] fn shell_identity_remains_available_without_core_but_never_reads_user_state(){
        let p=shell_product(&json!({"buildId":"candidate-42","commit":"0123456789abcdef","buildTime":"2026-10-31T00:00:00.000Z","token":"private","path":"C:/private"}));
        assert_eq!(p["version"],env!("CARGO_PKG_VERSION"));
        assert_eq!(p["build"]["commit"],"0123456789abcdef");
        assert_eq!(p["build"]["buildTime"],"2026-10-31T00:00:00.000Z");
        assert!(!p.to_string().contains("private"));
        assert_eq!(shell_product(&Value::Null)["build"]["commit"],Value::Null);
    }
    #[test] fn projection_discards_unknown_data_and_uses_fixed_copy(){
        let mut r=base_report("startup","CORE_PROCESS_UNAVAILABLE",false);
        r["token"]=json!("private-token");r["chat"]=json!("private conversation");
        r["checks"][0]["reason"]=json!("C:/private api_key=secret");
        let p=project_report(&r,"runtime").unwrap().to_string();
        assert!(!p.contains("private"));assert!(!p.contains("secret"));
    }
    #[test] fn trusted_feedback_matches_release_config_and_rejects_unsafe_paths(){
        let config=json!({"productLinks":{"officialUrls":{"website":"https://cetamesh.com"},"paths":{"bug":"/feedback"}}});
        assert_eq!(trusted_feedback(&config),Some("https://cetamesh.com/feedback".into()));
        for path in ["//evil.test", "/feedback?token=x", "/a\\b", "https://evil.test"]{
            let mut bad=config.clone();bad["productLinks"]["paths"]["bug"]=json!(path);assert_eq!(trusted_feedback(&bad),None);
        }
        let mut bad=config;bad["productLinks"]["officialUrls"]["website"]=json!("https://user:secret@host.test");assert_eq!(trusted_feedback(&bad),None);
    }
    #[test] fn timestamp_is_real_utc_iso(){
        assert_eq!(iso_time(UNIX_EPOCH),"1970-01-01T00:00:00Z");
        assert_eq!(iso_time(UNIX_EPOCH+Duration::from_secs(1_793_404_800)),"2026-10-31T00:00:00Z");
    }
    #[test] fn report_storage_is_bounded_and_read_is_identity_only(){
        let root=std::env::temp_dir().join(format!("cetamesh-diagnostic-{}",new_id()));
        let adapter=NativeDiagnostics::new(&root);
        for _ in 0..25 {let mut r=base_report("startup","CORE_PROCESS_UNAVAILABLE",false);r["persisted"]=json!(true);adapter.persist(&r).unwrap();}
        assert_eq!(adapter.files().len(),MAX_REPORTS);
        assert!(adapter.read("../../private").is_err());
        let history=adapter.history();let id=history["reports"][0]["id"].as_str().unwrap();
        assert_eq!(adapter.read(id).unwrap()["report"]["status"],"BLOCKED");
        fs::remove_dir_all(root).unwrap();
    }
}
