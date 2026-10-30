import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {crc32} from 'node:zlib';
import {createAttachmentStore} from '../src/desktop/attachment-store.js';import {importAttachmentArchive} from '../src/desktop/attachment-archive.js';
if(process.env.CETAMESH_TEST_ATTACHMENT_RESOURCES!=='1'){console.log('NOT_RUN_ENVIRONMENT: explicit large attachment disk/resource acceptance opt-in required');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-attachment-resource-')),MiB=1024*1024,session='resource-test';
const disk=fs.statfsSync(root);if(disk.bavail*disk.bsize<1024*MiB){console.log('NOT_RUN_ENVIRONMENT: at least 1 GiB free test disk required');fs.rmdirSync(root);process.exit(77);}
const initial=process.memoryUsage().rss;let peak=initial;const started=Date.now(),store=createAttachmentStore({stateDir:root}),block=Buffer.alloc(128*1024,65),base64=block.toString('base64');
function upload(name,size,writer){const meta=store.begin(session,{name,size});let offset=0;const write=b=>{for(let p=0;p<b.length;p+=128*1024){const data=b.subarray(p,p+128*1024);store.chunk(session,{ref:meta.ref,offset,data:data===block?base64:data.toString('base64')});offset+=data.length;peak=Math.max(peak,process.memoryUsage().rss);}};writer(write);assert.equal(offset,size);return store.finish(session,{ref:meta.ref});}
try {
 const document=upload('large-source.txt',100*MiB,write=>{for(let i=0;i<800;i++)write(block);});assert.equal(document.size,100*MiB);
 const dataSize=98*MiB,names=['project/a.txt','project/b.txt'];let crc=0;for(let i=0;i<dataSize/block.length;i++)crc=crc32(block,crc);
 const heads=names.map(name=>{const b=Buffer.alloc(30+Buffer.byteLength(name));b.writeUInt32LE(0x04034b50);b.writeUInt16LE(20,4);b.writeUInt32LE(crc,14);b.writeUInt32LE(dataSize,18);b.writeUInt32LE(dataSize,22);b.writeUInt16LE(Buffer.byteLength(name),26);b.write(name,30);return b;});
 const offsets=[0,heads[0].length+dataSize];const central=names.map((name,i)=>{const b=Buffer.alloc(46+Buffer.byteLength(name));b.writeUInt32LE(0x02014b50);b.writeUInt16LE(20,4);b.writeUInt16LE(20,6);b.writeUInt32LE(crc,16);b.writeUInt32LE(dataSize,20);b.writeUInt32LE(dataSize,24);b.writeUInt16LE(Buffer.byteLength(name),28);b.writeUInt32LE(offsets[i],42);b.write(name,46);return b;});
 const end=Buffer.alloc(22),centralOffset=offsets[1]+heads[1].length+dataSize,centralBytes=central.reduce((n,b)=>n+b.length,0);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(centralBytes,12);end.writeUInt32LE(centralOffset,16);
 const archive=upload('large-project.zip',centralOffset+centralBytes+end.length,write=>{for(const head of heads){write(head);for(let i=0;i<dataSize/block.length;i++)write(block);}for(const c of central)write(c);write(end);});
 assert.throws(()=>store.validateSelection(session,[document.ref,archive.ref]),e=>e.code==='ATTACHMENT_SIZE_LIMIT');
 const imported=await importAttachmentArchive({store,sessionId:session,ref:archive.ref,stateDir:root});assert.equal(imported.files,2);assert.equal(fs.statSync(path.join(imported.root,'project/a.txt')).size,dataSize);assert.equal(imported.bytes,196*MiB);
 assert.ok(peak-initial<256*MiB,'upload memory must not scale to whole archive buffers');
 console.log(JSON.stringify({resourceEvidence:{fixture:true,documentBytes:document.size,archiveBytes:archive.size,importedBytes:imported.bytes,chunkBytes:block.length,peakUploadRssIncrease:peak-initial,elapsedMs:Date.now()-started,message250MiBLimitEnforced:true}}));
}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
