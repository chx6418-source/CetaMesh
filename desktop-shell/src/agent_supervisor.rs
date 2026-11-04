//! Headless Core-owned execution. A root exit is never a Job-empty receipt.
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::Path, ptr, thread, time::Duration};
use windows_sys::Win32::{Foundation::{CloseHandle, DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE, DUPLICATE_SAME_ACCESS},
    System::{Console::{GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE},
    JobObjects::{CreateJobObjectW, AssignProcessToJobObject, SetInformationJobObject, QueryInformationJobObject,
        TerminateJobObject, JobObjectExtendedLimitInformation, JobObjectBasicAccountingInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
    Threading::{CreateProcessW, GetCurrentProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
        GetExitCodeProcess, CREATE_SUSPENDED, CREATE_NO_WINDOW, STARTF_USESTDHANDLES, STARTUPINFOW, PROCESS_INFORMATION}}};

const SCHEMA: &str = "CETAMESH_AGENT_SUPERVISOR_V1";
struct Handle(HANDLE);
impl Drop for Handle { fn drop(&mut self) { if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE { unsafe { CloseHandle(self.0); } } } }
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn quoted(value: &str) -> String {
    let mut output=String::from("\""); let mut slashes=0;
    for ch in value.chars() {
        if ch=='\\' { slashes+=1; continue; }
        if ch=='"' { output.push_str(&"\\".repeat(slashes*2+1)); output.push(ch); }
        else { output.push_str(&"\\".repeat(slashes)); output.push(ch); }
        slashes=0;
    }
    output.push_str(&"\\".repeat(slashes*2)); output.push('"'); output
}
fn hex(value: &str) -> bool { value.len()==64 && value.bytes().all(|v|v.is_ascii_hexdigit() && !v.is_ascii_uppercase()) }
fn read_json(file: &Path, max: u64) -> Result<serde_json::Value,&'static str> {
    let mut bytes=Vec::new(); fs::File::open(file).map_err(|_|"AGENT_SUPERVISOR_CONFIG_INVALID")?
        .take(max+1).read_to_end(&mut bytes).map_err(|_|"AGENT_SUPERVISOR_CONFIG_INVALID")?;
    if bytes.len() as u64 > max { return Err("AGENT_SUPERVISOR_CONFIG_INVALID"); }
    serde_json::from_slice(&bytes).map_err(|_|"AGENT_SUPERVISOR_CONFIG_INVALID")
}
fn duplicate_std(kind: u32) -> Result<Handle,&'static str> {
    let current=unsafe {GetCurrentProcess()}; let source=unsafe {GetStdHandle(kind)};
    if source.is_null() || source==INVALID_HANDLE_VALUE {return Err("AGENT_SUPERVISOR_STDIO_INVALID");}
    let mut cloned=ptr::null_mut();
    if unsafe {DuplicateHandle(current,source,current,&mut cloned,0,1,DUPLICATE_SAME_ACCESS)}==0 {return Err("AGENT_SUPERVISOR_STDIO_INVALID");}
    Ok(Handle(cloned))
}
fn start_suspended(executable: &str, args: &[String], cwd: &str, job: HANDLE) -> Result<Handle,&'static str> {
    let input=duplicate_std(STD_INPUT_HANDLE)?; let output=duplicate_std(STD_OUTPUT_HANDLE)?; let error=duplicate_std(STD_ERROR_HANDLE)?;
    let mut startup=STARTUPINFOW::default(); startup.cb=std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags=STARTF_USESTDHANDLES; startup.hStdInput=input.0; startup.hStdOutput=output.0; startup.hStdError=error.0;
    let executable_w=wide(executable); let cwd_w=wide(cwd);
    let command=std::iter::once(executable).chain(args.iter().map(String::as_str)).map(quoted).collect::<Vec<_>>().join(" ");
    let mut command_w=wide(&command); if command_w.len()>32767 {return Err("AGENT_SUPERVISOR_CONFIG_INVALID");}
    let mut info=PROCESS_INFORMATION::default();
    if unsafe {CreateProcessW(executable_w.as_ptr(),command_w.as_mut_ptr(),ptr::null(),ptr::null(),1,
        CREATE_SUSPENDED|CREATE_NO_WINDOW,ptr::null(),cwd_w.as_ptr(),&startup,&mut info)}==0 {return Err("AGENT_SUPERVISOR_LAUNCH_FAILED");}
    let process=Handle(info.hProcess); let thread_handle=Handle(info.hThread);
    // Nothing from this process can execute before ownership is attached.
    if unsafe {AssignProcessToJobObject(job,process.0)}==0 {
        unsafe {TerminateProcess(process.0,78);WaitForSingleObject(process.0,5000);}
        return Err("AGENT_SUPERVISOR_ASSIGN_FAILED");
    }
    if unsafe {ResumeThread(thread_handle.0)}==u32::MAX {return Err("AGENT_SUPERVISOR_RESUME_FAILED");}
    Ok(process)
}
pub fn run(config_file: &Path) -> Result<u32,&'static str> {
    if !config_file.is_absolute() || config_file.file_name().and_then(|v|v.to_str())!=Some("launch.json") {return Err("AGENT_SUPERVISOR_CONFIG_INVALID");}
    let directory=config_file.parent().ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")?;
    let nonce=directory.file_name().and_then(|v|v.to_str()).ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")?;
    if !hex(nonce) {return Err("AGENT_SUPERVISOR_CONFIG_INVALID");}
    // A native invocation is single-use, even if its config path is replayed.
    let _claim=OpenOptions::new().write(true).create_new(true).open(directory.join("claimed"))
        .map_err(|_|"AGENT_SUPERVISOR_ALREADY_CLAIMED")?;
    let config=read_json(config_file,65536)?;
    if config["schema"].as_str()!=Some(SCHEMA) || config["nonce"].as_str()!=Some(nonce) {return Err("AGENT_SUPERVISOR_CONFIG_INVALID");}
    let binding=config["binding"].as_str().filter(|v|hex(v)).ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")?;
    let executable=config["executable"].as_str().ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")?;
    let cwd=config["cwd"].as_str().ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")?;
    let args=config["args"].as_array().ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")?.iter()
        .map(|v|v.as_str().map(String::from).ok_or("AGENT_SUPERVISOR_CONFIG_INVALID")).collect::<Result<Vec<_>,_>>()?;
    if !Path::new(executable).is_absolute() || !Path::new(cwd).is_absolute()
        || std::iter::once(executable).chain(std::iter::once(cwd)).chain(args.iter().map(String::as_str)).any(|v|v.contains('\0')) {return Err("AGENT_SUPERVISOR_CONFIG_INVALID");}
    let job=Handle(unsafe {CreateJobObjectW(ptr::null(),ptr::null())});
    if job.0.is_null() {return Err("AGENT_SUPERVISOR_JOB_FAILED");}
    let mut limits=JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {SetInformationJobObject(job.0,JobObjectExtendedLimitInformation,&limits as *const _ as *const _,std::mem::size_of_val(&limits) as u32)}==0 {return Err("AGENT_SUPERVISOR_JOB_FAILED");}
    let process=start_suspended(executable,&args,cwd,job.0)?;
    let mut stopped=false;
    loop {
        let control_path=directory.join("control.json");
        if !stopped && control_path.exists() {
            let control=read_json(&control_path,4096)?;
            if control["schema"].as_str()!=Some(SCHEMA)||control["nonce"].as_str()!=Some(nonce)||control["action"].as_str()!=Some("stop") {return Err("AGENT_SUPERVISOR_CONTROL_INVALID");}
            if unsafe {TerminateJobObject(job.0,130)}==0 {return Err("AGENT_SUPERVISOR_STOP_UNCONFIRMED");} stopped=true;
        }
        let mut accounting=JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {QueryInformationJobObject(job.0,JobObjectBasicAccountingInformation,&mut accounting as *mut _ as *mut _,std::mem::size_of_val(&accounting) as u32,ptr::null_mut())}==0 {return Err("AGENT_SUPERVISOR_STOP_UNCONFIRMED");}
        if accounting.ActiveProcesses==0 {break;}
        thread::sleep(Duration::from_millis(20));
    }
    let mut exit_code=0;
    if unsafe {GetExitCodeProcess(process.0,&mut exit_code)}==0 {return Err("AGENT_SUPERVISOR_EXIT_UNCONFIRMED");}
    let receipt=serde_json::json!({"schema":SCHEMA,"nonce":nonce,"binding":binding,"state":"job-empty","exitCode":exit_code});
    let temp=directory.join("receipt.tmp");
    let mut file=OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_|"AGENT_SUPERVISOR_RECEIPT_FAILED")?;
    file.write_all(receipt.to_string().as_bytes()).map_err(|_|"AGENT_SUPERVISOR_RECEIPT_FAILED")?;
    file.sync_all().map_err(|_|"AGENT_SUPERVISOR_RECEIPT_FAILED")?;drop(file);
    fs::rename(temp,directory.join("receipt.json")).map_err(|_|"AGENT_SUPERVISOR_RECEIPT_FAILED")?;
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn command_line_quotes_backslashes_and_quotes() {
        assert_eq!(quoted("plain"),"\"plain\"");
        assert_eq!(quoted("a b\\"),"\"a b\\\\\"");
        assert_eq!(quoted("a\\\"b"),"\"a\\\\\\\"b\"");
    }
    #[test] fn assignment_failure_never_resumes_the_target() {
        let root=std::env::temp_dir().join(format!("cetamesh-assign-fail-{}",std::process::id()));
        fs::create_dir_all(&root).unwrap();let marker=root.join("must-not-exist.txt");
        let powershell=Path::new(&std::env::var("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let args=vec!["-NoProfile".into(),"-NonInteractive".into(),"-Command".into(),format!("New-Item -LiteralPath '{}' -ItemType File",marker.display())];
        assert!(matches!(start_suspended(powershell.to_str().unwrap(),&args,root.to_str().unwrap(),ptr::null_mut()),Err("AGENT_SUPERVISOR_ASSIGN_FAILED")));
        assert!(!marker.exists());fs::remove_dir(&root).unwrap();
    }
}
