import fs from 'node:fs';
import crypto from 'node:crypto';
import {resolveInside} from '../workspace/boundary.js';

const review = reason => ({status:'NEEDS_REVIEW',kind:'changes',evidenceEventIds:[],reasons:[reason]});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
/** Read current bytes against Core operation receipts, never report text. */
export function verifyIsolatedChildWrites(task,{operations,workspaceRoot,changedPaths}) {
  const attempt=task.attempts?.at(-1), observed=task.executionObservation;
  if(!attempt || attempt.state!=='completed' || observed?.state!=='awaiting-review'
    || observed.provider!==attempt.provider || observed.sessionId!==attempt.sessionId || observed.runId!==attempt.requestId
    || task.attempts.some(row=>['started','accepted','unknown'].includes(row.state)))return review('CHILD_EXECUTION_UNCONFIRMED');
  const evidence=(task.executionEvidence??[]).filter(row=>row.provider===attempt.provider&&row.sessionId===attempt.sessionId
    &&row.runId===attempt.requestId&&row.phase==='user'&&row.taskRev>=attempt.taskRev);
  const current=operations.filter(row=>row.capability==='filesystem.write'&&row.operationProof?.execution?.provider===attempt.provider
    &&row.operationProof.execution.sessionId===attempt.sessionId&&row.operationProof.execution.runId===attempt.requestId
    &&row.operationProof.execution.phase==='user');
  if(!current.length||current.length>100||current.some(row=>row.status!=='completed'))return review('CHILD_WRITE_RECEIPT_MISSING');
  if(task.childContract.expectedEvidence.some(capability=>!evidence.some(row=>row.capability===capability&&row.status==='completed')))
    return review('CHILD_REQUIRED_EVIDENCE_MISSING');
  const latest=new Map(), ids=new Set();
  for(const row of [...current].sort((a,b)=>a.at-b.at)) {
    const relative=row.accessInput?.path, hash=row.operationProof?.sha256;
    const source=evidence.findLast(item=>item.capability==='filesystem.write'&&item.status==='completed'&&item.filePath===relative);
    if(typeof relative!=='string'||!source||!/^[a-f0-9]{64}$/.test(hash??'')
      ||!task.childContract.writeScope.some(scope=>relative===scope||relative.startsWith(scope+'/')))return review('CHILD_WRITE_BINDING_INVALID');
    const prior=latest.get(relative);
    if(prior&&prior.at===row.at&&prior.sha256!==hash)return review('CHILD_WRITE_ORDER_UNCONFIRMED');
    latest.set(relative,{path:relative,sha256:hash,operationId:row.operationId,at:row.at});ids.add(source.eventId);
  }
  if(!Array.isArray(changedPaths)||changedPaths.some(relative=>!latest.has(relative)))return review('CHILD_UNOBSERVED_WORKSPACE_CHANGE');
  const files=[];
  try {
    for(const value of latest.values()) {
      const file=resolveInside(workspaceRoot,value.path).real,before=fs.lstatSync(file,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>16n*1024n*1024n)return review('CHILD_FILE_UNVERIFIED');
      const bytes=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});
      if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||sha(bytes)!==value.sha256)return review('CHILD_POSTIMAGE_CHANGED');
      files.push({path:value.path,sha256:value.sha256,operationId:value.operationId});
    }
  } catch {return review('CHILD_FILE_UNVERIFIED');}
  return {status:'VERIFIED',kind:'changes',evidenceEventIds:[...ids],reasons:[],
    changesProof:{version:1,runId:attempt.requestId,files,sha256:sha(JSON.stringify(files))}};
}
