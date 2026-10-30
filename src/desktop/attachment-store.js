// Extends Chat's local attachment namespace. Only random references cross IPC;
// each chunk is bounded below the existing native frame limit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {imageDimensions,validateModelImage} from './image-validation.js';

const MiB=1024*1024;
export const ATTACHMENT_DEFAULTS=Object.freeze({imageMiB:20,documentMiB:100,archiveMiB:200,messageMiB:250,count:20,storageMiB:2048,reserveMiB:256,incompleteHours:24});
const ceilings={imageMiB:100,documentMiB:500,archiveMiB:1024,messageMiB:2048,count:50,storageMiB:65536,reserveMiB:8192,incompleteHours:168};
const fault=(code,message)=>Object.assign(new Error(message),{code});
const fail=(code,message)=>{throw fault(code,message);};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const TEXT_EXT=/\.(?:txt|md|csv|json|js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|c|h|cpp|css|html|xml|yaml|yml|toml|ini|log|sql|sh|ps1)$/i;
export function createAttachmentStore({stateDir,now=()=>Date.now()}={}) {
  fs.mkdirSync(stateDir,{recursive:true});if(fs.lstatSync(stateDir).isSymbolicLink())fail('ATTACHMENT_PATH_DENIED','StateDir不可为链接');
  const stateReal=fs.realpathSync.native(stateDir),root=path.join(stateReal,'desktop-chat','attachment-files');
  function ensureRoot(){let current=stateReal;for(const name of ['desktop-chat','attachment-files']){current=path.join(current,name);if(!fs.existsSync(current))fs.mkdirSync(current);
      const st=fs.lstatSync(current);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync.native(current)!==current)fail('ATTACHMENT_PATH_DENIED','附件路径不可经过链接');}}
  ensureRoot();
  const limitFile=path.join(root,'limits.json');
  function limits(){ensureRoot();if(fs.existsSync(limitFile))regular(limitFile);const saved=readJsonFile(limitFile,{missing:{}});for(const [k,v] of Object.entries(saved))if(!Object.hasOwn(ceilings,k)||!Number.isSafeInteger(v)||v<1||v>ceilings[k])fail('ATTACHMENT_LIMITS_CORRUPT','附件配额配置损坏，请在设置中核对');return {...ATTACHMENT_DEFAULTS,...saved};}
  function setLimits(patch){if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('INVALID_PARAMS','附件限额需要对象');
    for(const [key,value] of Object.entries(patch))if(!Object.hasOwn(ceilings,key)||!Number.isSafeInteger(value)||value<1||value>ceilings[key])fail('INVALID_PARAMS','附件限额超出合理范围：'+key);
    const value={...limits(),...patch};writeJsonAtomic(limitFile,value);return value;}
  const sessionDir=id=>{ensureRoot();return path.join(root,hash(String(id)));};
  function location(id,ref){if(!/^[a-f0-9]{32}$/.test(ref??''))fail('ATTACHMENT_NOT_FOUND','附件引用无效');
    const dir=sessionDir(id);if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())fail('ATTACHMENT_PATH_DENIED','附件目录不可为链接');
    return {dir,meta:path.join(dir,ref+'.json'),file:path.join(dir,ref+'.bin')};}
  function regular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())fail('ATTACHMENT_PATH_DENIED','附件必须为独立常规文件');return s;}
  function row(id,ref){const loc=location(id,ref);let value;try{regular(loc.meta);value=readJsonFile(loc.meta);}catch(error){if(error.code==='ENOENT')fail('ATTACHMENT_NOT_FOUND','附件不存在或已删除');throw error;}
    if(value.ref!==ref||value.session!==hash(String(id)))fail('ATTACHMENT_NOT_FOUND','附件不属于此会话');return {...loc,value};}
  const publicRow=v=>Object.fromEntries(['ref','name','size','kind','mimeType','status','received','sha256','width','height','modelRef','originalRef','quality','createdAt'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]]));
  function usage(){let total=0;let count=0;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      for(const file of fs.readdirSync(path.join(root,entry.name))){if(!file.endsWith('.json'))continue;if(++count>10000)fail('ATTACHMENT_QUOTA','附件条目过多，请清理');
        const p=path.join(root,entry.name,file);regular(p);const r=readJsonFile(p);total+=r.size||0;}}
    return total;}
  function ensureDisk(extra){const l=limits();if(usage()+extra>l.storageMiB*MiB)fail('ATTACHMENT_QUOTA','本地附件存储配额不足，请删除不再需要的附件');
    const stat=fs.statfsSync(root);if(stat.bavail*stat.bsize<extra+l.reserveMiB*MiB)fail('ATTACHMENT_DISK_FULL','磁盘可用空间不足');}
  function kindFor(name,mimeType){if(/\.(png|jpe?g|webp)$/i.test(name))return 'image';if(/\.zip$/i.test(name))return 'archive';
    if(TEXT_EXT.test(name))return 'text';if(/\.(pdf|docx|xlsx|pptx)$/i.test(name))return 'document';fail('ATTACHMENT_TYPE_UNSUPPORTED','支持图片、文本源码、PDF、Office文档和ZIP；不接收可执行文件');}
  function begin(id,{name,size,mimeType='application/octet-stream'}={}){
    if(typeof name!=='string'||!name||name.length>200||/[\x00-\x1f/\\]/.test(name))fail('INVALID_PARAMS','附件名称无效');
    const kind=kindFor(name,mimeType),l=limits(),cap=kind==='image'?l.imageMiB:kind==='archive'?l.archiveMiB:l.documentMiB;
    if(!Number.isSafeInteger(size)||size<1||size>cap*MiB)fail('ATTACHMENT_SIZE_LIMIT','此类型附件超过大小限额');ensureDisk(size);
    const ref=crypto.randomBytes(16).toString('hex'),loc=location(id,ref);fs.mkdirSync(loc.dir,{recursive:true});
    const value={ref,name,size,kind,mimeType:String(mimeType).slice(0,80),session:hash(String(id)),received:0,status:'uploading',createdAt:now()};
    fs.writeFileSync(loc.file,Buffer.alloc(0),{flag:'wx',mode:0o600});writeJsonAtomic(loc.meta,value);return publicRow(value);}
  function chunk(id,{ref,offset,data}={}){const {value,file,meta}=row(id,ref);regular(file);
    if(typeof data!=='string'||data.length>180000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))fail('INVALID_PARAMS','分块编码无效');
    const bytes=Buffer.from(data,'base64');if(!bytes.length||bytes.length>128*1024||!Number.isSafeInteger(offset)||offset<0||offset+bytes.length>value.size)fail('ATTACHMENT_SIZE_LIMIT','分块范围无效');
    const received=fs.statSync(file).size;
    if(offset<received){if(offset+bytes.length>received)fail('ATTACHMENT_CHUNK_CONFLICT','上传分块重叠');const fd=fs.openSync(file,'r');const prior=Buffer.alloc(bytes.length);try{fs.readSync(fd,prior,0,prior.length,offset);}finally{fs.closeSync(fd);}if(!prior.equals(bytes))fail('ATTACHMENT_CHUNK_CONFLICT','重试分块内容已变化');return {ref,received};}
    if(value.status!=='uploading'||offset!==received)fail('ATTACHMENT_CHUNK_CONFLICT','上传偏移不匹配，请查询状态后重试');ensureDisk(0);
    const fd=fs.openSync(file,'r+');try{fs.writeSync(fd,bytes,0,bytes.length,offset);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    value.received=offset+bytes.length;writeJsonAtomic(meta,value);return {ref,received:value.received};}
  function finish(id,{ref}={}){const {value,file,meta}=row(id,ref);const stat=regular(file);if(value.status==='ready')return publicRow(value);
    if(stat.size!==value.size)fail('ATTACHMENT_INCOMPLETE','附件尚未上传完成');
    const fd=fs.openSync(file,'r'),head=Buffer.alloc(Math.min(stat.size,256*1024)),digest=crypto.createHash('sha256');value.chunkHashes=[];
    try{fs.readSync(fd,head,0,head.length,0);const buffer=Buffer.alloc(128*1024);for(let offset=0;offset<stat.size;){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!n)fail('ATTACHMENT_INCOMPLETE','读取附件中断');digest.update(buffer.subarray(0,n));value.chunkHashes.push(hash(buffer.subarray(0,n)));offset+=n;}}finally{fs.closeSync(fd);}
    if(value.kind==='image'){Object.assign(value,imageDimensions(head));const expected=/\.png$/i.test(value.name)?'image/png':/\.webp$/i.test(value.name)?'image/webp':'image/jpeg';if(value.mimeType!==expected)fail('ATTACHMENT_TYPE_MISMATCH','扩展名与图片真实类型不一致');}
    else if(value.kind==='archive'||/\.(docx|xlsx|pptx)$/i.test(value.name)){if(head.length<4||head.readUInt32LE(0)!==0x04034b50)fail('ATTACHMENT_TYPE_MISMATCH','不是有效ZIP类型文件');value.mimeType='application/zip';}
    else if(/\.pdf$/i.test(value.name)){if(head.toString('ascii',0,5)!=='%PDF-')fail('ATTACHMENT_TYPE_MISMATCH','不是有效PDF');value.mimeType='application/pdf';}
    else {if(head.includes(0))fail('ATTACHMENT_TYPE_MISMATCH','文本附件包含二进制字节');value.mimeType='text/plain';}
    value.sha256=digest.digest('hex');value.status='ready';value.received=stat.size;writeJsonAtomic(meta,value);return publicRow(value);}
  function describe(id,ref){return publicRow(row(id,ref).value);}
  function read(id,{ref,offset=0,maxBytes=128*1024}={}){const {value,file}=row(id,ref);if(value.status!=='ready')fail('ATTACHMENT_INCOMPLETE','附件不可读取');
    if(!Number.isSafeInteger(offset)||offset<0||offset>value.size||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>128*1024)fail('INVALID_PARAMS','附件分块范围无效');regular(file);
    if(regular(file).size!==value.size)fail('ATTACHMENT_STORE_CORRUPT','附件大小已改变');
    const b=Buffer.alloc(Math.min(maxBytes,value.size-offset)),fd=fs.openSync(file,'r');try{
      for(let i=Math.floor(offset/(128*1024));b.length&&i<=Math.floor((offset+b.length-1)/(128*1024));i++){const chunk=Buffer.alloc(Math.min(128*1024,value.size-i*128*1024));fs.readSync(fd,chunk,0,chunk.length,i*128*1024);if(hash(chunk)!==value.chunkHashes?.[i])fail('ATTACHMENT_STORE_CORRUPT','附件分块校验失败');}
      fs.readSync(fd,b,0,b.length,offset);
    }finally{fs.closeSync(fd);}
    return {ref,offset,data:b.toString('base64'),nextOffset:offset+b.length,size:value.size,mimeType:value.mimeType};}
  function bytes(id,ref,maxBytes){const {value,file}=row(id,ref);if(value.status!=='ready'||value.size>maxBytes)fail('ATTACHMENT_SIZE_LIMIT','附件超出此处理器限制');regular(file);const b=fs.readFileSync(file);if(hash(b)!==value.sha256)fail('ATTACHMENT_STORE_CORRUPT','附件内容已改变');return b;}
  function derive(id,{ref,modelRef,quality}={}){const source=row(id,ref),derived=row(id,modelRef);if(ref===modelRef||source.value.kind!=='image'||derived.value.kind!=='image'||(derived.value.originalRef&&derived.value.originalRef!==ref))fail('INVALID_PARAMS','图像版本关系无效');
    if(source.value.modelRef&&source.value.modelRef!==modelRef)fail('ATTACHMENT_CHUNK_CONFLICT','已保存的模型图像版本不可替换');
    const info=validateModelImage(bytes(id,modelRef,2*MiB));derived.value.originalRef=ref;source.value.modelRef=modelRef;source.value.quality={width:info.width,height:info.height,format:'image/png',processed:true};
    writeJsonAtomic(derived.meta,derived.value);writeJsonAtomic(source.meta,source.value);return publicRow(source.value);}
  function validateSelection(id,refs){const l=limits();if(!Array.isArray(refs)||refs.length>l.count||new Set(refs).size!==refs.length)fail('ATTACHMENT_COUNT_LIMIT','附件数量超过限额或重复');
    const rows=refs.map(ref=>{const v=describe(id,ref);if(v.status!=='ready')fail('ATTACHMENT_INCOMPLETE','附件未完成');return v;});
    if(rows.reduce((sum,r)=>sum+r.size,0)>l.messageMiB*MiB)fail('ATTACHMENT_SIZE_LIMIT','消息附件总量超过限额');return rows;}
  function modelParts(id,refs,{detail='low'}={}){const parts=[];let total=0;
    for(const file of validateSelection(id,refs)){if(file.kind==='image'){if(!file.modelRef)fail('IMAGE_PROCESSING_REQUIRED','图片尚未生成模型版本');const b=bytes(id,file.modelRef,2*MiB);validateModelImage(b);total+=b.length;if(total>4*MiB)fail('MODEL_IMAGE_LIMIT','模型图片合计超过4MiB，请减少图片或降低尺寸');parts.push({type:'image_url',image_url:{url:'data:image/png;base64,'+b.toString('base64'),detail:detail==='auto'?'auto':'low'}});}
      else if(file.kind==='text'){const preview=read(id,{ref:file.ref,maxBytes:16000});parts.push({type:'text',text:'[附件 '+file.name+'；受控引用 '+file.ref+'；仅前16KiB，全文保存在本机]\n'+Buffer.from(preview.data,'base64').toString('utf8')});}
      else parts.push({type:'text',text:'[本机附件 '+file.name+'；引用 '+file.ref+'；'+file.size+' bytes。此模型没有原生文档或ZIP输入；请经授权导入Workspace/使用本地处理器，不宣称已阅读全文。]'});
    }return parts;}
  function remove(id,ref){const r=row(id,ref);regular(r.file);fs.unlinkSync(r.file);fs.unlinkSync(r.meta);if(r.value.modelRef){try{remove(id,r.value.modelRef);}catch(error){if(error.code!=='ATTACHMENT_NOT_FOUND')throw error;}}return {removed:true};}
  function cleanup(){let removed=0;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;const dir=path.join(root,entry.name);
      for(const name of fs.readdirSync(dir)){if(!/^[a-f0-9]{32}\.json$/.test(name))continue;const meta=path.join(dir,name);regular(meta);const value=readJsonFile(meta);
        if(value.status==='uploading'&&now()-value.createdAt>limits().incompleteHours*3600000){const file=path.join(dir,name.replace('.json','.bin'));regular(file);fs.unlinkSync(file);fs.unlinkSync(meta);removed++;}}}return {removed};}
  function openRead(id,ref){const r=row(id,ref);if(r.value.status!=='ready')fail('ATTACHMENT_INCOMPLETE','附件尚未就绪');regular(r.file);return {fd:fs.openSync(r.file,'r'),metadata:publicRow(r.value)};}
  function list(id){const dir=sessionDir(id);if(!fs.existsSync(dir))return [];if(fs.lstatSync(dir).isSymbolicLink())fail('ATTACHMENT_PATH_DENIED','附件目录不可为链接');const names=fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n));if(names.length>10000)fail('ATTACHMENT_QUOTA','此会话附件过多');return names.map(name=>describe(id,name.slice(0,32)));}
  function removeSession(id){let removed=0;for(const item of list(id)){try{remove(id,item.ref);removed++;}catch(error){if(error.code!=='ATTACHMENT_NOT_FOUND')throw error;}}const dir=sessionDir(id);if(fs.existsSync(dir)&&!fs.readdirSync(dir).length)fs.rmdirSync(dir);return {removed};}
  return Object.freeze({limits,setLimits,begin,chunk,finish,describe,read,bytes,derive,validateSelection,modelParts,remove,cleanup,openRead,list,removeSession});
}
