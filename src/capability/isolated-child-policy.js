import path from 'node:path';
import {resolveInside} from '../workspace/boundary.js';
import {capabilityError} from './types.js';

export const ISOLATED_CHILD_CAPABILITIES = Object.freeze(['filesystem.read','filesystem.search','filesystem.write','workspace.apply','operation.read','operation.continue']);
const deny = () => { throw capabilityError('TASK_CHILD_SCOPE_DENIED','Tool paths must remain inside the isolated child contract'); };
export function assertIsolatedChildPath(task, root, value, write=false) {
  const relative=typeof value==='string'?value.replaceAll('\\','/'):'';
  if(!relative || relative.startsWith('/') || /[:\x00-\x1f\x7f]/.test(relative)
    || relative.split('/').some(part=>!part||part==='.'||part==='..'
      || /^(?:\.git|\.codex|\.ssh|\.aws|\.azure|\.gnupg|\.cetamesh|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part)))deny();
  const scopes=write?task.childContract.writeScope:task.childContract.readScope;
  const within=(scope,target)=>{const delta=path.relative(scope,target);return !delta || delta!=='..'&&!delta.startsWith('..'+path.sep)&&!path.isAbsolute(delta);};
  try {
    const target=resolveInside(root,relative,{forWrite:write}).real;
    if(!scopes.some(scope=>(relative===scope || relative.startsWith(scope+'/'))
      && within(resolveInside(root,scope,{forWrite:true}).real,target)))deny();
  } catch {deny();}
}
export function assertIsolatedChildCapability(task,request,entry,resolveWorkspace) {
  if(task.childContract?.mode!=='isolated-write')return;
  if(entry.id==='agent.run'&&request.actor.kind==='owner')return;
  if(!ISOLATED_CHILD_CAPABILITIES.includes(entry.id))
    throw capabilityError('TASK_CHILD_CAPABILITY_DENIED','This isolated writer profile only supports explicitly granted scoped file tools');
  if(entry.id==='operation.read'||entry.id==='operation.continue')return;
  const root=resolveWorkspace(request.workspaceId)?.root;
  if(typeof root!=='string')deny();
  if(entry.id==='workspace.apply') {
    if(!Array.isArray(request.input?.changes)||!request.input.changes.length)deny();
    for(const change of request.input.changes)assertIsolatedChildPath(task,root,change?.path,true);
  } else assertIsolatedChildPath(task,root,request.input?.path,entry.id==='filesystem.write');
}
