import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readJsonFile } from '../storage/json-file.js';
import { writeJsonAtomic } from '../storage/json-file.js';
import { agentProviderError as fault } from './agent-provider.js';

// Audited official npm packages; new releases require native permission revalidation.
export const GEMINI_QWEN_NATIVE_VERSIONS = Object.freeze({ gemini: '0.65.0', qwen: '0.26.1' });
export const GEMINI_QWEN_POLICY_VERSION = 'gemini-0.65.0-qwen-0.26.1-cetamesh-native-ask-v1';
// Qwen 0.26.1 does not implement '*' for builtin permission names. This is its
// complete pinned ToolNames registry; denied integrations still have ask coverage.
export const QWEN_NATIVE_TOOLS = Object.freeze([
  'exec','edit','write_file','read_file','zoom_image','grep_search','glob','run_shell_command','todo_write',
  'save_memory','manage_memory','search_memory','agent','skill','exit_plan_mode','enter_plan_mode','web_fetch','web_search',
  'image_gen','list_directory','lsp','ask_user_question','cron_create','cron_list','cron_delete','loop_wakeup',
  'create_sub_session','list_agents','task_stop','task_create','task_update','task_list','team_create','team_delete',
  'team_plan_approval','request_shutdown','send_message','structured_output','monitor','notebook_edit','tool_call','tool_search',
  'read_mcp_resource','advisor','enter_worktree','exit_worktree','workflow','artifact','record_artifact','record_source',
  'report_findings','get_goal','update_goal','omni_downsample_image','omni_downscale_video','omni_downsample_audio',
  'omni_extract_keyframes','omni_extract_audio','omni_clip_video','omni_convert_image','omni_transcribe_audio',
  'omni_clip_image','omni_clip_audio','omni_caption_image','omni_caption_audio','omni_ocr_image',
  'omni_understand_video_segments','omni_recall_media_memory','propose_goal','display_image'
]);
const QWEN_ALLOWED_TOOLS = new Set(['edit','write_file','read_file','zoom_image','grep_search','glob','run_shell_command',
  'todo_write','web_fetch','list_directory','notebook_edit','tool_call','tool_search']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const GEMINI_QWEN_SNAPSHOT_EXCLUDED_PATHS = Object.freeze(['.gemini','.qwen','.agents','.claude','.env','.env.local',
  '.mcp.json','.lsp.json','GEMINI.md','QWEN.md','AGENTS.md']);

export function knownGeminiQwenRuntime(id,version,initialized) {
  const expected=GEMINI_QWEN_NATIVE_VERSIONS[id];
  return Boolean(expected && process.platform==='win32' && version===expected && initialized?.protocolVersion===1
    && initialized.agentInfo?.version===expected && initialized.agentInfo?.name===(id==='gemini'?'gemini-cli':'qwen-code'));
}

export function createGeminiQwenProfile({id,configuration={},profileParent=os.tmpdir(),allowLoopbackHttpForTests=false}={}) {
  if(!Object.hasOwn(GEMINI_QWEN_NATIVE_VERSIONS,id)) throw fault('ACP_RUNTIME_INVALID','Unsupported native Agent profile');
  const model=configuration.model || 'health-probe';
  if(typeof model!=='string' || model.length>256 || /[\x00-\x1f{}]/.test(model)) throw fault('AGENT_MODEL_REQUIRED','Configure an Agent model');
  let endpoint;try{endpoint=new URL(configuration.baseUrl);}catch{throw fault('AGENT_ENDPOINT_INVALID','Configure an Agent API endpoint');}
  if(endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[{}]/.test(configuration.baseUrl)
    || (endpoint.protocol!=='https:' && !(allowLoopbackHttpForTests && endpoint.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))))
    throw fault('AGENT_ENDPOINT_INVALID','Invalid Agent API endpoint');
  const root=fs.mkdtempSync(path.join(profileParent,'cetamesh-'+id+'-'));
  const home=path.join(root,'.'+(id==='gemini'?'gemini':'qwen'));
  const environment={HOME:root,USERPROFILE:root,APPDATA:path.join(root,'app'),LOCALAPPDATA:path.join(root,'local'),
    PROGRAMDATA:path.join(root,'system'),HOMEDRIVE:path.parse(root).root.slice(0,2),HOMEPATH:root.slice(2),
    TEMP:path.join(root,'tmp'),TMP:path.join(root,'tmp'),TMPDIR:path.join(root,'tmp'),
    XDG_CONFIG_HOME:path.join(root,'.config'),XDG_DATA_HOME:path.join(root,'.local','share'),
    XDG_STATE_HOME:path.join(root,'.local','state'),XDG_CACHE_HOME:path.join(root,'.cache')};
  for(const directory of [home,environment.APPDATA,environment.LOCALAPPDATA,environment.PROGRAMDATA,environment.TEMP]) fs.mkdirSync(directory,{recursive:true});
  const systemFile=path.join(root,'system','settings.json'),defaultsFile=path.join(root,'system','defaults.json'),settingsFile=path.join(home,'settings.json');
  let settings,argv=['--approval-mode','default','--model',model];
  const ownedFiles=new Map();
  const own=(file,source)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);ownedFiles.set(file,source);};
  if(id==='gemini') {
    const policyFile=path.join(root,'system','policies','cetamesh.toml');
    own(policyFile,'[[rule]]\ntoolName = "*"\ndecision = "ask_user"\npriority = 999\n');
    settings={general:{enableAutoUpdate:false,enableAutoUpdateNotification:false,defaultApprovalMode:'default'},
      advanced:{ignoreLocalEnv:true,autoConfigureMemory:false},security:{auth:{selectedType:'gemini-api-key',enforcedType:'gemini-api-key'},disableAlwaysAllow:true},
      hooksConfig:{enabled:false},hooks:{},mcpServers:{},admin:{secureModeEnabled:true,extensions:{enabled:false},mcp:{enabled:false},skills:{enabled:false}},
      skills:{enabled:false},experimental:{enableAgents:false},telemetry:{enabled:false},model:{name:model},
      context:{fileName:[],loadMemoryFromIncludeDirectories:false},tools:{sandbox:false}};
    Object.assign(environment,{GEMINI_CLI_HOME:home,GEMINI_CLI_NO_RELAUNCH:'true',GEMINI_CLI_SYSTEM_SETTINGS_PATH:systemFile,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH:defaultsFile,GEMINI_CLI_TRUST_WORKSPACE:'true',GOOGLE_GEMINI_BASE_URL:configuration.baseUrl});
    argv.push('--admin-policy',policyFile);
  } else {
    // Qwen0.26.1 defaults this to true; its PowerShell Add-Type inhibitor can
    // orphan the compiler when the CLI kills only the helper's parent process.
    settings={$version:4,general:{enableAutoUpdate:false,chatRecording:false,preventSystemSleep:false,gitCoAuthor:{commit:false,pr:false}},
      security:{auth:{selectedType:'openai',enforcedType:'openai'},folderTrust:{enabled:false}},
      disableAllHooks:true,hooks:{},mcpServers:{},mcp:{excluded:['*'],serverCommand:''},
      permissions:{allow:[],ask:[...QWEN_NATIVE_TOOLS],deny:QWEN_NATIVE_TOOLS.filter(name=>!QWEN_ALLOWED_TOOLS.has(name))},
      skills:{disabledLevels:['project','user','extension','bundled'],directories:[]},
      agents:{crossSessionMessaging:false,crossSessionInbound:'refuse'},
      tools:{discoveryCommand:'',callCommand:'',workflowsEnabled:false,sandbox:false},
      context:{fileName:[],loadFromIncludeDirectories:false},model:{name:model},telemetry:{enabled:false},privacy:{usageStatisticsEnabled:false}};
    Object.assign(environment,{QWEN_HOME:home,QWEN_CODE_SYSTEM_SETTINGS_PATH:systemFile,QWEN_CODE_SYSTEM_DEFAULTS_PATH:defaultsFile,
      OPENAI_BASE_URL:configuration.baseUrl,QWEN_CODE_DISABLE_WORKFLOWS:'1',NO_BROWSER:'1'});
    argv.push('--extensions','');
  }
  for(const file of [systemFile,settingsFile]){writeJsonAtomic(file,settings);ownedFiles.set(file,fs.readFileSync(file,'utf8'));}
  writeJsonAtomic(defaultsFile,id==='qwen'?{$version:4}:{});ownedFiles.set(defaultsFile,fs.readFileSync(defaultsFile,'utf8'));
  const identity=hash(JSON.stringify({policyVersion:GEMINI_QWEN_POLICY_VERSION,id,settings,argv}));
  const protectedDirectories=[path.join(home,'policies'),path.join(home,'extensions'),path.join(home,'hooks'),path.join(home,'skills'),path.join(home,'agents')];
  return {root,environment,identity,argv,validate(){
    try {
      for(const [file,source] of ownedFiles) if(fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file,'utf8')!==source) throw Error('Policy changed');
      for(const directory of protectedDirectories) if(fs.existsSync(directory)) {
        if(fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw Error('Unapproved customization');
        for(const entry of fs.readdirSync(directory)) {
          const enablement=path.join(home,'extensions','extension-enablement.json');
          if(id!=='qwen' || path.join(directory,entry)!==enablement || fs.lstatSync(enablement).isSymbolicLink()
            || JSON.stringify(JSON.parse(fs.readFileSync(enablement,'utf8')))!=='{}') throw Error('Unapproved customization');
        }
      }
      const policyDir=path.join(root,'system','policies');
      if(id==='gemini' && fs.readdirSync(policyDir).some(name=>name!=='cetamesh.toml')) throw Error('Additional admin policy');
    } catch {throw fault('AGENT_RUNTIME_CHANGED','Native runtime policy changed; close the session and check the connection again');}
  },async cleanup(){await fs.promises.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}};
}

