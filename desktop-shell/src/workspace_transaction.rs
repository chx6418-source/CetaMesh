//! Bounded Windows byte operations for the existing Core Workspace journal.
//! Core owns authorization, intent and recovery. This module owns only physical facts.
use crate::installer::sha256_bytes;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{
        GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
    },
    Storage::FileSystem::*,
};
use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as nt},
    Win32::System::IO::IO_STATUS_BLOCK,
};

const REQUEST_SCHEMA: &str = "CETAMESH_WORKSPACE_BYTE_TRANSACTION_V1";
const RECEIPT_SCHEMA: &str = "CETAMESH_WORKSPACE_BYTE_TRANSACTION_RECEIPT_V1";
const FILE_LIMIT: u64 = 10 * 1024 * 1024;
const TOTAL_LIMIT: usize = 64 * 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Node {
    device: String,
    file: String,
}
impl Node {
    fn value(&self) -> Value {
        json!({"device":self.device,"file":self.file})
    }
    fn parse(v: &Value) -> Result<Self> {
        keys(v, &["device", "file"])?;
        let decimal = |key| -> Result<String> {
            let s = string(v, key)?;
            if s.is_empty()
                || !s.bytes().all(|c| c.is_ascii_digit())
                || (s.len() > 1 && s.starts_with('0'))
                || s.parse::<u64>().is_err()
            {
                return Err("INVALID_NODE");
            }
            Ok(s.to_string())
        };
        Ok(Self {
            device: decimal("device")?,
            file: decimal("file")?,
        })
    }
}
fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut value = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) } == 0 {
        return Err("HANDLE_INFO_FAILED");
    }
    Ok(value)
}
fn identity(file: &File) -> Result<Node> {
    let i = info(file)?;
    Ok(Node {
        device: i.dwVolumeSerialNumber.to_string(),
        file: (((i.nFileIndexHigh as u64) << 32) | i.nFileIndexLow as u64).to_string(),
    })
}
fn ordinary(file: &File, directory: bool) -> Result<()> {
    let i = info(file)?;
    if i.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (i.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory
            && (i.nNumberOfLinks != 1
                || unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK))
    {
        return Err("UNSAFE_NODE");
    }
    Ok(())
}
fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase()
}
fn handle_path(file: &File) -> Result<PathBuf> {
    let mut buf = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(file.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, 0)
    } as usize;
    if count == 0 || count >= buf.len() {
        return Err("CANONICAL_PATH_FAILED");
    }
    Ok(PathBuf::from(
        String::from_utf16(&buf[..count]).map_err(|_| "INVALID_PATH")?,
    ))
}
fn same_path(file: &File, path: &Path) -> Result<()> {
    if path_key(&handle_path(file)?) != path_key(path) {
        return Err("PATH_ALIAS");
    }
    Ok(())
}
fn read_bytes(file: &mut File, limit: u64) -> Result<Vec<u8>> {
    let size = file.metadata().map_err(|_| "READ_FAILED")?.len();
    if size > limit {
        return Err("SIZE_LIMIT");
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| "READ_FAILED")?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "READ_FAILED")?;
    if bytes.len() as u64 > limit {
        return Err("SIZE_LIMIT");
    }
    Ok(bytes)
}
fn write_bytes(file: &mut File, bytes: &[u8]) -> Result<String> {
    file.seek(SeekFrom::Start(0)).map_err(|_| "WRITE_FAILED")?;
    file.write_all(bytes).map_err(|_| "WRITE_FAILED")?;
    // This is the actual requested truncation, never a mapping-detection preflight.
    file.set_len(bytes.len() as u64)
        .map_err(|_| "TRUNCATE_FAILED")?;
    file.sync_all().map_err(|_| "FLUSH_FAILED")?;
    let actual = sha256_bytes(&read_bytes(file, FILE_LIMIT)?);
    if actual != sha256_bytes(bytes) {
        return Err("READBACK_FAILED");
    }
    Ok(actual)
}
fn disposition(file: &File, delete: bool) -> Result<()> {
    let data = FILE_DISPOSITION_INFO { DeleteFile: delete };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            &data as *const _ as *const _,
            std::mem::size_of_val(&data) as u32,
        )
    } == 0
    {
        return Err("DISPOSITION_FAILED");
    }
    Ok(())
}
fn pending_delete(file: &File) -> Result<bool> {
    let mut data: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            &mut data as *mut _ as *mut _,
            std::mem::size_of_val(&data) as u32,
        )
    } == 0
    {
        return Err("HANDLE_INFO_FAILED");
    }
    Ok(data.DeletePending)
}
fn keys(value: &Value, allowed: &[&str]) -> Result<()> {
    let obj = value.as_object().ok_or("INVALID_REQUEST")?;
    if obj.len() != allowed.len() || obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("INVALID_FIELDS");
    }
    Ok(())
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or("INVALID_REQUEST")
}
fn hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn optional_hash(v: &Value) -> Result<Option<String>> {
    if v.is_null() {
        Ok(None)
    } else {
        let s = v.as_str().ok_or("INVALID_HASH")?;
        if !hex64(s) {
            return Err("INVALID_HASH");
        }
        Ok(Some(s.into()))
    }
}
fn safe_segment(segment: &str) -> bool {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.ends_with(['.', ' '])
        || segment.chars().any(|c| c < ' ' || "<>:\"\\|?*".contains(c))
    {
        return false;
    }
    let lower = segment.to_lowercase();
    let base = lower.split('.').next().unwrap_or("");
    if ["con", "prn", "aux", "nul", "conin$", "conout$"].contains(&base)
        || ((base.starts_with("com") || base.starts_with("lpt"))
            && ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"]
                .contains(&base.get(3..).unwrap_or("")))
    {
        return false;
    }
    ![".git", ".ssh", ".aws", ".env", "credentials", "secrets"].contains(&lower.as_str())
        && !lower.starts_with(".env.")
}
fn safe_relative(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && path.split('/').all(safe_segment)
}
fn absolute_drive(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let b = s.as_bytes();
    b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
        && !s[3..].split(['\\', '/']).any(|p| {
            !p.is_empty() && (p == "." || p == ".." || p.ends_with(['.', ' ']) || p.contains(':'))
        })
        && !s.contains('\0')
}
struct Row {
    path: String,
    delete: bool,
    original_hash: Option<String>,
    original_node: Option<Node>,
    staged_hash: Option<String>,
}
struct Request {
    nonce: String,
    binding: String,
    root: PathBuf,
    root_node: Node,
    rows: Vec<Row>,
}
fn parse(bytes: &[u8], batch: &Path) -> Result<Request> {
    // serde_json rejects trailing bytes; the fixed field set grants no execution options.
    let v: Value = serde_json::from_slice(bytes).map_err(|_| "INVALID_JSON")?;
    keys(
        &v,
        &["schema", "nonce", "binding", "root", "rootNode", "rows"],
    )?;
    let nonce = string(&v, "nonce")?;
    let binding = string(&v, "binding")?;
    if string(&v, "schema")? != REQUEST_SCHEMA
        || !hex64(nonce)
        || !hex64(binding)
        || batch.file_name().and_then(|x| x.to_str()) != Some(&format!("batch-{nonce}"))
    {
        return Err("INVALID_BINDING");
    }
    let root = PathBuf::from(string(&v, "root")?);
    if !absolute_drive(&root) {
        return Err("INVALID_ROOT");
    }
    let root_node = Node::parse(&v["rootNode"])?;
    let input = v["rows"].as_array().ok_or("INVALID_ROWS")?;
    if input.is_empty() || input.len() > 100 {
        return Err("INVALID_ROWS");
    }
    let mut rows = Vec::new();
    let mut names = HashSet::new();
    for (index, r) in input.iter().enumerate() {
        keys(
            r,
            &[
                "path",
                "action",
                "originalHash",
                "originalNode",
                "stagedHash",
                "stagedFile",
            ],
        )?;
        let path = string(r, "path")?;
        if !safe_relative(path) {
            return Err("UNSAFE_PATH");
        }
        let key = path.to_lowercase();
        if names.iter().any(|other: &String| {
            *other == key
                || other.starts_with(&format!("{key}/"))
                || key.starts_with(&format!("{other}/"))
        }) {
            return Err("OVERLAPPING_PATHS");
        }
        names.insert(key);
        let delete = match string(r, "action")? {
            "write" => false,
            "delete" => true,
            _ => return Err("INVALID_ACTION"),
        };
        let original_hash = optional_hash(&r["originalHash"])?;
        let original_node = if r["originalNode"].is_null() {
            None
        } else {
            Some(Node::parse(&r["originalNode"])?)
        };
        let staged_hash = optional_hash(&r["stagedHash"])?;
        if original_hash.is_some() != original_node.is_some()
            || (delete && original_hash.is_none())
            || (delete && (!r["stagedFile"].is_null() || staged_hash.is_some()))
            || (!delete
                && (staged_hash.is_none()
                    || r["stagedFile"].as_str() != Some(&format!("{index}.staged"))))
        {
            return Err("INVALID_ROW");
        }
        if path_key(&root.join(path)).starts_with(&(path_key(batch) + "\\")) {
            return Err("JOURNAL_OVERLAP");
        }
        rows.push(Row {
            path: path.into(),
            delete,
            original_hash,
            original_node,
            staged_hash,
        });
    }
    Ok(Request {
        nonce: nonce.into(),
        binding: binding.into(),
        root,
        root_node,
        rows,
    })
}
// Exactly one component is resolved relative to the pinned directory object.
// A reparse failure is never retried through an absolute path.
fn open_relative(
    parent: &File,
    leaf: &str,
    access: u32,
    share: u32,
    create: bool,
    directory: bool,
) -> std::result::Result<File, i32> {
    if leaf.is_empty() || leaf.contains(['/', '\\', ':', '\0']) || leaf == "." || leaf == ".." {
        return Err(-1);
    }
    let mut wide: Vec<u16> = leaf.encode_utf16().collect();
    if wide.len() > 32766 {
        return Err(-1);
    }
    let name = UNICODE_STRING {
        Length: (wide.len() * 2) as u16,
        MaximumLength: (wide.len() * 2) as u16,
        Buffer: wide.as_mut_ptr(),
    };
    let attrs = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut io: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut handle = std::ptr::null_mut();
    let options = nt::FILE_OPEN_REPARSE_POINT
        | nt::FILE_SYNCHRONOUS_IO_NONALERT
        | if directory {
            nt::FILE_DIRECTORY_FILE
        } else {
            nt::FILE_NON_DIRECTORY_FILE
        };
    let status = unsafe {
        nt::NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attrs,
            &mut io,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            if create {
                nt::FILE_CREATE
            } else {
                nt::FILE_OPEN
            },
            options,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(status);
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}
struct Pins {
    journal_key: String,
    files: Vec<File>,
    indices: HashMap<String, usize>,
    created: Vec<(PathBuf, usize)>,
}
impl Pins {
    fn new(journal: &Path) -> Self {
        Self {
            journal_key: path_key(journal),
            files: vec![],
            indices: HashMap::new(),
            created: vec![],
        }
    }
    fn pin(&mut self, path: &Path, create: bool) -> Result<usize> {
        if !absolute_drive(path) {
            return Err("INVALID_DIRECTORY");
        }
        let mut cursor = PathBuf::new();
        let mut last = None;
        for component in path.components() {
            cursor.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            let key = path_key(&cursor);
            if let Some(&index) = self.indices.get(&key) {
                ordinary(&self.files[index], true)?;
                last = Some(index);
                continue;
            }
            let mut made = false;
            let file = if let Some(parent_index) = last {
                let leaf = component.as_os_str().to_str().ok_or("INVALID_DIRECTORY")?;
                let parent = &self.files[parent_index];
                ordinary(parent, true)?;
                match open_relative(
                    parent,
                    leaf,
                    GENERIC_READ,
                    if key == self.journal_key {
                        FILE_SHARE_READ | FILE_SHARE_WRITE
                    } else {
                        FILE_SHARE_READ
                    },
                    false,
                    true,
                ) {
                    Ok(file) => file,
                    Err(status) if status == 0xc0000034u32 as i32 && create => {
                        let file = open_relative(
                            parent,
                            leaf,
                            GENERIC_READ | DELETE,
                            FILE_SHARE_READ,
                            true,
                            true,
                        )
                        .map_err(|_| "CREATE_DIRECTORY_FAILED")?;
                        made = true;
                        file
                    }
                    Err(_) => return Err("DIRECTORY_LEASE_FAILED"),
                }
            } else {
                // Only the drive root uses an absolute Win32 open.
                OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&cursor)
                    .map_err(|_| "DIRECTORY_LEASE_FAILED")?
            };
            let index = self.files.len();
            self.files.push(file);
            self.indices.insert(key, index);
            last = Some(index);
            if made {
                self.created.push((cursor.clone(), index));
            }
            ordinary(&self.files[index], true)?;
            same_path(&self.files[index], &cursor)?;
        }
        last.ok_or("INVALID_DIRECTORY")
    }
    fn created_values(&self, root: &Path) -> Vec<Value> {
        self.created.iter().map(|(path,index)|json!({"path":path.strip_prefix(root).ok().map(|p|p.to_string_lossy().replace('\\',"/")),"node":identity(&self.files[*index]).ok().map(|n|n.value())})).collect()
    }
}
struct Lease {
    row_index: usize,
    file: Option<File>,
    original: Option<Vec<u8>>,
    node: Node,
    touched: bool,
    final_hash: Option<String>,
}
fn observed(row: &Row, lease: &Lease) -> Value {
    json!({"path":row.path,"action":if row.delete{"delete"}else{"write"},"originalHash":lease.original.as_ref().map(|b|sha256_bytes(b)),"originalNode":if lease.original.is_some(){Some(lease.node.value())}else{None},"stagedHash":row.staged_hash,"finalHash":lease.final_hash,"finalNode":if lease.final_hash.is_some(){Some(lease.node.value())}else{None}})
}
fn persist(journal: &File, receipt: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| "RECEIPT_FAILED")?;
    if bytes.len() > 262144 {
        return Err("RECEIPT_FAILED");
    }
    let mut file = open_relative(
        journal,
        "receipt.pending",
        GENERIC_WRITE | DELETE,
        0,
        true,
        false,
    )
    .map_err(|_| "RECEIPT_FAILED")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "RECEIPT_FAILED")?;
    // Rename through the owned handle. ReplaceIfExists is false; no path reopen gap.
    let wide: Vec<u16> = "receipt.json".encode_utf16().collect();
    let offset = std::mem::offset_of!(nt::FILE_RENAME_INFORMATION, FileName);
    let size = offset + wide.len() * 2;
    let mut storage = vec![0u64; size.div_ceil(8)];
    let rename = storage.as_mut_ptr() as *mut nt::FILE_RENAME_INFORMATION;
    unsafe {
        (*rename).Anonymous.ReplaceIfExists = false;
        (*rename).RootDirectory = journal.as_raw_handle();
        (*rename).FileNameLength = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), (*rename).FileName.as_mut_ptr(), wide.len());
    }
    let mut io: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let status = unsafe {
        nt::NtSetInformationFile(
            file.as_raw_handle(),
            &mut io,
            rename as *const _,
            size as u32,
            nt::FileRenameInformation,
        )
    };
    if status < 0 {
        #[cfg(test)]
        eprintln!("receipt rename NTSTATUS={status:#x}");
        return Err("RECEIPT_FAILED");
    }
    // Publication is the terminal boundary: the temp was fully flushed before
    // rename. Do not add fallible work here that could trigger compensation after
    // a completed receipt is visible. This does not claim power-loss durability
    // of the directory entry; another file flush cannot establish that guarantee.
    Ok(())
}
fn compensate(leases: &mut [Lease], pins: &mut Pins) -> bool {
    let mut ok = true;
    for lease in leases.iter_mut().rev() {
        let Some(file) = lease.file.as_mut() else {
            ok = false;
            continue;
        };
        if let Some(original) = &lease.original {
            if lease.touched
                && (disposition(file, false).is_err() || write_bytes(file, original).is_err())
            {
                ok = false;
            }
            match read_bytes(file, FILE_LIMIT) {
                Ok(bytes) => {
                    let actual = sha256_bytes(&bytes);
                    if actual != sha256_bytes(original) {
                        ok = false;
                    }
                    lease.final_hash = Some(actual);
                }
                Err(_) => {
                    lease.final_hash = None;
                    ok = false;
                }
            }
            if identity(file).ok().as_ref() != Some(&lease.node) {
                ok = false;
            }
        } else {
            if disposition(file, true).is_err() || pending_delete(file) != Ok(true) {
                ok = false;
                lease.final_hash = read_bytes(file, FILE_LIMIT)
                    .ok()
                    .map(|bytes| sha256_bytes(&bytes));
            } else {
                lease.final_hash = None;
            }
        }
    }
    // Created parents cannot be removed while their created children remain open.
    // Originals remain exclusively held. Only our exact new handles are closed.
    if !pins.created.is_empty() {
        for lease in leases.iter_mut().filter(|l| l.original.is_none()) {
            lease.file.take();
        }
        for (_, index) in pins.created.iter().rev() {
            let _ = disposition(&pins.files[*index], true);
        }
        // Directory handles remain pinned until receipt. Pending parent removal may
        // not be provable with nested children open: retain unknown conservatively.
        ok = false;
    }
    ok
}

