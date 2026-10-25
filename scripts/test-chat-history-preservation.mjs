import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {createChatService}=await import(process.env.CONTEXT_CHAT_MODULE ?? '../src/desktop/chat-service.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-history-'));
const calls=[];
const service=createChatService({ stateDir:dir, defaults:{model:'fixture'}, api:{},
 modelRuntime:{defaultProviderId:()=> 'fixture',resolveProvider:id=>({id}),supportsToolCalling:()=>true},
 toolExecutionCoordinator:{run:async request=>{calls.push(request.messages); return {status:'completed',toolCalling:'supported',text:'noted'};},cancelSession:()=>({cancelled:0})}
});
try {
 const session=await service.execute({method:'chat.sessions.create',params:{}});
 for(let i=0;i<23;i++) {
  await service.execute({method:'chat.send',params:{id:session.id,text:i===0?'ORIGINAL_GOAL_DO_NOT_LOSE':'next '+i}});
  const deadline=Date.now()+3000;
  while((await service.execute({method:'chat.status',params:{id:session.id}})).turn !== null) {
   assert.ok(Date.now()<deadline,'turn must finish');
   await new Promise(resolve=>setTimeout(resolve,5));
  }
 }
 assert.ok(calls.at(-1).some(message=>message.content==='ORIGINAL_GOAL_DO_NOT_LOSE'),'oldest task goal survives more than40 messages');
 assert.equal(calls.length,23);
 console.log('chat history preservation passed');
} finally {service.close();fs.rmSync(dir,{recursive:true,force:true});}
