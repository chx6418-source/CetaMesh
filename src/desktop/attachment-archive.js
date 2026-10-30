import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createInflateRaw} from 'node:zlib';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const digest=()=>crypto.createHash('sha256');
function safeName(name){if(!name||name.length>512||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.'||/[. ]$/.test(p)||/^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials|secrets|node_modules|CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(p)))fail('ARCHIVE_PATH_DENIED','ZIP含不安全或受保护路径');}
function crcUpdate(c,b){for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return c;}
/** Central directory preflight plus streaming bounded extraction to a NEW owned directory. */
export async function importAttachmentArchive({store,sessionId,ref,stateDir,signal}={}) {
  const {fd,metadata}=store.openRead(sessionId,ref);let stage;
  const read=(offset,n)=>{const b=Buffer.alloc(n);if(fs.readSync(fd,b,0,n,offset)!==n)fail('ARCHIVE_INVALID','ZIP读取中断');return b;};
  try {
    if(metadata.kind!=='archive')fail('ARCHIVE_INVALID','请选择项目ZIP附件');
    const actual=digest();for(let p=0;p<metadata.size;p+=128*1024){if(signal?.aborted)throw signal.reason??Error('Cancelled');actual.update(read(p,Math.min(128*1024,metadata.size-p)));if(p%(1024*1024)===0)await new Promise(resolve=>setImmediate(resolve));}
    if(actual.digest('hex')!==metadata.sha256)fail('ATTACHMENT_STORE_CORRUPT','ZIP内容已改变');
    const n=Math.min(metadata.size,65557),tail=read(metadata.size-n,n);let e=-1;
    for(let p=n-22;p>=0;p--)if(tail.readUInt32LE(p)===0x06054b50&&p+22+tail.readUInt16LE(p+20)===n){e=p;break;}
    if(e<0||tail.readUInt16LE(e+4)||tail.readUInt16LE(e+6))fail('ARCHIVE_INVALID','不支持分卷或损坏ZIP');
    const count=tail.readUInt16LE(e+10),length=tail.readUInt32LE(e+12),offset=tail.readUInt32LE(e+16);
    if(!count||count>5000||length>4*1024*1024||offset+length!==metadata.size-n+e)fail('ARCHIVE_LIMIT','ZIP目录数量/大小超限或需要ZIP64');
    const central=read(offset,length),entries=[],names=new Set();let p=0,total=0;
    for(let i=0;i<count;i++){
      if(p+46>central.length||central.readUInt32LE(p)!==0x02014b50)fail('ARCHIVE_INVALID','ZIP目录损坏');
      const flags=central.readUInt16LE(p+8),method=central.readUInt16LE(p+10),crc=central.readUInt32LE(p+16),compressed=central.readUInt32LE(p+20),size=central.readUInt32LE(p+24),nl=central.readUInt16LE(p+28),extra=central.readUInt16LE(p+30),comment=central.readUInt16LE(p+32),attributes=central.readUInt32LE(p+38),local=central.readUInt32LE(p+42);
      if(p+46+nl+extra+comment>central.length)fail('ARCHIVE_INVALID','ZIP目录溢出');
      let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(central.subarray(p+46,p+46+nl));}catch{fail('ARCHIVE_INVALID','ZIP文件名不是UTF-8');}
      const directory=name.endsWith('/');safeName(directory?name.slice(0,-1):name);
      const key=name.replace(/\/$/,'').normalize('NFC').toLowerCase();if(names.has(key))fail('ARCHIVE_PATH_DENIED','ZIP含重复路径');names.add(key);
      if(flags&1||![0,8].includes(method)||(attributes>>>16&0xf000)===0xa000||size>100*1024*1024||size>Math.max(1,compressed)*100)fail('ARCHIVE_LIMIT','ZIP加密、链接、压缩算法或膨胀比不受支持');
      total+=size;if(total>500*1024*1024)fail('ARCHIVE_LIMIT','ZIP展开总量超过500MiB');
      const header=read(local,30);if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(6)!==flags||header.readUInt16LE(8)!==method)fail('ARCHIVE_INVALID','ZIP本地目录不匹配');
      const hnl=header.readUInt16LE(26),hex=header.readUInt16LE(28),dataOffset=local+30+hnl+hex;
      if(!read(local+30,hnl).equals(Buffer.from(name))||dataOffset+compressed>offset)fail('ARCHIVE_INVALID','ZIP文件范围冲突');
      entries.push({name,directory,size,compressed,method,crc,dataOffset});p+=46+nl+extra+comment;
    }
    if(p!==central.length)fail('ARCHIVE_INVALID','ZIP目录尾部不匹配');
    const parent=path.join(stateDir,'workspace-imports');fs.mkdirSync(parent,{recursive:true});if(fs.lstatSync(parent).isSymbolicLink())fail('ARCHIVE_PATH_DENIED','导入根目录不可为链接');
    const disk=fs.statfsSync(parent);if(disk.bavail*disk.bsize<total+store.limits().reserveMiB*1024*1024)fail('ATTACHMENT_DISK_FULL','项目展开空间不足');
    stage=path.join(parent,crypto.randomBytes(16).toString('hex'));fs.mkdirSync(stage,{mode:0o700});
    for(const entry of entries){if(signal?.aborted)throw signal.reason??Error('Cancelled');const target=path.join(stage,...entry.name.split('/'));
      if(entry.directory){fs.mkdirSync(target,{recursive:true});continue;}fs.mkdirSync(path.dirname(target),{recursive:true});let written=0,crc=0xffffffff;
      const source=Readable.from((async function*(){for(let n=0;n<entry.compressed;n+=128*1024)yield read(entry.dataOffset+n,Math.min(128*1024,entry.compressed-n));})());
      const guard=new Transform({transform(chunk,encoding,callback){written+=chunk.length;if(written>entry.size)return callback(Object.assign(Error('ZIP output limit'),{code:'ARCHIVE_LIMIT'}));crc=crcUpdate(crc,chunk);callback(null,chunk);}});
      await pipeline(...[source,...(entry.method===8?[createInflateRaw()]:[]),guard,fs.createWriteStream(target,{flags:'wx',mode:0o600})],{signal});
      if(written!==entry.size||((crc^0xffffffff)>>>0)!==entry.crc)fail('ARCHIVE_INVALID','ZIP内容大小或CRC不匹配');
    }
    return {root:stage,files:entries.filter(e=>!e.directory).length,bytes:total,sourceRef:ref,sha256:metadata.sha256};
  }catch(error){if(stage){const checked=path.resolve(stage),parent=path.resolve(stateDir,'workspace-imports');if(path.dirname(checked)===parent&&/^[a-f0-9]{32}$/.test(path.basename(checked)))fs.rmSync(checked,{recursive:true,force:true,maxRetries:3});}throw error;}
  finally{fs.closeSync(fd);}
}
