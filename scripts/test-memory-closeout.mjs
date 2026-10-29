import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMemoryService} from '../src/memory/service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {createMemoryRuntime} from '../src/memory/runtime.js';
import {createProductContextService} from '../src/context/service.js';
import {normalizePacket} from '../src/continuity/types.js';
import {createTaskWorkingMemoryRecorder} from '../src/memory/task-working-memory.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-memory-closeout-'));
const owner = {kind:'user',id:'desktop'};
let failures = 0, passed = 0, clock = 1800000000000;
async function check(name, run) { try { await run(); passed++; console.log('PASS '+name); } catch(error) { failures++; console.error('FAIL '+name+'\n'+error.stack); } }
function fixture(name) { const stateDir=path.join(root,name); return {stateDir, memory:createMemoryRuntime({stateDir,now:()=>clock})}; }
function create(memory, content, extra={}) { return memory.create({principal:owner,type:'workspace',scope:'workspace:alpha',content,...extra}); }
function replace(memory, old, current) { memory.createLink({principal:owner,source:{kind:'memory',id:current.id,scope:current.scope},target:{kind:'memory',id:old.id,scope:old.scope},relation:'supersedes'}); }
function context(memory, refs=[]) {
  const task={id:'task-one',workspaceId:'alpha',goal:'compiler',memoryRefs:refs};
  return createProductContextService({memoryService:{runtime:memory},taskRuntime:{get:()=>({task})},memorySettings:()=>({enabled:true,retrievalLimit:50})});
}
try {
await check('explicit free-text correction suppresses A, preserves history, and survives restart',()=>{
 const {memory,stateDir}=fixture('correction'); const a=create(memory,'We selected compiler A for this project.'); const b=create(memory,'We selected compiler B for this project.'); replace(memory,a,b);
 assert.deepEqual(memory.retrieve({principal:owner,scope:a.scope,query:'compiler'}).memories.map(r=>r.id),[b.id]);
 assert.equal(memory.get({principal:owner,id:a.id}).memory.content,a.content);
 const reopened=createMemoryRuntime({stateDir,now:()=>clock}); assert.equal(reopened.assess({principal:owner,id:a.id}).status,'superseded');
 const actor={kind:'agent',id:'old-reader',grants:{scopes:[a.scope],types:['workspace'],readOnlyRefs:{[a.scope]:[a.id]}}};
 assert.equal(reopened.retrieve({principal:actor,scope:a.scope,query:'compiler'}).memories.length,0);
 assert.ok(!JSON.stringify(reopened.assess({principal:actor,id:a.id})).includes(b.id));
});
await check('stale free-text references cannot re-enter Chat or Agent handoff',async()=>{
 const {memory}=fixture('explicit'); const a=create(memory,'compiler A'); const b=create(memory,'compiler B'); replace(memory,a,b);
 const refs=[{memoryId:a.id,scope:a.scope,type:a.type,authorizedBy:'user:desktop'}];
 const result=await context(memory,refs).buildForChat({record:{id:'chat-one',taskId:'task-one'},memoryQuery:'compiler'});
 assert.ok(!result.includes('compiler A'));
 const recorder=createTaskWorkingMemoryRecorder({memoryRuntime:memory,taskRuntime:{get:()=>({task:{id:'task-one',memoryRefs:refs}})},enabled:()=>true});
 assert.throws(()=>recorder.references('task-one'),e=>e.code==='HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED');
});
await check('duplicate authorized references consume the context budget once',async()=>{
 const {memory}=fixture('dedupe'); const row=create(memory,'compiler choice is stable',{type:'knowledge',scope:'global'});
 const refs=[{memoryId:row.id,scope:'global',type:'knowledge',authorizedBy:'user:desktop'},{memoryId:row.id,scope:'global',type:'knowledge',authorizedBy:'user:desktop'}];
 const result=await context(memory,refs).buildForChat({record:{id:'chat-one',taskId:'task-one'},memoryQuery:'compiler'});
 assert.equal(result.split(row.id).length-1,1);
});
await check('Agent source labels cannot impersonate user confirmation across restart',()=>{
 const {memory,stateDir}=fixture('provenance');
 const row=memory.create({principal:{kind:'agent',id:'writer',grants:{scopes:['task:one'],types:['working']}},scope:'task:one',type:'working',source:'user',content:'Agent believes compiler A works'});
 assert.equal(row.provenance?.status,'agent-inference');
 const reopened=createMemoryRuntime({stateDir,now:()=>clock}); assert.equal(reopened.get({principal:owner,id:row.id}).memory.provenance.actor,'agent:writer');
 const corrected=reopened.update({principal:owner,id:row.id,expectedRev:row.rev,content:'User confirmed compiler B'});
 assert.equal(corrected.provenance.status,'user-confirmed'); assert.equal(corrected.provenance.actor,'user:desktop');
});
await check('context retains bounded provenance, scope, revision and authorized source references',async()=>{
 const {memory}=fixture('projection'); const row=create(memory,'compiler B is confirmed',{type:'knowledge',scope:'global',sourceRefs:[{kind:'task',id:'verified-task',scope:'global'}]});
 const result=JSON.parse(await context(memory).buildForChat({record:{id:'chat-one'},memoryQuery:'compiler'}));
 const text=JSON.stringify(result); assert.match(text,/user-confirmed/); assert.match(text,/user:desktop/); assert.match(text,/verified-task/); assert.match(text,/1800000000000/);
});
await check('conflicting sources stay unverified and Workspace/account retrieval remains isolated',()=>{
 const {memory}=fixture('scope'); create(memory,'compiler version A',{factKey:'compiler',sourceRefs:[{kind:'task',id:'source-a',scope:'workspace:alpha'}]}); create(memory,'compiler version B',{factKey:'compiler',sourceRefs:[{kind:'task',id:'source-b',scope:'workspace:alpha'}]});
 const conflict=memory.retrieve({principal:owner,scope:'workspace:alpha',query:'compiler'}); assert.equal(conflict.meta.conflicted,2); assert.equal(conflict.memories.length,0);
 create(memory,'OTHER-WORKSPACE',{scope:'workspace:beta'}); create(memory,'OTHER-ACCOUNT',{scope:'user:other',principal:{kind:'user',id:'other'}});
 const actor={kind:'agent',id:'reader',grants:{scopes:['workspace:alpha'],types:['workspace']}};
 assert.ok(!JSON.stringify(memory.list({principal:actor})).includes('OTHER-')); assert.ok(!JSON.stringify(memory.list({principal:owner})).includes('OTHER-ACCOUNT'));
});
await check('identical authorized content does not displace another relevant result',()=>{
 const {memory}=fixture('content-dedup'); create(memory,'compiler build duplicate'); create(memory,'compiler build duplicate'); create(memory,'compiler build relevant alternative');
 const page=memory.retrieve({principal:owner,scope:'workspace:alpha',query:'compiler build',limit:2});
 assert.equal(new Set(page.memories.map(row=>row.content)).size,2);
});
await check('historical import is not confirmation and metadata edits cannot promote it',()=>{
 const {memory,stateDir}=fixture('import'); const row=create(memory,'compiler A imported from history',{source:'qq-adapter',originRef:'historic-message'});
 assert.equal(row.provenance.status,'historical-unverified');
 const pinned=memory.update({principal:owner,id:row.id,expectedRev:row.rev,pinned:true}); assert.equal(pinned.provenance.status,'historical-unverified');
 const reopened=createMemoryRuntime({stateDir,now:()=>clock}); assert.equal(reopened.get({principal:owner,id:row.id}).memory.provenance.status,'historical-unverified');
 const corrected=reopened.update({principal:owner,id:row.id,expectedRev:pinned.rev,content:'compiler B confirmed by user'}); assert.equal(corrected.provenance.status,'user-confirmed');
});
await check('serialized handoff retains source confidence and refuses unrelated evidence',()=>{
 const {memory}=fixture('packet'); const row=create(memory,'compiler B confirmed',{sourceRefs:[{kind:'task',id:'source-task',scope:'workspace:alpha'}]});
 const refs=[{memoryId:row.id,scope:row.scope,type:row.type,authorizedBy:'user:desktop'}];
 const recorder=createTaskWorkingMemoryRecorder({memoryRuntime:memory,taskRuntime:{get:()=>({task:{id:'task-one',memoryRefs:refs}})},enabled:()=>true});
 const excerpts=recorder.references('task-one'); excerpts[0].sourceRefs.push({kind:'task',id:'unrelated-secret',scope:'workspace:other'});
 const packet=normalizePacket({taskId:'task-one',goal:'Keep compiler B',memoryRefs:refs,workingMemory:excerpts});
 assert.ok(!JSON.stringify(packet).includes('unrelated-secret'));
 assert.equal(packet.workingMemory[0].provenance.status,'user-confirmed'); assert.equal(packet.workingMemory[0].sourceRefs[0].id,'source-task');
 assert.equal(packet.workingMemory[0].revision,1); assert.equal(packet.workingMemory[0].createdAt,1800000000000);
});
await check('Desktop memory.get retains trusted provenance',async()=>{
 const service=createMemoryService({stateDir:path.join(root,'desktop-provenance'),now:()=>clock});
 const row=create(service.runtime,'compiler B confirmed');
 const ui=createDesktopUiService({services:{memoryService:service}});
 const projected=await ui.execute({method:'ui.memory.get',params:{id:row.id}});
 assert.equal(projected.provenance?.status,'user-confirmed'); assert.equal(projected.provenance.actor,'user:desktop');
});
await check('Desktop mark obsolete excludes the record from automatic retrieval',async()=>{
 const service=createMemoryService({stateDir:path.join(root,'desktop-obsolete'),now:()=>clock});
 const row=create(service.runtime,'compiler A obsolete',{source:'qq-adapter'});
 const ui=createDesktopUiService({services:{memoryService:service}});
 const updated=await ui.execute({method:'ui.memory.update',params:{id:row.id,expectedRev:row.rev,content:row.content,tags:row.tags,pinned:row.pinned,validUntil:clock-1}});
 assert.equal(updated.validUntil,clock-1);
 assert.equal(service.runtime.retrieve({principal:owner,scope:row.scope,query:'compiler'}).memories.length,0);
 assert.equal(service.runtime.get({principal:owner,id:row.id}).memory.provenance.status,'historical-unverified');
});
await check('unchanged content roundtrips do not promote imported claims',()=>{
 const {memory}=fixture('unchanged-content'); const row=create(memory,'compiler historical claim',{source:'qq-adapter'});
 const updated=memory.update({principal:owner,id:row.id,expectedRev:row.rev,content:row.content,validUntil:clock-1});
 assert.equal(updated.provenance.status,'historical-unverified');
});
await check('model self-report alone never creates a verified historical outcome candidate',async()=>{
 const {memory}=fixture('self-report'); const recorder=createTaskWorkingMemoryRecorder({memoryRuntime:memory,taskRuntime:{get:()=>({task:{id:'report',workspaceId:'alpha',status:'completed',result:{summary:'All tests passed'}}})},enabled:()=>true});
 assert.equal((await recorder.recordVerifiedOutcome('report')).skipped,true); assert.equal(memory.listCandidates({principal:owner}).candidates.length,0);
});
} finally { fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:50}); }
console.log(`Memory closeout: ${passed} PASS / ${failures} FAIL`);
if(failures) process.exitCode=1;
