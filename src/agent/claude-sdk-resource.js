import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Module from 'node:module';
import { APP_PATHS } from '../app-paths.js';
export const CLAUDE_SDK_VERSION = '0.3.308';
export const CLAUDE_SDK_SOURCE_SHA256 = '2134165c8a55a57099360e5f970a60586a8efc278d33404b6e50bdad43d7fdd3';
export const CLAUDE_SDK_RESOURCE_SHA256 = '735c7dd4729ac39bdb58c26e8139548ead25cfe47f8164c3493439bf4482ef0c';
export const CLAUDE_SDK_RESOURCE_FILE = 'agent-sdk/claude-0.3.308.cjs';
const unavailable = () => Object.assign(new Error('CLAUDE_SDK_RESOURCE_UNVERIFIED'), {code:'CLAUDE_SDK_RESOURCE_UNVERIFIED'});
export function verifyClaudeSdkBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 1286220 || crypto.createHash('sha256').update(bytes).digest('hex') !== CLAUDE_SDK_RESOURCE_SHA256) throw unavailable();
  return bytes;
}
/** Load only the exact audited build bytes; no bare SDK lookup or user scripts.
 * Compile the verified buffer itself to prevent a file replacement between hash and execution.
 */
export async function loadClaudeSdkResource({resourceRoot = APP_PATHS.resourceRoot} = {}) {
  try {
    const filename = path.resolve(resourceRoot, CLAUDE_SDK_RESOURCE_FILE);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size !== 1286220) throw unavailable();
    const bytes = verifyClaudeSdkBytes(fs.readFileSync(filename));
    const module = new Module(filename);
    module.filename = filename;
    module.paths = [];
    module._compile(bytes.toString('utf8'), filename);
    if (typeof module.exports.query !== 'function') throw unavailable();
    return module.exports;
  } catch { throw unavailable(); /* No local paths, vendor error text or credentials cross runner boundary. */ }
}
