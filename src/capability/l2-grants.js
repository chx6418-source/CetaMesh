// Trusted Core classification. A plugin's declared risk/effect alone cannot qualify.
export function isControlledL2Write(request, entry) {
 if(entry?.provider!=='workspace'||entry.permission!=='filesystem.write'||entry.risk!=='high')return false;
 if(entry.id==='filesystem.write')return typeof request.input?.path==='string'&&request.input.append!==true;
 if(entry.id==='workspace.apply')return Array.isArray(request.input?.changes)&&request.input.changes.length>0
  &&request.input.changes.every(change=>change?.action==='write'&&typeof change.path==='string');
 return false;
}
export function l2Resources(request) {
 return request.capability==='workspace.apply'?request.input.changes.map(change=>change.path):[request.input.path];
}
