import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import managedContract from '../agentos/managed-v1.json' with {type:'json'};
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {capabilityError as error} from '../capability/types.js';
import {loadEngineAssets} from '../reverselab/engine-assets.js';
import {extractRuntimePackage,findRuntimeRoot,cleanupRuntimeStage} from './runtime-package.js';

const IDS=['agentos','reverselab'];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){
 const stat=await fsp.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||await fsp.realpath(file)!==file)throw error('ENGINE_IDENTITY_CHANGED','Runtime must contain regular canonical files.');
 const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');
}
async function inspect(id,params){
 if(!IDS.includes(id)||typeof params.root!=='string'||!path.isAbsolute(params.root))throw error('ENGINE_PATH_REQUIRED','Select an absolute local runtime directory.');
 const root=await fsp.realpath(params.root);
 if(id==='reverselab'){
  const lock=readJsonFile(path.join(root,'engine.lock.json'),{maxBytes:16384});
  const assets=await loadEngineAssets({root:path.join(root,'engine'),manifestSha256:lock.manifestSha256});
  return {root,nodePath:assets.nodePath,version:assets.version,digest:assets.assetDigest,assets};
 }
 const manifest=readJsonFile(path.join(root,'agentos.system.json'),{maxBytes:65536});
 if(manifest.id!=='org.cetamesh.agentos'||manifest.managed?.protocol!=='cetamesh.agentos.managed.v1'
  ||manifest.managed.entry!=='server/managed/stdio.mjs')throw error('ENGINE_PROTOCOL_UNSUPPORTED','This AgentOS package has no supported managed entry.');
 if(JSON.stringify(managedContract)!==JSON.stringify(readJsonFile(path.join(root,'contracts','agentos-managed-v1.json'),{maxBytes:65536})))
  throw error('ENGINE_PROTOCOL_UNSUPPORTED','AgentOS managed contract differs from the reviewed Core contract.');
 let selectedNode=params.nodePath;
 if(!selectedNode){
  const candidates=[path.join(root,'runtime',process.platform==='win32'?'node.exe':'node'),
   ...(/^node(?:\.exe)?$/i.test(path.basename(process.execPath))?[process.execPath]:[]),
   ...(process.platform==='win32'?[path.join(process.env.ProgramFiles??'C:\\Program Files','nodejs','node.exe')]:[])];
  selectedNode=candidates.find(candidate=>fs.existsSync(candidate));
 }
 if(typeof selectedNode!=='string'||!path.isAbsolute(selectedNode))throw error('ENGINE_NODE_REQUIRED','插件包缺少 Node 运行环境，请使用包含运行环境的完整安装包。');
 if(typeof manifest.version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version))throw error('ENGINE_PROTOCOL_UNSUPPORTED','插件版本无效。');
 const nodePath=await fsp.realpath(selectedNode),files=[];
 // Hash the complete managed source dependency tree, including additions; never run an unreviewed entry.
 async function walk(relative){
  const absolute=path.join(root,relative),stat=await fsp.lstat(absolute);
  if(stat.isSymbolicLink()||await fsp.realpath(absolute)!==absolute)throw error('ENGINE_IDENTITY_CHANGED','Linked runtime entries cannot be reviewed.');
  if(stat.isDirectory()){for(const name of (await fsp.readdir(absolute)).sort())await walk(path.join(relative,name));}
  else {if(files.length>=20000)throw error('ENGINE_PACKAGE_LIMIT','Runtime package exceeds the review limit.');files.push([relative,await fileHash(absolute)]);}
 }
 if(params.package?.managed)await walk('');
 else {
  for(const entry of ['agentos.system.json','package.json','server','contracts','catalog'])await walk(entry);
  if(fs.existsSync(path.join(root,'vendor')))await walk('vendor');
  if(fs.existsSync(path.join(root,'cetamesh-adaptation.json')))await walk('cetamesh-adaptation.json');
 }
 return {root,nodePath,version:manifest.version,digest:digest(JSON.stringify(files)),nodeDigest:await fileHash(nodePath)};
}
export function createLocalEngineService({stateDir,capabilityService,taskRuntime,workbenchSpawn=spawn,workbenchPlatform=process.platform}){
 const file=path.join(stateDir,'plugins','local-engines.json'),reviews=new Map(),active=new Map(),adapters=new Map();
 const packagesRoot=path.resolve(stateDir,'plugins','engine-packages');
 let configs={},loadError=null,changing=false;
 let workbench=null,openingWorkbench=null;
 try {configs=readJsonFile(file,{missing:{},maxBytes:65536});if(!configs||Array.isArray(configs)||typeof configs!=='object')throw Error('Invalid configuration');}
 catch {loadError='ENGINE_STORE_UNAVAILABLE';}
 const assertId=id=>{if(!IDS.includes(id))throw error('ENGINE_UNKNOWN','Unknown local engine.');};
 const workbenchFiles=config=>config?.package?.managed&&['AgentOSConsole.exe','ui.mjs','install.mjs'].every(name=>fs.existsSync(path.join(config.root,name)));
 function watchChild(file,args,options){
  const child=workbenchSpawn(file,args,options),row={child,stopped:false};
  row.exit=new Promise(resolve=>{const done=()=>{row.stopped=true;resolve();};child.once('exit',done);child.once('error',()=>{if(!child.pid)done();});});
  row.spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(error('ENGINE_WORKBENCH_START_FAILED','AgentOS 工作台启动失败，请检查插件运行环境。')));});
  return row;
 }
 async function stopWorkbench(row){
  if(!row)return;
  if(row.closing)return row.closing;
  row.closing=(async()=>{
   const children=[row.console,row.engine].filter(Boolean);
   for(const item of children)if(!item.stopped)item.child.kill();
   let timer;try{
    await Promise.race([Promise.all(children.map(item=>item.exit)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('ENGINE_WORKBENCH_STOP_UNCONFIRMED','工作台进程停止尚未确认；插件占用和数据已保留。')),5000);})]);
    row.release();if(workbench===row)workbench=null;
   }finally{clearTimeout(timer);}
  })();return row.closing;
 }
 async function openWorkbench(){
  if(workbench&&!workbench.closing)return {opened:true,alreadyOpen:true,dataScope:'standalone'};
  if(workbench?.closing)throw error('ENGINE_BUSY','工作台停止尚未确认，请先完成进程核对。');
  if(openingWorkbench)return openingWorkbench;
  openingWorkbench=(async()=>{
   const config=configs.agentos;
   if(workbenchPlatform!=='win32')throw error('ENGINE_WORKBENCH_UNSUPPORTED','此插件工作台需要 Windows。');
   if(!config?.enabled)throw error('ENGINE_NOT_CONFIGURED','请先安装并启用 AgentOS 插件。');
   if(!workbenchFiles(config))throw error('ENGINE_WORKBENCH_MISSING','此安装包缺少原生工作台文件，请导入包含 AgentOSConsole.exe、ui.mjs 和 install.mjs 的完整插件 ZIP。');
   await service.verifyConfiguration('agentos',config);
   const release=service.acquire('agentos',config.revision),row={release,engine:null,console:null};workbench=row;
   try{
    const home=path.resolve(stateDir,'agentos','workbench');
    for(const relative of ['','temp','local','roaming'])await fsp.mkdir(path.join(home,relative),{recursive:true,mode:0o700});
    if(await fsp.realpath(home)!==home)throw error('ENGINE_IDENTITY_CHANGED','工作台数据目录归属已变化。');
    const systemRoot=process.env.SystemRoot??'C:\\Windows';
    const env={SystemRoot:systemRoot,WINDIR:systemRoot,COMSPEC:path.join(systemRoot,'System32','cmd.exe'),SystemDrive:path.parse(systemRoot).root.replace(/[\\/]$/,''),
     PATH:[path.dirname(config.nodePath),path.join(systemRoot,'System32'),systemRoot,path.join(systemRoot,'System32','Wbem'),
      path.join(process.env.ProgramFiles??'C:\\Program Files','Docker','Docker','resources','bin'),path.join(process.env.ProgramFiles??'C:\\Program Files','qemu')].join(path.delimiter),
     HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'local'),APPDATA:path.join(home,'roaming'),TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),AGENTOS_HOME:home};
    // Prestart the verified Node entry with absolute argv. The original console
    // connects via its private discovery file and need not resolve a shell command.
    row.engine=watchChild(config.nodePath,[path.join(config.root,'ui.mjs')],{cwd:config.root,env,shell:false,windowsHide:true,stdio:'ignore'});
    await row.engine.spawned;
    const deadline=Date.now()+20000;let ready=false;
    while(Date.now()<deadline&&!row.engine.stopped){
     try{const descriptor=readJsonFile(path.join(home,'console.json'),{missing:null,maxBytes:8192});ready=descriptor?.pid===row.engine.child.pid&&Number.isInteger(descriptor.port)&&descriptor.port>0&&descriptor.port<65536&&typeof descriptor.token==='string'&&descriptor.token.length>=16;}catch{/* A discovery file is not an execution receipt; wait for this owned process. */}
     if(ready)break;await delay(50);
    }
    if(!ready)throw error('ENGINE_WORKBENCH_START_FAILED','AgentOS 本地工作台引擎未就绪，请核对完整插件包及 Node 版本。');
    row.console=watchChild(path.join(config.root,'AgentOSConsole.exe'),[],{cwd:config.root,env,shell:false,windowsHide:false,stdio:'ignore'});
    await row.console.spawned;
    if(row.engine.stopped||row.console.stopped)throw error('ENGINE_WORKBENCH_START_FAILED','AgentOS 工作台在启动期间已退出。');
    for(const item of [row.engine,row.console])item.child.once('exit',()=>{void stopWorkbench(row).catch(()=>{/* Preserve the lease on unconfirmed shutdown. */});});
    return {opened:true,alreadyOpen:false,dataScope:'standalone'};
   }catch(cause){await stopWorkbench(row);throw cause;}
  })();
  try{return await openingWorkbench;}finally{openingWorkbench=null;}
 }
 const summary=id=>id==='agentos'
  ? ['只启动独立受管 Host；项目 Agent 可操作所属 Docker / QEMU 系统。','创建、命令、文件、快照、生命周期操作逐次经过 Core 审批；不接管独立控制台中的虚拟机。','创建系统可能下载镜像并占用磁盘；由具体调用审批展示参数。']
  : ['完整 REA MCP 工具和提示模板；同一 Task 保留独立分析会话。','完整模式是本机原生执行，不是操作系统沙箱；可读写主机文件、调用外部工具及访问网络。','必须逐次批准准确的工具名和参数；不自动继承 P1 静态分析授权。外部工具依赖需另行安装。'];
 async function removeManaged(id,directory){
  const expected=path.join(packagesRoot,id),target=path.resolve(directory);
  if(path.dirname(target)!==expected||!/^package-[\da-f-]{36}$/i.test(path.basename(target)))throw error('ENGINE_IDENTITY_CHANGED','拒绝删除非所属插件安装目录。');
  if(await fsp.realpath(expected)!==expected||await fsp.realpath(target)!==target||(await fsp.lstat(target)).isSymbolicLink())throw error('ENGINE_IDENTITY_CHANGED','插件安装目录归属已变化，文件已保留。');
  await fsp.rm(target,{recursive:true,force:true});
 }
 async function reviewPackage(params){
  if(loadError)throw error(loadError,'Local engine configuration is unreadable; retained for diagnosis.');
  const stage=await extractRuntimePackage(params.file,path.join(stateDir,'plugin-center','runtime-staging'));
  try {
   const {id,root}=await findRuntimeRoot(stage.directory),config=await inspect(id,{root,package:{managed:true}}),token=crypto.randomUUID();
   for(const [key,row] of reviews)if(row.expiresAt<Date.now()){if(row.stage)await cleanupRuntimeStage(row.stage);reviews.delete(key);}
   if(reviews.size>=16)throw error('ENGINE_BUSY','请先完成或关闭已有插件安装审查。');
   config.package={managed:true};
   reviews.set(token,{kind:'package',id,config,stage,prior:configs[id]?.revision,expiresAt:Date.now()+600000});
   return {id,name:id==='agentos'?'AgentOS':'逆向分析实验室',token,version:config.version,digest:config.digest,root:config.root,nodePath:config.nodePath,
    sourceSha256:stage.sha256,files:stage.files,bytes:stage.bytes,installed:!!configs[id],installable:true,summary:summary(id)};
  }catch(cause){await cleanupRuntimeStage(stage);throw cause;}
 }
 async function installPackage(id,params){
  if(changing||(active.get(id)??0)>0)throw error('ENGINE_BUSY','插件仍有进行中的操作，结束后才能更新或卸载。');
  const review=reviews.get(params.token);
  if(params.reviewed!==true||!review||review.kind!=='package'||review.id!==id||review.expiresAt<Date.now()||review.prior!==configs[id]?.revision)
   throw error('ENGINE_REVIEW_REQUIRED','请先核验并确认本次插件安装包。');
  reviews.delete(params.token);changing=true;let promoted=null,committed=false;
  try{
   await service.verifyConfiguration(id,review.config);
   await adapters.get(id)?.disconnect();
   const parent=path.join(packagesRoot,id);await fsp.mkdir(parent,{recursive:true});
   if(await fsp.realpath(parent)!==parent)throw error('ENGINE_IDENTITY_CHANGED','插件安装根目录已变化。');
   const destination=path.join(parent,'package-'+crypto.randomUUID());
   await fsp.rename(review.stage.directory,destination);promoted=destination;
   const root=path.join(destination,path.relative(review.stage.directory,review.config.root));
   const nodePath=review.config.nodePath.startsWith(review.stage.directory+path.sep)
    ?path.join(destination,path.relative(review.stage.directory,review.config.nodePath)):review.config.nodePath;
   const config=await inspect(id,{root,nodePath,package:{managed:true}});
   if(config.digest!==review.config.digest||config.nodeDigest!==review.config.nodeDigest)throw error('ENGINE_IDENTITY_CHANGED','安装内容与核验结果不一致。');
   delete config.assets;
   config.package={managed:true,directory:destination,sourceSha256:review.stage.sha256,files:review.stage.files,bytes:review.stage.bytes,installedAt:new Date().toISOString()};
   const next={...configs,[id]:{...config,enabled:params.enable===true,revision:crypto.randomUUID()}};
   writeJsonAtomic(file,next);configs=next;committed=true;adapters.get(id)?.refresh();
   return {id,installed:true,enabled:configs[id].enabled,version:config.version,revision:configs[id].revision};
  }finally{
   changing=false;
   if(promoted&&!committed)await removeManaged(id,promoted);
   await cleanupRuntimeStage(review.stage);
  }
 }
 const service={
  getConfiguration(id){assertId(id);return loadError?null:structuredClone(configs[id]??null);},
  attach(id,adapter){assertId(id);adapters.set(id,adapter);},
  acquire(id,revision){
   assertId(id);if(changing||loadError||!configs[id]?.enabled||configs[id].revision!==revision)throw error('ENGINE_CONFIGURATION_CHANGED','Engine configuration changed; review again.');
   active.set(id,(active.get(id)??0)+1);let released=false;
   return ()=>{if(!released){released=true;active.set(id,active.get(id)-1);}};
  },
  async verifyConfiguration(id,config){
   const now=await inspect(id,config);
   if(now.digest!==config.digest||now.nodePath!==config.nodePath||now.nodeDigest!==config.nodeDigest||now.root!==config.root)
    throw error('ENGINE_IDENTITY_CHANGED','Local runtime changed since review; inspect and enable it again.');
   return now;
  },
  async execute({actor,method,params={}}){
   if(actor?.kind!=='owner')throw error('PERMISSION_DENIED','Only Owner may configure native engines.');
   if(method==='engines.list')return {errorCode:loadError,engines:loadError?[]:IDS.filter(id=>configs[id]?.root).map(id=>({
    ...configs[id],id,name:id==='agentos'?'AgentOS':'逆向分析实验室',enabled:configs[id].enabled===true,
    summary:summary(id),active:active.get(id)??0,observation:adapters.get(id)?.status?.()??null,
    ...(id==='agentos'?{workbench:{available:workbenchPlatform==='win32'&&!!workbenchFiles(configs[id]),open:!!workbench&&!workbench.closing,dataScope:'standalone'}}:{})}))};
   if(method==='engines.package.review')return reviewPackage(params);
   if(method==='engines.package.cancel'){
    const review=reviews.get(params.token);
    if(!review||review.kind!=='package')return {cancelled:false};
    await cleanupRuntimeStage(review.stage);reviews.delete(params.token);return {cancelled:true};
   }
   const id=params.id;assertId(id);
   if(loadError)throw error(loadError,'Local engine configuration is unreadable; retained for diagnosis.');
   if(method==='engines.workbench.open'){
    if(id!=='agentos')throw error('ENGINE_WORKBENCH_UNSUPPORTED','此插件没有 AgentOS 工作台。');
    return openWorkbench();
   }
   if(method==='engines.package.install')return installPackage(id,params);
   if(method==='engines.uninstall'){
    if(changing||(active.get(id)??0)>0)throw error('ENGINE_BUSY','插件仍有进行中的操作，结束后才能卸载。');
    if(!configs[id])throw error('ENGINE_NOT_CONFIGURED','插件尚未安装。');
    changing=true;
    try{
     await adapters.get(id)?.disconnect();const previous=configs[id],next={...configs};delete next[id];
     writeJsonAtomic(file,next);configs=next;adapters.get(id)?.refresh();
     let filesRetained=!previous.package?.managed;
     if(previous.package?.managed){try{
      const parent=path.join(packagesRoot,id);
      for(const entry of await fsp.readdir(parent,{withFileTypes:true}))if(entry.isDirectory()&&/^package-[\da-f-]{36}$/i.test(entry.name))await removeManaged(id,path.join(parent,entry.name));
     }catch{filesRetained=true;}}
     return {id,uninstalled:true,filesRetained,historyRetained:true};
    }finally{changing=false;}
   }
   if(method==='engines.authorize-task'){
    if(changing||!configs[id]?.enabled)throw error('ENGINE_NOT_CONFIGURED','Enable the reviewed runtime first.');
    const task=taskRuntime.get({id:params.taskId}).task;
    if(task.rev!==params.expectedRev||task.status!=='queued'||task.currentAgent||task.parentTaskId)
     throw error('TASK_GRANT_NOT_IDLE','Choose an unassigned queued project Task before starting its Agent.');
    let principal;
    try{principal=capabilityService.principalForTask(task.id);}catch(cause){if(cause.code!=='TASK_NOT_AUTHORIZED')throw cause;}
    const capabilities=capabilityService.broker.registry.list().filter(row=>row.provider===id&&row.modelCallable).map(row=>row.id);
    principal??=capabilityService.grantTask(task.id);
    capabilityService.grantTask(task.id,{capabilities:[...new Set([...principal.grants.capabilities,...capabilities])]});
    return {taskId:task.id,capabilities,executionApprovalRequired:true};
   }
   if(method==='engines.review'){
    const saved=configs[id],managed=saved?.package?.managed&&saved.root===params.root;
    const config=await inspect(id,{...params,...(managed?{package:saved.package}:{})}),token=crypto.randomUUID();
    if(managed){
     if(config.digest!==saved.digest||config.nodeDigest!==saved.nodeDigest)throw error('ENGINE_IDENTITY_CHANGED','已安装插件文件发生变化，请重新导入完整安装包。');
     config.package=saved.package;
    }
    for(const [key,row] of reviews)if(row.expiresAt<Date.now())reviews.delete(key);
    if(reviews.size>=16)reviews.delete(reviews.keys().next().value);
    reviews.set(token,{id,config,prior:configs[id]?.revision,expiresAt:Date.now()+600000});
    return {id,token,version:config.version,digest:config.digest,root:config.root,nodePath:config.nodePath,summary:summary(id)};
   }
   if(!['engines.enable','engines.disable'].includes(method))throw error('METHOD_NOT_FOUND','Unknown local engine command.');
   if(method==='engines.disable'&&!configs[id]?.root)throw error('ENGINE_NOT_CONFIGURED','Connect a reviewed external plugin first.');
   if(changing||(active.get(id)??0)>0)throw error('ENGINE_BUSY','Wait for current plugin operations before changing configuration.');
   changing=true;
   try{
    let config;
    if(method==='engines.enable'){
     const review=reviews.get(params.token);reviews.delete(params.token);
     if(!review||review.kind==='package'||review.id!==id||review.expiresAt<Date.now()||review.prior!==configs[id]?.revision)throw error('ENGINE_REVIEW_REQUIRED','Review the exact runtime before enabling it.');
     await service.verifyConfiguration(id,review.config);config={...review.config,enabled:true};delete config.assets;
    }else config={...configs[id],enabled:false};
    await adapters.get(id)?.disconnect();
    const next={...configs,[id]:{...config,revision:crypto.randomUUID()}};
    writeJsonAtomic(file,next);configs=next;adapters.get(id)?.refresh();
    return {id,enabled:config.enabled,revision:configs[id].revision};
   }finally{changing=false;}
  },
  async close(){
   if(openingWorkbench)await openingWorkbench.catch(()=>{});
   const cleanup=[...reviews.values()].filter(row=>row.stage).map(row=>cleanupRuntimeStage(row.stage));reviews.clear();
   const outcomes=await Promise.allSettled([stopWorkbench(workbench),...cleanup,...[...adapters.values()].map(adapter=>Promise.resolve().then(()=>adapter.close()))]);
   const failures=outcomes.filter(row=>row.status==='rejected').map(row=>row.reason);
   if(failures.length===1)throw failures[0];
   if(failures.length)throw new AggregateError(failures,'Local engine shutdown remains unconfirmed.');
  }
 };
 return service;
}
