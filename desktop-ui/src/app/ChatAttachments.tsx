import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, Dispatch, SetStateAction } from 'react';

export type AttachmentCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type AttachmentRef = { ref: string; name: string; size: number; kind: 'image' | 'text' | 'document' | 'archive'; mimeType: string; status?: string; received?: number; sha256?: string; width?: number; height?: number; modelRef?: string; originalRef?: string; quality?: { width: number; height: number; processed: boolean; format?: string } };
export type AttachmentLimits = { imageMiB: number; documentMiB: number; archiveMiB: number; messageMiB: number; count: number; storageMiB: number; reserveMiB: number; incompleteHours: number };
export const ATTACHMENT_CHUNK_BYTES = 128 * 1024;
const MiB = 1024 * 1024;
const defaults: AttachmentLimits = { imageMiB: 20, documentMiB: 100, archiveMiB: 200, messageMiB: 250, count: 20, storageMiB: 2048, reserveMiB: 256, incompleteHours: 24 };
const accept = '.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.rs,.go,.java,.c,.h,.cpp,.css,.html,.xml,.yaml,.yml,.toml,.ini,.log,.sql,.sh,.ps1,.zip';
const sourceExtensions = /\.(?:txt|md|csv|json|js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|c|h|cpp|css|html|xml|yaml|yml|toml|ini|log|sql|sh|ps1)$/i;
const abortError = () => new DOMException('上传已取消', 'AbortError');
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
export function attachmentSize(bytes: number) { return bytes >= MiB ? `${(bytes / MiB).toFixed(bytes >= 10 * MiB ? 0 : 1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`; }
function kindOf(file: File): AttachmentRef['kind'] {
  if (/\.(?:png|jpe?g|webp)$/i.test(file.name)) return 'image';
  if (/\.zip$/i.test(file.name)) return 'archive';
  if (sourceExtensions.test(file.name)) return 'text';
  if (/\.(?:pdf|docx|xlsx|pptx)$/i.test(file.name)) return 'document';
  throw new Error('支持 JPG、PNG、WebP、文档、文本源码和 ZIP 文件。');
}
function encodeChunk(bytes: Uint8Array) { let text = ''; for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192)); return btoa(text); }
function decodeChunk(data: string) { const text = atob(data), bytes = new Uint8Array(text.length); for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index); return bytes; }

/** Read at most 256 KiB before browser decoding. Header dimensions must fit Core's bounds. */
export async function inspectImageHeader(file: Blob & { name?: string }, signal?: AbortSignal): Promise<{ width: number; height: number; mimeType: string }> {
  checkAbort(signal); const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()); checkAbort(signal);
  const view = new DataView(bytes.buffer), word = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let width = 0, height = 0, mimeType = '';
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) { width = view.getUint32(16); height = view.getUint32(20); mimeType = 'image/png'; }
  else if (bytes.length >= 30 && word(0) === 'RIFF' && word(8) === 'WEBP') {
    mimeType = 'image/webp'; const type = word(12);
    if (type === 'VP8X') { width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536; height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536; }
    else if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
    else if (type === 'VP8L' && bytes[20] === 0x2f) { const value = view.getUint32(21, true); width = (value & 16383) + 1; height = ((value >>> 14) & 16383) + 1; }
  } else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    mimeType = 'image/jpeg'; let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      const length = view.getUint16(offset); if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; }
      offset += length;
    }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000) throw new Error('图片文件头无效，或尺寸超过 4000 万像素 / 单边 16384。');
  if (file.name) { const expected = /\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : ''; if (expected !== mimeType) throw new Error('图片扩展名与真实文件类型不一致。'); }
  return { width, height, mimeType };
}

