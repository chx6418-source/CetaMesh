import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../src/storage/json-file.js';
import {createReverseLabAnalyzer} from '../src/reverselab/static-analysis.js';
import {loadEngineAssets} from '../src/reverselab/engine-assets.js';
import {createReaWorker} from '../src/reverselab/stdio-worker.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const resources=process.env.CETAMESH_TEST_REVERSELAB_RESOURCES;
assert.ok(resources,'Real packaged REA resources required');
const engineRoot=path.join(resources,'plugins','reverselab','engine');
const lock=readJsonFile(path.join(resources,'plugins','reverselab','engine.lock.json'));
const base=fs.mkdtempSync(path.join(process.env.CETAMESH_REVERSELAB_EVIDENCE_DIR??os.tmpdir(),'reverselab-engine-'));
const analyzer=createReverseLabAnalyzer({engine:{root:engineRoot,manifestSha256:lock.manifestSha256},maxWorkers:2});
function sample(name){const dir=path.join(base,name);fs.mkdirSync(dir);writeJsonAtomic(path.join(dir,'package.json'),{name,version:'1.0.0',type:'module',main:'main.js'});
  fs.writeFileSync(path.join(dir,'main.js'),`export function ${name}(value) { return value.trim().toUpperCase(); }\n`);return dir;}
try{
  const healthStarted=performance.now();analyzer.health();analyzer.health();
  assert.ok(performance.now()-healthStarted<100,'Plugin health must not synchronously hash the 389 MB engine on the Core event loop');
  await analyzer.ready();
  assert.equal(analyzer.health().status,'ENGINE_READY');
  const discoveryRoot=path.join(base,'relocated-discovery');fs.mkdirSync(discoveryRoot);
  const assets=await loadEngineAssets({root:engineRoot,manifestSha256:lock.manifestSha256});
  const discovery=createReaWorker({assets,runRoot:discoveryRoot});
  try{
    await discovery.initialize();
    const catalog=readJsonFile(path.join(engineRoot,'rea','dist','mcp-catalog-full.json'));
    assert.equal(catalog.tools.length,229);assert.equal(catalog.prompts.length,6);
    const actual=await discovery.listTools(),prompts=await discovery.listPrompts();
    assert.deepEqual(actual.tools.map(t=>t.name),catalog.tools.map(t=>t.name));assert.equal(prompts.prompts.length,6);
  }finally{await discovery.close();}
  // Controlled disk-write and unconfirmed-cleanup faults, with a real REA child.
  const faultRoot=path.join(base,'transcript-io-fault');fs.mkdirSync(faultRoot);
  const owned=createReaWorker({assets,runRoot:faultRoot}),closeOwned=owned.close;
  const writeWire=fs.writeSync;
  fs.writeSync=(fd,data,...args)=>{if(Buffer.isBuffer(data))throw Object.assign(new Error('Controlled transcript disk failure'),{code:'ENOSPC'});return writeWire(fd,data,...args);};
  owned.close=async()=>{throw Object.assign(new Error('Controlled cleanup failure'),{code:'REVERSELAB_STOP_UNCONFIRMED'});};
  try{await assert.rejects(owned.initialize(),{code:'REVERSELAB_STOP_UNCONFIRMED'});
    assert.ok(owned.pid,'Failed initialization still returns an owned process handle for cleanup retry');
  }finally{fs.writeSync=writeWire;owned.close=closeOwned;
    await assert.rejects(owned.close(),{code:'REVERSELAB_TRANSCRIPT_IO'});await owned.close();}
  assert.throws(()=>process.kill(owned.pid,0),e=>e.code==='ESRCH','Cleanup retry must confirm actual child exit');
  const drainRoot=path.join(base,'transcript-drain-fault');fs.mkdirSync(drainRoot);
  const draining=createReaWorker({assets,runRoot:drainRoot});await draining.initialize();await draining.callTool('binary_session',{});
  const closeTransport=StdioClientTransport.prototype.close;
  // Inject a late diagnostic frame at the transport leaf; the child and its final shutdown remain real.
  StdioClientTransport.prototype.close=async function(...args){
    this._process?.stdout.emit('data',Buffer.from('{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"controlled final drain"}}\n'));
    return closeTransport.apply(this,args);
  };
  fs.writeSync=(fd,data,...args)=>{if(Buffer.isBuffer(data))throw Object.assign(new Error('Controlled final-drain failure'),{code:'ENOSPC'});return writeWire(fd,data,...args);};
  try{await assert.rejects(draining.close(),{code:'REVERSELAB_TRANSCRIPT_IO'},'Transcript failure during final output drain cannot certify successful completion');}
  finally{fs.writeSync=writeWire;StdioClientTransport.prototype.close=closeTransport;await draining.close();}
  assert.throws(()=>process.kill(draining.pid,0),e=>e.code==='ESRCH');
  const alpha=sample('reverseLabAlpha'),beta=sample('reverseLabBeta');
  const [a,b]=await Promise.all([analyzer.analyze({target:alpha,artifactRoot:path.join(base,'alpha-result'),taskId:'task-a',workspaceId:'workspace-a'}),
    analyzer.analyze({target:beta,artifactRoot:path.join(base,'beta-result'),taskId:'task-b',workspaceId:'workspace-b'})]);
  assert.notEqual(a.workerPid,b.workerPid,'Independent analyses must use distinct REA processes');
  assert.notEqual(a.analysisRunId,b.analysisRunId);
  for(const [receipt,own,other] of [[a,'reverseLabAlpha','reverseLabBeta'],[b,'reverseLabBeta','reverseLabAlpha']]){
    const bundle=readJsonFile(receipt.bundlePath);
    assert.ok(bundle.records.length>0,'Actual REA Evidence required');
    assert.ok(JSON.stringify(bundle).includes(own),'Named source fact must occur in original analysis');
    assert.ok(!JSON.stringify(bundle).includes(other),'Concurrent session evidence must not mix');
    assert.ok(bundle.records.every(r=>typeof r.evidence_id==='string'));
    assert.ok(fs.statSync(receipt.rawProtocolPath).size>0,'Raw received MCP frames retained');
    assert.ok(fs.existsSync(receipt.indexPath),'Commit index appears only with durable artifacts');
    assert.throws(()=>process.kill(receipt.workerPid,0),error=>error.code==='ESRCH','Worker must actually exit before successful receipt');
  }
  await assert.rejects(analyzer.analyze({target:alpha,artifactRoot:path.join(base,'alpha-result')}),{code:'REVERSELAB_OUTPUT_EXISTS'});
  const missing=createReverseLabAnalyzer({engine:{root:path.join(base,'missing'),manifestSha256:lock.manifestSha256}});
  assert.equal(missing.health().status,'PROVIDER_MISSING');
  await assert.rejects(missing.analyze({target:alpha,artifactRoot:path.join(base,'missing-result')}),{code:'REVERSELAB_ENGINE_MISSING'});
  await missing.close();
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(analyzer.analyze({target:alpha,artifactRoot:path.join(base,'cancelled-result'),signal:cancelled.signal}));
  writeJsonAtomic(path.join(base,'test-receipts.json'),{evidence:'real-pinned-REA-6.8.0-Windows-stdio-static-analysis',a,b});
  console.log('PASS actual REA graph/Evidence, two concurrent independent Workers, process cleanup, missing assets and no overwrite; evidence '+base);
}finally{await analyzer.close();}
