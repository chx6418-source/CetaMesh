import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createGitBranchActions} from '../src/workspace/git-branch-actions.js';

const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
const git=(root,...args)=>childProcess.execFileSync('git',['--literal-pathspecs','-c','commit.gpgSign=false','-c','core.hooksPath='+(process.platform==='win32'?'NUL':'/dev/null'),...args],{cwd:root,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trimEnd();
let failures=0;
for(const scenario of ['clean','ignored-late-addition','canonical-equivalent-raw-edit']){
 const parent=fs.realpathSync.native(os.tmpdir()),root=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'cm-branch-byteguard-'))),identity=fs.lstatSync(root,{bigint:true});
 const original=childProcess.execFile;let injected=false;
 try{
  git(root,'init','-b','main');git(root,'config','user.name','Owned branch bytes');git(root,'config','user.email','owned@example.invalid');git(root,'config','core.autocrlf','false');git(root,'config','core.trustctime','false');
  const mainFile=path.join(root,'a.txt'),lateFile=path.join(root,'late.txt'),baseline=scenario==='canonical-equivalent-raw-edit'?'one\r\ntwo\n':'base\n';
  if(scenario==='canonical-equivalent-raw-edit')fs.writeFileSync(path.join(root,'.git','info','attributes'),'a.txt text eol=lf\n');
  fs.writeFileSync(mainFile,baseline);git(root,'add','--','a.txt');git(root,'commit','-m','base');const oldHead=git(root,'rev-parse','HEAD');
  git(root,'switch','-c','target');fs.writeFileSync(mainFile,'targ\n');if(scenario==='ignored-late-addition')fs.writeFileSync(lateFile,'target addition\n');
  git(root,'add','--','a.txt',...(scenario==='ignored-late-addition'?['late.txt']:[]));git(root,'commit','-m','target');const targetHead=git(root,'rev-parse','HEAD');git(root,'switch','main');
  fs.writeFileSync(mainFile,baseline);fs.utimesSync(mainFile,1000000000,1000000000);git(root,'add','--','a.txt');
  if(scenario==='ignored-late-addition')fs.writeFileSync(path.join(root,'.git','info','exclude'),'late.txt\n');
  assert.equal(git(root,'status','--porcelain'),'');const beforeIndex=fs.readFileSync(path.join(root,'.git','index'));
  const actions=createGitBranchActions({nativeExecutable:process.env.CETAMESH_TEST_WORKSPACE_NATIVE}),entry={id:path.basename(root),root},review=await actions.reviewSwitch(entry,{targetBranch:'refs/heads/target'});assert.equal(review.canSwitch,true);
  childProcess.execFile=function(command,args,...rest){
   // Inject at the actual effectful launch, after the last application-level
   // observation. Support the old native checkout and the fixed native writer.
   if(!injected&&((command==='git'&&args.includes('read-tree')&&args.includes('-u'))||args.some(arg=>typeof arg==='string'&&arg.startsWith('--workspace-byte-transaction=')))){
    injected=true;if(scenario==='ignored-late-addition')fs.writeFileSync(lateFile,'USER UNREVIEWED IGNORED BYTES\n');
    if(scenario==='canonical-equivalent-raw-edit'){fs.writeFileSync(mainFile,'one\ntwo\r\n');fs.utimesSync(mainFile,1000000000,1000000000);}
   }
   return original.call(this,command,args,...rest);
  };syncBuiltinESMExports();
  let outcome,error;try{outcome=await actions.switchBranch(entry,review);}catch(caught){error=caught;}
  assert.equal(injected,true,'the race must reach the actual effectful launch; preceding failure='+error?.code);
  if(scenario==='clean'){
   assert.equal(error,undefined,error?.message);assert.equal(outcome.switched,true);assert.equal(fs.readFileSync(mainFile,'utf8'),'targ\n');assert.equal(git(root,'symbolic-ref','HEAD'),'refs/heads/target');
  }else{
   const file=scenario==='ignored-late-addition'?lateFile:mainFile,wanted=scenario==='ignored-late-addition'?'USER UNREVIEWED IGNORED BYTES\n':'one\ntwo\r\n';
   assert.equal(fs.readFileSync(file,'utf8'),wanted,'Unreviewed raw bytes must survive the last native launch gap; returned '+JSON.stringify(outcome??{code:error?.code,effectStatus:error?.effectStatus}));
   assert.ok(error,'a changed raw preimage cannot be declared a successful switch');assert.equal(git(root,'symbolic-ref','HEAD'),'refs/heads/main');assert.deepEqual(fs.readFileSync(path.join(root,'.git','index')),beforeIndex);
  }
  assert.equal(git(root,'rev-parse','refs/heads/main'),oldHead);assert.equal(git(root,'rev-parse','refs/heads/target'),targetHead);
  console.log('PASS branch raw-byte preservation: '+scenario);
 }catch(error){failures++;console.error('FAIL branch raw-byte preservation: '+scenario+'\n'+error.stack);}
 finally{childProcess.execFile=original;syncBuiltinESMExports();const current=fs.lstatSync(root,{bigint:true});assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('cm-branch-byteguard-'));assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino);assert.equal(fs.realpathSync.native(root),root);fs.rmSync(root,{recursive:true,force:true});}
}
assert.equal(failures,0,'Git final publication must preserve actual raw bytes in every case');