/** Keep the original intact; derive a bounded browser-decoded PNG for model input. */
export async function createModelImage(file: File, signal?: AbortSignal): Promise<File> {
  await inspectImageHeader(file, signal); checkAbort(signal);
  const bitmap = await createImageBitmap(file);
  try {
    checkAbort(signal); if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('解码后的图片尺寸超过上限。');
    let side = Math.min(2048, Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 10; attempt++) {
      checkAbort(signal); const ratio = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(bitmap.width * ratio)); canvas.height = Math.max(1, Math.floor(bitmap.height * ratio));
      const context = canvas.getContext('2d'); if (!context) throw new Error('当前环境无法处理图片，请重新选择图片。');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片模型版本生成失败。')), 'image/png'));
      checkAbort(signal); canvas.width = 1; canvas.height = 1;
      if (png.size <= 2 * MiB) return new File([png], file.name.replace(/\.[^.]+$/, '').slice(0, 160) + '-model.png', { type: 'image/png' });
      side = Math.max(32, Math.floor(side * Math.min(0.8, Math.sqrt(2 * MiB / png.size) * 0.9)));
    }
    throw new Error('图片无法压缩到 2 MiB，请选择更小的图片。');
  } finally { bitmap.close(); }
}

export async function uploadFile(call: AttachmentCall, sessionId: string, file: File, options: { signal?: AbortSignal; mimeType?: string; onProgress?(received: number, size: number): void; onReference?(ref: string): void } = {}): Promise<AttachmentRef> {
  checkAbort(options.signal);
  const started = await call('ui.chat.attachment.begin', { id: sessionId, name: file.name, size: file.size, mimeType: options.mimeType || file.type || 'application/octet-stream' }) as AttachmentRef;
  if (!/^[a-f0-9]{32}$/.test(started.ref)) throw new Error('附件服务返回了无效引用。');
  options.onReference?.(started.ref);
  try {
    let offset = 0;
    while (offset < file.size) {
      checkAbort(options.signal); const bytes = new Uint8Array(await file.slice(offset, offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer()); checkAbort(options.signal);
      const result = await call('ui.chat.attachment.chunk', { id: sessionId, ref: started.ref, offset, data: encodeChunk(bytes) }) as { received: number };
      if (result.received !== offset + bytes.length) throw new Error('上传分块偏移不一致，请重试。');
      offset = result.received; options.onProgress?.(offset, file.size);
    }
    checkAbort(options.signal); const ready = await call('ui.chat.attachment.finish', { id: sessionId, ref: started.ref }) as AttachmentRef; checkAbort(options.signal);
    if (ready.ref !== started.ref || ready.status !== 'ready') throw new Error('附件未完成保存。');
    return ready;
  } catch (error) {
    // References remain available to the caller for a second cleanup attempt.
    try { await call('ui.chat.attachment.remove', { id: sessionId, ref: started.ref }); } catch { /* The panel reports cleanup failures using its retained reference set. */ }
    throw error;
  }
}

export async function readFileAttachment(call: AttachmentCall, sessionId: string, attachment: AttachmentRef, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<{ blob: Blob; truncated: boolean }> {
  const cap = Math.min(attachment.size, options.maxBytes ?? attachment.size), parts: BlobPart[] = []; let offset = 0;
  while (offset < cap) {
    checkAbort(options.signal); const result = await call('ui.chat.attachment.read', { id: sessionId, ref: attachment.ref, offset, maxBytes: Math.min(ATTACHMENT_CHUNK_BYTES, cap - offset) }) as { ref: string; offset: number; data: string; nextOffset: number; size: number };
    const bytes = decodeChunk(result.data);
    if (result.ref !== attachment.ref || result.offset !== offset || result.size !== attachment.size || bytes.length < 1 || bytes.length > ATTACHMENT_CHUNK_BYTES || result.nextOffset !== offset + bytes.length || result.nextOffset > cap) throw new Error('附件读取范围不一致。');
    parts.push(bytes.buffer as ArrayBuffer); offset = result.nextOffset;
  }
  checkAbort(options.signal); return { blob: new Blob(parts, { type: attachment.mimeType }), truncated: offset < attachment.size };
}
export type AttachmentPreview = { attachment: AttachmentRef; kind: 'image' | 'text' | 'file'; url?: string; text?: string; truncated?: boolean };
export async function previewAttachment(call: AttachmentCall, sessionId: string, attachment: AttachmentRef, signal?: AbortSignal): Promise<AttachmentPreview> {
  if (attachment.kind === 'image') { const { blob } = await readFileAttachment(call, sessionId, attachment, { signal }); return { attachment, kind: 'image', url: URL.createObjectURL(blob) }; }
  if (attachment.kind === 'text') { const { blob, truncated } = await readFileAttachment(call, sessionId, attachment, { signal, maxBytes: ATTACHMENT_CHUNK_BYTES }); return { attachment, kind: 'text', text: await blob.text(), truncated }; }
  return { attachment, kind: 'file' };
}

type UploadJob = { key: string; sessionId: string; file: File; controller: AbortController; refs: Set<string>; status: 'queued' | 'uploading' | 'processing' | 'cancelling' | 'error' | 'cancelled'; progress: number; error?: string };
type Capabilities = { supported?: boolean; status?: string; externalAgent?: boolean };
type AttachmentController = ReturnType<typeof useAttachmentController>;
type PanelProps = { capabilityKey?:string; sessionId: string; files: AttachmentRef[]; onChange(files: AttachmentRef[]): void; disabled?: boolean; call: AttachmentCall };

function useAttachmentController({ sessionId, files, onChange, disabled = false, call,capabilityKey='' }: PanelProps) {
  const [jobs, setJobs] = useState<UploadJob[]>([]), [error, setError] = useState(''), [limits, setLimits] = useState(defaults), [capabilities, setCapabilities] = useState<Capabilities>({});
  const [preview, setPreview] = useState<AttachmentPreview | null>(null), [previewBusy, setPreviewBusy] = useState(false), [removing, setRemoving] = useState<string[]>([]);
  const jobsRef = useRef(new Map<string, UploadJob>()), queueRef = useRef(Promise.resolve()), sessionRef = useRef(sessionId), filesRef = useRef(files), callRef = useRef(call), changeRef = useRef(onChange), limitsRef = useRef(limits), previewRef = useRef(preview), previewAbort = useRef<AbortController | null>(null);
  sessionRef.current = sessionId; filesRef.current = files; callRef.current = call; changeRef.current = onChange; limitsRef.current = limits; previewRef.current = preview;
  const publish = () => setJobs([...jobsRef.current.values()].filter(job => job.sessionId === sessionRef.current));
  const updateFiles = (next: AttachmentRef[]) => { filesRef.current = next; changeRef.current(next); };
  const closePreview = () => { previewAbort.current?.abort(); if (previewRef.current?.url) URL.revokeObjectURL(previewRef.current.url); previewRef.current = null; setPreview(null); setPreviewBusy(false); };
  useEffect(() => {
    let live = true; setError(''); setCapabilities({}); closePreview();
    void callRef.current('ui.chat.attachment.limits', {}).then(value => { if (live) setLimits(value as AttachmentLimits); }).catch(cause => { if (live) setError('附件限额读取失败：' + describeError(cause)); });
    if(sessionId)void callRef.current('ui.chat.attachment.list',{id:sessionId}).then(value=>{const ready=(value as {files?:AttachmentRef[]})?.files;if(live&&filesRef.current.length===0&&Array.isArray(ready)&&ready.length)changeRef.current(ready);}).catch(()=>{ /* Existing drafts remain intact if the optional restore query fails. */ });
    if (sessionId) void callRef.current('ui.chat.attachment.capabilities', { id: sessionId }).then(value => { if (live) setCapabilities(value as Capabilities); }).catch(() => { if (live) setCapabilities({ status: 'unknown' }); });
    return () => { live = false; previewAbort.current?.abort(); if (previewRef.current?.url) URL.revokeObjectURL(previewRef.current.url); for (const job of jobsRef.current.values()) if (job.sessionId === sessionId) job.controller.abort(); };
  }, [sessionId]);

  useEffect(()=>{let live=true;setCapabilities({status:'unknown'});if(sessionId)void callRef.current('ui.chat.attachment.capabilities',{id:sessionId}).then(value=>{if(live)setCapabilities(value as Capabilities);}).catch(()=>{if(live)setCapabilities({status:'unknown'});});return()=>{live=false;};},[sessionId,capabilityKey]);

  async function cleanup(job: UploadJob) {
    const failed: string[] = [];
    // Original removal may also remove its model version. Not-found is already clean.
    for (const ref of job.refs) { try { await callRef.current('ui.chat.attachment.remove', { id: job.sessionId, ref }); } catch (cause) { const message = describeError(cause); if (!/ATTACHMENT_NOT_FOUND|不存在|已删除/.test(message)) failed.push(ref); } }
    if (failed.length) throw new Error('部分临时附件清理失败，请重试移除。');
    job.refs.clear();
  }
  function schedule(job: UploadJob) {
    queueRef.current = queueRef.current.then(async () => {
      try {
        checkAbort(job.controller.signal); if (sessionRef.current !== job.sessionId) throw abortError();
        const kind = kindOf(job.file); let imageInfo: Awaited<ReturnType<typeof inspectImageHeader>> | undefined;
        if (kind === 'image') imageInfo = await inspectImageHeader(job.file, job.controller.signal);
        job.status = 'uploading'; publish();
        let ready = await uploadFile((method, params) => callRef.current(method, params), job.sessionId, job.file, { signal: job.controller.signal, mimeType: imageInfo?.mimeType,
          onReference: ref => job.refs.add(ref), onProgress: (received, size) => { job.progress = (received / size) * (kind === 'image' ? 82 : 99); publish(); } });
        if (kind === 'image') {
          job.status = 'processing'; job.progress = 84; publish(); const model = await createModelImage(job.file, job.controller.signal); checkAbort(job.controller.signal);
          const modelRef = await uploadFile((method, params) => callRef.current(method, params), job.sessionId, model, { signal: job.controller.signal, onReference: ref => job.refs.add(ref), onProgress: (received, size) => { job.progress = 88 + 11 * received / size; publish(); } });
          checkAbort(job.controller.signal); ready = await callRef.current('ui.chat.attachment.derive', { id: job.sessionId, ref: ready.ref, modelRef: modelRef.ref }) as AttachmentRef;
        }
        checkAbort(job.controller.signal); if (sessionRef.current !== job.sessionId) throw abortError();
        updateFiles([...filesRef.current, ready]); job.refs.clear(); jobsRef.current.delete(job.key); publish();
      } catch (cause) {
        job.status = job.controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError') ? 'cancelled' : 'error'; job.error = describeError(cause);
        try { await cleanup(job); } catch (cleanupError) { job.status = 'error'; job.error += ' ' + describeError(cleanupError); }
        publish();
      }
    }).catch(cause => { setError(describeError(cause)); });
  }
  function addFiles(input: FileList | readonly File[] | Iterable<File>) {
    if (disabled || !sessionId) return;
    setError('');
    for (const file of Array.from(input)) {
      try {
        const kind = kindOf(file), currentLimits = limitsRef.current, cap = kind === 'image' ? currentLimits.imageMiB : kind === 'archive' ? currentLimits.archiveMiB : currentLimits.documentMiB;
        const pending = [...jobsRef.current.values()].filter(job => job.sessionId === sessionId && !['error', 'cancelled'].includes(job.status));
        if (!file.size || file.size > cap * MiB) throw new Error(`${file.name} 超过此类型的 ${cap} MiB 限额，或文件为空。`);
        if (filesRef.current.length + pending.length >= currentLimits.count) throw new Error(`每条消息最多 ${currentLimits.count} 个附件。`);
        if (filesRef.current.reduce((sum, item) => sum + item.size, 0) + pending.reduce((sum, item) => sum + item.file.size, 0) + file.size > currentLimits.messageMiB * MiB) throw new Error(`附件总量超过 ${currentLimits.messageMiB} MiB。`);
        const job: UploadJob = { key: crypto.randomUUID(), sessionId, file, controller: new AbortController(), refs: new Set(), status: 'queued', progress: 0 };
        jobsRef.current.set(job.key, job); publish(); schedule(job);
      } catch (cause) { setError(describeError(cause)); }
    }
  }
  async function remove(file: AttachmentRef) {
    const targetSession = sessionId; setRemoving(value => [...value, file.ref]); setError('');
    try { await callRef.current('ui.chat.attachment.remove', { id: targetSession, ref: file.ref }); if (sessionRef.current === targetSession) { updateFiles(filesRef.current.filter(item => item.ref !== file.ref)); if (previewRef.current?.attachment.ref === file.ref) closePreview(); } }
    catch (cause) { if (sessionRef.current === targetSession) setError(describeError(cause)); }
    finally { setRemoving(value => value.filter(ref => ref !== file.ref)); }
  }
  async function retry(job: UploadJob) { try { await cleanup(job); job.controller = new AbortController(); job.status = 'queued'; job.error = ''; job.progress = 0; publish(); schedule(job); } catch (cause) { setError(describeError(cause)); } }
  async function dismiss(job: UploadJob) { job.controller.abort(); try { await cleanup(job); jobsRef.current.delete(job.key); publish(); } catch (cause) { setError(describeError(cause)); } }
  function cancel(job: UploadJob) { job.status = 'cancelling'; job.controller.abort(); publish(); }
  async function showPreview(file: AttachmentRef) {
    closePreview(); setPreviewBusy(true); setError(''); const targetSession = sessionId, controller = new AbortController(); previewAbort.current = controller;
    try { const result = await previewAttachment((method, params) => callRef.current(method, params), targetSession, file, controller.signal); if (controller.signal.aborted || sessionRef.current !== targetSession) { if (result.url) URL.revokeObjectURL(result.url); return; } previewRef.current = result; setPreview(result); }
    catch (cause) { if (!controller.signal.aborted && sessionRef.current === targetSession) setError(describeError(cause)); }
    finally { if (previewAbort.current === controller) setPreviewBusy(false); }
  }
  async function download(file: AttachmentRef) {
    setPreviewBusy(true); setError(''); const controller = new AbortController(); previewAbort.current?.abort(); previewAbort.current = controller;
    try { const { blob } = await readFileAttachment((method, params) => callRef.current(method, params), sessionId, file, { signal: controller.signal }); checkAbort(controller.signal); const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30000); }
    catch (cause) { if (!controller.signal.aborted) setError(describeError(cause)); }
    finally { if (previewAbort.current === controller) setPreviewBusy(false); }
  }
  async function saveLimits(patch: Partial<AttachmentLimits>) { setError(''); try { setLimits(await callRef.current('ui.chat.attachment.limits.set', patch) as AttachmentLimits); } catch (cause) { setError(describeError(cause)); } }
  const activeJobs = jobs.filter(job => job.sessionId === sessionId), pending = activeJobs.some(job => !['error', 'cancelled'].includes(job.status)) || removing.length > 0;
  return { call: (method: string, params: Record<string, unknown>) => callRef.current(method, params), sessionId, files, disabled, jobs: activeJobs, error, limits, capabilities, pending, preview, previewBusy, removing, addFiles, remove, cancel, retry, dismiss, showPreview, closePreview, download, saveLimits };
}

const panelStyle = `.chat-attachments{font-size:12px;color:inherit}.chat-attachments button,.chat-attachments input{font:inherit}.chat-attachments button{border:1px solid var(--border,#dbe1d5);background:var(--surface,#fffef9);color:inherit;border-radius:7px;padding:5px 9px;cursor:pointer}.chat-attachments button:disabled{opacity:.45;cursor:default}.attachment-thumbnail{flex:0 0 64px;display:block;width:64px;height:64px;object-fit:contain;border-radius:6px;background:var(--background,#f3f5ee)}.attachment-thumbnail-placeholder{display:grid;place-content:center;color:var(--text-secondary,#788174);font-size:10px;text-align:center}.attachment-controls{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:6px 0}.attachment-controls small{color:var(--text-secondary,#788174);font-size:10px}.attachment-items{display:flex;flex-wrap:wrap;gap:7px;margin:7px 0}.attachment-item{border:1px solid var(--border,#dbe1d5);border-radius:9px;background:var(--surface,#fffef9);padding:9px 10px;display:flex;gap:10px;align-items:center;max-width:100%;min-width:200px}.attachment-item>div{min-width:0;flex:1}.attachment-item strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;font-size:12px}.attachment-item small{display:block;color:var(--text-secondary,#788174);font-size:10px;margin-top:4px}.attachment-item button{border:0;background:transparent;padding:3px 5px;font-size:11px}.attachment-item progress{width:100%;height:4px;accent-color:#64835a;margin-top:5px}.attachment-error{color:#9a5938;font-size:11px;margin:6px 0;overflow-wrap:anywhere}.attachment-preview{margin:10px 0;padding:12px;border:1px solid var(--border,#dbe1d5);border-radius:9px;background:var(--surface,#fffef9)}.attachment-preview header{display:flex;justify-content:space-between;align-items:center;gap:12px}.attachment-preview img{display:block;max-width:100%;max-height:360px;object-fit:contain;margin:12px auto}.attachment-preview pre{max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.7 Consolas,monospace}.attachment-preview p{font-size:11px;line-height:1.7;color:var(--text-secondary,#788174)}.attachment-settings{font-size:10px;color:var(--text-secondary,#788174)}.attachment-settings summary{cursor:pointer}.attachment-settings form{display:flex;flex-wrap:wrap;gap:8px;align-items:end;padding:9px 0}.attachment-settings label{display:grid;gap:4px}.attachment-settings input{width:65px;padding:4px;border:1px solid var(--border,#dbe1d5);border-radius:6px;background:var(--surface,#fffef9);color:inherit}.attachment-drag-hint{font-size:10px;color:var(--text-secondary,#788174)}`;

/** Display only the bounded model version; Blob URLs never enter attachment DTOs. */
export function AttachmentThumbnail({ sessionId, file, call }: { sessionId: string; file: AttachmentRef; call: AttachmentCall }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  const callRef = useRef(call); callRef.current = call;
  useEffect(() => {
    let active = true, ownedUrl = ''; const controller = new AbortController();
    setUrl(''); setError('');
    if (file.modelRef) void (async () => {
      try {
        const model = await callRef.current('ui.chat.attachment.describe', { id: sessionId, ref: file.modelRef }) as AttachmentRef;
        checkAbort(controller.signal);
        if (model.kind !== 'image' || model.mimeType !== 'image/png' || model.size > 2 * MiB || model.originalRef !== file.ref) throw new Error('模型图片版本不可用于缩略图。');
        const result = await readFileAttachment((method, params) => callRef.current(method, params), sessionId, model, { signal: controller.signal, maxBytes: 2 * MiB });
        checkAbort(controller.signal); if (result.truncated) throw new Error('模型图片版本不完整。');
        ownedUrl = URL.createObjectURL(result.blob); if (active) setUrl(ownedUrl); else URL.revokeObjectURL(ownedUrl);
      } catch (cause) { if (active && !controller.signal.aborted) setError(describeError(cause)); }
    })();
    return () => { active = false; controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [sessionId, file.ref, file.modelRef]);
  return url ? <img loading="lazy" className="attachment-thumbnail" src={url} alt={`${file.name} 缩略图`} width={64} height={64} /> : <span className="attachment-thumbnail attachment-thumbnail-placeholder" role="status" title={error || '正在读取模型图片版本'}>{error ? '预览暂不可用' : '图片'}</span>;
}
function AttachmentPanelView({ controller: c }: { controller: AttachmentController }) {
  const picker = useRef<HTMLInputElement | null>(null);
  return <div className="chat-attachments" onPaste={event => { const picked = Array.from(event.clipboardData.files); if (picked.length) { event.preventDefault(); event.stopPropagation(); c.addFiles(picked); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); c.addFiles(event.dataTransfer.files); } }}><style>{panelStyle}</style>
    <div className="attachment-controls"><input ref={picker} type="file" multiple accept={accept} aria-label="选择图片或文件附件" style={{ display: 'none' }} disabled={c.disabled || !c.sessionId} onChange={event => { if (event.currentTarget.files) c.addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} /><button type="button" disabled={c.disabled || !c.sessionId} onClick={() => picker.current?.click()}>添加图片 / 文件</button><small>图片 {c.limits.imageMiB} · 文档 {c.limits.documentMiB} · ZIP {c.limits.archiveMiB} MiB · {c.files.length}/{c.limits.count} 个</small><span className="attachment-drag-hint">支持粘贴图片和拖放文件</span></div>
    {(c.files.length > 0 || c.jobs.length > 0) && <div className="attachment-items">{c.files.map(file => <article className="attachment-item" key={file.ref}>{file.kind === 'image' && <AttachmentThumbnail sessionId={c.sessionId} file={file} call={c.call} />}<div><strong title={file.name}>{file.name}</strong><small>{attachmentSize(file.size)} · {file.kind === 'image' ? `原图已保留${file.quality ? ` · 模型 ${file.quality.width}×${file.quality.height}` : ''}` : file.kind === 'archive' ? 'ZIP 原文件' : file.kind === 'text' ? '文本 / 源码' : '文档原文件'}</small></div><button type="button" disabled={c.previewBusy} onClick={() => void c.showPreview(file)}>预览</button><button type="button" aria-label={`移除 ${file.name}`} disabled={c.disabled || c.removing.includes(file.ref)} onClick={() => void c.remove(file)}>{c.removing.includes(file.ref) ? '移除中' : '移除'}</button></article>)}{c.jobs.map(job => <article className="attachment-item" key={job.key}><div><strong title={job.file.name}>{job.file.name}</strong><small>{job.status === 'queued' ? '排队中' : job.status === 'processing' ? '生成模型图片' : job.status === 'uploading' ? `上传 ${Math.floor(job.progress)}%` : job.status === 'cancelling' ? '取消并清理中' : job.status === 'cancelled' ? '已取消' : '上传失败'} · {attachmentSize(job.file.size)}</small>{!['error', 'cancelled'].includes(job.status) && <progress aria-label={`${job.file.name} 上传进度`} max={100} value={job.progress} />}{job.error && <p className="attachment-error" role="alert">{job.error}</p>}</div>{['error', 'cancelled'].includes(job.status) ? <><button type="button" disabled={c.disabled} onClick={() => void c.retry(job)}>重试</button><button type="button" onClick={() => void c.dismiss(job)}>移除</button></> : <button type="button" disabled={job.status === 'cancelling'} onClick={() => c.cancel(job)}>取消</button>}</article>)}</div>}
    {c.error && <p className="attachment-error" role="alert">{c.error}</p>}{c.previewBusy && <p role="status">正在读取附件… <button type="button" onClick={c.closePreview}>取消</button></p>}
    {c.preview && <section className="attachment-preview" aria-label="附件预览"><header><strong>{c.preview.attachment.name}</strong><button type="button" onClick={c.closePreview}>关闭预览</button></header>{c.preview.kind === 'image' && <img src={c.preview.url} alt={c.preview.attachment.name} />}{c.preview.kind === 'text' && <><pre>{c.preview.text}</pre>{c.preview.truncated && <p>预览只显示前 128 KiB，原文件已完整保存。</p>}</>}{c.preview.kind === 'file' && <p>{c.preview.attachment.kind === 'archive' ? 'ZIP 原文件已保存在本机，内容需通过受控的本地处理器读取。' : '文档原文件已保存在本机，可下载后用对应应用查看。'}</p>}<p>{attachmentSize(c.preview.attachment.size)} · {c.preview.attachment.mimeType}{c.preview.attachment.sha256 ? ` · SHA-256 ${c.preview.attachment.sha256.slice(0, 16)}…` : ''}</p><button type="button" disabled={c.previewBusy} onClick={() => void c.download(c.preview!.attachment)}>下载原文件</button></section>}
    {c.files.some(file => file.kind === 'image') && <p className="attachment-drag-hint">{c.capabilities.externalAgent ? '原图与模型版本保存在本机；外部 Agent 按实际接入能力读取。' : c.capabilities.supported === true ? '当前模型支持图片输入，发送模型版本，原图保留在本机。' : '当前模型的图片支持尚未确认，发送前将由 Core 校验。'}</p>}
    <details className="attachment-settings"><summary>附件限额设置 · 每条消息总计 {c.limits.messageMiB} MiB</summary><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void c.saveLimits(Object.fromEntries(['imageMiB', 'documentMiB', 'archiveMiB', 'messageMiB', 'count'].map(key => [key, Number(data.get(key))]))); }}>{([{ key: 'imageMiB', label: '图片 MiB', max: 100 }, { key: 'documentMiB', label: '文档 MiB', max: 500 }, { key: 'archiveMiB', label: 'ZIP MiB', max: 1024 }, { key: 'messageMiB', label: '总计 MiB', max: 2048 }, { key: 'count', label: '附件数量', max: 50 }] as const).map(field => <label key={`${field.key}-${c.limits[field.key]}`}>{field.label}<input type="number" name={field.key} min={1} max={field.max} step={1} defaultValue={c.limits[field.key]} required disabled={c.disabled} /></label>)}<button type="submit" disabled={c.disabled}>保存限额</button></form></details>
  </div>;
}

export function AttachmentPanel(props: PanelProps) { const controller = useAttachmentController(props); return <AttachmentPanelView controller={controller} />; }
const emptyFiles: AttachmentRef[] = [];
export function useChatAttachments({ sessionId, call, disabled = false,capabilityKey='' }: { sessionId: string; call: AttachmentCall; disabled?: boolean;capabilityKey?:string }) {
  const [drafts, setDrafts] = useState<Record<string, AttachmentRef[]>>({}); const files = drafts[sessionId] ?? emptyFiles;
  const setFiles: Dispatch<SetStateAction<AttachmentRef[]>> = useCallback(value => setDrafts(current => ({ ...current, [sessionId]: typeof value === 'function' ? value(current[sessionId] ?? []) : value })), [sessionId]);
  const controller = useAttachmentController({ sessionId, call, disabled, files, onChange: setFiles,capabilityKey });
  const onPaste = (event: ClipboardEvent<HTMLElement>) => { if (event.clipboardData.files.length) { event.preventDefault(); controller.addFiles(event.clipboardData.files); } };
  const onDrop = (event: DragEvent<HTMLElement>) => { if (event.dataTransfer.files.length) { event.preventDefault(); controller.addFiles(event.dataTransfer.files); } };
  const onDragOver = (event: DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); };
  return { files, setFiles, addFiles: controller.addFiles, onPaste, onDrop, onDragOver, pending: controller.pending, ui: <AttachmentPanelView controller={controller} /> };
}
