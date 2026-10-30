import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createChatService} from '../src/desktop/chat-service.js';
import {createDesktopUiService} from '../src/desktop/ui-service.js';
import {createOpenAiCompatibleModelProvider} from '../src/model/providers/openai-compatible.js';
import {visionFixturePng} from './test-support/image-fixture.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-vision-'));let calls=0,seen;
const runtime={defaultProviderId:()=> 'fixture',resolveProvider:()=>({id:'fixture'}),supportsToolCalling:()=>false,imageInputCapabilities:()=>({supported:true}),stream:async function*(r){calls++;seen=r;yield {type:'turn/start',data:{}};yield {type:'assistant/message',data:{text:'fixture: red square and blue circle'}};yield {type:'turn/end',data:{reason:{kind:'completed'}}};}};
const chat=createChatService({stateDir:root,defaults:{model:''},modelRuntime:runtime,api:null,controlExecute:async()=>({})});const ui=createDesktopUiService({services:{chatService:chat}});
const invoke=(method,params)=>ui.execute({method:'ui.chat.'+method,params});
try {
 const {id}=await chat.execute({method:'chat.sessions.create',params:{}});const bytes=visionFixturePng();
 async function upload(name,b){const f=await invoke('attachment.begin',{id,name,size:b.length,mimeType:'image/png'});await invoke('attachment.chunk',{id,ref:f.ref,offset:0,data:b.toString('base64')});return invoke('attachment.finish',{id,ref:f.ref});}
 const original=await upload('picture.png',bytes),derived=await upload('model.png',bytes);await invoke('attachment.derive',{id,ref:original.ref,modelRef:derived.ref});
 const input={id,text:'',attachments:[{ref:original.ref}],clientMessageId:'vision-message-01'};
 await invoke('send',input);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);assert.ok(seen.messages.at(-1).content.some(p=>p.type==='image_url'));assert.ok(!seen.messages.at(-1).content[0].text.includes('base64'));
 await invoke('send',input);assert.equal(calls,1,'same accepted message cannot issue duplicate request');
 const hist=await chat.execute({method:'chat.history',params:{id}});assert.equal(hist.messages[0].attachmentRefs[0].ref,original.ref);assert.ok(!JSON.stringify(hist).includes('data:image'));
 await invoke('send',{id,text:'What color was the square in the previous picture?',clientMessageId:'followup-image-01'});await new Promise(r=>setTimeout(r,10));assert.equal(calls,2);assert.ok(seen.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')),'image-only history remains available');
 runtime.imageInputCapabilities=()=>({supported:false});await assert.rejects(invoke('send',{...input,clientMessageId:'vision-message-02'}),e=>e.code==='MODEL_IMAGE_UNSUPPORTED');assert.equal(calls,2);
 const other=await chat.execute({method:'chat.sessions.create',params:{}});await assert.rejects(invoke('attachment.read',{id:other.id,ref:original.ref}),e=>e.code==='ATTACHMENT_NOT_FOUND');
 const provider=createOpenAiCompatibleModelProvider({id:'deepseek-official',label:'DeepSeek',baseUrl:'https://api.deepseek.com',defaultModel:'deepseek-chat',secrets:{raw:()=>({apiKey:'synthetic-key'})},fetchImpl:()=>{throw Error('must not send');}});
 await assert.rejects(provider.chat({model:'deepseek-chat',messages:seen.messages}),e=>e.code==='MODEL_IMAGE_UNSUPPORTED');
 console.log('PASS production UI DTO -> controlled chunks -> Chat -> structured multimodal request, history, dedupe, unsupported provider and session isolation');
} finally {await chat.close();fs.rmSync(root,{recursive:true,force:true});}
