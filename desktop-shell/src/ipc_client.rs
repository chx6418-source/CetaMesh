//! Synchronous client for the private Core named-pipe protocol.
//!
//! `IpcClient` is intended to be called from a worker thread (the native UI does that); every
//! connect, write, handshake, and response read is bounded by a single ten-second deadline.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::native_ui::CoreApi;

const PROTOCOL_VERSION: u64 = 1;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(40);
const IO_RETRY_DELAY: Duration = Duration::from_millis(4);
const ERROR_NO_DATA: i32 = 232;
const ERROR_PIPE_LISTENING: i32 = 536;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Core client using the pipe name supplied by the desktop shell.
///
/// The call is synchronous by design; callers must keep it off the UI/event thread.
pub struct IpcClient {
    pipe_name: String,
}

impl IpcClient {
    pub fn new(pipe_name: impl Into<String>) -> Self {
        Self {
            pipe_name: pipe_name.into(),
        }
    }

    fn request_inner(&self, method: &str, params: Value) -> Result<Value, String> {
        if method.trim().is_empty() {
            return Err("IPC method must not be empty".to_owned());
        }

        #[cfg(windows)]
        {
            request_pipe(&self.pipe_name, method, params, REQUEST_TIMEOUT)
        }
        #[cfg(not(windows))]
        {
            let _ = (method, params);
            Err("Core named-pipe IPC is only supported on Windows".to_owned())
        }
    }
}

impl CoreApi for IpcClient {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_inner(method, params)
    }
}

#[cfg(windows)]
fn request_pipe(
    pipe_name: &str,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    let mut pipe = connect_until(pipe_name, deadline)?;
    set_pipe_nonblocking(&pipe).map_err(|error| format!("configure Core pipe: {error}"))?;

    let ready = read_frame_until(&mut pipe, deadline)
        .map_err(|error| format!("read Core IPC ready event: {error}"))?;
    let ready_value: Value = serde_json::from_slice(&ready)
        .map_err(|error| format!("invalid Core IPC ready event: {error}"))?;
    validate_ready(&ready_value)?;

    let request_id = next_request_id();
    let request = json!({
        "version": PROTOCOL_VERSION,
        "id": request_id,
        "method": method,
        "params": params,
    });
    write_frame_until(&mut pipe, &request, deadline)
        .map_err(|error| format!("write Core IPC request: {error}"))?;

    let response = read_frame_until(&mut pipe, deadline)
        .map_err(|error| format!("read Core IPC response: {error}"))?;
    let response_value: Value = serde_json::from_slice(&response)
        .map_err(|error| format!("invalid Core IPC response: {error}"))?;
    validate_response(&response_value, &request_id)
}

#[cfg(windows)]
fn connect_until(pipe_name: &str, deadline: Instant) -> Result<File, String> {
    loop {
        match OpenOptions::new().read(true).write(true).open(pipe_name) {
            Ok(pipe) => return Ok(pipe),
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                sleep_until(deadline, CONNECT_RETRY_DELAY);
            }
            Err(error) => return Err(format!("connect to Core pipe: {error}")),
        }
    }
}

#[cfg(windows)]
fn read_frame_until(pipe: &mut File, deadline: Instant) -> std::io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    read_exact_until(pipe, &mut header, deadline)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "empty IPC frame",
        ));
    }
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("IPC frame exceeds {MAX_FRAME_BYTES} bytes"),
        ));
    }
    let mut payload = vec![0_u8; length];
    read_exact_until(pipe, &mut payload, deadline)?;
    Ok(payload)
}

#[cfg(windows)]
fn write_frame_until(pipe: &mut File, value: &Value, deadline: Instant) -> std::io::Result<()> {
    let frame = encode_frame(value)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidData, message))?;
    write_all_until(pipe, &frame, deadline)
}

#[cfg(windows)]
fn read_exact_until(pipe: &mut File, output: &mut [u8], deadline: Instant) -> std::io::Result<()> {
    let mut offset = 0;
    while offset < output.len() {
        if Instant::now() >= deadline {
            return Err(timeout_error());
        }
        match pipe.read(&mut output[offset..]) {
            // A PIPE_NOWAIT named pipe can produce an empty read during the brief
            // interval between CreateFile connecting and the Node accept callback
            // writing its ready frame. Poll within the request deadline instead of
            // treating that transient state as EOF.
            Ok(0) => sleep_until(deadline, IO_RETRY_DELAY),
            Ok(count) => offset += count,
            Err(error) if is_pipe_would_block(&error) => sleep_until(deadline, IO_RETRY_DELAY),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn write_all_until(pipe: &mut File, input: &[u8], deadline: Instant) -> std::io::Result<()> {
    let mut offset = 0;
    while offset < input.len() {
        if Instant::now() >= deadline {
            return Err(timeout_error());
        }
        match pipe.write(&input[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "Core pipe accepted no data",
                ));
            }
            Ok(count) => offset += count,
            Err(error) if is_pipe_would_block(&error) => sleep_until(deadline, IO_RETRY_DELAY),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_pipe_would_block(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || matches!(
            error.raw_os_error(),
            Some(ERROR_NO_DATA) | Some(ERROR_PIPE_LISTENING)
        )
}

#[cfg(windows)]
fn set_pipe_nonblocking(pipe: &File) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    unsafe extern "system" {
        fn SetNamedPipeHandleState(
            named_pipe: *mut c_void,
            mode: *const u32,
            max_collection_count: *const u32,
            collect_data_timeout: *const u32,
        ) -> i32;
    }

    const PIPE_NOWAIT: u32 = 0x0000_0001;
    let mode = PIPE_NOWAIT;
    // SAFETY: `pipe` owns a live Windows named-pipe handle. The mode points to a live local
    // `u32`, and the two optional arguments are null as permitted by the Win32 API.
    let ok = unsafe {
        SetNamedPipeHandleState(
            pipe.as_raw_handle().cast(),
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sleep_until(deadline: Instant, interval: Duration) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        thread::sleep(interval.min(remaining));
    }
}

fn timeout_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "Core IPC request timed out")
}

fn next_request_id() -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("{}-{sequence}", std::process::id())
}

/// Encode a JSON value into the protocol's four-byte little-endian length-prefixed frame.
fn encode_frame(value: &Value) -> Result<Vec<u8>, String> {
    let payload =
        serde_json::to_vec(value).map_err(|error| format!("serialize IPC JSON: {error}"))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "IPC payload length {} is outside 1..={MAX_FRAME_BYTES}",
            payload.len()
        ));
    }
    let length = u32::try_from(payload.len()).map_err(|_| "IPC payload is too large".to_owned())?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// Decode exactly one complete length-prefixed JSON frame.
