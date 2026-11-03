// Opt-in production Harbor/WebView2 validation in an isolated development profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SELF = fileURLToPath(import.meta.url);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const load = (root, name) => import(pathToFileURL(path.join(root, name)).href);
const parentGoal = 'Audit isolated parent';
const childGoal = 'Audit isolated read child';

async function until(read, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Native acceptance timeout: ' + label);
}

function ownedEnv(root, repo, gitDir) {
  const env = {};
  for (const key of ['SystemRoot','windir','SystemDrive','ComSpec','PATHEXT','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [path.dirname(process.execPath), gitDir, path.join(env.SystemRoot,'System32'), env.SystemRoot,
    path.join(env.SystemRoot,'System32','WindowsPowerShell','v1.0')].join(path.delimiter);
  for (const [key, dir] of Object.entries({USERPROFILE:'home',HOME:'home',LOCALAPPDATA:'local',APPDATA:'roaming',TEMP:'tmp',TMP:'tmp',CODEX_HOME:'codex',DSH_HOME:'dsh'})) {
    env[key] = path.join(root, dir);
    fs.mkdirSync(env[key], {recursive:true});
  }
  return {...env, WHALEBRIDGE_DATA_DIR:path.join(root,'data'), WHALEBRIDGE_RESOURCE_DIR:repo,
    WHALEBRIDGE_REPO_ROOT:repo, WHALEBRIDGE_CORE_EXE:process.execPath, WHALEBRIDGE_CORE_MODE:'development',
    WHALEBRIDGE_INSTANCE_SUFFIX:'native-audit-'+crypto.randomUUID(), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'NUL',
    GIT_TERMINAL_PROMPT:'0', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --disable-background-networking'};
}

// Run seeding in a separately bounded process so even module-level discovery uses the synthetic identity.
async function seed(repo, root) {
  assert.equal(fs.realpathSync(process.env.WHALEBRIDGE_DATA_DIR), fs.realpathSync(path.join(root,'data')));
  const { bootstrapCetaMesh } = await load(repo,'src/app/bootstrap.js');
  const { writeJsonAtomic } = await load(repo,'src/storage/json-file.js');
  const data = process.env.WHALEBRIDGE_DATA_DIR;
  const app = bootstrapCetaMesh({stateDir:path.join(data,'state'),dataRoot:data,sourceRoot:repo,resourceRoot:repo,deferOptionalStart:true});
  const ui = (method,params={}) => app.services.desktopUiService.execute({method,params});
  try {
    const {workspace} = await app.services.workspaceService.execute({method:'workspace.create',params:{name:'Audit local project',root:path.join(root,'project')}});
    await app.services.workspaceService.execute({method:'workspace.open',params:{id:workspace.id}});
    const {role} = await ui('ui.simulation.role.save',{name:'Audit role',sourceText:'A synthetic role with no tools or account.'});
    await ui('ui.simulation.room.create',{title:'Audit local planning',goal:parentGoal,scene:'project',workspaceId:workspace.id,roleIds:[role.id]});
    await app.services.settingsService.execute({method:'settings.update',params:{section:'general',values:{confirmOnExit:false}}});
    for (const stepId of ['welcome','provider','connection','model']) await ui('ui.onboarding.completeStep',{stepId});
    await ui('ui.onboarding.finish');
    assert.equal(app.services.providerSecrets.list().length,0);
    assert.equal(app.services.taskService.runtime.list({}).tasks.length,0);
  } finally {
    assert.equal((await app.lifecycle.stop()).ok,true,'all fixture services must close before starting the real Core');
  }
  writeJsonAtomic(path.join(data,'state','desktop-ui.json'),{closeBehavior:'quit'});
}

function profilePort(directory) {
  if (!fs.existsSync(directory)) return null;
  const visit = (dir, depth) => {
    for (const row of fs.readdirSync(dir,{withFileTypes:true})) {
      const file = path.join(dir,row.name);
      if (row.isFile() && row.name==='DevToolsActivePort') return file;
      if (row.isDirectory() && depth<4) { const child=visit(file,depth+1); if(child)return child; }
    }
    return null;
  };
  return visit(directory,0);
}

// Query only descendants of the still-owned Shell. Return a projection, never raw command lines.
function ownedWebViewFacts(child, profile, env) {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid>0);
  const script=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$auditProfile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(profile).toString('base64')}'))
$auditExpected=@([IO.Path]::GetFullPath($auditProfile).TrimEnd('\'),[IO.Path]::GetFullPath([IO.Path]::Combine($auditProfile,'EBWebView')).TrimEnd('\'))
$auditFront=@(${child.pid});$auditSeen=@(${child.pid});$auditRows=@()
for($auditDepth=0;$auditDepth -lt 4 -and $auditFront.Count -gt 0;$auditDepth++){
  $auditNext=@()
  foreach($auditParent in $auditFront){
    foreach($auditChild in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$auditParent")){
      if($auditSeen -contains [int]$auditChild.ProcessId){continue}
      $auditSeen += [int]$auditChild.ProcessId
      if($auditSeen.Count -gt 64){throw 'OWNED_PROCESS_LIMIT'}
      $auditNext += [int]$auditChild.ProcessId
      if($auditChild.Name -ine 'msedgewebview2.exe'){continue}
      $auditLine=[string]$auditChild.CommandLine
      $auditUserDir=[regex]::Match($auditLine,'(?:^|\s)--user-data-dir=(?:"([^"]*)"|(\S+))')
      $auditDir=if($auditUserDir.Groups[1].Success){$auditUserDir.Groups[1].Value}else{$auditUserDir.Groups[2].Value}
      $auditOwned=$false
      if($auditDir){$auditOwned=$auditExpected -contains [IO.Path]::GetFullPath($auditDir).TrimEnd('\')}
      $auditPort=[regex]::Match($auditLine,'(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)')
      $auditKind=[regex]::Match($auditLine,'(?:^|\s)--type=([a-z-]+)(?:\s|$)').Groups[1].Value
      if(-not $auditKind){$auditKind='browser'}elseif($auditKind -notin @('renderer','gpu-process','utility')){$auditKind='other'}
      $auditRows += [pscustomobject]@{pid=[int]$auditChild.ProcessId;parentPid=[int]$auditChild.ParentProcessId;kind=$auditKind;profileOwned=$auditOwned;debugPort=if($auditPort.Success){[int]$auditPort.Groups[1].Value}else{$null};debugAddressLoopback=$auditLine.Contains('--remote-debugging-address=127.0.0.1');backgroundNetworkDisabled=$auditLine.Contains('--disable-background-networking')}
    }
  }
  $auditFront=$auditNext
}
ConvertTo-Json -InputObject @($auditRows) -Compress -Depth 3
`;
  return JSON.parse(execFileSync(path.join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {env,encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:16384}));
}

function startupReportFacts(data, readJsonFile) {
  const dir=path.join(data,'state','diagnostics-shell');
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(file=>file.endsWith('.json')).slice(0,20).map(file=>{
    const report=readJsonFile(path.join(dir,file));
    return {status:report.status,pending:report.pending===true,codes:[...new Set((report.checks??[])
      .map(row=>row.code).filter(code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)))].slice(0,24)};
  });
}

function ownedDebugPort(child, profile, env, fact) {
  const browser=ownedWebViewFacts(child,profile,env).find(row=>row.kind==='browser'&&row.profileOwned&&row.debugPort!==null);
  if(!browser)return null;
  const script=`$ProgressPreference='SilentlyContinue'
$ports=@(Get-NetTCPConnection -State Listen -OwningProcess ${browser.pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort)
ConvertTo-Json -InputObject $ports -Compress`;
  const ports=JSON.parse(execFileSync(path.join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {env,encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:16384}));
  fact.ownedListeners=ports;
  // A requested positive port must actually belong to this profile's browser.
  return ports.find(row=>row.LocalAddress==='127.0.0.1'&&row.LocalPort===browser.debugPort)?.LocalPort??null;
}

async function launch({shell,repo,root,env,WebSocket,terminateSuiteProcessTree,readJsonFile,confirmTitle,evidence}) {
  const data=path.join(root,'data'),profile=path.join(data,'webview2');
  const reservation=net.createServer();
  await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
  const debugPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  env={...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
    '--remote-debugging-port='+debugPort+' --remote-debugging-address=127.0.0.1 --disable-background-networking'};
  const stale=profilePort(profile);
  if(stale) fs.unlinkSync(stale);
  const child=spawn(shell,['--ui=v2','--data-dir',data],{cwd:path.dirname(shell),env,stdio:['ignore','ignore','pipe'],windowsHide:true});
  const fact={phase:'spawn',desktopPid:child.pid??null};
  evidence.startup??=[];evidence.startup.push(fact);
  let shellError='';
  child.stderr?.on('data',bytes=>{shellError=(shellError+String(bytes)).slice(-1600);});
  let ended=false, socket, sequence=0, expectedDialog=null, launchError;
  const pending=new Map();
  const exited=new Promise(resolve=>{
    child.once('error',error=>{launchError=error;ended=true;resolve();});
    child.once('close',(code,signal)=>{ended=true;resolve({code,signal});});
  });
  const alive=()=>{if(ended)throw Error('Owned Desktop exited: '+(launchError?.code||child.exitCode));};
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    if(socket?.readyState!==WebSocket.OPEN)return reject(Error('Owned CDP unavailable'));
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},10000);
    pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw Error('Native UI action failed: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,300));
    return r.result?.value;
  };
  async function close({requireGraceful=true}={}) {
    let normal=false,forced=false;
    try {
      if(!ended && socket?.readyState===WebSocket.OPEN){
        await evaluate('void window.cetamesh.invoke("app.windowAction",{action:"close"}).catch(()=>{ /* Shell may close before replying. */ })').catch(()=>{ /* Exit confirmation below decides whether shutdown passed. */ });
        const result=await Promise.race([exited,delay(12000,null,{ref:false})]);
        normal=result?.code===0 && result?.signal===null;
      }
    } finally {
      socket?.terminate();
      if(!ended && child.pid){await terminateSuiteProcessTree(child);await until(()=>ended,'owned fallback exit',5000);forced=true;}
    }
    fact.exit={confirmed:ended,graceful:normal,forced,code:child.exitCode,signal:child.signalCode};
    if(!ended || (requireGraceful && !normal))throw Error('Native Shell graceful exit was not confirmed');
    if(normal)await until(()=>!fs.existsSync(path.join(data,'state','.core-owner.lock')),'Core StateDir lease released',5000);
  }
  try {
    fact.phase='waiting-profile-port';
    const port=await until(()=>{
      alive();
      const file=profilePort(profile);
      return file ? Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]) : ownedDebugPort(child,profile,env,fact);
    },'owned WebView2 profile debug endpoint',45000);
    fact.phase='waiting-bundled-target';
    assert.ok(Number.isInteger(port)&&port>0&&port<65536);
    const target=await until(async()=>{
      alive();
      try{return (await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1000)})).json())
        .find(row=>row.type==='page'&&new URL(row.url).origin==='https://cetamesh.localhost');}
      catch{return null;} // Only the just-created profile's loopback endpoint can participate.
    },'bundled application origin',20000);
    const address=new URL(target.webSocketDebuggerUrl);
    assert.equal(address.protocol,'ws:');assert.equal(address.hostname,'127.0.0.1');assert.equal(Number(address.port),port);
    fact.phase='connecting-cdp';
    socket=new WebSocket(address,{handshakeTimeout:6000});
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    socket.on('error',()=>{ /* close releases every pending transport wait below. */ });
    socket.on('close',()=>{for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error('Owned CDP closed'));}pending.clear();});
    socket.on('message',raw=>{
      const msg=JSON.parse(raw);
      if(msg.method==='Page.javascriptDialogOpening'){
        const expected=expectedDialog!==null && msg.params.type==='confirm' && msg.params.message==='取消任务“'+expectedDialog+'”？';
        if(expected){evidence.cancelDialogs++;expectedDialog=null;}else{evidence.unexpectedDialogs++;}
        void rpc('Page.handleJavaScriptDialog',{accept:expected}).catch(()=>{evidence.dialogFailures++;});
      }
      const row=pending.get(msg.id);if(!row)return;clearTimeout(row.timer);pending.delete(msg.id);
      if(msg.error)row.reject(Error('CDP '+msg.error.code));else row.resolve(msg.result);
    });
    fact.phase='waiting-renderer';
    await rpc('Runtime.enable');await rpc('Page.enable');
    await until(()=>evaluate('typeof window.cetamesh?.invoke==="function" && !!document.querySelector(".harbor-shell")'),'real product shell',30000);
    fact.phase='waiting-core-ready';
    assert.equal((await evaluate('window.cetamesh.invoke("app.ping",{})')).host,'webview2');
    await until(()=>evaluate('window.cetamesh.invoke("app.status",{}).then(x=>x.ready===true)'),'authenticated Core readiness',30000);
    assert.equal(await evaluate('location.origin'),'https://cetamesh.localhost');
    fact.phase='ready';
    return {evaluate,close,armCancel(title){assert.equal(title,confirmTitle);expectedDialog=title;}};
  }catch(error){
    const safeRead=file=>{try{return fs.readFileSync(file,'utf8').slice(-16000);}catch{return ''; /* only optional owned diagnostics */}};
    const hostLog=safeRead(path.join(data,'logs','desktop-shell.log')),coreLog=safeRead(path.join(data,'logs','worker.log'));
    let reports=[];
    try{reports=startupReportFacts(data,readJsonFile);}catch(readError){fact.diagnosticsReadCode=readError.code??readError.name; /* Preserve the primary startup error. */}
    if(!ended && child.pid){
      try{fact.ownedWebViews=ownedWebViewFacts(child,profile,env);}catch(queryError){fact.ownedProcessQueryCode=queryError.code??queryError.name; /* Optional evidence must not mask the startup error. */}
    }
    fact.fault={message:error.message,profileExists:fs.existsSync(profile),portExists:Boolean(profilePort(profile)),hostStarted:hostLog.includes('[start]'),
      trayCreated:hostLog.includes('[tray]'),webviewInitialized:hostLog.includes('[ui-v2] WebView2 ready'),corePipeReady:coreLog.includes('Native UI IPC server is ready'),
      nativeFallbackReport:reports.some(report=>report.codes.includes('SHELL_PRESENTATION_UNAVAILABLE')),diagnostics:reports,stderrPresent:Boolean(shellError.trim()),
      stderrCodes:[...new Set(shellError.match(/0x[0-9a-f]{8}|(?:ERROR|HRESULT|CORE|WEBVIEW|EACCESS|EPERM|ENOENT)[_A-Z0-9]{0,100}/gi)??[])].slice(0,6)};
    try{await close({requireGraceful:false});}catch(cleanupError){error.cleanupCode=cleanupError.message;}
    throw error;
  }
}

const arg=JSON.stringify;
function browserActions(evaluate) {
  const clickable=(selector,label,contains=false)=>'[...document.querySelectorAll('+arg(selector)+')].find(e=>e.getClientRects().length && !e.disabled && e.textContent.trim()'+(contains?'.includes('+arg(label)+')':'==='+arg(label))+')';
  async function click(selector,label,{contains=false,details=false}={}) {
    const target=clickable(selector,label,contains);
    await until(()=>evaluate('!!('+target+')'),'visible '+label);
    await evaluate('(()=>{const e='+target+';if(!e)throw Error("control changed");'+(details?'if(!e.parentElement.open)e.click();':'e.click();')+'})()');
  }
  const fill=async(label,value)=>{
    const selector='[aria-label='+arg(label)+']';
    await until(()=>evaluate('!!document.querySelector('+arg(selector)+')'),'field '+label);
    await evaluate('(()=>{const e=document.querySelector('+arg(selector)+');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+arg(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
  };
  return {click,fill,visible:async(selector,label)=>until(()=>evaluate('!!('+clickable(selector,label,true)+')'),'visible '+label)};
}

async function runNativeTaskAudit({sourceRoot,debugShell,expectedShellSha256,tempRoot}) {
  assert.equal(process.platform,'win32');
  const repo=fs.realpathSync(sourceRoot),binary=fs.realpathSync(debugShell);
  assert.equal(path.basename(binary).toLowerCase(),'whalebridge-desktop.exe');
  assert.equal(path.basename(path.dirname(binary)).toLowerCase(),'debug','only a development Debug build is accepted');
  assert.match(expectedShellSha256,/^[a-f0-9]{64}$/i);
  const binaryHash=digest(fs.readFileSync(binary));assert.equal(binaryHash,expectedShellSha256.toLowerCase());
  const {createSuiteSandbox,finalizeSuiteSandbox}=await load(repo,'src/testing/suite-sandbox.js');
  const {terminateSuiteProcessTree}=await load(repo,'src/testing/suite-process.js');
  const {readJsonFile,writeJsonAtomic}=await load(repo,'src/storage/json-file.js');
  const WebSocket=createRequire(path.join(repo,'package.json'))('ws');
  const gitExe=execFileSync(path.join(process.env.SystemRoot,'System32','where.exe'),['git.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0];
  assert.ok(path.isAbsolute(gitExe)&&fs.existsSync(gitExe));
  const sandbox=createSuiteSandbox({suiteId:'native-task-audit',...(tempRoot?{tempRoot}:{})}),root=sandbox.root;
  const env=ownedEnv(root,repo,path.dirname(gitExe)),data=env.WHALEBRIDGE_DATA_DIR,project=path.join(root,'project'),app=path.join(root,'app');
  const evidence={source:'development WebView2 and source Core',head:execFileSync(gitExe,['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),shellSha256:binaryHash,launches:[],cancelDialogs:0,unexpectedDialogs:0,dialogFailures:0,stages:[]};
  const sink=http.createServer((req,res)=>{res.writeHead(503);res.end();});
  let native,failed=true,cleanupConfirmed=true,primaryError=null;
  const tasks=()=>readJsonFile(path.join(data,'state','tasks','tasks.json'),{missing:{tasks:[]}}).tasks;
  const getTask=id=>'window.cetamesh.invoke("ui.task.get",{id:'+arg(id)+'}).then(x=>x.task)';
  try {
    await new Promise((resolve,reject)=>{sink.once('error',reject);sink.listen(0,'127.0.0.1',resolve);});
    for(const dir of [data,project,app])fs.mkdirSync(dir);
    const endpoint='http://127.0.0.1:'+sink.address().port;
    writeJsonAtomic(path.join(data,'config.json'),{dsh:{baseUrl:endpoint,homeDir:env.DSH_HOME},allow:{groups:[],private:[]},onebot:{enabled:false,httpUrl:'',wsUrl:''},allowAllWhenEmpty:false});
    fs.writeFileSync(path.join(project,'scope.txt'),'immutable native audit fixture\n',{flag:'wx'});
    const git=(...args)=>execFileSync(gitExe,args,{cwd:project,env,encoding:'utf8',windowsHide:true}).trim();
    git('init','-q','-b','main');git('add','scope.txt');
    git('-c','user.name=Audit','-c','user.email=audit@example.invalid','-c','commit.gpgSign=false','-c','core.hooksPath='+path.join(root,'no-hooks'),'commit','-qm','audit baseline');
    const baseline=git('rev-parse','HEAD');
    const shell=path.join(app,'WhaleBridge.exe');fs.copyFileSync(binary,shell);assert.equal(digest(fs.readFileSync(shell)),binaryHash);
    const ui=path.join(repo,'desktop-ui','dist'),dest=path.join(app,'resources','desktop-ui');
    assert.ok(fs.existsSync(path.join(ui,'index.html')));fs.cpSync(ui,dest,{recursive:true});
    const bundleHash=dir=>digest(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
      const file=path.join(e.parentPath,e.name);return path.relative(dir,file).split(path.sep).join('/')+' '+digest(fs.readFileSync(file));
    }).sort().join('\n'));
    evidence.uiSha256=bundleHash(ui);assert.equal(bundleHash(dest),evidence.uiSha256);
    execFileSync(process.execPath,[SELF,'--seed',repo,root],{cwd:root,env,stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true});
    assert.equal(tasks().length,0);
    const open=async()=>{const t=Date.now();const n=await launch({shell,repo,root,env,WebSocket,terminateSuiteProcessTree,readJsonFile,confirmTitle:childGoal,evidence});evidence.launches.push({readyMs:Date.now()-t});return n;};
    native=await open();
    const {click,fill,visible}=browserActions(native.evaluate);
    await click('[role=tab]','项目协作');
    await click('.simulation-room-item','Audit local planning',{contains:true});
    await click('.simulation-project-strip summary','项目',{contains:true,details:true});
    await click('button','创建真实任务');
    await fill('真实任务目标',parentGoal);
    await click('button','确认创建待启动任务');
    const parent=await until(()=>tasks().find(row=>row.goal===parentGoal),'durable queued parent');
    assert.equal(parent.status,'queued');assert.equal(parent.currentAgent,null);assert.equal(tasks().length,1);
    evidence.stages.push({stage:'native project Task creation',revision:parent.rev});
    await click('button','查看任务',{contains:true});
    await visible('.cm-sheet h2',parentGoal);
    await click('.task-detail-section > summary','协作与子任务',{details:true});
    await click('.task-advanced > summary','创建只读子任务',{details:true});
    await fill('子任务目标',childGoal);await fill('相对读取范围','scope.txt');
    await click('button','创建只读子任务');
    const child=await until(()=>tasks().find(t=>t.goal===childGoal),'durable queued child');
    assert.equal(child.parentTaskId,parent.id);assert.equal(child.workspaceId,parent.workspaceId);assert.equal(child.currentAgent,null);
    assert.equal(child.status,'queued');assert.equal(child.childContract.mode,'read-only');assert.deepEqual(child.childContract.readScope,['scope.txt']);
    await click('.task-child-summary button',childGoal);await visible('.cm-sheet h2',childGoal);
    native.armCancel(childGoal);await click('.task-detail-actions button','取消任务');
    const cancelled=await until(()=>tasks().find(t=>t.id===child.id&&t.status==='cancelled'),'durable cancellation');
    assert.ok(cancelled.rev>child.rev);assert.equal((await native.evaluate(getTask(child.id))).rev,cancelled.rev);
    await visible('.cm-sheet .task-detail-overview','已取消');
    assert.equal(evidence.cancelDialogs,1);assert.equal(evidence.unexpectedDialogs,0);assert.equal(evidence.dialogFailures,0);
    evidence.stages.push({stage:'native scoped child create, read and cancel',createdRevision:child.rev,cancelledRevision:cancelled.rev});
    await click('button','返回父任务');await visible('.cm-sheet h2',parentGoal);
    const testBranch='codex/audit-local-ref';
    const pending=await native.evaluate('window.cetamesh.invoke("ui.workspace.git.branch.create",'+arg({id:parent.workspaceId,taskId:parent.id,branch:testBranch,expectedHead:baseline})+')');
    assert.ok(pending.approvalId);assert.equal(git('branch','--list',testBranch),'');
    const approvalScope='[aria-label="本任务待确认操作"]';
    await click(approvalScope+' button','拒绝');
    const approvals=()=>readJsonFile(path.join(data,'state','capability','approvals.json'),{missing:[]});
    await until(()=>approvals().some(row=>row.id===pending.approvalId&&row.status==='rejected'),'durable Owner rejection');
    assert.equal(git('branch','--list',testBranch),'');
    evidence.stages.push({stage:'real Git approval request via native bridge, rejection via Task UI',gitRefCreated:false});
    await native.close();native=null;
    native=await open();
    const restored=await native.evaluate(getTask(child.id));assert.equal(restored.status,'cancelled');assert.equal(restored.rev,cancelled.rev);
    assert.equal((await native.evaluate(getTask(parent.id))).status,'queued');assert.equal(tasks().length,2);
    assert.ok(tasks().every(t=>!t.currentAgent&&!t.agentHistory.length&&!t.attempts.length&&!t.executionEvidence.length));
    assert.equal(fs.existsSync(path.join(data,'state','provider-keys.json')),false);
    const usage=readJsonFile(path.join(data,'state','model','usage-ledger.json'),{missing:{receipts:[]}});
    assert.equal(usage.receipts.length,0);assert.equal(git('status','--porcelain'),'');assert.equal(git('rev-parse','HEAD'),baseline);
    assert.equal(fs.readFileSync(path.join(project,'scope.txt'),'utf8'),'immutable native audit fixture\n');assert.equal(evidence.unexpectedDialogs,0);
    await native.close();native=null;
    evidence.stages.push({stage:'two graceful exits, cold real Core and readback',modelReceipts:0,unknownDialogs:0});
    failed=false;return evidence;
  }catch(error){
    primaryError=error;
    if(error.cleanupCode)cleanupConfirmed=false;
    console.error('NATIVE_TASK_AUDIT_FAILURE '+JSON.stringify({head:evidence.head,primary:error.message,stages:evidence.stages,launches:evidence.launches,startup:evidence.startup,unexpectedDialogs:evidence.unexpectedDialogs,cleanupCode:error.cleanupCode??null}));
    throw error;
  }finally{
    if(native){try{await native.close({requireGraceful:false});}catch(error){cleanupConfirmed=false;console.error('OWNED_NATIVE_CLEANUP_UNCONFIRMED',error.message);}}
    sink.closeAllConnections();if(sink.listening)await new Promise(resolve=>sink.close(resolve));
    if(cleanupConfirmed){for(let i=0;;i++){try{finalizeSuiteSandbox({sandbox,failed,keepFailed:Boolean(tempRoot)&&process.env.KEEP_TEST_ARTIFACTS==='1'});break;}catch(error){if(i>=30){if(!primaryError)throw error;primaryError.cleanupCode=error.code??'OWNED_FILES_UNRELEASED';console.error('NATIVE_AUDIT_FILE_CLEANUP_UNCONFIRMED '+primaryError.cleanupCode);break;}await delay(150);}}}
    else if(!primaryError)throw Error('Owned native sandbox retained because shutdown was not confirmed');
  }
}

if(process.argv[2]==='--seed' && path.resolve(process.argv[1])===SELF)await seed(process.argv[3],process.argv[4]);
else if (process.env.WHALEBRIDGE_TEST_NATIVE_PRODUCT === '1') {
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  const debugShell = path.join(sourceRoot, 'desktop-shell', 'target', 'debug', 'whalebridge-desktop.exe');
  const result = await runNativeTaskAudit({sourceRoot, debugShell, tempRoot:process.env.CETAMESH_AUDIT_NATIVE_TMP,
    expectedShellSha256: process.env.CETAMESH_AUDIT_DEBUG_SHA256 || digest(fs.readFileSync(debugShell))});
  console.log('NATIVE_TASK_AUDIT '+JSON.stringify(result));
} else {
  console.log('NOT_RUN_ENVIRONMENT: native product opt-in required');
  process.exitCode = 77;
}
