import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const module = await import('../src/context/tool-evidence.js').catch(()=>({}));
assert.equal(typeof module.createToolEvidenceStore, 'function', 'scoped durable evidence store is required');
const {createToolEvidenceStore}=module;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-evidence-'));
try {
 const binding={actorKind:'agent',actorId:'a',sessionId:'s',taskId:'t',workspaceId:'w'};
 const content=JSON.stringify({status:'completed',result:{content:'x'.repeat(700000)+'END-EVIDENCE'}});
 const store=createToolEvidenceStore({stateDir:dir});
 const ref=store.put({binding,content,sourceCapability:'filesystem.read'});
 assert.match(ref.id,/^[a-f0-9-]{36}$/); assert.equal(ref.sha256.length,64);
 const restarted=createToolEvidenceStore({stateDir:dir});
 const auth=source=>source.capability==='filesystem.read';
 const page=restarted.read({binding,id:ref.id,offset:content.length-20,limit:200,authorizeSource:auth});
 assert.equal(page.content,content.slice(-20)); assert.equal(page.complete,true); assert.equal(page.sha256,ref.sha256);
 for(const key of Object.keys(binding)) assert.throws(()=>restarted.read({binding:{...binding,[key]:'other'},id:ref.id,authorizeSource:auth}),{code:'TOOL_EVIDENCE_DENIED'});
 assert.throws(()=>restarted.read({binding,id:ref.id,authorizeSource:()=>false}),{code:'TOOL_EVIDENCE_DENIED'});
 assert.throws(()=>restarted.read({binding,id:'../../secret',authorizeSource:auth}),{code:'TOOL_EVIDENCE_DENIED'});
 assert.throws(()=>restarted.read({binding,id:ref.id,offset:-1,authorizeSource:auth}),{code:'TOOL_EVIDENCE_PAGE_INVALID'});
 const files=fs.readdirSync(path.join(dir,'model','tool-evidence'));
 const file=path.join(dir,'model','tool-evidence',files[0]);
 const record=JSON.parse(fs.readFileSync(file,'utf8')); record.content+='tampered'; fs.writeFileSync(file,JSON.stringify(record));
 assert.throws(()=>restarted.read({binding,id:ref.id,authorizeSource:auth}),{code:'TOOL_EVIDENCE_CORRUPT'});
 console.log('tool evidence store: restart/page/scope/revocation/tamper passed');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
