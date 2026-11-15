import fs from 'node:fs';
import path from 'node:path';
import {isManagedWorktree} from './managed-worktree.js';
import {resolveInside} from './boundary.js';

const fail = () => { throw Object.assign(new Error('Registered isolated worktree identity is unavailable or changed'), {code:'TASK_CHILD_ISOLATION_INVALID'}); };
function smallFile(file, limit = 4096) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail();
  return fs.readFileSync(file,'utf8');
}
function identity(root) {
  const stat = fs.lstatSync(root,{bigint:true}), real = fs.realpathSync.native(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(real,root)) fail();
  return {path:real,device:String(stat.dev),file:String(stat.ino)};
}

// Core-only, synchronous admission observation. No Git process, registration,
// approval or recovery effects. Initial writer profile supports normal refs.
export function inspectIsolatedChildWorkspace(entry, {stateDir,resolveWorkspace,parentTaskId,sourceWorkspaceId,baselineHead,branch}) {
  try {
    if (!isManagedWorktree(entry,{stateDir,resolveWorkspace})) fail();
    const relation=entry.gitWorktree, source=resolveWorkspace(sourceWorkspaceId);
    if (!source || relation.parentWorkspaceId!==sourceWorkspaceId || relation.taskId!==parentTaskId
      || relation.baselineHead!==baselineHead || relation.branch!==branch || !/^[a-f0-9]{40}$/.test(baselineHead??'')) fail();
    const marker=/^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(smallFile(path.join(entry.root,'.git')));
    if(!marker)fail();
    const gitDir=path.resolve(entry.root,marker[1]);
    const common=path.resolve(gitDir,smallFile(path.join(gitDir,'commondir')).trim());
    const head=smallFile(path.join(gitDir,'HEAD')).trim(), ref='refs/heads/'+branch;
    if(head!=='ref: '+ref)fail();
    let actual;
    try {actual=smallFile(resolveInside(common,ref).real).trim();}
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      const rows=smallFile(path.join(common,'packed-refs'),2*1024*1024).split(/\r?\n/).filter(line=>line.endsWith(' '+ref));
      if(rows.length!==1)fail(); actual=rows[0].split(' ')[0];
    }
    if(actual!==baselineHead)fail();
    return {rootIdentity:identity(entry.root),sourceRootIdentity:identity(source.root),gitCommonIdentity:identity(common)};
  } catch { fail(); }
}
