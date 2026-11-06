import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {resolveInside} from '../workspace/boundary.js';
import {redactText} from '../logging/redact.js';
import {simulationError} from './types.js';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const protectedName=/^(?:credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|config\.json)$|\.(?:pem|key|pfx|p12)$/i;
function sanitizeExcerpt(value){
 const text=String(value??'');
 // The read may end inside JSON or a PEM block. Withhold credential-bearing
 // excerpts rather than relying on a complete document or closing delimiter.
 if(/["'](?:api[-_]?key|access[-_]?key|(?:access|refresh|auth)[-_]?token|token|password|passwd|secrets?|credentials?|authorization|cookie|private[-_]?key|pairing[-_]?secret)["']\s*:/i.test(text))return '[REDACTED:credential-bearing excerpt]';
 return redactText(text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,'[REDACTED:privateKey]'));
}
function relativeFile(value){
 if(typeof value!=='string'||!value||value.length>512||/[\x00-\x1f\x7f:]/.test(value)||/^[\\/]/.test(value))return null;
 const normalized=value.replaceAll('\\','/'),parts=normalized.split('/');
 if(parts.some(part=>!part||part.startsWith('.')||protectedName.test(part))
  ||/^(?:state|private-development-archive|backups)$/i.test(parts[0]))return null;
 return normalized;
}
function checkedFile(root,relative){
 const resolved=resolveInside(root,relative);
 if(!relativeFile(path.relative(root,resolved.real)))throw simulationError('SIMULATION_PROJECT_PATH_DENIED');
 let current=root;
 for(const part of relative.split('/')){
  current=path.join(current,part);const stat=fs.lstatSync(current);
  if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)throw simulationError('SIMULATION_PROJECT_PATH_DENIED');
 }
}

// An Owner-selected project room may receive bounded read-only reference data.
// Personas never get a principal, arbitrary tools, another Workspace or Task grants.
export async function readProjectContext({room,workspaceService,query='',signal,maxChars=8000}){
 if(room.scene!=='project'||!room.workspaceId)return null;
 const source=workspaceService.describeWorkspace(room.workspaceId);
 if(!source)throw simulationError('SIMULATION_WORKSPACE_UNAVAILABLE');
 const check=()=>{if(signal?.aborted)throw simulationError('SIMULATION_CANCELLED');
  const current=workspaceService.describeWorkspace(room.workspaceId);
  if(!current||current.root!==source.root)throw simulationError('SIMULATION_WORKSPACE_CHANGED');};
 const cap=Math.min(8000,Math.max(0,maxChars));
 if(cap<1200)throw simulationError('SIMULATION_CONTEXT_TOO_LARGE');
 check();
 const listing=await workspaceService.execute({method:'workspace.file.search',params:{id:source.id,
  path:'.',glob:'*',maxResults:80,searchRestricted:true,actor:'simulation-project:'+room.id}});
 check();
 const paths=(listing.results??[]).filter(row=>!row.dir).map(row=>relativeFile(row.path)).filter(Boolean);
 const directory=[];let pathChars=0;
 for(const item of paths){if(directory.length>=30||pathChars+item.length>1500)break;directory.push(item);pathChars+=item.length;}
 const requested=[...String(query).matchAll(/(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_.-]+\.[\p{L}\p{N}_-]+/gu)].map(match=>relativeFile(match[0])).filter(Boolean);
 const lower=String(query).toLowerCase();
 const named=paths.filter(file=>lower.includes(file.toLowerCase())||lower.includes(path.posix.basename(file).toLowerCase()));
 const selected=[...new Set([...requested,...named,'README.md','package.json'])].slice(0,3);
 const reference={workspaceId:source.id,access:'read-only',observedAt:Date.now(),
  directory:{paths:directory,truncated:listing.truncated===true||directory.length<paths.length},files:[],unavailable:[]};
 for(const file of selected){
  check();
  try{
   checkedFile(source.root,file);
   const read=await workspaceService.execute({method:'workspace.read',params:{id:source.id,path:file,maxBytes:2048,offset:0,actor:'simulation-project:'+room.id}});
   check();checkedFile(source.root,file);
   if(read.binary){reference.unavailable.push({path:file,code:'BINARY_FILE'});continue;}
   const content=sanitizeExcerpt(read.content);
   reference.files.push({path:file,offset:read.offset,size:read.size,nextOffset:read.nextOffset,truncated:read.truncated===true,
    fileSha256:read.expectedHash??null,excerptSha256:digest(content),redacted:content!==read.content,content});
  }catch(error){
   if(signal?.aborted||error?.code==='SIMULATION_WORKSPACE_CHANGED')throw error;
   reference.unavailable.push({path:file,code:error?.code==='ENOENT'?'FILE_NOT_FOUND':'READ_UNAVAILABLE'});
  }
 }
 while(JSON.stringify(reference).length>cap&&reference.directory.paths.length){reference.directory.paths.pop();reference.directory.truncated=true;}
 while(JSON.stringify(reference).length>cap&&reference.files.length){const omitted=reference.files.pop();reference.unavailable.push({path:omitted.path,code:'CONTEXT_BUDGET'});}
 if(JSON.stringify(reference).length>cap)throw simulationError('SIMULATION_CONTEXT_TOO_LARGE');
 const trace={...reference,files:reference.files.map(({content,...receipt})=>receipt)};
 return {reference,trace};
}
