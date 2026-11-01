import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {parseJsonText,writeJsonAtomic} from '../storage/json-file.js';
import {SIMULATION_LIMITS as LIMITS,simulationError,localId,normalizeBudget} from './types.js';
const statuses=['idle','running','paused','completed','failed'];
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const safeText=(value,max)=>typeof value==='string'&&value.length<=max&&!value.includes('\0');
function validUsage(u){return u&&['complete','unknown'].includes(u.accounting)&&['modelCalls','completedCalls','unknownCalls'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)&&['inputTokens','outputTokens','reservedTokens','reservedCost'].every(k=>nonnegative(u[k]))&&u.cost&&['unknown','estimated'].includes(u.cost.status)&&nonnegative(u.cost.knownAmount)&&(u.cost.amount===null||nonnegative(u.cost.amount))&&(u.cost.currency===null||/^[A-Z]{3}$/.test(u.cost.currency));}
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
function validRoom(r){
 if(!plain(r)||!localId(r.id)||!Number.isSafeInteger(r.rev)||r.rev<1||!statuses.includes(r.status)
  ||!safeText(r.title,200)||!safeText(r.scene,2000)||!safeText(r.goal,4000)
  ||!timestamp(r.createdAt)||!timestamp(r.updatedAt)||!validUsage(r.usage))return false;
 if(!Array.isArray(r.roleIds)||!r.roleIds.length||r.roleIds.length>LIMITS.rolesPerRoom||!r.roleIds.every(localId)||new Set(r.roleIds).size!==r.roleIds.length)return false;
 if(!Array.isArray(r.roleRefs)||r.roleRefs.length!==r.roleIds.length||r.roleRefs.some((ref,i)=>!plain(ref)||ref.id!==r.roleIds[i]||!Number.isSafeInteger(ref.revision)||ref.revision<1||!safeText(ref.name,256)||!(/^[a-f0-9]{64}$/).test(ref.sourceHash??'')))return false;
 if(!Array.isArray(r.messages)||r.messages.length>LIMITS.messagesPerRoom||r.messages.some(m=>{
  if(!plain(m)||!localId(m.id)||!['user','discussion','notice','project'].includes(m.kind)||!safeText(m.text,m.kind==='user'?LIMITS.messageChars:LIMITS.outputChars)||!timestamp(m.createdAt))return true;
  if(m.kind==='discussion'?!localId(m.roleId):m.roleId!==null)return true;
  if(m.stage!==(m.kind==='discussion'?'simulated':'recorded'))return true;
  return m.trace!==undefined&&(!plain(m.trace)||Buffer.byteLength(JSON.stringify(m.trace))>32768);
 })||new Set(r.messages.map(m=>m.id)).size!==r.messages.length)return false;
 if(!Array.isArray(r.tasks)||r.tasks.length>LIMITS.tasksPerRoom||r.tasks.some(t=>!plain(t)||!localId(t.id)||Buffer.byteLength(JSON.stringify(t))>32768))return false;
 if(!Array.isArray(r.requests)||r.requests.length>LIMITS.requestsPerRoom||r.requests.some(q=>{
  if(!plain(q)||!localId(q.id)||!['pending','completed','unknown'].includes(q.status)||!(/^[a-f0-9]{64}$/).test(q.hash??''))return true;
  if(q.kind==='message')return !localId(q.messageId)||!r.messages.some(m=>m.id===q.messageId&&m.kind==='user');
  if(q.kind==='project')return q.taskId!==null&&(!localId(q.taskId)||!r.tasks.some(t=>t.id===q.taskId));
  return true;
 })||new Set(r.requests.map(q=>q.id)).size!==r.requests.length)return false;
 if(['modelProvider','model'].some(k=>r[k]!==null&&!safeText(r[k],300))||(r.workspaceId!==null&&!localId(r.workspaceId)))return false;
 try{if(JSON.stringify(canonical(normalizeBudget(r.budget)))!==JSON.stringify(canonical(r.budget)))return false;}catch{return false;}
 if(r.status==='running'){
  const run=r.activeRun;
  if(!plain(run)||!localId(run.id)||!['reply','discussion'].includes(run.kind)||!timestamp(run.startedAt)
   ||!Number.isSafeInteger(run.maxTurns)||run.maxTurns<1||run.maxTurns>6||!Number.isSafeInteger(run.turns)||run.turns<0||run.turns>run.maxTurns
   ||(run.currentRoleId!==null&&!r.roleIds.includes(run.currentRoleId)))return false;
 }else if(r.activeRun!==null)return false;
 return true;
}
// Check every existing component, including StateDir ancestors and Windows junctions.
// The Core StateDir lease remains the cross-process boundary; these checks do not
// claim to defeat an adversarial local filesystem writer racing each syscall.
function checkedPath(target,{directory=false,missing=true}={}){
 const absolute=path.resolve(target);let cursor=path.parse(absolute).root;
 for(const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,segment);let stat;
  try{stat=fs.lstatSync(cursor);}catch(error){if(error.code==='ENOENT'&&missing)return null;throw simulationError('SIMULATION_STORE_UNAVAILABLE');}
  if(stat.isSymbolicLink()||(stat.isFile()&&stat.nlink!==1)|| (cursor!==absolute&&!stat.isDirectory()) || (cursor===absolute&&(directory?!stat.isDirectory():!stat.isFile())))throw simulationError('SIMULATION_STORE_UNAVAILABLE');
 }
 return fs.lstatSync(absolute);
}
function readBoundedState(file){
 const stat=checkedPath(file);if(!stat)return {version:1,rooms:[]};
 if(stat.size>LIMITS.storeBytes)throw simulationError('SIMULATION_STORE_UNAVAILABLE');
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  const before=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)throw simulationError('SIMULATION_STORE_UNAVAILABLE');
  const bytes=Buffer.alloc(Math.min(LIMITS.storeBytes+1,stat.size+1));let length=0;
  while(length<bytes.length){const read=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!read)break;length+=read;}
  const after=fs.fstatSync(fd);
  if(length!==stat.size||length>LIMITS.storeBytes||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw simulationError('SIMULATION_STORE_UNAVAILABLE');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));
  return parseJsonText(text,{file:'simulation-rooms'});
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
/** Single Core owner; bounded file IO reuses JSON parsing and atomic-write primitives. */
export function createRoomStore({stateDir,now=()=>Date.now()}){
 const file=path.join(stateDir,'simulation','rooms.json');let state;
 try{state=readBoundedState(file);}catch{throw simulationError('SIMULATION_STORE_UNAVAILABLE');}
 if(state?.version!==1||!Array.isArray(state.rooms)||state.rooms.length>LIMITS.rooms||state.rooms.some(r=>!validRoom(r))||new Set(state.rooms.map(r=>r.id)).size!==state.rooms.length)throw simulationError('SIMULATION_STORE_UNAVAILABLE');
 function persist(next){if(Buffer.byteLength(JSON.stringify(next,null,2)+'\n')>LIMITS.storeBytes)throw simulationError('SIMULATION_STORE_FULL');try{checkedPath(file);fs.mkdirSync(path.dirname(file),{recursive:true});checkedPath(path.dirname(file),{directory:true,missing:false});checkedPath(file);writeJsonAtomic(file,next);}catch{throw simulationError('SIMULATION_STORE_UNAVAILABLE');}state=next;}
 let recovered=false;const next=structuredClone(state);
 for(const r of next.rooms){if(r.status==='running'||r.activeRun||r.requests.some(q=>q.status==='pending')){r.status='paused';r.activeRun=null;r.usage.accounting='unknown';r.usage.cost.status='unknown';r.usage.cost.amount=null;r.lastError={code:'SIMULATION_RESTART_OUTCOME_UNKNOWN',at:now()};for(const q of r.requests)if(q.status==='pending')q.status='unknown';r.rev++;recovered=true;}}
 if(recovered)persist(next);
 return Object.freeze({id:prefix=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`,list:()=>structuredClone(state.rooms),get(id){if(!localId(id))throw simulationError('SIMULATION_ROOM_NOT_FOUND');const r=state.rooms.find(r=>r.id===id);if(!r)throw simulationError('SIMULATION_ROOM_NOT_FOUND');return structuredClone(r);},create(room){if(state.rooms.length>=LIMITS.rooms)throw simulationError('SIMULATION_STORE_FULL');const next=structuredClone(state);next.rooms.push(structuredClone(room));if(!validRoom(room))throw simulationError('SIMULATION_INPUT_INVALID');persist(next);return structuredClone(room);},update(id,mutate,expectedRev){const current=this.get(id);if(expectedRev!==undefined&&current.rev!==expectedRev)throw simulationError('SIMULATION_REV_CONFLICT');const updated=mutate(structuredClone(current))??current;updated.rev=current.rev+1;updated.updatedAt=now();if(!validRoom(updated))throw simulationError('SIMULATION_STORE_FULL');const next=structuredClone(state);next.rooms[next.rooms.findIndex(r=>r.id===id)]=updated;persist(next);return structuredClone(updated);}});
}