pub fn run(request_path: &Path, expected_digest: &str) -> Result<u32> {
    if !hex64(expected_digest) {
        return Err("INVALID_REQUEST_DIGEST");
    }
    if !absolute_drive(request_path)
        || request_path.file_name().and_then(|s| s.to_str()) != Some("request.json")
    {
        return Err("INVALID_REQUEST_PATH");
    }
    let batch = request_path.parent().ok_or("INVALID_REQUEST_PATH")?;
    let mut pins = Pins::new(batch);
    let journal_index = pins.pin(batch, false)?;
    let mut request_file = open_relative(
        &pins.files[journal_index],
        "request.json",
        GENERIC_READ,
        FILE_SHARE_READ,
        false,
        false,
    )
    .map_err(|_| "REQUEST_OPEN_FAILED")?;
    ordinary(&request_file, false)?;
    same_path(&request_file, request_path)?;
    let bytes = read_bytes(&mut request_file, 262144)?;
    if sha256_bytes(&bytes) != expected_digest {
        return Err("REQUEST_DIGEST_MISMATCH");
    }
    let request = parse(&bytes, batch)?;
    let request_sha = sha256_bytes(&bytes);
    // Single-use claim precedes all target acquisition/effects. Existing claim is never overwritten.
    let mut claim = open_relative(
        &pins.files[journal_index],
        "native.claimed",
        GENERIC_WRITE,
        FILE_SHARE_READ,
        true,
        false,
    )
    .map_err(|_| "ALREADY_CLAIMED")?;
    claim
        .write_all(request_sha.as_bytes())
        .and_then(|_| claim.sync_all())
        .map_err(|_| "CLAIM_FAILED")?;
    let mut leases: Vec<Lease> = vec![];
    let mut payloads: Vec<Option<Vec<u8>>> = vec![];
    let mut backup_handles = vec![];
    let mut payload_handles = vec![];
    let mut untracked_effect = false;
    let mut effects = false;
    let operation = (|| -> Result<()> {
        let root_index = pins.pin(&request.root, false)?;
        if identity(&pins.files[root_index])? != request.root_node {
            return Err("ROOT_CHANGED");
        }
        let mut total = 0usize;
        for (index, row) in request.rows.iter().enumerate() {
            if row.delete {
                payloads.push(None);
                continue;
            }
            let path = batch.join(format!("{index}.staged"));
            let mut file = open_relative(
                &pins.files[journal_index],
                &format!("{index}.staged"),
                GENERIC_READ,
                FILE_SHARE_READ,
                false,
                false,
            )
            .map_err(|_| "PAYLOAD_OPEN_FAILED")?;
            ordinary(&file, false)?;
            same_path(&file, &path)?;
            let size = file.metadata().map_err(|_| "READ_FAILED")?.len();
            if size > FILE_LIMIT || size as usize > TOTAL_LIMIT - total {
                return Err("TOTAL_LIMIT");
            }
            let bytes = read_bytes(&mut file, FILE_LIMIT)?;
            total += bytes.len();
            if Some(sha256_bytes(&bytes)) != row.staged_hash {
                return Err("PAYLOAD_CHANGED");
            }
            payloads.push(Some(bytes));
            payload_handles.push(file);
        }
        let mut originals_total = 0usize;
        let mut nodes = HashSet::new();
        // Bound every existing original before creating any target.
        for existing in [true, false] {
            for (row_index, row) in request
                .rows
                .iter()
                .enumerate()
                .filter(|(_, row)| row.original_hash.is_some() == existing)
            {
                let path = request.root.join(&row.path);
                let before = pins.created.len();
                let parent_result = pins.pin(
                    path.parent().ok_or("UNSAFE_PATH")?,
                    row.original_hash.is_none(),
                );
                if pins.created.len() != before {
                    effects = true;
                }
                let parent_index = parent_result?;
                let mut file = open_relative(
                    &pins.files[parent_index],
                    path.file_name()
                        .and_then(|s| s.to_str())
                        .ok_or("UNSAFE_PATH")?,
                    GENERIC_READ | GENERIC_WRITE | DELETE,
                    0,
                    row.original_hash.is_none(),
                    false,
                )
                .map_err(|_| "TARGET_LEASE_FAILED")?;
                let new = row.original_hash.is_none();
                if new {
                    effects = true;
                }
                // Install every newly created handle in the compensation set immediately.
                let node = match identity(&file) {
                    Ok(node) => node,
                    Err(code) => {
                        if new
                            && (disposition(&file, true).is_err()
                                || pending_delete(&file) != Ok(true))
                        {
                            untracked_effect = true;
                        }
                        return Err(code);
                    }
                };
                if !new {
                    ordinary(&file, false)?;
                    same_path(&file, &path)?;
                    let size = file.metadata().map_err(|_| "READ_FAILED")?.len();
                    if size > FILE_LIMIT || size as usize > TOTAL_LIMIT - originals_total {
                        return Err("TOTAL_LIMIT");
                    }
                }
                let original = if new {
                    None
                } else {
                    Some(read_bytes(&mut file, FILE_LIMIT)?)
                };
                let final_hash = original.as_ref().map(|b| sha256_bytes(b));
                leases.push(Lease {
                    row_index,
                    file: Some(file),
                    original,
                    node: node.clone(),
                    touched: false,
                    final_hash,
                });
                let lease = leases.last().unwrap();
                ordinary(lease.file.as_ref().unwrap(), false)?;
                same_path(lease.file.as_ref().unwrap(), &path)?;
                if !nodes.insert((node.device.clone(), node.file.clone())) {
                    return Err("ALIASED_NODE");
                }
                if !new
                    && (row.original_node.as_ref() != Some(&node)
                        || row.original_hash != lease.final_hash)
                {
                    return Err("ORIGINAL_CHANGED");
                }
                originals_total += lease.original.as_ref().map_or(0, Vec::len);
                if originals_total > TOTAL_LIMIT {
                    return Err("TOTAL_LIMIT");
                }
            }
        }
        leases.sort_by_key(|lease| lease.row_index);
        for lease in &leases {
            let index = lease.row_index;
            if let Some(original) = &lease.original {
                let mut file = open_relative(
                    &pins.files[journal_index],
                    &format!("{index}.preimage"),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ,
                    true,
                    false,
                )
                .map_err(|_| "BACKUP_FAILED")?;
                write_bytes(&mut file, original).map_err(|_| "BACKUP_FAILED")?;
                backup_handles.push(file);
            }
        }
        for directory in &pins.files {
            ordinary(directory, true)?;
        }
        for lease in &mut leases {
            let index = lease.row_index;
            lease.touched = true;
            effects = true;
            let file = lease.file.as_mut().ok_or("HANDLE_LOST")?;
            ordinary(file, false)?;
            if request.rows[index].delete {
                disposition(file, true)?;
                if !pending_delete(file)? {
                    return Err("DELETE_NOT_PENDING");
                }
                lease.final_hash = None;
            } else {
                let bytes = payloads[index].as_ref().ok_or("PAYLOAD_MISSING")?;
                lease.final_hash = Some(write_bytes(file, bytes)?);
            }
            if identity(file)? != lease.node {
                return Err("NODE_CHANGED");
            }
        }
        for directory in &pins.files {
            ordinary(directory, true)?;
        }
        Ok(())
    })();
    let (status, code, rollback, remaining) = match operation {
        Ok(()) => ("completed", "COMPLETED", false, "known"),
        Err(code) if !effects => ("refused", code, false, "none"),
        Err(code) => {
            let restored = compensate(&mut leases, &mut pins);
            let verified = restored
                && !untracked_effect
                && leases.len() == request.rows.len()
                && leases.iter().all(|l| {
                    l.original.as_ref().map(|b| sha256_bytes(b))
                        == request.rows[l.row_index].original_hash
                });
            if verified {
                ("rolled-back", code, true, "none")
            } else {
                ("unknown", code, false, "unknown")
            }
        }
    };
    let rows: Vec<Value> = leases
        .iter()
        .map(|lease| observed(&request.rows[lease.row_index], lease))
        .collect();
    let receipt = json!({"schema":RECEIPT_SCHEMA,"nonce":request.nonce,"binding":request.binding,"requestSha256":request_sha,"status":status,"code":code,"rows":rows,"createdDirectories":pins.created_values(&request.root),"rollbackVerified":rollback,"effects":remaining});
    if persist(&pins.files[journal_index], &receipt).is_err() {
        // No durable terminal receipt means unknown, even if compensation succeeds.
        if status == "completed" {
            let _ = compensate(&mut leases, &mut pins);
        }
        return Err("RECEIPT_FAILED");
    }
    // Explicit order: close target/backup handles before pinned parent directories.
    drop(leases);
    drop(backup_handles);
    drop(payload_handles);
    drop(claim);
    drop(request_file);
    drop(pins);
    Ok(if status == "completed" { 0 } else { 1 })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn run(path: &Path) -> Result<u32> {
        super::run(
            path,
            &fs::read(path)
                .map(|b| sha256_bytes(&b))
                .unwrap_or_else(|_| "a".repeat(64)),
        )
    }
    use serde_json::{Value, json};
    use std::{
        fs,
        fs::{File, OpenOptions},
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        path::PathBuf,
    };

    fn node(path: &Path) -> Value {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .unwrap();
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            0
        );
        json!({"device":info.dwVolumeSerialNumber.to_string(),"file":(((info.nFileIndexHigh as u64)<<32)|info.nFileIndexLow as u64).to_string()})
    }
    struct Fixture {
        temp_parent: PathBuf,
        base: PathBuf,
        root: PathBuf,
        batch: PathBuf,
        identity: Value,
    }
    impl Fixture {
        fn new() -> Self {
            let temp_parent = fs::canonicalize(std::env::temp_dir()).unwrap();
            // Canonical Windows paths have a verbatim prefix; requests deliberately
            // accept canonical drive paths without that device-namespace spelling.
            let parent_text = temp_parent.to_str().unwrap();
            let base = PathBuf::from(parent_text.strip_prefix(r"\\?\").unwrap_or(parent_text))
                .join(format!(
                    "cm-byte-fixture-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            fs::create_dir(&base).unwrap();
            let root = base.join("root");
            let batch = base.join(format!("batch-{}", "a".repeat(64)));
            fs::create_dir(&root).unwrap();
            fs::create_dir(&batch).unwrap();
            let identity = node(&base);
            Self {
                temp_parent,
                base,
                root,
                batch,
                identity,
            }
        }
        fn request(&self, items: &[(&str, Option<&[u8]>, Option<&[u8]>)]) -> PathBuf {
            let mut rows = vec![];
            for (i, (path, old, new)) in items.iter().enumerate() {
                let target = self.root.join(path);
                if let Some(bytes) = old {
                    fs::create_dir_all(target.parent().unwrap()).unwrap();
                    fs::write(&target, bytes).unwrap();
                }
                if let Some(bytes) = new {
                    fs::write(self.batch.join(format!("{i}.staged")), bytes).unwrap();
                }
                rows.push(json!({"path":path,"action":if new.is_some(){"write"}else{"delete"},"originalHash":old.map(crate::installer::sha256_bytes),"originalNode":old.map(|_|node(&target)),"stagedHash":new.map(crate::installer::sha256_bytes),"stagedFile":new.map(|_|format!("{i}.staged"))}));
            }
            let req = self.batch.join("request.json");
            fs::write(&req,serde_json::to_vec(&json!({"schema":"CETAMESH_WORKSPACE_BYTE_TRANSACTION_V1","nonce":"a".repeat(64),"binding":"b".repeat(64),"root":self.root.to_str().unwrap(),"rootNode":node(&self.root),"rows":rows})).unwrap()).unwrap();
            req
        }
        fn receipt(&self) -> Value {
            serde_json::from_slice(&fs::read(self.batch.join("receipt.json")).unwrap()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert!(
                self.base
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("cm-byte-fixture-")
            );
            assert_eq!(
                fs::canonicalize(self.base.parent().unwrap()).unwrap(),
                self.temp_parent
            );
            assert_eq!(
                fs::canonicalize(&self.base).unwrap(),
                self.temp_parent.join(self.base.file_name().unwrap())
            );
            assert!(
                !fs::symlink_metadata(&self.base)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(node(&self.base), self.identity);
            fs::remove_dir_all(&self.base).unwrap();
        }
    }
    #[test]
    fn malformed_request_is_bounded_refusal() {
        assert_eq!(
            run(Path::new("relative/request.json")),
            Err("INVALID_REQUEST_PATH")
        );
    }
    #[test]
    fn writes_shorter_longer_binary_and_exact_backups() {
        let f = Fixture::new();
        let req = f.request(&[
            ("short", Some(b"long original"), Some(b"x")),
            ("long", Some(b"x"), Some(b"longer new")),
            ("binary", Some(&[0, 255, 1]), Some(&[0, 128, 255, 3])),
        ]);
        assert_eq!(run(&req), Ok(0));
        assert_eq!(fs::read(f.root.join("short")).unwrap(), b"x");
        assert_eq!(fs::read(f.root.join("long")).unwrap(), b"longer new");
        assert_eq!(fs::read(f.root.join("binary")).unwrap(), [0, 128, 255, 3]);
        assert_eq!(
            fs::read(f.batch.join("0.preimage")).unwrap(),
            b"long original"
        );
        assert_eq!(f.receipt()["status"], "completed");
    }
    #[test]
    fn creates_absent_and_deletes_original() {
        let f = Fixture::new();
        let req = f.request(&[
            ("new/deep/file", None, Some(b"new")),
            ("delete", Some(b"old"), None),
        ]);
        assert_eq!(run(&req), Ok(0));
        assert_eq!(fs::read(f.root.join("new/deep/file")).unwrap(), b"new");
        assert!(!f.root.join("delete").exists());
    }
    #[test]
    fn absence_collision_preserves_bytes_and_time() {
        let f = Fixture::new();
        let req = f.request(&[("file", None, Some(b"new"))]);
        let target = f.root.join("file");
        fs::write(&target, b"late").unwrap();
        let before = fs::metadata(&target).unwrap().modified().unwrap();
        assert_ne!(run(&req), Ok(0));
        assert_eq!(fs::read(&target).unwrap(), b"late");
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), before);
        assert_eq!(f.receipt()["effects"], "none");
    }
    #[test]
    fn raw_preimage_change_refuses_without_write() {
        let f = Fixture::new();
        let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
        let target = f.root.join("file");
        let time = fs::metadata(&target).unwrap().modified().unwrap();
        fs::write(&target, b"NEW").unwrap();
        File::options()
            .write(true)
            .open(&target)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
        assert_ne!(run(&req), Ok(0));
        assert_eq!(fs::read(&target).unwrap(), b"NEW");
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), time);
    }
    #[test]
    fn existing_reader_and_writer_refuse() {
        for write in [false, true] {
            let f = Fixture::new();
            let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
            let held = OpenOptions::new()
                .read(true)
                .write(write)
                .share_mode(7)
                .open(f.root.join("file"))
                .unwrap();
            assert_ne!(run(&req), Ok(0));
            drop(held);
            assert_eq!(fs::read(f.root.join("file")).unwrap(), b"old");
        }
    }
    #[test]
    fn hardlink_refuses() {
        let f = Fixture::new();
        let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
        fs::hard_link(f.root.join("file"), f.root.join("alias")).unwrap();
        assert_ne!(run(&req), Ok(0));
        assert_eq!(fs::read(f.root.join("file")).unwrap(), b"old");
    }
    #[test]
    fn replay_is_not_a_second_operation() {
        let f = Fixture::new();
        let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
        assert_eq!(run(&req), Ok(0));
        let receipt = fs::read(f.batch.join("receipt.json")).unwrap();
        assert_ne!(run(&req), Ok(0));
        assert_eq!(fs::read(f.batch.join("receipt.json")).unwrap(), receipt);
    }
    #[test]
    fn malformed_scope_and_digest_have_no_claim_or_effects() {
        for field in [
            "nonce",
            "binding",
            "rootNode",
            "path",
            "duplicate",
            "payload",
            "command",
            "digest",
            "oversize",
        ] {
            let f = Fixture::new();
            let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
            let mut v: Value = serde_json::from_slice(&fs::read(&req).unwrap()).unwrap();
            match field {
                "nonce" => v["nonce"] = json!("A".repeat(64)),
                "binding" => v["binding"] = json!("invalid"),
                "rootNode" => v["rootNode"]["file"] = json!(23),
                "path" => v["rows"][0]["path"] = json!("../escape"),
                "duplicate" => {
                    let row = v["rows"][0].clone();
                    v["rows"].as_array_mut().unwrap().push(row);
                }
                "payload" => v["rows"][0]["stagedFile"] = json!("../payload"),
                "command" => v["command"] = json!("no"),
                _ => {}
            }
            fs::write(
                &req,
                if field == "oversize" {
                    vec![b' '; 262145]
                } else {
                    serde_json::to_vec(&v).unwrap()
                },
            )
            .unwrap();
            let result = if field == "digest" {
                super::run(&req, &"c".repeat(64))
            } else {
                run(&req)
            };
            assert!(result.is_err(), "{field}: {result:?}");
            assert!(!f.batch.join("native.claimed").exists());
            assert_eq!(fs::read(f.root.join("file")).unwrap(), b"old");
        }
    }
    #[test]
    fn unsafe_windows_aliases_and_overlaps_refuse() {
        for path in [
            ".git/config",
            ".ssh/key",
            ".aws/config",
            ".env",
            "credentials/a",
            "secrets/a",
            "a:ads",
            "a\\b",
            "a//b",
            "a/../b",
            "NUL.txt",
            "a. ",
            "COM1",
            "CONIN$",
            "/abs",
        ] {
            let f = Fixture::new();
            let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
            let mut v: Value = serde_json::from_slice(&fs::read(&req).unwrap()).unwrap();
            v["rows"][0]["path"] = json!(path);
            fs::write(&req, serde_json::to_vec(&v).unwrap()).unwrap();
            assert!(run(&req).is_err(), "{path}");
            assert!(!f.batch.join("native.claimed").exists());
        }
    }
    #[test]
    fn wrong_node_and_oversize_payload_preserve_original() {
        for oversize in [false, true] {
            let f = Fixture::new();
            let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
            if oversize {
                File::options()
                    .write(true)
                    .open(f.batch.join("0.staged"))
                    .unwrap()
                    .set_len(FILE_LIMIT + 1)
                    .unwrap();
            } else {
                let mut v: Value = serde_json::from_slice(&fs::read(&req).unwrap()).unwrap();
                v["rows"][0]["originalNode"]["file"] = json!("1");
                fs::write(&req, serde_json::to_vec(&v).unwrap()).unwrap();
            }
            assert_eq!(run(&req), Ok(1));
            assert_eq!(f.receipt()["status"], "refused");
            assert_eq!(f.receipt()["effects"], "none");
            assert_eq!(fs::read(f.root.join("file")).unwrap(), b"old");
        }
    }
    #[test]
    fn root_and_parent_leases_block_rename_and_writable_directory_open() {
        let f = Fixture::new();
        fs::create_dir(f.root.join("parent")).unwrap();
        let mut pins = Pins::new(&f.batch);
        pins.pin(&f.root.join("parent"), false).unwrap();
        for p in [&f.root, f.root.join("parent").as_path()] {
            assert!(fs::rename(p, p.with_extension("moved")).is_err());
            assert!(
                OpenOptions::new()
                    .access_mode(GENERIC_WRITE)
                    .share_mode(7)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(p)
                    .is_err()
            );
        }
        drop(pins);
        assert!(fs::rename(f.root.join("parent"), f.root.join("moved")).is_ok());
    }
    #[test]
    fn receipt_collision_never_overwrites_or_reports_completed() {
        let f = Fixture::new();
        let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
        fs::write(f.batch.join("receipt.json"), b"existing receipt").unwrap();
        assert_eq!(run(&req), Err("RECEIPT_FAILED"));
        assert_eq!(
            fs::read(f.batch.join("receipt.json")).unwrap(),
            b"existing receipt"
        );
        assert_eq!(fs::read(f.root.join("file")).unwrap(), b"old");
        assert_eq!(fs::read(f.batch.join("0.preimage")).unwrap(), b"old");
        assert!(f.batch.join("native.claimed").exists());
    }
    struct Mapping {
        mapping: windows_sys::Win32::Foundation::HANDLE,
        view: windows_sys::Win32::System::Memory::MEMORY_MAPPED_VIEW_ADDRESS,
    }
    impl Mapping {
        fn new(path: &Path, writable: bool) -> Self {
            use windows_sys::Win32::System::Memory::*;
            let file = OpenOptions::new()
                .read(true)
                .write(writable)
                .share_mode(7)
                .open(path)
                .unwrap();
            let mapping = unsafe {
                CreateFileMappingW(
                    file.as_raw_handle(),
                    std::ptr::null(),
                    if writable {
                        PAGE_READWRITE
                    } else {
                        PAGE_READONLY
                    },
                    0,
                    0,
                    std::ptr::null(),
                )
            };
            assert!(!mapping.is_null());
            let view = unsafe {
                MapViewOfFile(
                    mapping,
                    if writable {
                        FILE_MAP_WRITE
                    } else {
                        FILE_MAP_READ
                    },
                    0,
                    0,
                    0,
                )
            };
            assert!(!view.Value.is_null());
            drop(file);
            Self { mapping, view }
        }
    }
    impl Drop for Mapping {
        fn drop(&mut self) {
            unsafe {
                assert_ne!(
                    windows_sys::Win32::System::Memory::UnmapViewOfFile(self.view),
                    0
                );
                assert_ne!(windows_sys::Win32::Foundation::CloseHandle(self.mapping), 0);
            }
        }
    }
    #[test]
    fn live_writable_mapping_refuses_after_original_handle_closes() {
        let f = Fixture::new();
        let req = f.request(&[("file", Some(b"old bytes"), Some(b"new"))]);
        let mapping = Mapping::new(&f.root.join("file"), true);
        assert_eq!(run(&req), Ok(1));
        assert_eq!(f.receipt()["effects"], "none");
        unsafe {
            *(mapping.view.Value as *mut u8) = b'L';
        }
        drop(mapping);
        assert_eq!(fs::read(f.root.join("file")).unwrap(), b"Lld bytes");
    }
    #[test]
    fn real_truncate_failure_restores_prior_row_and_partial_current_row() {
        let f = Fixture::new();
        let req = f.request(&[
            ("first", Some(b"first original"), Some(b"changed first")),
            ("mapped", Some(b"second original"), Some(b"x")),
        ]);
        let mapping = Mapping::new(&f.root.join("mapped"), false);
        assert_eq!(run(&req), Ok(1));
        let receipt = f.receipt();
        assert_eq!(receipt["status"], "rolled-back");
        assert_eq!(receipt["rollbackVerified"], true);
        assert_eq!(receipt["effects"], "none");
        drop(mapping);
        assert_eq!(fs::read(f.root.join("first")).unwrap(), b"first original");
        assert_eq!(fs::read(f.root.join("mapped")).unwrap(), b"second original");
    }
    struct Junction(File);
    impl Junction {
        fn new(path: &Path, target: &Path) -> Self {
            let file = OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .share_mode(7)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .unwrap();
            let substitute: Vec<u16> =
                format!(r"\??\{}", target.to_string_lossy().replace('/', "\\"))
                    .encode_utf16()
                    .collect();
            let print: Vec<u16> = target.to_string_lossy().encode_utf16().collect();
            let mut buffer = Vec::new();
            buffer.extend_from_slice(&0xa0000003u32.to_le_bytes());
            buffer.extend_from_slice(
                &((8 + (substitute.len() + print.len() + 2) * 2) as u16).to_le_bytes(),
            );
            buffer.extend_from_slice(&0u16.to_le_bytes());
            for n in [
                0,
                substitute.len() * 2,
                (substitute.len() + 1) * 2,
                print.len() * 2,
            ] {
                buffer.extend_from_slice(&(n as u16).to_le_bytes());
            }
            for n in substitute.into_iter().chain([0]).chain(print).chain([0]) {
                buffer.extend_from_slice(&n.to_le_bytes());
            }
            let mut returned = 0;
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::IO::DeviceIoControl(
                        file.as_raw_handle(),
                        0x900a4,
                        buffer.as_ptr() as *const _,
                        buffer.len() as u32,
                        std::ptr::null_mut(),
                        0,
                        &mut returned,
                        std::ptr::null_mut(),
                    )
                },
                0,
                "{}",
                std::io::Error::last_os_error()
            );
            Self(file)
        }
    }
    impl Drop for Junction {
        fn drop(&mut self) {
            let data = [3u8, 0, 0, 160, 0, 0, 0, 0];
            let mut returned = 0;
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::IO::DeviceIoControl(
                        self.0.as_raw_handle(),
                        0x900ac,
                        data.as_ptr() as *const _,
                        data.len() as u32,
                        std::ptr::null_mut(),
                        0,
                        &mut returned,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
        }
    }
    #[test]
    fn reparse_parent_and_payload_cannot_redirect_bytes() {
        for payload in [false, true] {
            let f = Fixture::new();
            let req = f.request(&[("file", Some(b"old"), Some(b"new"))]);
            let outside = f.base.join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("sentinel"), b"outside").unwrap();
            let link = if payload {
                fs::remove_file(f.batch.join("0.staged")).unwrap();
                f.batch.join("0.staged")
            } else {
                let mut v: Value = serde_json::from_slice(&fs::read(&req).unwrap()).unwrap();
                v["rows"][0]["path"] = json!("link/sentinel");
                fs::write(&req, serde_json::to_vec(&v).unwrap()).unwrap();
                f.root.join("link")
            };
            fs::create_dir(&link).unwrap();
            let junction = Junction::new(&link, &outside);
            assert_eq!(run(&req), Ok(1));
            assert_eq!(f.receipt()["effects"], "none");
            assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"outside");
            assert_eq!(fs::read(f.root.join("file")).unwrap(), b"old");
            drop(junction);
        }
    }
    #[test]
    fn attributes_only_reparse_mutation_of_held_parent_does_not_redirect_relative_io() {
        let f = Fixture::new();
        let source = f.root.join("parent");
        let outside = f.base.join("outside");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), b"outside").unwrap();
        let mut pins = Pins::new(&f.batch);
        let index = pins.pin(&source, false).unwrap();
        let before = identity(&pins.files[index]).unwrap();
        let junction = Junction::new(&source, &outside);
        assert_eq!(identity(&pins.files[index]).unwrap(), before);
        assert!(ordinary(&pins.files[index], true).is_err());
        assert_eq!(fs::read(source.join("sentinel")).unwrap(), b"outside");
        for (leaf, create) in [("sentinel", false), ("new", true)] {
            let result = open_relative(
                &pins.files[index],
                leaf,
                GENERIC_READ | GENERIC_WRITE | DELETE,
                0,
                create,
                false,
            );
            assert_eq!(result.unwrap_err(), 0xc0000280u32 as i32);
        }
        assert!(!outside.join("new").exists());
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"outside");
        drop(junction);
        drop(pins);
    }
    #[test]
    fn deleting_then_real_truncate_failure_clears_pending_delete() {
        let f = Fixture::new();
        let req = f.request(&[
            ("delete", Some(b"retained"), None),
            ("mapped", Some(b"mapped bytes"), Some(b"x")),
        ]);
        let mapping = Mapping::new(&f.root.join("mapped"), false);
        assert_eq!(run(&req), Ok(1));
        assert_eq!(f.receipt()["status"], "rolled-back");
        drop(mapping);
        assert_eq!(fs::read(f.root.join("delete")).unwrap(), b"retained");
        assert_eq!(fs::read(f.root.join("mapped")).unwrap(), b"mapped bytes");
    }
    #[test]
    fn late_absence_collision_removes_only_owned_placeholder_and_is_unknown() {
        let f = Fixture::new();
        let req = f.request(&[
            ("added", None, Some(b"new")),
            ("collision", None, Some(b"new")),
        ]);
        fs::write(f.root.join("collision"), b"late").unwrap();
        assert_eq!(run(&req), Ok(1));
        assert!(!f.root.join("added").exists());
        assert_eq!(fs::read(f.root.join("collision")).unwrap(), b"late");
        assert_eq!(f.receipt()["status"], "unknown");
        assert_eq!(f.receipt()["rollbackVerified"], false);
    }
}
