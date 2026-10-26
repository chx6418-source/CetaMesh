import crypto from 'node:crypto';
import path from 'node:path';

export function environmentError(code, message) { return Object.assign(new Error(message), { code }); }
const fail = (code, message) => { throw environmentError(code, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const id = /^[a-zA-Z0-9_:.\-]{1,160}$/;
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('ENV_SCHEMA_INVALID', 'Unexpected environment fields');
}
export function validateLimits(value) {
  const ranges = {cpuCount:[1,4],memoryMiB:[4096,8192],diskGiB:[32,128],timeoutMs:[10000,3600000],maxEvidenceBytes:[1024,67108864],maxEvidenceFiles:[1,128]};
  keys(value,Object.keys(ranges));
  for (const [key,[min,max]] of Object.entries(ranges)) if (!Number.isSafeInteger(value[key]) || value[key]<min || value[key]>max) fail('ENV_LIMIT_INVALID', `Invalid ${key}`);
  return structuredClone(value);
}
export function validateBinding(value, {now=Date.now(),allowExpired=false}={}) {
  keys(value,['version','actor','taskId','attemptId','runId','environmentId','workspaceId','capability','expiresAt','profileId','profileDigest','limits']);
  keys(value.actor,['kind','id']);
  if (value.version!==1 || !['owner','agent'].includes(value.actor.kind) || !id.test(value.actor.id || '') || !uuid.test(value.runId || '') || !uuid.test(value.environmentId || '') || ['taskId','attemptId','workspaceId','profileId'].some(k=>!id.test(value[k] || '')) || value.capability!=='environment.test' || !hash.test(value.profileDigest || '')) fail('ENV_IDENTITY_INVALID','Invalid environment authority binding');
  if (!Number.isSafeInteger(value.expiresAt) || (!allowExpired && value.expiresAt<=now)) fail('ENV_AUTH_EXPIRED','Environment authorization expired');
  validateLimits(value.limits);
  return structuredClone(value);
}
export const BACKENDS = Object.freeze(['hyper-v','windows-sandbox','linux-vm','container','android','agentos'].map(id=>Object.freeze({id,implemented:id==='hyper-v'})));
export function validateProfile(value) {
  keys(value,['version','id','backend','mode','network','image','candidate','guestCredentialFile','limits','packIds','retainedLimit']);
  if (value.backend!=='hyper-v') fail('ENV_BACKEND_UNAVAILABLE','Backend is not implemented');
  if (value.network!=='offline') fail('ENV_NETWORK_UNSUPPORTED','Only offline profiles are implemented');
  if(value.version!==1 || !id.test(value.id || '') || !['lifecycle-fixture','cetamesh'].includes(value.mode) || value.retainedLimit!==1) fail('ENV_SCHEMA_INVALID','Invalid profile');
  keys(value.image,['id','path','sha256','source','windowsBuild','architecture']);
  if(!id.test(value.image.id || '') || !path.isAbsolute(value.image.path || '') || !hash.test(value.image.sha256 || '') || value.image.source!=='owner-approved-local-image' || !/^\d{4,6}$/.test(value.image.windowsBuild || '') || value.image.architecture!=='x64' || !path.isAbsolute(value.guestCredentialFile || '')) fail('ENV_SCHEMA_INVALID','Invalid approved image or credential reference');
  if(!Array.isArray(value.packIds) || !value.packIds.length || new Set(value.packIds).size!==value.packIds.length || value.packIds.some(p=>!/^W0[1-7]$/.test(p))) fail('ENV_SCHEMA_INVALID','Invalid pack selection');
  validateLimits(value.limits);
  if(value.candidate!==null) {
    keys(value.candidate,['root','installer','installerSha256','manifestSha256','buildCommit','buildHash']);
    const c=value.candidate;
    if(!path.isAbsolute(c.root || '') || c.installer!=='WhaleBridge.exe' || !hash.test(c.installerSha256 || '') || !hash.test(c.manifestSha256 || '') || !/^[0-9a-f]{40}$/.test(c.buildCommit || '') || !hash.test(c.buildHash || '')) fail('ENV_SCHEMA_INVALID','Invalid candidate provenance');
    if(c.buildHash!==c.manifestSha256)fail('ENV_SCHEMA_INVALID','Build hash must pin the complete input inventory');
  } else if(value.mode==='cetamesh') fail('ENV_SCHEMA_INVALID','Product acceptance requires a built candidate');
  return structuredClone(value);
}
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function sha256(value) { return crypto.createHash('sha256').update(typeof value==='string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex'); }
export function profileDigest(value) { return sha256(validateProfile(value)); }
export function summarizeResults(results) {
  const order=['FAIL','INCONCLUSIVE','BLOCKED_ENV','NOT_RUN','PASS'];
  if(!Array.isArray(results) || results.some(r=>!order.includes(r.status))) fail('ENV_RESULT_INVALID','Invalid test status');
  return order.find(status=>results.some(r=>r.status===status)) || 'NOT_RUN';
}
