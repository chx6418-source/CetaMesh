import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {resolveInside} from './boundary.js';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Preflight binds the approved file set to actual bytes and the current repository version. */
export async function prepareScopedCommit(root,{paths,expectedHead,expectedHashes}={}, {gitRun,gitStatus}) {
  if(!Array.isArray(paths)||paths.length<1||paths.length>100)fail('COMMIT_PATHS_REQUIRED','Commit requires 1-100 explicitly authorized relative paths');
  if(expectedHead!==null&&!/^[a-f0-9]{40}$/.test(expectedHead??''))fail('COMMIT_BASELINE_REQUIRED','Commit requires expected HEAD or explicit null for an empty repository');
  if(!expectedHashes||typeof expectedHashes!=='object'||Array.isArray(expectedHashes))fail('COMMIT_HASHES_REQUIRED','Commit requires every selected file hash');
  const selected=[],seen=new Set();
  for(const rel of paths) {
    if(typeof rel!=='string'||!rel||rel.length>1024||rel.includes('\0')||rel.includes('\\')||rel.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))fail('COMMIT_PATH_INVALID','Commit requires normalized relative file paths');
    const key=process.platform==='win32'?rel.toLowerCase():rel;
    if(seen.has(key))fail('COMMIT_PATH_INVALID','Duplicate commit path');seen.add(key);
    const target=resolveInside(root,rel,{forWrite:true}).absolute;
    let bytes=null;
    try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())fail('COMMIT_PATH_INVALID','Commit target must be a regular file');bytes=fs.readFileSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}
    const expected=expectedHashes[rel];
    if(!Object.hasOwn(expectedHashes,rel)||expected!==null&&!/^[a-f0-9]{64}$/.test(expected??''))fail('COMMIT_HASHES_REQUIRED','Every path requires SHA256 or a null deletion marker');
    if((bytes===null?null:sha256(bytes))!==expected)fail('WORKSPACE_CONFLICT','Selected commit content changed after authorization');
    selected.push(rel);
  }
  if(Object.keys(expectedHashes).length!==selected.length)fail('COMMIT_HASHES_REQUIRED','Hash keys must exactly match selected paths');
  const status=await gitStatus(root,{completeFiles:true});
  if(!status.isRepo)fail('GIT_NOT_REPOSITORY','Commit requires an existing Git repository');
  if(path.resolve(status.repoRoot)!==path.resolve(fs.realpathSync.native(root)))fail('COMMIT_ROOT_REQUIRED','Commit requires the registered repository root');
  for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply']) {
    const location=path.resolve(root,(await gitRun(root,['rev-parse','--git-path',marker])).stdout.trim());
    if(fs.existsSync(location))fail('GIT_OPERATION_IN_PROGRESS','Finish or review the current Git integration before creating a scoped commit');
  }
  if(status.headSha!==expectedHead)fail('GIT_HEAD_CHANGED','Repository version changed after authorization');
  return {paths:selected,expectedHead,expectedHashes:Object.fromEntries(selected.map(rel=>[rel,expectedHashes[rel]]))};
}

/** A private index creates the tree. CAS updates HEAD; the held normal-index lock preserves unrelated staged work. */
export async function commitScopedPaths(root,request={},dependencies) {
  const {gitRun}=dependencies,message=String(request.message??'').trim();
  if(!message)fail('COMMIT_MESSAGE_REQUIRED','Commit requires a message');
  if(message.length>2000)fail('COMMIT_MESSAGE_TOO_LONG','Commit message exceeds 2000 characters');
  const selection=await prepareScopedCommit(root,request,dependencies);
  const indexPath=path.resolve(root,(await gitRun(root,['rev-parse','--git-path','index'])).stdout.trim()),lockPath=indexPath+'.lock';
  let handle;
  try{handle=fs.openSync(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('GIT_INDEX_BUSY','Another Git operation owns the index');throw error;}
  fs.closeSync(handle);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cm-git-index-')),indexFile=path.join(temporary,'index');
  let committed=false,sha=null;
  try {
    if(fs.existsSync(indexPath))fs.copyFileSync(indexPath,lockPath);
    else {
      // Initialize a separate file and copy it into our already-owned lock.
      await gitRun(root,selection.expectedHead?['read-tree',selection.expectedHead]:['read-tree','--empty'],{indexFile});
      fs.copyFileSync(indexFile,lockPath);
    }
    await gitRun(root,selection.expectedHead?['read-tree',selection.expectedHead]:['read-tree','--empty'],{indexFile});
    await gitRun(root,['add','--all','--',...selection.paths],{indexFile});
    await prepareScopedCommit(root,selection,dependencies);
    const tree=(await gitRun(root,['write-tree'],{indexFile})).stdout.trim();
    if(selection.expectedHead&&tree===(await gitRun(root,['rev-parse',selection.expectedHead+'^{tree}'])).stdout.trim())return {committed:false,reason:'nothing-to-commit',paths:selection.paths};
    const entries=(await gitRun(root,['ls-files','--stage','-z','--',...selection.paths],{indexFile})).stdout.split('\0').filter(Boolean),found=new Set();
    for(const entry of entries){const match=/^(\d+) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(entry);if(!match||!['100644','100755'].includes(match[1]))fail('GIT_INDEX_INVALID','Selected index entry is unresolved or not a regular file');
      if(selection.expectedHashes[match[3]]==null || (await gitRun(root,['hash-object','--path',match[3],'--',match[3]])).stdout.trim()!==match[2])fail('WORKSPACE_CONFLICT','Temporary index does not match authorized content');
      found.add(match[3]);await gitRun(root,['update-index','--add','--cacheinfo',match[1],match[2],match[3]],{indexFile:lockPath});}
    for(const rel of selection.paths)if(!found.has(rel)){if(selection.expectedHashes[rel]!==null)fail('WORKSPACE_CONFLICT','Authorized file disappeared from temporary index');await gitRun(root,['update-index','--force-remove','--',rel],{indexFile:lockPath});}
    await prepareScopedCommit(root,selection,dependencies);
    sha=(await gitRun(root,['commit-tree',tree,...(selection.expectedHead?['-p',selection.expectedHead]:[]),'-m',message],{indexFile})).stdout.trim();
    if(!/^[a-f0-9]{40}$/.test(sha))fail('GIT_COMMIT_INVALID','Git did not return a commit identity');
    await gitRun(root,['update-ref','-m',message.slice(0,200),'HEAD',sha,selection.expectedHead??'0'.repeat(40)]);
    committed=true;
    try{fs.renameSync(lockPath,indexPath);}catch{return {committed:true,sha,paths:selection.paths,indexUpdated:false,code:'GIT_INDEX_REVIEW_REQUIRED'};}
    return {committed:true,sha,paths:selection.paths,indexUpdated:true};
  }catch(error){
    if(error.code&&typeof error.code==='string')throw error;
    throw Object.assign(new Error('Scoped Git commit could not complete'),{code:committed?'GIT_COMMIT_REVIEW_REQUIRED':'GIT_FAILED',...(committed?{effectStatus:'unknown',sha}:{})});
  }finally{
    try{fs.unlinkSync(lockPath);}catch(error){if(error.code!=='ENOENT')process.emitWarning('Owned Git index lock cleanup needs review',{code:'GIT_INDEX_REVIEW_REQUIRED'});}
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}
