import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {Unzip,UnzipInflate} from 'fflate';
import {pluginCenterError as error} from './catalog.js';

// Larger, independently supplied native engines have a separate bounded profile.
// The ordinary Extension ZIP limits and its node_modules prohibition stay intact.
const MAX_COMPRESSED=128*1024*1024,MAX_EXPANDED=512*1024*1024,MAX_ENTRIES=20000;
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const invalid=message=>error('PACKAGE_PATH_INVALID',message);
function checkedName(raw){
 const name=raw.replace(/\\/g,'/').replace(/\/$/,'');
 if(!name||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f<>:"|?*]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw invalid('插件包包含不安全的文件路径。');
 if(name.split('/').some(part=>/^(?:\.git|\.ssh|\.npm|\.env(?:\..*)?)$/i.test(part))||/\.(?:pem|key|p12|pfx|secret|credentials)$/i.test(name))throw error('PACKAGE_FORBIDDEN_FILE','插件包不能包含凭据或版本库私有文件。');
 return name;
}
async function centralDirectory(handle,size){
 const tail=Buffer.alloc(Math.min(size,65557));await handle.read(tail,0,tail.length,size-tail.length);
 let end=-1;
 for(let p=tail.length-22;p>=0;p--)if(tail.readUInt32LE(p)===0x06054b50&&p+22+tail.readUInt16LE(p+20)===tail.length){end=p;break;}
 if(end<0||tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw error('PACKAGE_INVALID','请选择完整的单卷 ZIP 插件安装包。');
 const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
 if(!count||count>MAX_ENTRIES||length>4*1024*1024||offset+length>size-tail.length+end||tail.readUInt16LE(end+8)!==count)throw error('PACKAGE_TOO_LARGE','插件包目录超出限制或使用不支持的 ZIP64 格式。');
 const bytes=Buffer.alloc(length);await handle.read(bytes,0,length,offset);
 const rows=new Map(),folded=new Set();let p=0,total=0;
 for(let i=0;i<count;i++){
  if(p+46>length||bytes.readUInt32LE(p)!==0x02014b50)throw error('PACKAGE_INVALID','插件包目录损坏。');
  const flags=bytes.readUInt16LE(p+8),method=bytes.readUInt16LE(p+10),crc=bytes.readUInt32LE(p+16),compressed=bytes.readUInt32LE(p+20),expanded=bytes.readUInt32LE(p+24);
  const n=bytes.readUInt16LE(p+28),extra=bytes.readUInt16LE(p+30),comment=bytes.readUInt16LE(p+32),kind=(bytes.readUInt32LE(p+38)>>>16)&0xf000;
  if(!n||p+46+n+extra+comment>length||(flags&1)||![0,8].includes(method)||![0,0x4000,0x8000].includes(kind))throw error('PACKAGE_INVALID','不支持加密、链接或特殊文件插件包。');
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(p+46,p+46+n)),name=checkedName(raw),directory=/[\\/]$/.test(raw);
  if(folded.has(name.toLowerCase()))throw invalid('插件包包含重复或大小写冲突的路径。');
  folded.add(name.toLowerCase());total+=expanded;
  if(total>MAX_EXPANDED||compressed>MAX_COMPRESSED)throw error('PACKAGE_TOO_LARGE','插件解压大小超出 512 MB 限制。');
  rows.set(raw,{name,directory,crc,expanded,method});p+=46+n+extra+comment;
 }
 if(p!==length)throw error('PACKAGE_INVALID','插件包目录长度不匹配。');
 return {rows,total};
}
export async function cleanupRuntimeStage(stage){
 if(!stage?.directory||!stage?.stagingRoot)return;
 const root=await fsp.realpath(stage.stagingRoot),target=path.resolve(stage.directory);
 if(path.dirname(target)!==root||!path.basename(target).startsWith('runtime-stage-'))throw invalid('拒绝清理非所属暂存目录。');
 try{if(await fsp.realpath(target)!==target||(await fsp.lstat(target)).isSymbolicLink())throw invalid('暂存目录归属已变化。');}
 catch(cause){if(cause.code==='ENOENT')return;throw cause;}
 await fsp.rm(target,{recursive:true,force:true});
}
export async function extractRuntimePackage(file,stagingRoot){
 if(typeof file!=='string'||!path.isAbsolute(file)||!['.zip','.cmpkg'].includes(path.extname(file).toLowerCase()))throw error('PACKAGE_INVALID','请选择 ZIP 插件安装包。');
 const resolved=await fsp.realpath(file),stat=await fsp.lstat(resolved);
 if(!stat.isFile()||stat.size<22||stat.size>MAX_COMPRESSED)throw error('PACKAGE_TOO_LARGE','插件压缩包必须小于 128 MB。');
 const handle=await fsp.open(resolved,'r');let stage;
 const open=new Set();
 try{
  const {rows,total}=await centralDirectory(handle,stat.size);
  await fsp.mkdir(stagingRoot,{recursive:true});stagingRoot=await fsp.realpath(stagingRoot);
  const directory=await fsp.mkdtemp(path.join(stagingRoot,'runtime-stage-'));stage={directory,stagingRoot};
  let failure,actualTotal=0;const seen=new Set(),hash=crypto.createHash('sha256');
  const unzip=new Unzip(entry=>{
   const meta=rows.get(entry.name);
   if(!meta||seen.has(entry.name)||entry.compression!==meta.method){failure=error('PACKAGE_INVALID','ZIP 文件头与目录不一致。');return;}
   seen.add(entry.name);const destination=path.join(directory,...meta.name.split('/'));
   if(meta.directory){fs.mkdirSync(destination,{recursive:true});entry.ondata=cause=>{if(cause)failure=cause;};entry.start();return;}
   fs.mkdirSync(path.dirname(destination),{recursive:true});const fd=fs.openSync(destination,'wx',0o600);open.add(fd);let bytes=0,crc=0xffffffff;
   entry.ondata=(cause,data,final)=>{
    if(cause){failure=error('PACKAGE_INVALID','插件压缩数据损坏。');return;}
    bytes+=data.length;actualTotal+=data.length;
    if(bytes>meta.expanded||actualTotal>MAX_EXPANDED){failure=error('PACKAGE_TOO_LARGE','插件实际解压大小与目录不符。');entry.terminate();return;}
    for(const byte of data)crc=crcTable[(crc^byte)&255]^(crc>>>8);
    let offset=0;while(offset<data.length)offset+=fs.writeSync(fd,data,offset,data.length-offset);
    if(final){fs.closeSync(fd);open.delete(fd);if(bytes!==meta.expanded||((crc^0xffffffff)>>>0)!==meta.crc)failure=error('PACKAGE_INVALID','插件文件完整性校验失败。');}
   };entry.start();
  });unzip.register(UnzipInflate);
  // Yield between bounded compressed chunks: a large engine must not freeze Core RPC.
  for await(const chunk of handle.createReadStream({start:0,autoClose:false,highWaterMark:32*1024})){
   hash.update(chunk);unzip.push(chunk,false);if(failure)throw failure;await yieldIO();
  }
  unzip.push(new Uint8Array(),true);if(failure)throw failure;
  if(seen.size!==rows.size||open.size||actualTotal!==total)throw error('PACKAGE_INVALID','插件包内容不完整。');
  return {...stage,sha256:hash.digest('hex'),files:rows.size,bytes:actualTotal};
 }catch(cause){for(const fd of open)fs.closeSync(fd);if(stage)await cleanupRuntimeStage(stage);if(cause.code)throw cause;throw error('PACKAGE_INVALID','无法读取插件 ZIP 安装包。');}
 finally{await handle.close();}
}
export async function findRuntimeRoot(directory){
 let root=directory;
 for(let depth=0;depth<4;depth++){
  const entries=await fsp.readdir(root,{withFileTypes:true});
  const agentos=entries.some(row=>row.name==='agentos.system.json'),reverselab=entries.some(row=>row.name==='engine.lock.json');
  if(agentos&&reverselab)throw error('PACKAGE_INVALID','同一安装包不能包含两个插件根目录。');
  if(agentos||reverselab)return {id:agentos?'agentos':'reverselab',root};
  if(entries.length!==1||!entries[0].isDirectory())break;
  root=path.join(root,entries[0].name);
 }
 throw error('ENGINE_PACKAGE_NOT_SUPPORTED','此包不含可安装的 AgentOS 或逆向分析实验室运行文件。');
}
