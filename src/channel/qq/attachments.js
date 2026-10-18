import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInsideRoot } from '../../workspace/boundary.js';
import { validateFetchUrl } from '../../safe-fetch.js';
import { channelError } from '../delivery-journal.js';

export async function assertQqAttachments(params, { config = {}, dataRoot } = {}) {
  const files = [params.file, ...(Array.isArray(params.message) ? params.message : [])
    .filter(segment => ['file', 'record', 'image', 'video'].includes(segment?.type)).map(segment => segment.data?.file)].filter(value => value !== undefined);
  const limit = Math.min(100, Math.max(1, Number(config.fileSend?.maxSizeMb) || 25)) * 1024 * 1024;
  for (const value of files) {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(limit * 4 / 3) + 100) throw channelError('QQ_ATTACHMENT_DENIED', 'Invalid or oversized QQ attachment');
    if (/^https?:\/\//i.test(value)) { await validateFetchUrl(value); continue; }
    if (value.startsWith('base64://')) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.slice(9)) || Buffer.byteLength(value.slice(9), 'base64') > limit) throw channelError('QQ_ATTACHMENT_DENIED', 'Invalid inline QQ attachment');
      continue;
    }
    const local = value.startsWith('file:') ? fileURLToPath(value) : value;
    if (!path.isAbsolute(local)) throw channelError('QQ_ATTACHMENT_DENIED', 'QQ local attachments require explicit absolute paths');
    const roots = [...(Array.isArray(config.fileSend?.localDirs) ? config.fileSend.localDirs : []),
      ...(dataRoot ? [path.join(dataRoot, 'state', 'file-send-cache')] : [])];
    let file;
    try { file = fs.realpathSync(local); }
    catch (error) { throw Object.assign(channelError('QQ_ATTACHMENT_DENIED', 'QQ attachment cannot be read'), { cause: error }); }
    if (!roots.some(root => {
      try { return isInsideRoot(fs.realpathSync(root), file); }
      catch (error) { void error; return false; /* Missing/unverifiable roots never grant local read access. */ }
    })) throw channelError('QQ_ATTACHMENT_DENIED', 'QQ attachment is outside declared local read directories');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) throw channelError('QQ_ATTACHMENT_DENIED', 'QQ attachment exceeds the declared file limit');
  }
}
