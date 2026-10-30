// Actual Chromium + production React attachment components + production Chat/UI Core.
// HTTP is a test-only bridge; this does not claim native WebView2/OS-picker acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createChatService } from '../src/desktop/chat-service.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';

const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));
const { buildSync } = require('esbuild');
const sandbox = createSuiteSandbox({ suiteId: 'chat-attachment-ui' });
let failed = true, child, socket, server, chat, closeBrowser;
const calls = [], faults = { failChunk: false, chunkDelayMs: 0 };
try {
  chat = createChatService({ stateDir: path.join(sandbox.root, 'state'), defaults: {}, defaultAgentProvider: () => 'none' });
  const first = await chat.execute({ method: 'chat.sessions.create', params: { title: 'Attachment UI fixture' } });
  const second = await chat.execute({ method: 'chat.sessions.create', params: { title: 'Other session' } });
  const composer = await chat.execute({method:'chat.sessions.create',params:{title:'Independent Composer fixture'}});
  const ui = createDesktopUiService({ services: { chatService: chat } });
  const bundle = buildSync({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {chatClient} from './src/bridge/typed-client';import {useChatAttachments} from './src/app/ChatAttachments';import {ChatComposer} from './src/app/HarborApp';
    const first=${JSON.stringify(first.id)},second=${JSON.stringify(second.id)},composer=${JSON.stringify(composer.id)};
    const call=async(method,params)=>{const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.message),{code:data.code});return data;};
    window.ipc={postMessage(raw){const request=JSON.parse(raw);call(request.method,request.params).then(result=>window.__cetameshReceive({id:request.id,ok:true,result}),error=>window.__cetameshReceive({id:request.id,ok:false,error:{code:error.code||'FIXTURE',message:error.message}}));}};
    const nativeURL=URL.createObjectURL.bind(URL),nativeRevoke=URL.revokeObjectURL.bind(URL);window.revokedUrls=[];URL.createObjectURL=blob=>nativeURL(blob);URL.revokeObjectURL=url=>{window.revokedUrls.push(url);nativeRevoke(url);};
    const nativeBitmap=window.createImageBitmap.bind(window);window.bitmapCalls=0;window.createImageBitmap=(...args)=>{window.bitmapCalls++;return nativeBitmap(...args);};
    const originalArrayBuffer=Blob.prototype.arrayBuffer;window.fullFileReads=0;
    Blob.prototype.arrayBuffer=function(){if(this.size>256*1024){window.fullFileReads++;throw new Error('production path read a whole large file');}return originalArrayBuffer.call(this);};
    function Harness(){const [sessionId,setSessionId]=useState(first),[mode,setMode]=useState('panel');const draft=useChatAttachments({sessionId,call});
      window.fixture={files:draft.files,pending:draft.pending,addFiles:draft.addFiles,setFiles:draft.setFiles,changeSession:setSessionId,showComposer:()=>{setSessionId(composer);setMode('composer');},showPanel:()=>setMode('panel'),first,second};
      return mode==='panel'?<main id="attachment-harness" onPaste={draft.onPaste} onDrop={draft.onDrop} onDragOver={draft.onDragOver}><textarea aria-label="Fixture message"/>{draft.ui}</main>:<div className="composer-dock"><ChatComposer sessionId={sessionId} busy={false} models={[]} selectedModelKey="" agentProviders={[]} selectedAgent="none" workspaces={[]} workspaceId="" activeWorkspaceId={null} onWorkspaceChange={()=>{}} onModelChange={()=>{}} onAgentChange={()=>{}} onSend={async(text,attachments,clientMessageId)=>{window.sentText=text;window.sendAttempts=(window.sendAttempts||0)+1;await chatClient.send(sessionId,text,attachments,clientMessageId);}} onStop={()=>{}}/></div>;
    }
    flushSync(()=>createRoot(document.getElementById('root')).render(<Harness/>));
    window.makeImage=async(name='pasted.png',large=false)=>{const canvas=document.createElement('canvas');canvas.width=24;canvas.height=12;canvas.getContext('2d').fillRect(0,0,24,12);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));return new File(large?[blob,new Uint8Array(20*1024*1024-blob.size)]:[blob],name,{type:'image/png'});};
    window.pasteImage=async(large=false)=>{const data=new DataTransfer();data.items.add(await window.makeImage(large?'large.png':'pasted.png',large));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));};
    window.dropText=(name='dropped.ts',size=24)=>{const data=new DataTransfer();data.items.add(new File(['x'.repeat(size)],name,{type:'text/plain'}));document.querySelector('main')?.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));};
    window.findButton=text=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===text);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' } });
  const html = '<!doctype html><meta charset="utf-8"><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script>';
  server = http.createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 256 * 1024) throw new Error('Fixture transport frame exceeded bound'); }
      const { method, params } = JSON.parse(body);
      if (method === 'ui.chat.send') { calls.push({ method, request: params }); throw Object.assign(new Error('fixture-send-rejected'), { code: 'FIXTURE_SEND_REJECTED' }); }
      if (!/^ui\.chat\.attachment\./.test(method)) throw new Error('Fixture only forwards attachment methods');
      const record = { method, id: params.id, ref: params.ref, name: params.name, offset: params.offset, bytes: params.data ? Buffer.byteLength(params.data, 'base64') : 0 };
      calls.push(record);
      if (method === 'ui.chat.attachment.chunk') {
        if (faults.chunkDelayMs) await delay(faults.chunkDelayMs);
        if (faults.failChunk) { faults.failChunk = false; throw Object.assign(new Error('fixture-upload-interrupted'), { code: 'FIXTURE_UPLOAD_FAILURE' }); }
      }
      const result = await ui.execute({ method, params }); record.result = result;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: error.code || 'FIXTURE', message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  assert.ok(fs.existsSync(edge), 'NOT_RUN_ENVIRONMENT: actual Chromium/Edge is required');
  const profile = path.join(sandbox.root, 'profile');
  child = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort'); for (let index = 0; !fs.existsSync(portFile) && index < 100; index++) await delay(100); assert.ok(fs.existsSync(portFile));
  const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0; const pending = new Map();
  socket.on('message', bytes => { const message = JSON.parse(String(bytes)), entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); });
  const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  closeBrowser = () => rpc('Browser.close');
  const target = await rpc('Target.createTarget', { url: 'about:blank' }), { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await rpc('Runtime.enable', {}, sessionId); await rpc('Page.enable', {}, sessionId);
  await rpc('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }, sessionId);
  const evaluate = async expression => { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
  async function until(expression, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(expression)) return; await delay(40); } throw new Error('Timed out: ' + label + '\n' + await evaluate('document.body.innerText')); }
  const click = text => evaluate('window.findButton(' + JSON.stringify(text) + ')?.click()');
  await until('!!window.fixture && !!document.querySelector("input[type=file]")', 'production attachment hook mount');

  const textFile = path.join(sandbox.root, 'picked.ts'); fs.writeFileSync(textFile, 'export const attachment = true;\n');
  const { root } = await rpc('DOM.getDocument', {}, sessionId); const { nodeId } = await rpc('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' }, sessionId);
  await rpc('DOM.setFileInputFiles', { nodeId, files: [textFile] }, sessionId);
  await until('window.fixture.files.length===1&&!window.fixture.pending', 'file picker upload');
  let files = await evaluate('window.fixture.files'); const firstRef = files[0].ref;
  assert.equal(chat.attachmentStore.bytes(first.id, firstRef, 1024).toString(), 'export const attachment = true;\n');
  await click('预览'); await until('document.querySelector(".attachment-preview pre")?.textContent.includes("export const attachment")', 'text preview'); await click('关闭预览');
  await evaluate('window.dropText()'); await until('window.fixture.files.length===2&&!window.fixture.pending', 'drop upload');
  await evaluate('window.pasteImage()'); await until('window.fixture.files.length===3&&!window.fixture.pending', 'paste image and actual canvas model derivation');
  await until('Array.from(document.querySelectorAll(".attachment-item img")).some(image=>image.alt==="pasted.png 缩略图"&&image.naturalWidth===24)', 'Composer image thumbnail renders from model reference', 5000);
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".attachment-item img")).find(image=>image.alt==="pasted.png 缩略图").getBoundingClientRect().width'), 64);
  const thumbnailUrl = await evaluate('Array.from(document.querySelectorAll(".attachment-item img")).find(image=>image.alt==="pasted.png 缩略图").src');
  files = await evaluate('window.fixture.files'); const image = files.find(file => file.name === 'pasted.png'); assert.ok(image.modelRef); assert.equal(image.width, 24); assert.equal(image.height, 12); assert.ok(chat.attachmentStore.describe(first.id, image.modelRef).originalRef === image.ref);
  await evaluate('document.querySelectorAll(".attachment-item")[2].querySelector("button").click()'); await until('document.querySelector(".attachment-preview img")?.naturalWidth===24', 'original image preview'); await click('关闭预览');
  await evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.getAttribute("aria-label")==="移除 picked.ts").click()'); await until('window.fixture.files.length===2&&!window.fixture.pending', 'remove saved attachment'); assert.throws(() => chat.attachmentStore.describe(first.id, firstRef), error => error.code === 'ATTACHMENT_NOT_FOUND');
  console.log('PASS actual file input, paste, drop, original/model PNG, model-reference thumbnails, bounded text/image previews and Core removal');

  faults.failChunk = true; await evaluate('window.dropText("retry.ts",262144)'); await until('document.body.innerText.includes("fixture-upload-interrupted")&&!window.fixture.pending', 'upload failure is actionable');
  assert.equal((await evaluate('window.fixture.files')).length, 2); await click('重试'); await until('window.fixture.files.length===3&&!window.fixture.pending', 'retry actual failed chunk upload');
  console.log('PASS interrupted upload preserves previous ready files and retries through actual Core chunks');

  faults.chunkDelayMs = 400; const priorCalls = calls.length; await evaluate('window.dropText("cancel.ts",524288)');
  await until('document.body.innerText.includes("cancel.ts") && document.body.innerText.includes("上传")', 'cancel reaches upload');
  for (let index = 0; !calls.slice(priorCalls).some(row => row.method === 'ui.chat.attachment.chunk') && index < 100; index++) await delay(20);
  await click('取消'); await until('!window.fixture.pending&&document.body.innerText.includes("已取消")', 'cancel settles and cleans reference'); faults.chunkDelayMs = 0;
  assert.equal((await evaluate('window.fixture.files')).length, 3); const cancelled = calls.slice(priorCalls).find(row => row.method === 'ui.chat.attachment.begin'); assert.ok(cancelled?.result?.ref); assert.throws(() => chat.attachmentStore.describe(first.id, cancelled.result.ref), error => error.code === 'ATTACHMENT_NOT_FOUND');
  console.log('PASS cancellation during in-flight chunk leaves no published selection or partial Core attachment');

  await evaluate('window.fixture.changeSession(window.fixture.second)'); await until('window.fixture.files.length===0', 'new session has isolated draft');
  await until('window.revokedUrls.includes(' + JSON.stringify(thumbnailUrl) + ')', 'thumbnail Blob URL revoked on session change');
  await evaluate('window.fixture.changeSession(window.fixture.first)'); await until('window.fixture.files.length===3', 'return restores session draft');
  const beforeLarge = calls.length; await evaluate('window.pasteImage(true)'); await until('window.fixture.files.some(file=>file.name==="large.png")&&!window.fixture.pending', '20 MiB original uses bounded chunks', 60000);
  const largeCalls = calls.slice(beforeLarge).filter(row => row.method === 'ui.chat.attachment.chunk'); assert.ok(largeCalls.length >= 160); assert.ok(largeCalls.every(row => row.bytes <= 128 * 1024)); assert.equal(await evaluate('window.fullFileReads'), 0);
  const large = (await evaluate('window.fixture.files')).find(file => file.name === 'large.png'); assert.equal(large.size, 20 * 1024 * 1024); assert.ok(large.modelRef); assert.ok(chat.attachmentStore.describe(first.id, large.modelRef).size <= 2 * 1024 * 1024);
  console.log('PASS real 20 MiB original and model PNG with 128 KiB chunks, no whole-file renderer reads, and isolated session drafts');

  const bitmapBefore = await evaluate('window.bitmapCalls'), callsBeforeHeader = calls.length;
  await evaluate('(()=>{const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,8000);view.setUint32(20,8000);window.fixture.addFiles([new File([bytes],"oversized-dimensions.png",{type:"image/png"})]);})()');
  await until('document.body.innerText.includes("4000 万像素")&&!window.fixture.pending', 'image header budget rejects before decode');
  assert.equal(await evaluate('window.bitmapCalls'), bitmapBefore); assert.ok(!calls.slice(callsBeforeHeader).some(row => row.name === 'oversized-dimensions.png'));
  console.log('PASS oversized image dimensions are rejected before browser decoding or Core upload');
  await evaluate('window.fixture.showComposer()'); await until('!!document.querySelector(".composer-dock textarea")', 'production Composer mount');
  await evaluate('window.pasteImage()'); await until('document.querySelector(".composer-dock")?.innerText.includes("pasted.png")', 'production Composer receives paste');
  await until('document.querySelector(".composer-dock")?.innerText.includes("原图已保留")', 'Composer upload completes');
  const composerText = await evaluate('document.querySelector(".composer-dock textarea").getAttribute("aria-label")');
  await evaluate('(()=>{const element=document.querySelector(".composer-dock textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(element,"keep this failed draft");element.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await until('(()=>{const button=Array.from(document.querySelectorAll(".composer-dock button")).find(button=>button.getAttribute("aria-label")==="发送消息");return !!button&&!button.disabled;})()', 'Composer send enabled');
  await evaluate('Array.from(document.querySelectorAll(".composer-dock button")).find(button=>button.getAttribute("aria-label")==="发送消息")?.click()');
  await until('window.sendAttempts===1', 'actual Composer sends'); await delay(150);
  assert.equal(await evaluate('document.querySelector(".composer-dock textarea").value'), 'keep this failed draft'); assert.ok(await evaluate('document.querySelector(".composer-dock").innerText.includes("pasted.png")'));
  const sent = calls.findLast(row => row.method === 'ui.chat.send')?.request.attachments; assert.equal(sent.length, 1); assert.deepEqual(Object.keys(sent[0]), ['ref']); assert.match(sent[0].ref, /^[a-f0-9]{32}$/); assert.equal(await evaluate('window.sentText'), 'keep this failed draft');
  console.log('PASS production ChatComposer async send rejection preserves text and attachment selection (' + composerText + ')');
  await rpc('Browser.close'); await delay(750); failed = false;
  console.log('Attachment Chromium UI: PASS (real React + Core; native host acceptance remains separate)');
} catch (error) { console.error(error.stack); throw error; } finally {
  if (closeBrowser && socket?.readyState === WebSocket.OPEN) { try { await closeBrowser(); } catch {} await delay(1000); }
  if (socket?.readyState === WebSocket.OPEN) socket.terminate();
  if (child?.pid && child.exitCode === null && child.signalCode === null) { await terminateSuiteProcessTree(child); await delay(250); }
  if (server) await new Promise(resolve => server.close(resolve));
  await chat?.close();
  finalizeSuiteSandbox({ sandbox, failed, keepFailed: failed });
}
