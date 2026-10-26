import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const modulePath = new URL('../src/environment/contracts.js', import.meta.url);
assert.ok(fs.existsSync(modulePath), 'Environment contract must exist before authorizing a VM');
const { validateBinding, validateProfile, profileDigest, BACKENDS, summarizeResults } = await import(modulePath.href);
const { assertOwnedPath, hashFile, verifyFile } = await import('../src/environment/paths.js');
const { createEvidenceStore } = await import('../src/environment/evidence.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-env-contract-'));
const now = 1800000000000;
const limits = {cpuCount:2,memoryMiB:4096,diskGiB:64,timeoutMs:60000,maxEvidenceBytes:4096,maxEvidenceFiles:8};
const binding = {version:1,actor:{kind:'agent',id:'task:fixture'},taskId:'task_fixture',attemptId:'attempt_fixture',
  runId:crypto.randomUUID(),environmentId:crypto.randomUUID(),workspaceId:'workspace_fixture',capability:'environment.test',
  expiresAt:now+60000,profileId:'offline-fixture',profileDigest:'a'.repeat(64),limits};
const profile = {version:1,id:'offline-fixture',backend:'hyper-v',mode:'lifecycle-fixture',network:'offline',
  image:{id:'win11',path:path.join(dir,'base.vhdx'),sha256:'b'.repeat(64),source:'owner-approved-local-image',windowsBuild:'22631',architecture:'x64'},
  candidate:null,guestCredentialFile:path.join(dir,'guest-credential.xml'),limits,packIds:['W01'],retainedLimit:1};
try {
  assert.equal(validateBinding(binding,{now}).runId,binding.runId);
  assert.throws(()=>validateBinding({...binding,expiresAt:now},{now}),{code:'ENV_AUTH_EXPIRED'});
  assert.throws(()=>validateBinding({...binding,actor:{kind:'external',id:'forged'}},{now}),{code:'ENV_IDENTITY_INVALID'});
  assert.throws(()=>validateBinding({...binding,runId:'../foreign'},{now}),{code:'ENV_IDENTITY_INVALID'});
  assert.throws(()=>validateBinding({...binding,limits:{...limits,cpuCount:900}},{now}),{code:'ENV_LIMIT_INVALID'});
  assert.throws(()=>validateBinding({...binding,hostCommand:'Remove-VM *'},{now}),{code:'ENV_SCHEMA_INVALID'});
  assert.equal(validateProfile(profile).backend,'hyper-v');
  assert.equal(profileDigest(profile),profileDigest({...profile,limits:{...limits}}));
  assert.notEqual(profileDigest(profile),profileDigest({...profile,limits:{...limits,timeoutMs:120000}}));
  assert.throws(()=>validateProfile({...profile,network:'internet'}),{code:'ENV_NETWORK_UNSUPPORTED'});
  assert.throws(()=>validateProfile({...profile,backend:'windows-sandbox'}),{code:'ENV_BACKEND_UNAVAILABLE'});
  assert.equal(BACKENDS.filter(row=>row.implemented).length,1);
  assert.equal(summarizeResults([{status:'PASS'},{status:'BLOCKED_ENV'}]),'BLOCKED_ENV');
  assert.equal(summarizeResults([]),'NOT_RUN');
  assert.equal(summarizeResults([{status:'FAIL'},{status:'PASS'}]),'FAIL');
  assert.equal(summarizeResults([{status:'PASS'},{status:'INCONCLUSIVE'}]),'INCONCLUSIVE');
  assert.throws(()=>summarizeResults([{status:'green'}]),{code:'ENV_RESULT_INVALID'});
  fs.mkdirSync(path.join(dir,'owned'));fs.mkdirSync(path.join(dir,'foreign'));
  const root=path.join(dir,'owned');
  fs.writeFileSync(path.join(root,'result.txt'),'test result');
  assert.equal(assertOwnedPath(root,'result.txt',{mustExist:true}),path.join(root,'result.txt'));
  for(const name of ['../foreign','a/../../foreign','C:\\escape','/absolute','a:stream','a\\..\\foreign'])
    assert.throws(()=>assertOwnedPath(root,name),{code:'ENV_PATH_DENIED'});
  fs.symlinkSync(path.join(dir,'foreign'),path.join(root,'junction'),'junction');
  assert.throws(()=>assertOwnedPath(root,'junction/evidence.txt'),{code:'ENV_PATH_DENIED'});
  const hash=await hashFile(path.join(root,'result.txt'));
  await verifyFile(path.join(root,'result.txt'),{sha256:hash,bytes:11,maxBytes:4096});
  await assert.rejects(verifyFile(path.join(root,'result.txt'),{sha256:'0'.repeat(64),maxBytes:4096}),{code:'ENV_HASH_MISMATCH'});
  await assert.rejects(hashFile(path.join(root,'result.txt'),{maxBytes:2}),{code:'ENV_ARTIFACT_TOO_LARGE'});
  const evidence=createEvidenceStore({root:path.join(dir,'evidence')});
  const report={schemaVersion:1,binding,layer:'Unit/Fixture',status:'PASS',checks:[{id:'fixture',status:'PASS'}],cleanup:{state:'pending'}};
  const receipt=await evidence.save({binding,report,files:[{source:path.join(root,'result.txt'),path:'result.txt',sha256:hash,bytes:11}]});
  await assert.rejects(evidence.save({binding,report,files:[{source:path.join(root,'result.txt'),path:'missing-size.txt',sha256:hash}]}),{code:'ENV_SCHEMA_INVALID'});
  await assert.rejects(evidence.save({binding,report,files:[{source:path.join(root,'result.txt'),path:'oversized.txt',sha256:hash,bytes:4097}]}),{code:'ENV_ARTIFACT_TOO_LARGE'});
  assert.equal((await evidence.verify(receipt,binding)).verified,true);
  assert.throws(()=>evidence.directory({...binding,runId:'../escape'}),{code:'ENV_IDENTITY_INVALID'});
  await assert.rejects(evidence.verify(receipt,{...binding,taskId:'other'}),{code:'ENV_EVIDENCE_BINDING'});
  fs.writeFileSync(path.join(evidence.directory(binding),'result.txt'),'tampered');
  await assert.rejects(evidence.verify(receipt,binding),{code:'ENV_HASH_MISMATCH'});
  await assert.rejects(evidence.save({binding:{...binding,runId:crypto.randomUUID()},report,files:[{source:path.join(root,'result.txt'),path:'../escape',sha256:hash,bytes:11}]}),{code:'ENV_PATH_DENIED'});
  console.log('PASS Environment identity, strict profiles, unsupported backends, truthful statuses, path escapes, hash and evidence ownership');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
