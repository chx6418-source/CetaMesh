import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {capabilityError} from '../capability/types.js';
import {validateFetchUrl} from '../safe-fetch.js';
import {redactText} from '../logging/redact.js';

const denied=()=>capabilityError('DEVELOPER_URL_DENIED','Browser destination must be an approved public HTTP(S) URL without credentials, query data or fragments');
export async function validateDeveloperBrowserTarget(value){
  let target;try{target=await validateFetchUrl(value);}catch{throw denied();}
  if(target.url.search||target.url.hash||! /^[A-Za-z0-9.-]+$/.test(target.url.hostname))throw denied();
  return target;
}
export function findDeveloperBrowser(){
  if(process.platform!=='win32')return null;
  return [process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean)
    .map(root=>path.join(root,'Microsoft','Edge','Application','msedge.exe')).find(file=>fs.existsSync(file))??null;
}
const cancelled=signal=>{if(signal?.aborted)throw signal.reason?.code?signal.reason:capabilityError('DEVELOPER_BROWSER_ABORTED','Browser operation cancelled');};
const delay=(ms,signal)=>new Promise((resolve,reject)=>{
  const finish=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
  const abort=()=>finish(signal.reason??capabilityError('DEVELOPER_BROWSER_ABORTED','Browser operation cancelled'));
  const timer=setTimeout(()=>finish(),ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});
async function connectCdp(url,signal){
  const socket=new WebSocket(url);const pending=new Map(),listeners=new Set();let sequence=0;
  const fail=()=>{for(const row of pending.values())row.reject(capabilityError('DEVELOPER_BROWSER_CDP_FAILED','Browser control connection ended'));pending.clear();};
  socket.addEventListener('close',fail);socket.addEventListener('error',fail);
  socket.addEventListener('message',event=>{
    let message;try{if(typeof event.data!=='string'||event.data.length>4*1024*1024)throw Error();message=JSON.parse(event.data);}catch{return;}
    if(message.id){const row=pending.get(message.id);if(!row)return;pending.delete(message.id);message.error?row.reject(capabilityError('DEVELOPER_BROWSER_CDP_FAILED','Browser control command failed')):row.resolve(message.result);}
    else for(const listener of listeners)listener(message);
  });
  await new Promise((resolve,reject)=>{
    const finish=failed=>{signal?.removeEventListener('abort',abort);socket.removeEventListener('open',open);socket.removeEventListener('error',error);failed?reject(capabilityError('DEVELOPER_BROWSER_CDP_FAILED','Browser control connection unavailable')):resolve();};
    const open=()=>finish(),error=()=>finish(true),abort=()=>{socket.close();finish(true);};
    socket.addEventListener('open',open,{once:true});socket.addEventListener('error',error,{once:true});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  const abort=()=>{fail();socket.close();};signal.addEventListener('abort',abort,{once:true});
  return {on:listener=>listeners.add(listener),off:listener=>listeners.delete(listener),
    send(method,params={},sessionId){
      cancelled(signal);return new Promise((resolve,reject)=>{
        const id=++sequence;pending.set(id,{resolve,reject});try{socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}: {})}));}catch{pending.delete(id);reject(capabilityError('DEVELOPER_BROWSER_CDP_FAILED','Browser control command failed'));}
      });
    },close(){signal.removeEventListener('abort',abort);listeners.clear();fail();socket.close();}};
}
async function stopBrowser(child){
  if(!child||child.exitCode!==null||!child.pid)return;
  if(process.platform==='win32')await new Promise(resolve=>execFile(path.join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>resolve()));
  else child.kill('SIGKILL');
  if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)]);
}
async function stopOwnedProfileProcesses(profile){
  if(process.platform!=='win32')return;
  // Edge's launcher can exit before the browser, and its crash reporter can
  // survive Browser.close. Match the exact random profile before stopping any
  // remaining Edge process. No caller text is interpolated into shell code.
  const encodedProfile=Buffer.from(profile,'utf8').toString('base64');
  const script=`$ErrorActionPreference='Stop';$ownedProfile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedProfile}'));function OwnedRows { @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ownedProfile,[StringComparison]::OrdinalIgnoreCase) -ge 0 }) };foreach($ownedRow in (OwnedRows)){Stop-Process -Id $ownedRow.ProcessId -Force -ErrorAction SilentlyContinue};for($attempt=0;$attempt -lt 5;$attempt++){if((OwnedRows).Count -eq 0){exit 0};Start-Sleep -Milliseconds 100};exit 3`;
  const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((resolve,reject)=>execFile(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:6000,maxBuffer:1024},error=>error?reject(capabilityError('DEVELOPER_BROWSER_CLEANUP_REQUIRED','Owned temporary browser processes need cleanup')):resolve()));
}

