import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createChannelService} from '../src/channel/service.js';
import {enableOneBotFixture} from './fixtures/onebot-activation.mjs';
import {createOneBotConfiguration} from '../src/config/onebot-configuration.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-onebot-config-'));
try {
  const file=path.join(root,'config.json'),state=path.join(root,'state');fs.mkdirSync(state);
  const original=Buffer.from('\uFEFF'+JSON.stringify({snowluma:{wsUrl:'ws://127.0.0.1:19001',httpUrl:'http://127.0.0.1:19000',accessToken:'legacy-secret-must-stay-private'},ownerQQ:42,custom:{preserve:'yes'}},null,2)+'\r\n');
  fs.writeFileSync(file,original);
  const config={};let refreshes=0;
  const api=createOneBotConfiguration({configFile:file,stateDir:state,config,health:async()=>({installed:true,configured:!!config.onebot?.wsUrl,connected:false,authenticated:false,ready:false}),beforeChange:async()=>{refreshes++;}});
  const preview=await api.preview();assert.equal(preview.legacyPresent,true);assert.equal(preview.requiresTokenEntry,true);
  assert.equal(preview.sourceHash,crypto.createHash('sha256').update(original).digest('hex'));
  assert.ok(!JSON.stringify(preview).includes('legacy-secret'));assert.equal(fs.readFileSync(file).equals(original),true);
  await assert.rejects(api.migrate({confirm:false,expectedSourceHash:preview.sourceHash}),{code:'ONEBOT_MIGRATION_CONFIRM_REQUIRED'});
  assert.equal(refreshes,0);
  const migrated=await api.migrate({confirm:true,expectedSourceHash:preview.sourceHash});
  assert.equal(migrated.configuration.enabled,false);assert.equal(migrated.configuration.accessTokenConfigured,false);
  assert.equal(config.onebot.wsUrl,preview.candidate.wsUrl);assert.equal(config.onebot.accessToken,'');
  assert.equal(fs.readFileSync(path.join(state,'config-backups',migrated.backup.id)).equals(original),true,'original bytes including BOM/CRLF retained');
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(raw.snowluma.accessToken,'legacy-secret-must-stay-private');assert.deepEqual(raw.custom,{preserve:'yes'});
  await assert.rejects(api.migrate({confirm:true,expectedSourceHash:migrated.configuration.sourceHash}),{code:'ONEBOT_ALREADY_CONFIGURED'});
  await assert.rejects(api.configure({expectedSourceHash:preview.sourceHash,enabled:true,wsUrl:preview.candidate.wsUrl,httpUrl:preview.candidate.httpUrl}),{code:'ONEBOT_CONFIG_CONFLICT'});
  const configured=await api.configure({expectedSourceHash:migrated.configuration.sourceHash,enabled:true,wsUrl:preview.candidate.wsUrl,httpUrl:preview.candidate.httpUrl,accessToken:'new-owner-entered-token'});
  assert.equal(configured.configuration.accessTokenConfigured,true);assert.equal(configured.health.connected,false,'saving never connects');
  assert.ok(!JSON.stringify(configured).includes('new-owner-entered-token'));
  const untrustedHealth=createOneBotConfiguration({configFile:file,stateDir:state,config,
    health:async()=>({ready:false,connected:false,authenticated:false,details:{accessToken:'untrusted-extra-secret'},error:{code:'ONEBOT_AUTH_FAILED',message:'Failed with new-owner-entered-token'}})});
  const publicHealth=await untrustedHealth.get();
  assert.ok(!JSON.stringify(publicHealth).includes('new-owner-entered-token'),'known credentials must be removed even from unlabelled transport errors');
  assert.equal(Object.hasOwn(publicHealth.health,'details'),false,'only bounded health fields cross the Owner UI boundary');
  await assert.rejects(api.configure({expectedSourceHash:configured.configuration.sourceHash,enabled:true,wsUrl:'ws://user:secret@host/',httpUrl:''}),{code:'ONEBOT_CONFIG_INVALID'});
  await assert.rejects(api.configure({expectedSourceHash:configured.configuration.sourceHash,enabled:'true',wsUrl:'ws://localhost:19001',httpUrl:''}),{code:'ONEBOT_CONFIG_INVALID'});
  assert.equal(refreshes,2,'invalid, stale and rejected migration requests never stop the active connector');
  const cleared=await api.configure({expectedSourceHash:configured.configuration.sourceHash,enabled:false,wsUrl:'',httpUrl:'',clearAccessToken:true});
  assert.equal(cleared.configuration.accessTokenConfigured,false);
  const blockedBytes=fs.readFileSync(file);
  const busy=createOneBotConfiguration({configFile:file,stateDir:state,beforeChange:async()=>({ok:false,code:'QQ_SEND_DRAIN_TIMEOUT'})});
  await assert.rejects(busy.configure({expectedSourceHash:cleared.configuration.sourceHash,enabled:false,httpUrl:'',wsUrl:''}),{code:'ONEBOT_CONNECTOR_BUSY'});
  assert.deepEqual(fs.readFileSync(file),blockedBytes,'unconfirmed send drain preserves configuration');
  const drainState=path.join(root,'drain-state');enableOneBotFixture(drainState);
  const channel=createChannelService({stateDir:drainState,config:{onebot:{enabled:true,httpUrl:'http://127.0.0.1:19000',wsUrl:'ws://127.0.0.1:19001'}}});
  let stopCalls=0,confirmed=false;
  channel.adoptLegacy({connect:async()=>{},health:()=>({ready:true,accountId:'10001'}),stop:async()=>{stopCalls++;return confirmed?{ok:true,stopped:true}:{ok:false,code:'QQ_SEND_DRAIN_TIMEOUT'};}});
  const guarded=createOneBotConfiguration({configFile:file,stateDir:drainState,beforeChange:()=>channel.stop()});
  for(let attempt=0;attempt<2;attempt++){
    await assert.rejects(guarded.configure({expectedSourceHash:cleared.configuration.sourceHash,enabled:false,httpUrl:'',wsUrl:''}),{code:'ONEBOT_CONNECTOR_BUSY'});
    assert.deepEqual(fs.readFileSync(file),blockedBytes,'repeated save cannot forget an unconfirmed send drain');
  }
  assert.equal(stopCalls,2,'uncertain connector remains owned and is rechecked');
  await assert.rejects(channel.start(),{code:'CHANNEL_STOP_UNCONFIRMED'});
  assert.equal((await channel.execute({method:'channel.qq.health'})).canSend,false);
  confirmed=true;await guarded.configure({expectedSourceHash:cleared.configuration.sourceHash,enabled:false,httpUrl:'',wsUrl:''});await channel.close();
  // A real process crash after taking the lock must not permanently brick Owner settings.
  const crashState=path.join(root,'crash-state');fs.mkdirSync(crashState);
  const child=spawnSync(process.execPath,['--input-type=module','--eval',
    'import {createOneBotConfiguration} from '+JSON.stringify(new URL('../src/config/onebot-configuration.js',import.meta.url).href)+';'+
    'const api=createOneBotConfiguration({configFile:'+JSON.stringify(file)+',stateDir:'+JSON.stringify(crashState)+',beforeChange:async()=>process.exit(77)});'+
    'const {configuration}=await api.get();await api.configure({expectedSourceHash:configuration.sourceHash,enabled:false,httpUrl:"",wsUrl:""});'],{timeout:5000,windowsHide:true,encoding:'utf8'});
  assert.ifError(child.error);assert.equal(child.status,77);
  const orphan=fs.readFileSync(path.join(crashState,'onebot-config.lock'));
  const recovered=createOneBotConfiguration({configFile:file,stateDir:crashState});
  const revision=(await recovered.get()).configuration.sourceHash;
  await recovered.configure({expectedSourceHash:revision,enabled:false,httpUrl:'',wsUrl:''});
  assert.equal(fs.existsSync(path.join(crashState,'onebot-config.lock')),false);
  const evidence=fs.readdirSync(path.join(crashState,'config-backups')).filter(n=>n.startsWith('onebot-orphan-lock-'));
  assert.equal(evidence.length,1);assert.deepEqual(fs.readFileSync(path.join(crashState,'config-backups',evidence[0])),orphan);
  for(const contents of [JSON.stringify({version:1,pid:process.pid,nonce:crypto.randomUUID()}),'']){
    fs.writeFileSync(path.join(crashState,'onebot-config.lock'),contents);
    await assert.rejects(recovered.configure({expectedSourceHash:(await recovered.get()).configuration.sourceHash,enabled:false,httpUrl:'',wsUrl:''}),{code:'ONEBOT_CONFIG_BUSY'});
    assert.equal(fs.readFileSync(path.join(crashState,'onebot-config.lock'),'utf8'),contents,'never reclaim a live or unverifiable lock');
    fs.unlinkSync(path.join(crashState,'onebot-config.lock'));
  }
  fs.writeFileSync(file,'{corrupt');
  await assert.rejects(api.get(),{code:'ONEBOT_CONFIG_UNAVAILABLE'});assert.equal(fs.readFileSync(file,'utf8'),'{corrupt');
  const outside=path.join(root,'outside.json');fs.writeFileSync(outside,'{}');fs.unlinkSync(file);fs.linkSync(outside,file);
  await assert.rejects(api.get(),{code:'ONEBOT_CONFIG_UNSAFE'});assert.equal(fs.readFileSync(outside,'utf8'),'{}');
  console.log('PASS neutral OneBot config: no automatic legacy/token import, exact backup, CAS, bounded endpoints and secrets, disabled migration, corruption/link preservation.');
}finally{fs.rmSync(root,{recursive:true,force:true});}