/** Bind consent to bundled chunks and every resolvable declared native dependency. */
export function geminiQwenPackageIdentity(id,entry) {
  const layout=id==='gemini'?{name:'@google/gemini-cli',bin:'bundle/gemini.js'}:id==='qwen'?{name:'@qwen-code/qwen-code',bin:'cli-entry.js'}:null;
  if(!layout || typeof entry!=='string') return null;
  const normalized=path.resolve(entry),parts=layout.bin.split('/');
  let packageRoot=normalized;for(const ignored of parts)packageRoot=path.dirname(packageRoot);
  if(path.join(packageRoot,...parts)!==normalized) return null;
  const manifest=readJsonFile(path.join(packageRoot,'package.json'),{maxBytes:65536});
  if(manifest?.name!==layout.name || manifest.version!==GEMINI_QWEN_NATIVE_VERSIONS[id] || manifest.bin?.[id]!==layout.bin) return null;
  const nodeModulesRoot=fs.realpathSync(path.dirname(path.dirname(packageRoot)));
  const contentHash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),packages=[packageRoot],seen=new Set();let count=0,bytes=0;
  const contained=(root,file)=>{const relative=path.relative(root,file);return relative!=='' && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);};
  function walk(directory,label) {
    for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const file=path.join(directory,item.name),relative=label+'/'+item.name;
      if(item.isSymbolicLink()) throw fault('AGENT_RUNTIME_CHANGED','Runtime package links are not authorized');
      if(item.isDirectory()){walk(file,relative);continue;}
      if(!item.isFile() || ++count>16384) throw fault('ACP_RUNTIME_INVALID','Runtime package exceeds its bounded file contract');
      const fd=fs.openSync(file,'r');try{
        const before=fs.fstatSync(fd);bytes+=before.size;if(bytes>512*1024*1024)throw fault('ACP_RUNTIME_INVALID','Runtime package exceeds its bounded size contract');
        contentHash.update(relative+'\0'+before.size+'\0');let read;
        while((read=fs.readSync(fd,buffer,0,buffer.length,null))>0)contentHash.update(buffer.subarray(0,read));
        const after=fs.fstatSync(fd);if(before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs)throw fault('AGENT_RUNTIME_CHANGED','Runtime package changed while being checked');
      }finally{fs.closeSync(fd);}
    }
  }
  for(let index=0;index<packages.length;index++) {
    if(index>128)throw fault('ACP_RUNTIME_INVALID','Runtime package dependency limit exceeded');
    const candidate=packages[index],canonical=fs.realpathSync(candidate);
    if(!contained(nodeModulesRoot,canonical) || fs.lstatSync(candidate).isSymbolicLink())throw fault('AGENT_RUNTIME_CHANGED','Runtime dependency escaped its installed package tree');
    if(seen.has(canonical))continue;seen.add(canonical);
    const metadata=readJsonFile(path.join(canonical,'package.json'),{maxBytes:65536});
    walk(canonical,path.relative(nodeModulesRoot,canonical).replaceAll(path.sep,'/'));
    const resolver=createRequire(path.join(canonical,'package.json'));
    for(const name of Object.keys({...metadata.dependencies,...metadata.optionalDependencies}).sort()) {
      if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw fault('ACP_RUNTIME_INVALID','Invalid runtime dependency declaration');
      let resolved;try{resolved=fs.realpathSync(resolver.resolve(name));}catch{if(Object.hasOwn(metadata.optionalDependencies??{},name))continue;throw fault('ACP_RUNTIME_INVALID','A required runtime dependency is missing');}
      const dependency=(resolver.resolve.paths(name)??[]).map(base=>path.join(base,...name.split('/'))).find(root=>{
        try{return contained(fs.realpathSync(root),resolved);}catch{return false;}
      });
      if(!dependency || !contained(nodeModulesRoot,fs.realpathSync(dependency)))throw fault('AGENT_RUNTIME_CHANGED','Runtime dependency resolved outside its installed package tree');
      packages.push(dependency);
    }
  }
  return contentHash.digest('hex');
}