/** Fixed navigation/DOM/screenshot executor, not a generic CDP or JS interface.
 * Each run uses a fresh profile and Chromium sandbox. CDP interception and a
 * pinned approved hostname constrain page requests; this is not an OS network
 * sandbox. resolveTarget/profileRoot are trusted host/test seams, never IPC input. */
export function createDeveloperBrowserExecutor({browserExecutable=findDeveloperBrowser(),profileRoot=os.tmpdir(),timeoutMs=15000,resolveTarget=validateDeveloperBrowserTarget}={}){
  if(!browserExecutable)return null;
  if(!path.isAbsolute(browserExecutable)||path.basename(browserExecutable).toLowerCase()!=='msedge.exe'||!fs.existsSync(browserExecutable)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||typeof resolveTarget!=='function')throw capabilityError('DEVELOPER_BROWSER_CONFIG_INVALID','Invalid bounded browser configuration');
  return async function runBrowser(input){
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['url','signal'].includes(key))||typeof input.url!=='string'||input.url.length>2048)throw denied();
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(capabilityError('DEVELOPER_BROWSER_TIMEOUT','Browser operation timed out')),timeoutMs);
    const signal=controller.signal;const abort=()=>controller.abort(capabilityError('DEVELOPER_BROWSER_ABORTED','Browser operation cancelled'));
    input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
    let profile,child,cdp,wsUrl,childFailed=false,session,targetId,blockedRequests=0,loaded=false;
    try{
      cancelled(signal);
      const destination=await Promise.race([resolveTarget(input.url),new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
      cancelled(signal);
      const approved=destination.url;
      if(!(approved instanceof URL)||!['http:','https:'].includes(approved.protocol)||approved.username||approved.password||!net.isIP(destination.ip)||! /^[A-Za-z0-9.-]+$/.test(approved.hostname))throw denied();
      profile=fs.mkdtempSync(path.join(profileRoot,'cetamesh-browser-'));
      const ip=net.isIP(destination.ip)===6?'['+destination.ip+']':destination.ip;
      child=spawn(browserExecutable,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,
        '--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-default-apps',
        '--no-proxy-server','--mute-audio','--window-size=1200,800',`--host-resolver-rules=MAP ${approved.hostname} ${ip}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
      child.once('error',()=>{childFailed=true;});
      const portFile=path.join(profile,'DevToolsActivePort');let lines;
      // Recent Edge launchers can exit with 0 while their owned browser starts.
      while(!lines){cancelled(signal);if(childFailed||(child.exitCode!==null&&child.exitCode!==0))throw capabilityError('DEVELOPER_BROWSER_START_FAILED','Browser could not start');try{lines=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);}catch{await delay(40,signal);}}
      if(!/^\d{1,5}$/.test(lines[0])||Number(lines[0])>65535||!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1]??''))throw capabilityError('DEVELOPER_BROWSER_START_FAILED','Invalid local browser control endpoint');
      wsUrl=`ws://127.0.0.1:${lines[0]}${lines[1]}`;cdp=await connectCdp(wsUrl,signal);
      ({targetId}=await cdp.send('Target.createTarget',{url:'about:blank'}));
      ({sessionId:session}=await cdp.send('Target.attachToTarget',{targetId,flatten:true}));
      const pageSend=(method,params={})=>cdp.send(method,params,session);
      cdp.on(message=>{
        if(message.sessionId!==session)return;
        if(message.method==='Page.loadEventFired')loaded=true;
        if(message.method==='Page.fileChooserOpened')void pageSend('Page.handleFileChooser',{action:'cancel'}).catch(()=>{});
        if(message.method==='Fetch.requestPaused')void (async()=>{
          const paused=message.params;let allowed=false;
          try{
            const url=new URL(paused.request.url);
            allowed=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.origin===approved.origin
              &&(paused.resourceType!=='Document'||url.href===approved.href);
            if(allowed){const checked=await resolveTarget(url.href);allowed=checked.ip===destination.ip&&checked.url.origin===approved.origin;}
          }catch{allowed=false;}
          if(!allowed)blockedRequests++;
          await pageSend(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:paused.requestId}:{requestId:paused.requestId,errorReason:'BlockedByClient'});
        })().catch(()=>{});
        if(message.method==='Page.windowOpen')void cdp.send('Target.getTargets').then(result=>Promise.all(result.targetInfos.filter(row=>row.targetId!==targetId&&row.type==='page').map(row=>cdp.send('Target.closeTarget',{targetId:row.targetId})))).catch(()=>{});
      });
      await cdp.send('Browser.setDownloadBehavior',{behavior:'deny'});
      for(const name of ['geolocation','notifications','camera','microphone','clipboard-read'])await cdp.send('Browser.setPermission',{permission:{name},setting:'denied',origin:approved.origin}).catch(()=>{});
      await pageSend('Page.enable');await pageSend('Emulation.setScriptExecutionDisabled',{value:true});await pageSend('Network.enable');await pageSend('Network.setBypassServiceWorker',{bypass:true});await pageSend('Network.setCacheDisabled',{cacheDisabled:true});
      await pageSend('Network.setBlockedURLs',{urls:['file://*','ftp://*','ws://*','wss://*']});await pageSend('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
      const navigation=await pageSend('Page.navigate',{url:approved.href});if(navigation.errorText)throw capabilityError('DEVELOPER_BROWSER_NAVIGATION_FAILED','Approved page navigation failed');
      while(!loaded){cancelled(signal);await delay(40,signal);}
      const visible=await pageSend('Runtime.evaluate',{expression:'({url:location.href,title:document.title.slice(0,240),text:(document.body?.innerText||"").slice(0,8000)})',returnByValue:true,timeout:1000});
      const value=visible.result?.value;if(!value||value.url!==approved.href||typeof value.title!=='string'||typeof value.text!=='string')throw capabilityError('DEVELOPER_BROWSER_NAVIGATION_FAILED','Page changed from its approved destination');
      const screenshot=await pageSend('Page.captureScreenshot',{format:'jpeg',quality:55,fromSurface:true,captureBeyondViewport:false});
      if(typeof screenshot.data!=='string'||screenshot.data.length>2*1024*1024||!/^[A-Za-z0-9+/]+=*$/.test(screenshot.data))throw capabilityError('DEVELOPER_BROWSER_RESPONSE_LIMIT','Browser screenshot exceeds its limit');
      return {opened:true,url:approved.href,title:redactText(value.title).slice(0,240),visibleText:redactText(value.text).slice(0,8000),screenshot:{mimeType:'image/jpeg',base64:screenshot.data},blockedRequests,
        isolation:'temporary-profile; page scripts disabled; same-origin requests; not an OS network sandbox'};
    }catch(error){if(signal.aborted)throw signal.reason;if(typeof error?.code==='string'&&error.code.startsWith('DEVELOPER_'))throw error;throw capabilityError('DEVELOPER_BROWSER_FAILED','Browser operation failed');}
    finally{
      clearTimeout(timer);input.signal?.removeEventListener('abort',abort);
      if(profile){
        // Cleanup has its own short deadline so cancellation does not strand an
        // Edge instance after the Windows launcher already exited successfully.
        const cleanupSignal=AbortSignal.timeout(2500);let cleanup;
        try{
          while(!wsUrl&&!childFailed){
            cancelled(cleanupSignal);
            try{const [port,endpoint]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);if(/^\d{1,5}$/.test(port)&&Number(port)>0&&Number(port)<65536&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint??''))wsUrl=`ws://127.0.0.1:${port}${endpoint}`;}catch{wsUrl=null; /* Poll only this owned profile until the cleanup deadline. */}
            if(!wsUrl)await delay(40,cleanupSignal);
          }
          if(wsUrl){cleanup=await connectCdp(wsUrl,cleanupSignal);await cleanup.send('Browser.close').catch(()=>{});}
        }catch{cleanup?.close();cleanup=null; /* The verified process/profile cleanup below remains mandatory. */}finally{cleanup?.close();cdp?.close();}
      }
      await stopBrowser(child);
      if(profile){
        const relative=path.relative(path.resolve(profileRoot),path.resolve(profile));
        if(relative.startsWith('..')||path.isAbsolute(relative)||!path.basename(profile).startsWith('cetamesh-browser-'))throw capabilityError('DEVELOPER_BROWSER_CLEANUP_REQUIRED','Temporary profile ownership could not be verified');
        await stopOwnedProfileProcesses(profile);
        for(let attempt=0;attempt<20;attempt++){try{fs.rmSync(profile,{recursive:true,force:true});break;}catch{if(attempt===19)throw capabilityError('DEVELOPER_BROWSER_CLEANUP_REQUIRED','Temporary browser profile needs cleanup');await delay(100);}}
      }
    }
  };
}
