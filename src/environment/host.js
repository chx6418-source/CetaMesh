import fs from 'node:fs';
import path from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {validateBinding,validateProfile,profileDigest,sha256,environmentError,summarizeResults} from './contracts.js';
import {assertOwnedPath,verifyFile,hashFile} from './paths.js';
import {createEvidenceStore} from './evidence.js';
import {evaluateGuestReport} from './test-packs.js';

// Resource ownership only. Core remains the Task/Attempt and authorization authority.
export function createEnvironmentHost({root,profiles,backend,now=Date.now,layer='Windows VM E2E'}) {
 const catalog=new Map(profiles.map(p=>{const v=validateProfile(p);return [v.id,v];}));
 if(catalog.size!==profiles.length) throw environmentError('ENV_SCHEMA_INVALID','Duplicate profile');
 const evidence=createEvidenceStore({root:path.join(root,'evidence')});
 const stateRoot=path.join(root,'service-runs');fs.mkdirSync(stateRoot,{recursive:true});
 const active=new Map();
 const stateFile=b=>assertOwnedPath(stateRoot,`${b.runId}.json`);
 for(const name of fs.readdirSync(stateRoot)) {
  if(!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
  const file=assertOwnedPath(stateRoot,name,{mustExist:true});const row=readJsonFile(file,{maxBytes:1048576});
  if(row.state==='running') {row.state='quarantined';row.status='INCONCLUSIVE';row.code='HOST_RESTART_EFFECTS_UNKNOWN';writeJsonAtomic(file,row);}
 }
 const check=b=>{validateBinding(b,{now:now()});const p=catalog.get(b.profileId);if(!p || profileDigest(p)!==b.profileDigest || sha256(p.limits)!==sha256(b.limits))throw environmentError('ENV_PROFILE_MISMATCH','Approved profile changed');return p;};
 const read=b=>{validateBinding(b,{allowExpired:true});const row=readJsonFile(stateFile(b),{maxBytes:1048576});if(sha256(row.binding)!==sha256(b))throw environmentError('ENV_EVIDENCE_BINDING','Run does not belong to this binding');return row;};
 const summary=row=>({binding:row.binding,status:row.status,layer:row.layer,mode:row.mode,cleanup:row.cleanup || {state:row.state},code:row.code || null,evidence:row.evidence || null,checks:row.checks || [],finalReport:row.finalReport || null});
 async function run(binding,{signal}={}) {
  const profile=check(binding);
  if(fs.existsSync(stateFile(binding)))throw environmentError('ENV_REPLAY','Run identity already consumed');
  if(active.size)throw environmentError('ENV_BUSY','One environment run at a time');
  const retained=fs.readdirSync(stateRoot).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n)).map(n=>readJsonFile(assertOwnedPath(stateRoot,n),{maxBytes:1048576})).filter(r=>r.state==='quarantined');
  if(retained.length>=profile.retainedLimit)throw environmentError('ENV_QUARANTINE_LIMIT','Retained environment requires Owner reconciliation');
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadline=setTimeout(abort,Math.min(profile.limits.timeoutMs,binding.expiresAt-now()));
  const row={binding,state:'running',status:'NOT_RUN',layer,mode:profile.mode,checks:[],startedAt:now()};
  writeJsonAtomic(stateFile(binding),row);active.set(binding.runId,controller);
  let resources=null,ctx={binding,profile},unknown=false,response,createAttempted=false;
  const options={signal:controller.signal};
  const gate=()=>{check(binding);if(controller.signal.aborted)throw environmentError('ENV_CANCELLED','Environment run cancelled');};
  try {
   gate();const preflight=await backend.preflight(ctx,options);
   if(preflight.status!=='PASS'){row.status='BLOCKED_ENV';row.code='ENV_PREFLIGHT';row.checks=[{id:'preflight',status:'BLOCKED_ENV',reasons:preflight.reasons || []}];row.state='completed';row.cleanup={state:'not-created'};return (response=summary(row));}
   gate();createAttempted=true;resources=await backend.prepare(ctx,options);ctx={...ctx,resources};row.resources=resources;writeJsonAtomic(stateFile(binding),row);
   gate();await backend.start(ctx,options);
   if(profile.mode==='cetamesh') {
    const manifestPath=assertOwnedPath(profile.candidate.root,'environment-inputs.json',{mustExist:true});
    await verifyFile(manifestPath,{sha256:profile.candidate.manifestSha256,maxBytes:1048576});
    const manifest=readJsonFile(manifestPath,{maxBytes:1048576});
    if(!Array.isArray(manifest.files)||manifest.files.length>profile.limits.maxEvidenceFiles)throw environmentError('ENV_SCHEMA_INVALID','Candidate manifest file quota');
    const files=manifest.files.map(f=>({source:assertOwnedPath(profile.candidate.root,f.path,{mustExist:true}),relativePath:`input/${f.path}`,sha256:f.sha256,bytes:f.bytes}));
    if(!files.some(f=>f.relativePath==='input/WhaleBridge.exe' && f.sha256===profile.candidate.installerSha256))throw environmentError('ENV_HASH_MISMATCH','Installer absent from candidate manifest');
    gate();await backend.copyIn({...ctx,files},options);
    const guestRequest={version:1,binding,mode:profile.mode,packIds:profile.packIds,guestRoot:`C:\\CetaMeshEnv\\${binding.runId}`,artifact:{installer:'input/WhaleBridge.exe',installerSha256:profile.candidate.installerSha256,payloadDir:'input/payload',buildCommit:profile.candidate.buildCommit,buildHash:profile.candidate.buildHash,files:manifest.files.map(f=>({...f,path:`input/${f.path}`}))}};
    gate();await backend.exec({...ctx,guestRequest},options);
   } else {gate();await backend.copyIn({...ctx,files:[]},options);gate();await backend.exec({...ctx,guestRequest:{version:1,binding,mode:profile.mode,packIds:profile.packIds,guestRoot:`C:\\CetaMeshEnv\\${binding.runId}`}},options);}
   gate();await backend.capture(ctx,options);
   gate();const exported=await backend.copyOut(ctx,options);
   const files=(exported.files || []).map(f=>({source:f.source,path:f.path || f.relativePath,sha256:f.sha256,bytes:f.bytes}));
   if(profile.mode==='cetamesh') {
    const guestFile=files.find(f=>f.path==='report.json');if(!guestFile)throw environmentError('ENV_EVIDENCE_MISSING','Guest report missing');
    await verifyFile(guestFile.source,{...guestFile,maxBytes:profile.limits.maxEvidenceBytes});
    const guestReport=readJsonFile(guestFile.source,{maxBytes:profile.limits.maxEvidenceBytes});
    const evaluated=evaluateGuestReport(guestReport,{binding,packIds:profile.packIds,layer});
    row.checks=evaluated.packs.flatMap(p=>p.checks);row.status=evaluated.status;
    const identityOk=String(guestReport.guest?.windowsBuild)===profile.image.windowsBuild && ['x64','amd64'].includes(String(guestReport.guest?.architecture).toLowerCase());
    const artifactHash=row.checks.find(c=>c.packId==='W01' && c.id==='artifact-hashes')?.observations?.installerSha256;
    const commit=row.checks.find(c=>c.packId==='W01' && c.id==='build-info')?.observations?.commit;
    if(!identityOk || (profile.packIds.includes('W01') && (artifactHash!==profile.candidate.installerSha256 || commit!==profile.candidate.buildCommit))) {row.checks.push({id:'approved-baseline-identity',status:'FAIL'});row.status='FAIL';}
   }else {
    const probe=files.find(f=>f.path==='lifecycle.txt');
    if(!probe)throw environmentError('ENV_EVIDENCE_MISSING','Guest lifecycle proof missing');
    await verifyFile(probe.source,{...probe,maxBytes:128});
    if(fs.readFileSync(probe.source,'utf8')!==binding.runId)throw environmentError('ENV_EVIDENCE_BINDING','Guest lifecycle proof belongs to a different run');
    row.checks=[{id:'owned-lifecycle-fixture',status:'PASS'}];row.status='PASS';
   }
   const report={schemaVersion:1,binding,layer,status:row.status,checks:row.checks,cleanup:{state:'pending'}};
   const receipt=await evidence.save({binding,report,files:files.map(f=>({...f,path:`guest/${f.path}`}))});
   const verified=await evidence.verify(receipt,binding);row.evidence=receipt;gate();
   await backend.stop(ctx); // Stop is permitted after expiry, but deletion still needs verified evidence.
   const manifest=path.join(evidence.directory(binding),'manifest.json');
   gate();await backend.destroyOwned({...ctx,evidenceReceipt:{...verified,environmentId:binding.environmentId,files:[{relativePath:path.relative(root,manifest),sha256:receipt.manifestHash,bytes:fs.statSync(manifest).size}]}});
   row.cleanup={state:'destroyed'};row.state='completed';
   gate();
   row.cleanup={state:'destroyed'};row.state='completed';return (response=summary(row));
  } catch(error) {
   unknown=!!resources || error.code==='EFFECTS_UNKNOWN';
   if(resources && row.cleanup?.state!=='destroyed'){try{await backend.stop(ctx);}catch{unknown=true;}}
   row.status=error.code==='BLOCKED_ENV'?'BLOCKED_ENV':'INCONCLUSIVE';row.code=error.code || 'ENV_EXECUTION_FAILED';
   // A create attempt can leave resources without a returned receipt: retain conservatively.
   if(!createAttempted){row.state='completed';row.cleanup={state:'not-created'};}
   else if(row.cleanup?.state!=='destroyed'){row.state='quarantined';row.cleanup={state:'quarantined',effectsUnknown:unknown};}
   return (response=summary(row));
  } finally {
   clearTimeout(deadline);signal?.removeEventListener('abort',abort);active.delete(binding.runId);row.endedAt=now();
   // The final lifecycle report is separate from immutable pre-destruction evidence.
   const finalFile=assertOwnedPath(root,`final-reports/${binding.runId}.json`);
   writeJsonAtomic(finalFile,{schemaVersion:1,...summary(row),startedAt:row.startedAt,endedAt:row.endedAt});
   row.finalReport={sha256:await hashFile(finalFile),relativePath:`final-reports/${binding.runId}.json`};
   writeJsonAtomic(stateFile(binding),row);if(response)Object.assign(response,summary(row),{finalReport:row.finalReport});
  }
 }
 return {run,profiles:()=>[...catalog.values()].map(p=>({id:p.id,digest:profileDigest(p),backend:p.backend,mode:p.mode,limits:p.limits,packIds:p.packIds})),
  preflight:profileId=>backend.preflight({profile:catalog.get(profileId)}),
  status:async binding=>{const row=read(binding);if(row.finalReport){const file=assertOwnedPath(root,row.finalReport.relativePath,{mustExist:true});await verifyFile(file,{sha256:row.finalReport.sha256});if(sha256(readJsonFile(file).binding)!==sha256(binding))throw environmentError('ENV_EVIDENCE_BINDING','Final report binding differs');}return summary(row);},cancel:async binding=>{read(binding);active.get(binding.runId)?.abort();return {requested:true};}};
}
