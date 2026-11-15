import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {resolveInside} from './boundary.js';
import {gitRun} from './tools.js';
import {observeGitMutation,assertGitMutationExpected,acquireGitMutationIndexLock,readGitMutationIndex} from './git-index-actions.js';
import {temporaryGitIndex,prepareTargetBytes} from './git-branch-actions.js';
import {applyWorkspaceByteTransaction} from './transaction.js';

const fail=(code,message,extra={})=>{throw Object.assign(new Error(message),{code,...extra});};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sameNode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const active=signal=>{if(signal?.aborted)fail('INVOKE_CANCELLED','Checkpoint operation cancelled before its next phase');};
const sensitive=rel=>rel.split('/').some(part=>/^(?:\.git|\.codex|\.ssh|\.aws|\.azure|\.gnupg|\.cetamesh|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|private_keys|id_(?:rsa|ed25519|ecdsa)|known_hosts|authorized_keys)$/i.test(part));
function pathsOf(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>100||rows.reduce((n,row)=>n+(typeof row==='string'?row.length:0),0)>8000)fail('GIT_CHECKPOINT_LIMIT','A checkpoint requires 1–100 exact dirty files within 8000 path characters; no partial backup is published');
 const seen=new Set();for(const rel of rows){if(typeof rel!=='string'||!rel||rel.length>1024||rel.includes('\0')||rel.includes('\\')||path.isAbsolute(rel)||/^[A-Za-z]:/.test(rel)||rel.split('/').some(p=>!p||p==='.'||p==='..'))fail('GIT_PATH_INVALID','Checkpoint paths must be exact normalized files');
  if(sensitive(rel))fail('SENSITIVE_RESOURCE','Sensitive files are excluded; preserve them independently before checkpointing');
  const key=process.platform==='win32'?rel.toLowerCase():rel;if(seen.has(key)||[...seen].some(p=>p.startsWith(key+'/')||key.startsWith(p+'/')))fail('GIT_PATH_INVALID','Overlapping or aliased checkpoint paths are unsupported');seen.add(key);}
 return rows;
}
const dirtyPaths=meta=>[...new Set(meta.status.entries.flatMap(row=>[row.path,...(row.origPath?[row.origPath]:[])]))].sort();
const dirtyIdentity=meta=>digest(JSON.stringify(meta.status.entries));
const binding=meta=>({expectedHead:meta.headSha,expectedHeadRef:meta.headRef,expectedRepositoryIdentity:meta.repositoryIdentity,indexIdentity:meta.index.identity,
 expectedHashes:Object.fromEntries([...meta.files].map(([rel,file])=>[rel,file.hash])),expectedWorkingModes:Object.fromEntries([...meta.files].map(([rel,file])=>[rel,file.stat?file.stat.mode&0o7777:null])),expectedDirtyIdentity:dirtyIdentity(meta)});
const run=(meta,args,options={})=>gitRun(meta.root,args,{...options,literalPaths:true,repository:meta.repository,referenceBackend:{format:meta.refFormat,root:meta.commonDir}});
function assertBinding(meta,input,original){assertGitMutationExpected(meta,input,original);if(dirtyIdentity(meta)!==input.expectedDirtyIdentity||JSON.stringify(binding(meta).expectedWorkingModes)!==JSON.stringify(input.expectedWorkingModes))fail('GIT_WORKTREE_CHANGED','The reviewed dirty scope or file modes changed; review again');}
function readBytes(root,rel,expected){const file=resolveInside(root,rel,{forWrite:true}).absolute,stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>10*1024*1024)fail('GIT_PATH_INVALID','Checkpoint source must be a bounded regular file');const bytes=fs.readFileSync(file);if(digest(bytes)!==expected)fail('WORKSPACE_CONFLICT','Checkpoint source changed while capturing');return bytes;}
const decode=(value,limit)=>{if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('GIT_CHECKPOINT_CORRUPT','Invalid checkpoint byte payload');return Buffer.from(value,'base64');};

