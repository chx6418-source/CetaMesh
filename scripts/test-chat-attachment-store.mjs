import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createAttachmentStore} from '../src/desktop/attachment-store.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-attachments-'));
try {
 const store=createAttachmentStore({stateDir:root});const limits=store.limits();assert.equal(limits.imageMiB,20);assert.equal(limits.documentMiB,100);assert.equal(limits.archiveMiB,200);assert.equal(limits.messageMiB,250);assert.equal(limits.count,20);
 const data=Buffer.from('safe source\n');const file=store.begin('session-a',{name:'code.ts',size:data.length,mimeType:'text/plain'});
 store.chunk('session-a',{ref:file.ref,offset:0,data:data.toString('base64')});
 assert.equal(store.chunk('session-a',{ref:file.ref,offset:0,data:data.toString('base64')}).received,data.length);
 assert.throws(()=>store.chunk('session-a',{ref:file.ref,offset:0,data:Buffer.from('DIFFERENT').toString('base64')}),e=>e.code==='ATTACHMENT_CHUNK_CONFLICT');
 const ready=store.finish('session-a',{ref:file.ref});assert.equal(ready.status,'ready');assert.equal(store.read('session-a',{ref:file.ref,offset:0}).data,data.toString('base64'));
 assert.throws(()=>store.read('session-b',{ref:file.ref}),e=>e.code==='ATTACHMENT_NOT_FOUND');assert.throws(()=>store.read('session-a',{ref:'../../escape'}));
 assert.equal(createAttachmentStore({stateDir:root}).describe('session-a',file.ref).sha256,ready.sha256);
 assert.throws(()=>store.begin('session-a',{name:'huge.png',size:21*1024*1024,mimeType:'image/png'}),e=>e.code==='ATTACHMENT_SIZE_LIMIT');
 const fake=store.begin('session-a',{name:'fake.png',size:data.length,mimeType:'image/png'});store.chunk('session-a',{ref:fake.ref,offset:0,data:data.toString('base64')});assert.throws(()=>store.finish('session-a',{ref:fake.ref}),e=>e.code==='ATTACHMENT_TYPE_MISMATCH');
 store.setLimits({count:5});assert.equal(store.limits().count,5);assert.throws(()=>store.setLimits({imageMiB:0}));
 store.remove('session-a',file.ref);assert.throws(()=>store.read('session-a',{ref:file.ref}));
 const recovered=store.begin('recover',{name:'resume.txt',size:data.length});store.chunk('recover',{ref:recovered.ref,offset:0,data:data.toString('base64')});store.finish('recover',{ref:recovered.ref});assert.equal(store.list('recover').length,1);assert.equal(store.removeSession('recover').removed,1);assert.equal(store.list('recover').length,0);
 console.log('PASS chunk retry/conflict, persistence, per-session isolation, magic types, configurable bounds, removal');
} finally {fs.rmSync(root,{recursive:true,force:true});}
