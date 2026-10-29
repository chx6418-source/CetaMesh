import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {computeAgentExpansionFingerprint} from '../src/agent/expansion-provenance.js';
import {loadReleaseVersion,releaseArtifactDirectory} from '../src/release/version.js';
const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'release-input-'));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const version=loadReleaseVersion({rootDir:root});
const manifests=[...new Set([version.channel,'dev'])].map(channel=>path.join(releaseArtifactDirectory({rootDir:root,...version,channel}),'release-manifest.json'));
const releaseShell=path.join(root,'desktop-shell/target/release/whalebridge-desktop.exe');
const debugShell=path.join(root,'desktop-shell/target/debug/whalebridge-desktop.exe');
const preload=path.join(temp,'guard.mjs');
const syntheticShell=path.join(temp,'never-launch.exe');fs.writeFileSync(syntheticShell,Buffer.alloc(64));
fs.writeFileSync(preload,`
import fs from 'node:fs';import path from 'node:path';import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spec=JSON.parse(fs.readFileSync(process.env.RELEASE_INPUT_FIXTURE,'utf8'));
const originalExists=fs.existsSync,originalRead=fs.readFileSync,originalSpawn=child.spawnSync;
fs.readFileSync=(file,...args)=>{if(spec.versionOverride&&path.resolve(String(file))===spec.versionFile)return JSON.stringify(spec.versionOverride);return originalRead(file,...args);};
const mark=row=>fs.appendFileSync(spec.calls,JSON.stringify(row)+'\\n');
fs.existsSync=file=>{const target=path.resolve(String(file));if(spec.mode==='core-swap'&&(target===spec.uiIndex||target.startsWith(spec.manifestIndexRoot+path.sep)))return target===spec.uiIndex;if(spec.mode.startsWith('desktop')){if(target===spec.releaseShell)return false;if(target===spec.debugShell)return true;if(spec.manifests.includes(target))return spec.evidence;}return originalExists(file);};
child.spawnSync=(command,args,options)=>{if(command==='git')return originalSpawn(command,args,options);mark({command:path.basename(String(command)),args});if(spec.mode==='core-swap'&&args?.includes('build:ui')){fs.appendFileSync(path.join(spec.coreDir,'WhaleBridgeCore.exe'),'changed in synthetic UI phase');return {status:0,stdout:'',stderr:''};}if(command==='cargo')return {status:0,stdout:'',stderr:''};return {status:86,stdout:'',stderr:'SYNTHETIC_EXECUTION_BOUNDARY'};};
child.spawn=(command,args)=>{mark({forbiddenNativeDispatch:true,command:path.basename(String(command)),args});throw Error('PRIVATE_APPLICATION_EXECUTION_REACHED');};
syncBuiltinESMExports();
`);
const outcomes=[];
function check(name,body){try{body();outcomes.push({name,status:'PASS'});}catch(error){outcomes.push({name,status:'FAIL',message:error.message});}}
function run(file,{mode,evidence=true,extraEnv={},args=[],versionOverride=null}){const id=crypto.randomUUID(),calls=path.join(temp,id+'.calls'),config=path.join(temp,id+'.json');fs.writeFileSync(config,JSON.stringify({mode,evidence,calls,releaseShell,debugShell,manifests:versionOverride?[...new Set([versionOverride.channel,'dev'])].map(channel=>path.join(releaseArtifactDirectory({rootDir:root,...versionOverride,channel}),'release-manifest.json')):manifests,versionOverride,versionFile:path.join(root,'release/version.json'),coreDir:args[args.indexOf('--core-dir')+1],uiIndex:path.join(root,'desktop-ui/dist/index.html'),manifestIndexRoot:path.join(root,'artifacts/manifests')}));const result=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,file),...args],{cwd:root,encoding:'utf8',timeout:20000,windowsHide:true,env:{...process.env,RELEASE_INPUT_FIXTURE:config,WHALEBRIDGE_SKIP_RELEASE_SHELL_TEST:'0',npm_execpath:process.env.npm_execpath||'synthetic-npm-cli',...extraEnv}});assert.equal(result.error,undefined);return {...result,text:(result.stdout??'')+(result.stderr??''),calls:fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};}
function coreFixture(kind){const dir=path.join(temp,'core-'+kind);fs.mkdirSync(path.join(dir,'resources'),{recursive:true});const bytes=Buffer.from('MZ synthetic Core fixture; never executed');fs.writeFileSync(path.join(dir,'WhaleBridgeCore.exe'),bytes);const manifest={noWebUi:true,legacyHttp:false,uiDistribution:'native-no-web',executable:'WhaleBridgeCore.exe',executableSha256:kind==='corrupt'?sha(Buffer.from('different bytes')):sha(bytes),agentExpansion:{contractVersion:1,sourceFingerprint:kind==='stale'?'0'.repeat(64):computeAgentExpansionFingerprint(root)}};fs.writeFileSync(path.join(dir,'runtime-manifest.json'),JSON.stringify(manifest));return dir;}
try{
 for(const [kind,code]of [['corrupt','AGENT_EXPANSION_SHA_MISMATCH'],['stale','AGENT_EXPANSION_SOURCE_MISMATCH']])check(kind+' Core rejected before UI/packaging',()=>{const result=run('scripts/build-release.mjs',{mode:'core',args:['--dev','--use-current-build-number','--core-dir',coreFixture(kind),'--shell-exe',path.join(temp,'never-launch.exe')]});assert.notEqual(result.status,0);assert.match(result.text,new RegExp(code));assert.equal(result.calls.length,0,'invalid Core must not reach UI/compiler/installer dispatch');});
 check('valid Core reaches controlled UI boundary',()=>{const result=run('scripts/build-release.mjs',{mode:'core',args:['--dev','--use-current-build-number','--core-dir',coreFixture('valid'),'--shell-exe',path.join(temp,'never-launch.exe')]});assert.notEqual(result.status,0);assert.ok(result.calls.some(row=>row.args?.includes('build:ui')),'valid fixture reaches UI build; guard prevents real packaging');});
 check('Core changed during UI phase is blocked before packaging',()=>{const result=run('scripts/build-release.mjs',{mode:'core-swap',args:['--dev','--core-dir',coreFixture('swap'),'--shell-exe',syntheticShell]});assert.notEqual(result.status,0);assert.match(result.text,/AGENT_EXPANSION_SHA_MISMATCH/);assert.equal(result.calls.length,1,'only synthetic UI boundary reached; installer never dispatched');});
 check('Cargo build freezes reviewed lockfile',()=>{const result=run('scripts/build-desktop.mjs',{mode:'cargo',args:['--release']});assert.equal(result.status,0,result.text);const cargo=result.calls.find(row=>row.command==='cargo');assert.ok(cargo.args.includes('--locked'),'cargo build must receive --locked');assert.ok(cargo.args.includes('--release'));assert.ok(cargo.args.some(row=>row.includes('--remap-path-prefix')),'existing remap retained');if(process.platform==='win32')assert.ok(cargo.args.some(row=>row.includes('crt-static')),'existing CRT retained');});
 check('missing expected Release blocks before native launch',()=>{const result=run('scripts/test-desktop-shell.mjs',{mode:'desktop-missing'});assert.equal(result.status,1,result.text);assert.match(result.text,/RELEASE_SHELL_MISSING/);assert.equal(result.calls.length,0,'no private artifact may be launched before block');});
 check('explicit release exclusion is NOT_RUN, never PASS',()=>{const result=run('scripts/test-desktop-shell.mjs',{mode:'desktop-excluded',extraEnv:{WHALEBRIDGE_SKIP_RELEASE_SHELL_TEST:'1'}});assert.equal(result.status,77,result.text);assert.match(result.text,/NOT_RUN_ENVIRONMENT/);assert.equal(result.calls.length,0);});
 check('initial debug-only checkout is not called quarantine',()=>{const result=run('scripts/test-desktop-shell.mjs',{mode:'desktop-unbuilt',evidence:false});assert.notEqual(result.status,0);assert.doesNotMatch(result.text,/RELEASE_SHELL_MISSING/);assert.ok(result.calls.length>0,'guard confirms ordinary initial checkout reached its debug boundary');});
 for(const [channel,productVersion]of [['beta','1.0.0-beta.1'],['stable','1.0.0']]){
  const versionOverride={...JSON.parse(fs.readFileSync(path.join(root,'release/version.json'),'utf8')),channel,productVersion};
  check(channel+' initial checkout reaches its debug boundary',()=>{const result=run('scripts/test-desktop-shell.mjs',{mode:'desktop-channel',evidence:false,versionOverride});assert.doesNotMatch(result.text,/CHANNEL_VERSION_MISMATCH|RELEASE_SHELL_MISSING/);assert.ok(result.calls.length>0);});
  check(channel+' missing candidate shell blocks before dispatch',()=>{const result=run('scripts/test-desktop-shell.mjs',{mode:'desktop-channel',evidence:true,versionOverride});assert.match(result.text,/RELEASE_SHELL_MISSING/);assert.equal(result.calls.length,0);});
 }
 for(const row of outcomes)console.log(JSON.stringify(row));assert.equal(outcomes.filter(row=>row.status==='FAIL').length,0,'release input boundary regressions failed');console.log('PASS actual release/build/Desktop entry boundaries; synthetic bytes only, no private application executed');
}finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