/** Workspace-owned immutable artifacts, not an execution or Task store. */
export function createGitCheckpoints({stateDir,nativeExecutable,record=()=>{}}){
 const knownNoEffect=new WeakSet();
 function directory(entry,create=false){
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(entry.id))fail('GIT_CHECKPOINT_CORRUPT','Invalid Workspace checkpoint identity');
  fs.mkdirSync(stateDir,{recursive:true});const root=fs.realpathSync.native(stateDir);let current=root;const nodes=[];
  for(const name of ['workspace-checkpoints',entry.id]){current=path.join(current,name);if(!fs.existsSync(current)){if(!create)return null;fs.mkdirSync(current,{mode:0o700});}const stat=fs.lstatSync(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(current)!==current)fail('GIT_CHECKPOINT_STORE_CHANGED','Checkpoint storage cannot traverse links');nodes.push([current,stat]);}
  return {path:current,assertOwned(){if(fs.realpathSync.native(stateDir)!==root)fail('GIT_CHECKPOINT_STORE_CHANGED','StateDir identity changed');for(const [location,node]of nodes){const stat=fs.lstatSync(location,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameNode(stat,node))fail('GIT_CHECKPOINT_STORE_CHANGED','Checkpoint storage identity changed');}}};
 }
 function load(entry,id){
  if(typeof id!=='string'||!/^checkpoint-[a-f0-9]{64}$/.test(id))fail('GIT_CHECKPOINT_INVALID','Select an existing checkpoint');const dir=directory(entry);if(!dir)fail('GIT_CHECKPOINT_NOT_FOUND','Checkpoint is unavailable');
  const file=path.join(dir.path,id+'.json');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>132*1024*1024)fail('GIT_CHECKPOINT_CORRUPT','Checkpoint must be a bounded regular artifact');
  const saved=readJsonFile(file,{maxBytes:132*1024*1024});dir.assertOwned();
  const {id:_id,...content}=saved??{};if(id!=='checkpoint-'+digest(JSON.stringify(content)))fail('GIT_CHECKPOINT_CORRUPT','Checkpoint content identity changed');
  if(saved?.schema!==1||saved.id!==id||saved.workspaceId!==entry.id||saved.root!==entry.root||!hash(saved.repositoryIdentity)||!hash(saved.indexSha256)||!Array.isArray(saved.files)||!Array.isArray(saved.blobs)||saved.blobs.length>100)fail('GIT_CHECKPOINT_CORRUPT','Checkpoint does not belong to this Workspace');
  pathsOf(saved.files.map(row=>row.path));let total=0;for(const row of saved.files){if(!(row.sha256===null||hash(row.sha256))||row.sha256===null&&row.bytes!==null)fail('GIT_CHECKPOINT_CORRUPT','Invalid saved file identity');if(row.sha256!==null){const bytes=decode(row.bytes,10*1024*1024);if(digest(bytes)!==row.sha256||(total+=bytes.length)>64*1024*1024)fail('GIT_CHECKPOINT_CORRUPT','Saved file bytes do not match checkpoint');}}
  if(digest(decode(saved.index,32*1024*1024))!==saved.indexSha256)fail('GIT_CHECKPOINT_CORRUPT','Saved index bytes changed');
  for(const row of saved.blobs){const bytes=decode(row.bytes,10*1024*1024);if(!/^[a-f0-9]{40}$/.test(row.oid)||crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')!==row.oid||(total+=bytes.length)>96*1024*1024)fail('GIT_CHECKPOINT_CORRUPT','Saved staged content changed');}
  return {saved,sha256:digest(JSON.stringify(saved))};
 }
 const summary=(saved,sha256)=>({workspaceId:saved.workspaceId,id:saved.id,sha256,label:saved.label,createdAt:saved.createdAt,head:saved.head,headRef:saved.headRef,paths:saved.files.map(row=>row.path),bytes:saved.files.reduce((n,row)=>n+(row.bytes?Buffer.byteLength(row.bytes,'base64'):0),0),indexSha256:saved.indexSha256,ignoredIncluded:false});
 async function capture(entry,{label='',signal}={}){
  active(signal);let meta=await observeGitMutation(entry,[]);const paths=pathsOf(dirtyPaths(meta));meta=await observeGitMutation(entry,paths);const request={paths,...binding(meta)};
  if(!meta.headSha||!meta.index.bytes)fail('GIT_CHECKPOINT_HEAD_REQUIRED','Commit a baseline before creating a Git checkpoint');
  if((await run(meta,['rev-parse','--shared-index-path'],{signal})).stdout.trim())fail('GIT_CHECKPOINT_INDEX_UNSUPPORTED','A split index requires explicit native normalization before checkpoint capture');
  const files=paths.map(rel=>({path:rel,sha256:meta.files.get(rel).hash,mode:meta.files.get(rel).stat?.mode&0o7777,bytes:meta.files.get(rel).hash===null?null:readBytes(meta.root,rel,meta.files.get(rel).hash).toString('base64')}));
  const blobs=[];let size=meta.total;for(const oid of new Set(paths.map(rel=>meta.entries.get(rel)?.oid).filter(Boolean))){const bytes=(await run(meta,['cat-file','blob',oid],{signal,binaryOutput:true,maxOutputBytes:10*1024*1024})).stdout;if(!Buffer.isBuffer(bytes)||(size+=bytes.length)>96*1024*1024)fail('GIT_CHECKPOINT_LIMIT','Staged checkpoint content exceeds the byte bound');blobs.push({oid,bytes:bytes.toString('base64')});}
  const final=await observeGitMutation(entry,paths);assertBinding(final,request,meta);active(signal);
  const content={schema:1,workspaceId:entry.id,root:entry.root,label:String(label).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120),createdAt:Date.now(),repositoryIdentity:meta.repositoryIdentity,head:meta.headSha,headRef:meta.headRef,files,index:meta.index.bytes.toString('base64'),indexSha256:meta.index.identity,blobs,dirtyIdentity:dirtyIdentity(meta)};
  const saved={...content,id:'checkpoint-'+digest(JSON.stringify(content))};if(Buffer.byteLength(JSON.stringify(saved))+1>132*1024*1024)fail('GIT_CHECKPOINT_LIMIT','Complete checkpoint artifact exceeds its bound; nothing was published');
  const dir=directory(entry,true);if(fs.readdirSync(dir.path).filter(name=>/^checkpoint-[a-f0-9]{64}\.json$/.test(name)).length>=20)fail('GIT_CHECKPOINT_LIMIT','20 retained checkpoints reached; no existing checkpoint is automatically removed');
  dir.assertOwned();writeJsonAtomic(path.join(dir.path,saved.id+'.json'),saved,{indent:0});dir.assertOwned();const verified=load(entry,saved.id);record(entry,'owner','git.checkpoint.capture',saved.id);return summary(verified.saved,verified.sha256);
 }
 function list(entry){const dir=directory(entry);if(!dir)return {workspaceId:entry.id,entries:[],ignoredIncluded:false};const names=fs.readdirSync(dir.path).filter(name=>/^checkpoint-[a-f0-9]{64}\.json$/.test(name));if(names.length>20)fail('GIT_CHECKPOINT_LIMIT','Checkpoint archive exceeds the supported bound');return {workspaceId:entry.id,entries:names.map(name=>{const row=load(entry,name.slice(0,-5));return summary(row.saved,row.sha256);}).sort((a,b)=>b.createdAt-a.createdAt),ignoredIncluded:false};}
 function preview(entry,{checkpointId,path:rel}={}){const {saved,sha256}=load(entry,checkpointId);const row=saved.files.find(item=>item.path===rel);if(!row)fail('GIT_CHECKPOINT_PATH_INVALID','Select a saved exact file');const bytes=row.bytes===null?null:decode(row.bytes,10*1024*1024),binary=!!bytes&&bytes.subarray(0,8000).includes(0);return {workspaceId:entry.id,checkpointId,checkpointSha256:sha256,path:rel,sha256:row.sha256,deleted:bytes===null,binary,truncated:!!bytes&&bytes.length>64000,content:bytes&&!binary?bytes.subarray(0,64000).toString('utf8'):'',byteLength:bytes?.length??0};}
 async function prepare(entry,input,signal,checkExpected){
  active(signal);if(!['saved','head'].includes(input.mode))fail('GIT_CHECKPOINT_MODE_INVALID','Select saved restore or original HEAD preparation');const artifact=load(entry,input.checkpointId),{saved}=artifact,paths=pathsOf(saved.files.map(row=>row.path));
  const meta=await observeGitMutation(entry,paths);if(meta.repositoryIdentity!==saved.repositoryIdentity)fail('GIT_REPOSITORY_CHANGED','Checkpoint repository identity changed');if(meta.headSha!==saved.head||meta.headRef!==saved.headRef)fail('GIT_CHECKPOINT_HEAD_CHANGED','Return explicitly to the checkpoint original branch and HEAD before restore; cross-branch merge is not supported');
  if(input.mode==='saved'&&meta.status.entries.some(row=>row.x!==' '&&row.x!=='?'&&(!paths.includes(row.path)||row.origPath&&!paths.includes(row.origPath))))fail('GIT_CHECKPOINT_SCOPE_CHANGED','Unrelated staged content is outside this checkpoint; preserve or reconcile it before restoring the saved index');
  if(checkExpected){if(input.checkpointSha256!==artifact.sha256||JSON.stringify(input.paths)!==JSON.stringify(paths))fail('GIT_CHECKPOINT_CHANGED','Checkpoint differs from approved artifact');assertBinding(meta,input);}
  if(input.mode==='head'&&(meta.index.identity!==saved.indexSha256||dirtyIdentity(meta)!==saved.dirtyIdentity||saved.files.some(row=>meta.files.get(row.path).hash!==row.sha256)))fail('GIT_CHECKPOINT_SOURCE_CHANGED','Working or staged content changed since capture; save a new checkpoint before cleaning');
  active(signal);return {...artifact,paths,meta};
 }
 async function review(entry,input,{signal}={}){const p=await prepare(entry,input,signal,false);return {workspaceId:entry.id,checkpointId:p.saved.id,checkpointSha256:p.sha256,mode:input.mode,paths:p.paths,...binding(p.meta),ignoredIncluded:false};}
 async function restore(entry,input,{signal,application}={}){
  let p;try{p=await prepare(entry,input,signal,true);application.assertAvailable();}catch(error){knownNoEffect.add(error);throw error;}
  const {saved,meta,paths}=p;let lock,temporary,raw,result,attempted=false;
  try{
   lock=acquireGitMutationIndexLock(meta);let changes,indexBytes;
   if(input.mode==='head'){temporary=temporaryGitIndex();changes=await prepareTargetBytes(meta,saved.head,paths,temporary,signal);indexBytes=readGitMutationIndex(temporary.indexFile).bytes;}
   else{changes=saved.files.map(row=>({path:row.path,action:row.sha256===null?'delete':'write',expectedHash:meta.files.get(row.path).hash,...(row.sha256===null?{}:{bytes:decode(row.bytes,10*1024*1024)})}));indexBytes=decode(saved.index,32*1024*1024);}
   changes=changes.filter(row=>row.action!=='delete'||row.expectedHash!==null);
   assertBinding(await observeGitMutation(entry,paths),input,meta);lock.assertOwned();active(signal);application.assertAvailable();
   // Retained staged blobs may have been pruned after capture. Recreate only
   // their exact verified objects in the same pinned repository before index use.
   if(input.mode==='saved'){temporary=temporaryGitIndex();for(const blob of saved.blobs){temporary.assertOwned();const file=path.join(temporary.directory,blob.oid);fs.writeFileSync(file,decode(blob.bytes,10*1024*1024),{flag:'wx',mode:0o600});const oid=(await run(meta,['hash-object','-w','--no-filters','--',file],{signal})).stdout.trim();if(oid!==blob.oid)fail('GIT_CHECKPOINT_CORRUPT','Restored staged object differs from the saved identity');}}
   assertBinding(await observeGitMutation(entry,paths),input,meta);active(signal);application.assertAvailable();
   if(changes.length){attempted=true;raw=await applyWorkspaceByteTransaction(meta.root,changes,{nativeExecutable,signal,beforeCommit:application.assertAvailable,owner:{kind:'git-checkpoint-restore',workspaceId:entry.id,checkpointId:saved.id,checkpointSha256:p.sha256,mode:input.mode,repositoryIdentity:meta.repositoryIdentity,targetHead:meta.headSha,targetBranch:meta.headRef,dispatchBinding:application.dispatchBinding}});application.retainTransaction(raw);raw.assertApplied();}
   const targetHashes=Object.fromEntries(changes.map(row=>[row.path,row.action==='delete'?null:digest(row.bytes)]));
   const afterFiles=await observeGitMutation(entry,paths);assertGitMutationExpected(afterFiles,{...input,expectedHashes:{...input.expectedHashes,...targetHashes}});raw?.assertApplied();lock.assertOwned();active(signal);application.assertAvailable();attempted=true;lock.replace(indexBytes);
   const final=await observeGitMutation(entry,paths);assertGitMutationExpected(final,{...input,indexIdentity:digest(indexBytes),expectedHashes:{...input.expectedHashes,...targetHashes}});raw?.assertApplied();if(input.mode==='head'&&final.status.entries.length)fail('GIT_WORKTREE_CHANGED','Uncaptured dirty state appeared; branch switch remains blocked');
   result={workspaceId:entry.id,checkpointId:saved.id,checkpointSha256:p.sha256,mode:input.mode,phase:'completed',targetHead:meta.headSha,targetBranch:meta.headRef,indexIdentity:final.index.identity,paths,postHashes:Object.fromEntries([...final.files].map(([rel,file])=>[rel,file.hash]))};
   if(raw){result.nativeReceiptSha256=raw.receiptSha256;raw.recordGitCompletion({schema:1,requestSha256:raw.evidence.requestSha256,dispatchBinding:application.dispatchBinding,invocationBinding:application.dispatchBinding,result});result.byteTransaction=raw.evidence;result.cleanupPending=true;application.deferSettlement(result,raw);}
   return result;
  }catch(error){if(!attempted||!raw&&error.effectStatus==='none'){knownNoEffect.add(error);throw error;}throw Object.assign(new Error('Checkpoint application is unconfirmed; retained original bytes and operation evidence require Owner review before any further write'),{code:'GIT_CHECKPOINT_REVIEW_REQUIRED',effectStatus:'unknown',causeCode:error.code,...(raw?{byteTransaction:raw.evidence}:error.byteTransaction?{byteTransaction:error.byteTransaction}:{})});}
  finally{const pending=[];for(const [resource,kind]of [[lock,'git-index-lock'],[temporary,'temporary-git-index']])if(resource)try{resource.release();}catch{pending.push({kind,id:resource.id??'index.lock',identity:resource.identity??resource.ownershipIdentity});}if(result&&pending.length)Object.assign(result,{cleanupPending:true,cleanupResources:pending});}
 }
 return {captureCheckpoint:capture,listCheckpoints:list,previewCheckpoint:preview,reviewCheckpoint:review,restoreCheckpoint:restore,
  validateCheckpointRestore:async(entry,input)=>{await prepare(entry,input,undefined,true);return {valid:true};},isKnownCheckpointNoEffectError:error=>knownNoEffect.has(error)};
}
