// Explicit real-provider acceptance using synthetic non-private image only.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';import {createProviderSecrets} from '../src/providers/secrets.js';
import {createModelProviderRegistry,createModelRuntimeService,createOpenAiCompatibleModelProvider} from '../src/model/index.js';
import {visionFixturePng} from './test-support/image-fixture.mjs';
if(process.env.CETAMESH_TEST_REAL_VISION!=='1'){console.log('NOT_RUN_ENVIRONMENT: explicit real vision opt-in required');process.exit(77);}
const secrets=createProviderSecrets({root:process.env.CETAMESH_TEST_PROVIDER_DATA_ROOT||path.join(process.env.LOCALAPPDATA,'WhaleBridge')});
const providerId=secrets.list().some(r=>r.provider==='deepseek-official')?'deepseek-official':'openai';
if(!secrets.list().some(r=>r.provider===providerId)){console.log('NOT_RUN_ENVIRONMENT: no configured verified vision provider');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-real-vision-'));const model=providerId==='deepseek-official'?'deepseek-flash':'gpt-4o-mini';let chat;let requests=0;
try {const provider=createOpenAiCompatibleModelProvider({id:providerId,label:providerId,baseUrl:providerId==='deepseek-official'?'https://api.deepseek.com':'https://api.openai.com/v1',defaultModel:model,secrets,fetchImpl:(...args)=>{requests++;return fetch(...args);}});
 const runtime=createModelRuntimeService({registry:createModelProviderRegistry({providers:[provider]}),secrets});
 if(runtime.imageInputCapabilities(providerId,model).supported!==true){console.log('NOT_RUN_ENVIRONMENT: configured endpoint has no verified image profile');process.exitCode=77;}
 else {chat=createChatService({stateDir:root,defaults:{model:''},modelRuntime:runtime,defaultModelConfig:()=>({provider:providerId,defaultModel:model}),controlExecute:async()=>({})});const run=(method,params)=>chat.execute({method,params});const {id}=await run('chat.sessions.create',{});const b=visionFixturePng();
 const upload=async (name,b)=>{const f=await run('chat.attachment.begin',{id,name,size:b.length,mimeType:'image/png'});await run('chat.attachment.chunk',{id,ref:f.ref,offset:0,data:b.toString('base64')});return run('chat.attachment.finish',{id,ref:f.ref});};
 const source=await upload('synthetic-shapes.png',b),modelImage=await upload('model.png',b);await run('chat.attachment.derive',{id,ref:source.ref,modelRef:modelImage.ref});
 const second=await upload('second.png',visionFixturePng({swap:true})),secondModel=await upload('second-model.png',visionFixturePng({swap:true}));await run('chat.attachment.derive',{id,ref:second.ref,modelRef:secondModel.ref});
 await run('chat.send',{id,text:'Describe the left-hand shape and its color in each image. Reply only JSON with string fields first and second, in English.',attachments:[{ref:source.ref},{ref:second.ref}],clientMessageId:'real-vision-shapes-01'});
 let history;const deadline=Date.now()+180000;while(Date.now()<deadline){history=await run('chat.history',{id});if(history.messages.some(m=>m.role==='assistant'))break;await new Promise(r=>setTimeout(r,100));}
 const answer=history.messages.findLast(m=>m.role==='assistant');assert.ok(answer&&!answer.error&&!answer.cancelled,'Real vision turn must complete');assert.match(answer.text,/red|红/i);assert.match(answer.text,/blue|蓝/i);assert.match(answer.text,/square|rectangle|方|矩形/i);const structured=JSON.parse(answer.text.replace(/^```(?:json)?\s*|\s*```$/g,''));assert.match(structured.first,/red/i);assert.match(structured.second,/blue/i);assert.equal(requests,1);
 console.log(JSON.stringify({acceptanceEvidence:{fixture:false,entrance:'production source Chat with controlled attachment references',provider:providerId,model,requests,images:2,image:'first red square/blue circle; second blue square/red circle',response:answer.text,usage:answer.usage??null}}));}
}finally{await chat?.close();fs.rmSync(root,{recursive:true,force:true});}