#[cfg(test)]
fn decode_frame(frame: &[u8]) -> Result<Value, String> {
    if frame.len() < 4 {
        return Err("truncated IPC frame header".to_owned());
    }
    let length = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(format!("invalid IPC frame length: {length}"));
    }
    if frame.len() != length + 4 {
        return Err(format!(
            "IPC frame length mismatch: header says {length}, received {}",
            frame.len().saturating_sub(4)
        ));
    }
    serde_json::from_slice(&frame[4..]).map_err(|error| format!("invalid IPC JSON: {error}"))
}

fn validate_ready(value: &Value) -> Result<(), String> {
    if value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("unsupported Core IPC ready-event version".to_owned());
    }
    if value.get("event").and_then(Value::as_str) != Some("core.ready") {
        return Err("expected Core IPC core.ready event".to_owned());
    }
    Ok(())
}

fn validate_response(value: &Value, expected_id: &str) -> Result<Value, String> {
    if value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("unsupported Core IPC response version".to_owned());
    }
    if value.get("id").and_then(Value::as_str) != Some(expected_id) {
        return Err("Core IPC response request id does not match".to_owned());
    }
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => value
            .get("result")
            .cloned()
            .ok_or_else(|| "Core IPC success response has no result".to_owned()),
        Some(false) => {
            let error = value
                .get("error")
                .ok_or_else(|| "Core IPC failure response has no error object".to_owned())?;
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("CORE_ERROR");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Core rejected the request");
            Err(format!("Core IPC {code}: {message}"))
        }
        None => Err("Core IPC response is missing boolean `ok`".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_uses_little_endian_and_utf8_json() {
        let value = json!({ "message": "原生控制台", "count": 7 });
        let frame = encode_frame(&value).expect("encode");
        let length = u32::from_le_bytes(frame[..4].try_into().expect("four-byte prefix")) as usize;
        assert_eq!(length, frame.len() - 4);
        assert_eq!(decode_frame(&frame).expect("decode"), value);
    }

    #[test]
    fn frame_decoder_rejects_truncated_mismatched_and_oversized_frames() {
        assert!(decode_frame(&[1, 2, 3]).unwrap_err().contains("header"));
        assert!(
            decode_frame(&[2, 0, 0, 0, b'{'])
                .unwrap_err()
                .contains("mismatch")
        );
        assert!(decode_frame(&[0, 0, 0, 0]).unwrap_err().contains("length"));
        assert!(
            decode_frame(&(u32::MAX).to_le_bytes())
                .unwrap_err()
                .contains("length")
        );
    }

    #[test]
    fn ready_event_requires_expected_version_and_event_name() {
        assert!(validate_ready(&json!({ "version": 1, "event": "core.ready" })).is_ok());
        assert!(validate_ready(&json!({ "version": 2, "event": "core.ready" })).is_err());
        assert!(validate_ready(&json!({ "version": 1, "event": "other" })).is_err());
    }

    #[test]
    fn response_validation_checks_version_id_and_returns_result() {
        let response = json!({
            "version": 1,
            "id": "req-1",
            "ok": true,
            "result": { "status": "pong" }
        });
        assert_eq!(
            validate_response(&response, "req-1").expect("valid response"),
            json!({ "status": "pong" })
        );
        assert!(
            validate_response(&response, "different-id")
                .unwrap_err()
                .contains("id")
        );
        let unsupported = json!({ "version": 2, "id": "req-1", "ok": true, "result": {} });
        assert!(
            validate_response(&unsupported, "req-1")
                .unwrap_err()
                .contains("version")
        );
    }

    #[test]
    fn response_validation_surfaces_structured_core_errors() {
        let response = json!({
            "version": 1,
            "id": "req-2",
            "ok": false,
            "error": { "code": "NOT_ALLOWED", "message": "白名单外" }
        });
        let error = validate_response(&response, "req-2").unwrap_err();
        assert!(error.contains("NOT_ALLOWED"));
        assert!(error.contains("白名单外"));
    }
}
