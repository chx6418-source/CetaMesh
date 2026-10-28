import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {terminateSuiteProcessTree} from '../src/testing/suite-process.js';
import * as store from '../src/testing/suite-sandbox.js';
// A persisted registration left by a killed child; all bytes below are synthetic.
const outer=store.createSuiteSandbox({suiteId:'secret-parent'});
const child=store.createSuiteSandbox({suiteId:'secret-child',tempRoot:outer.root});
const secret=path.join(child.root,'data','state','provider-keys.json');
const retainedEvidence=path.join(child.root,'safe-evidence.json');
fs.mkdirSync(path.dirname(secret),{recursive:true});
fs.writeFileSync(secret,'NOT_A_REAL_API_KEY');fs.writeFileSync(retainedEvidence,'{"synthetic":true}');
const relative=path.relative(outer.root,secret);
let killedChild;
let marker=JSON.parse(fs.readFileSync(outer.markerPath,'utf8'));
marker.secretFiles=[relative];fs.writeFileSync(outer.markerPath,JSON.stringify(marker));
try {
 const result=store.finalizeSuiteSandbox({sandbox:outer,failed:true,keepFailed:true});
 assert.equal(result.retained,true);
 assert.equal(fs.existsSync(secret),false,'failure artifact retention must scrub a killed child credential');
 assert.equal(fs.existsSync(retainedEvidence),true,'nonsecret failure evidence remains reviewable');
 const atom=secret+'.12345.0123456789ab.tmp',neighbor=secret+'.diagnostic.tmp';
 fs.writeFileSync(atom,'SYNTHETIC_INTERRUPTED_ATOMIC_WRITE');fs.writeFileSync(neighbor,'nonsensitive evidence');
 store.scrubSuiteSecrets({sandbox:outer});
 assert.equal(fs.existsSync(atom),false,'interrupted atomic credential writes must also be scrubbed');
 assert.equal(fs.existsSync(neighbor),true,'unrelated diagnostic filenames remain');
 const ready=path.join(outer.root,'killed-child-ready.json');
 const moduleUrl=new URL('../src/testing/suite-sandbox.js',import.meta.url).href;
 const program='import fs from "node:fs";import path from "node:path";import {createSuiteSandbox,registerSuiteSecret} from '+JSON.stringify(moduleUrl)+';const box=createSuiteSandbox({suiteId:"killed-credential-writer",tempRoot:'+JSON.stringify(outer.root)+'});const key=path.join(box.root,"credential.json");registerSuiteSecret({sandbox:box,file:key});fs.writeFileSync(key,"SYNTHETIC_ONLY");fs.writeFileSync('+JSON.stringify(ready)+',JSON.stringify({key}));setInterval(()=>{},1000);';
 killedChild=spawn(process.execPath,['--input-type=module','-e',program],{windowsHide:true,detached:process.platform!=='win32',stdio:'ignore'});
 const closed=new Promise((resolve,reject)=>{killedChild.once('close',resolve);killedChild.once('error',reject);});
 const deadline=Date.now()+5000;while(!fs.existsSync(ready)&&Date.now()<deadline)await delay(20);
 assert.ok(fs.existsSync(ready),'actual child registered and wrote a synthetic credential');
 const written=JSON.parse(fs.readFileSync(ready,'utf8')).key;
 await terminateSuiteProcessTree(killedChild);await closed;
 assert.equal(fs.existsSync(written),true,'forced child termination bypassed its cleanup');
 store.finalizeSuiteSandbox({sandbox:outer,failed:true,keepFailed:true});
 assert.equal(fs.existsSync(written),false,'parent retention scrubs after real process termination');
 const newSecret=path.join(child.root,'data','state','another-secret.json');
 store.registerSuiteSecret({sandbox:child,file:newSecret});
 fs.writeFileSync(newSecret,'ALSO_SYNTHETIC');
 const parent=JSON.parse(fs.readFileSync(outer.markerPath,'utf8'));
 assert.ok(parent.secretFiles.includes(path.relative(outer.root,newSecret)),'nested registration reaches owning runner before secret creation');
 store.scrubSuiteSecrets({sandbox:outer});
 assert.equal(fs.existsSync(newSecret),false,'runner can scrub even when process-tree exit is unconfirmed');
 assert.throws(()=>store.registerSuiteSecret({sandbox:child,file:path.join(outer.tempRoot,'outside-secret.json')}),/outside/);
 // Tampered paths cannot delete outside the marked sandbox.
 marker=JSON.parse(fs.readFileSync(outer.markerPath,'utf8'));marker.secretFiles=['../outside-secret.json'];fs.writeFileSync(outer.markerPath,JSON.stringify(marker));
 assert.throws(()=>store.scrubSuiteSecrets({sandbox:outer}),/outside/);
 marker.secretFiles=[];fs.writeFileSync(outer.markerPath,JSON.stringify(marker));
 console.log('PASS retained failure and unconfirmed-exit secret scrubbing, nested registration and traversal rejection');
} finally {
 if(killedChild?.pid&&killedChild.exitCode===null&&killedChild.signalCode===null)await terminateSuiteProcessTree(killedChild);
 const m=JSON.parse(fs.readFileSync(outer.markerPath,'utf8'));m.secretFiles=[];fs.writeFileSync(outer.markerPath,JSON.stringify(m));
 store.finalizeSuiteSandbox({sandbox:outer,failed:false});
}
