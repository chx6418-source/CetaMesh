import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {loadEngineAssets,reverseLabError,sha256} from './engine-assets.js';
import {createReaWorker} from './stdio-worker.js';

export function createReverseLabAnalyzer({engine,maxWorkers=2,timeoutMs=120000}={}){
  const active=new Set();let closed=false;
  let healthError=null,healthState={status:fs.existsSync(path.join(engine?.root??'','engine-manifest.json'))?'DEGRADED':'PROVIDER_MISSING',
    verification:'pending',checkedAt:null};
  const initialController=new AbortController();
  async function verify(signal){
    try{const assets=await loadEngineAssets(engine,{signal});healthError=null;healthState={status:'ENGINE_READY',version:assets.version,
      assetDigest:assets.assetDigest,verification:'last-complete-integrity-check',checkedAt:Date.now()};return assets;}
    catch(error){if(!signal?.aborted){healthError=error;healthState={status:error.code==='REVERSELAB_ENGINE_MISSING'?'PROVIDER_MISSING':'DEGRADED',
      code:error.code??'REVERSELAB_ENGINE_IDENTITY',verification:'failed',checkedAt:Date.now()};}throw error;}
  }
  const initialVerification=verify(initialController.signal).catch(()=>null);
  const analyzer={
    health(){return {...healthState,...(closed?{status:'STOPPING'}:{}),active:active.size};},
    async ready(){await initialVerification;if(healthError)throw healthError;return analyzer.health();},
    analyze({target,artifactRoot,taskId=null,workspaceId=null,signal,validateOutput=()=>{}}){
      if(closed)return Promise.reject(reverseLabError('REVERSELAB_STOPPING','ReverseLab is stopping.'));
      if(active.size>=maxWorkers)return Promise.reject(reverseLabError('REVERSELAB_CAPACITY','ReverseLab Worker capacity is full; retry after an active analysis settles.'));
      const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
      const run={controller,worker:null,done:null};active.add(run);
      run.done=(async()=>{
        let receipt;
        try{
          combined.throwIfAborted();const assets=await verify(combined);
          if(!fs.statSync(target).isDirectory())throw reverseLabError('REVERSELAB_TARGET_INVALID','P1 expects an extracted JavaScript application directory.');
          validateOutput();
          try{fs.mkdirSync(artifactRoot,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw reverseLabError('REVERSELAB_OUTPUT_EXISTS','Analysis output already exists; choose a fresh run path.');throw error;}
          const analysisRunId=crypto.randomUUID();
          writeJsonAtomic(path.join(artifactRoot,'run-start.json'),{schemaVersion:1,analysisRunId,taskId,workspaceId,
            engineVersion:assets.version,assetDigest:assets.assetDigest,status:'PREPARING'});
          run.worker=createReaWorker({assets,runRoot:artifactRoot,signal:combined,timeoutMs});
          await run.worker.initialize();
          const tools=await run.worker.listTools();
          if(!tools.tools.some(t=>t.name==='analyze_javascript_application'))throw reverseLabError('REVERSELAB_CAPABILITY_MISSING','Pinned REA tool is absent.');
          const analysis=await run.worker.callTool('analyze_javascript_application',{input_path:target,format:'directory',detail:'summary'});
          writeJsonAtomic(path.join(artifactRoot,'analysis-result.json'),analysis);
          // Always use the upstream file export: complete bundles may exceed MCP delivery budgets.
          const bundlePath=path.join(artifactRoot,'evidence-bundle.json');
          validateOutput();
          const exported=await run.worker.callTool('export_evidence_bundle',{path:bundlePath,overwrite:false});
          writeJsonAtomic(path.join(artifactRoot,'export-result.json'),exported);
          if(exported.isError||!fs.existsSync(bundlePath))throw reverseLabError('REVERSELAB_EVIDENCE_FAILED','REA did not export its original Evidence bundle.');
          const bundle=readJsonFile(bundlePath),records=bundle.records??[];
          const primary=records.find(r=>r.operation==='analyze_javascript_application');
          if(!primary||!records.every(r=>typeof r.evidence_id==='string'))throw reverseLabError('REVERSELAB_ANALYSIS_FAILED','No completed REA analysis Evidence exists; raw diagnostic artifacts were retained.');
          if(analysis.isError){const text=JSON.stringify(analysis);if(!/response.{0,20}(?:large|budget)|(?:large|budget).{0,20}response|overflow/i.test(text))
            throw reverseLabError('REVERSELAB_ANALYSIS_FAILED','REA returned a non-delivery error; raw result and bundle retained.');}
          combined.throwIfAborted();validateOutput();
          receipt={schemaVersion:1,analysisRunId,taskId,workspaceId,engineVersion:assets.version,assetDigest:assets.assetDigest,
            workerPid:run.worker.pid,targetSha256:primary.subject?.digest?.sha256??null,evidenceIds:records.map(r=>r.evidence_id),
            bundlePath,rawProtocolPath:run.worker.rawProtocolPath,indexPath:path.join(artifactRoot,'index.json'),
            bundleSha256:sha256(fs.readFileSync(bundlePath)),status:analysis.isError?'COMPLETED_DELIVERY_LIMIT':'COMPLETED'};
          // Worker exit is part of successful completion. Commit marker is written only afterwards.
          await run.worker.close();combined.throwIfAborted();validateOutput();
          writeJsonAtomic(receipt.indexPath,receipt);return receipt;
        }finally{
          if(run.worker)await run.worker.close();
          active.delete(run);
        }
      })();
      return run.done;
    },
    async stop(){
      for(const run of active)run.controller.abort(reverseLabError('REVERSELAB_CANCELLED','Plugin stop requested; analysis artifacts are retained.'));
      await Promise.allSettled([...active].map(run=>run.done));
      for(const run of [...active]){await run.worker?.close();active.delete(run);}
    },
    async close(){closed=true;initialController.abort();await analyzer.stop();await initialVerification;}
  };
  return analyzer;
}
