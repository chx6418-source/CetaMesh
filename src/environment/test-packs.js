import { environmentError, validateBinding } from './contracts.js';
/** Versioned evidence contract. A check label alone is never execution proof. */
export const TEST_PACK_VERSION = 1;
const pack = (id, checks, prerequisites, layer = 'Windows VM E2E') => Object.freeze({id,requiredChecks:Object.freeze(checks.split(' ')),prerequisites:Object.freeze(prerequisites),layer});
export const TEST_PACKS = Object.freeze([
  pack('W01','artifact-hashes install-exit installed-files build-info',['candidate']),
  pack('W02','gui-process gui-window',['candidate','interactive-desktop']),
  pack('W03','model-step4 chat-reached',['candidate','interactive-desktop','uia-driver']),
  pack('W04','core-ipc task-attempt memory workspace permission error',['candidate'],'Integration'),
  pack('W05','managed-tool-roundtrip task-progress cancel-propagation real-provider',['candidate','synthetic-loopback','optional-provider-credentials'],'Integration'),
  pack('W06','cancel-owned crash-restart unknown-outcome',['candidate'],'Integration'),
  pack('W07','upgrade uninstall',['previous-candidate']),
]);
const statuses = ['PASS','FAIL','NOT_RUN','BLOCKED_ENV','INCONCLUSIVE'];
export function selectTestPacks(ids) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw environmentError('ENV_TEST_PACKS_INVALID','Select unique known test packs');
  return ids.map(id => { const found=TEST_PACKS.find(p=>p.id===id); if(!found) throw environmentError('ENV_TEST_PACK_UNKNOWN','Unknown test pack'); return found; });
}
const time = n => Number.isSafeInteger(n) && n >= 0;
const hash = value => typeof value==='string' && /^[0-9a-f]{64}$/i.test(value);
function observed(c) {
  const o=c.observations;
  if(!o || typeof o!=='object' || Array.isArray(o) || o.actual!==true) return false;
  switch(`${c.packId}/${c.id}`) {
    case 'W01/artifact-hashes': return Number.isSafeInteger(o.files) && o.files>=2 && hash(o.installerSha256);
    case 'W01/install-exit': return Number.isSafeInteger(o.pid) && o.pid>0 && c.exitCode===0;
    case 'W01/installed-files': return hash(o.coreSha256);
    case 'W01/build-info': return /^[0-9a-f]{7,40}$/i.test(o.commit) && typeof o.version==='string' && !!o.version;
    case 'W02/gui-process': return Number.isSafeInteger(o.pid) && o.pid>0 && o.sessionId>0 && Number.isFinite(Date.parse(o.startedAt));
    case 'W02/gui-window': return Number.isSafeInteger(o.pid) && o.pid>0 && Number.isSafeInteger(o.windowHandle) && o.windowHandle!==0;
    case 'W04/core-ipc': return o.binary==='WhaleBridgeCore.exe' && o.framing==='v1-length-prefixed' && o.pid>0;
    case 'W04/task-attempt': return !!o.taskId && !!o.attemptId && o.attemptExecuted===true && o.attemptState==='accepted' && !!o.requestId && o.provider==='cetamesh' && o.inferenceObserved===true;
    case 'W04/memory': return o.method==='memory.list' && o.responseReceived===true;
    case 'W04/workspace': return o.method==='workspace.list' && o.responseReceived===true;
    case 'W04/permission': return o.rejectedCode==='IPC_AUTH_DENIED';
    case 'W04/error': return typeof o.errorCode==='string' && !!o.errorCode;
    case 'W06/cancel-owned': return o.pid>0 && o.exitConfirmed===true && Number.isFinite(Date.parse(o.startedAt));
    case 'W06/crash-restart': return o.oldPid>0 && o.newPid>0 && o.oldPid!==o.newPid && !!o.taskId && o.persistenceRead===true;
    case 'W06/unknown-outcome': return o.replayed===false && o.reconciliationRequired===true && !!o.attemptId && o.attemptState==='unknown' && o.taskStatus==='blocked' && o.rejectionCode==='NEEDS_RECONCILIATION';
    case 'W05/managed-tool-roundtrip': return o.capability==='filesystem.read' && !!o.callId && o.resultMatched===true && o.rounds>=2 && o.actualContentObserved===true && o.provider==='synthetic-loopback';
    case 'W05/task-progress': return !!o.taskId && o.taskStatus==='running' && o.executionEvidence>0 && o.progressObserved===true && o.completed===false;
    case 'W05/cancel-propagation': return !!o.taskId && o.taskStatus==='cancelled' && o.modelConnectionClosed===true && time(o.cancelRequestedAt) && time(o.connectionClosedAt) && o.connectionClosedAt>=o.cancelRequestedAt;
    case 'W07/uninstall': return o.coreRemoved===true && o.pid>0 && c.exitCode===0;
    case 'W03/model-step4': case 'W03/chat-reached': return o.driver==='UIAutomation';
    default: return false; // Conditional packs require a future versioned proof contract.
  }
}
const aggregate = states => ['FAIL','INCONCLUSIVE','BLOCKED_ENV','NOT_RUN','PASS'].find(s=>states.includes(s)) ?? 'INCONCLUSIVE';
export function evaluateGuestReport(report, {binding,packIds,layer='Windows VM E2E'}) {
  const selected = selectTestPacks(packIds), issues=[];
  try { validateBinding(binding,{allowExpired:true}); } catch { issues.push('BINDING_INVALID'); }
  if (!report || report.schemaVersion!==1) issues.push('REPORT_SCHEMA');
  for(const key of ['runId','environmentId','taskId','attemptId']) if(!binding?.[key] || report?.[key]!==binding[key]) issues.push(`BINDING_${key}`);
  if(!time(report?.startedAt)||!time(report?.endedAt)||report.endedAt<report.startedAt) issues.push('REPORT_TIME');
  if(!report?.guest?.windowsBuild||!report?.guest?.architecture) issues.push('GUEST_IDENTITY');
  if(!Array.isArray(report?.checks)||!Array.isArray(report?.evidence)) issues.push('REPORT_COLLECTIONS');
  const checks = Array.isArray(report?.checks)?report.checks:[];
  const packs = selected.map(p => {
    const results=p.requiredChecks.map(id=>{
      const matches=checks.filter(c=>c?.packId===p.id && c.id===id);
      if(matches.length!==1) { issues.push(`${p.id}/${id}:CHECK_COUNT`); return {id,status:'FAIL'}; }
      const c=matches[0]; let status=c.status;

      if(!statuses.includes(status)||!time(c.startedAt)||!time(c.endedAt)||c.endedAt<c.startedAt||c.startedAt<report.startedAt||c.endedAt>report.endedAt) status='FAIL';
      if(c.exitCode!==undefined && (!Number.isInteger(c.exitCode)||(c.status==='PASS' && c.exitCode!==0))) status='FAIL';
      if(c.status==='PASS') {
        if(!observed(c)) status='INCONCLUSIVE';
        const expected = layer==='Unit/Fixture' ? layer : p.id==='W05' && id==='real-provider' ? 'Real Provider E2E' : p.layer;
        if(c.layer!==expected) status='INCONCLUSIVE';
        if(p.id==='W03' && (c.observations?.driver!=='UIAutomation' || (id==='model-step4' && !(c.observations.step===4 && typeof c.observations.savedModel==='string' && !!c.observations.savedModel && c.observations.advanced===true)) || (id==='chat-reached' && c.observations.chatVisible!==true))) status='INCONCLUSIVE';
      }
      if (/^(GUI_EXITED|GUI_LAUNCH_FAILED|GUI_WINDOW_UNAVAILABLE|ONBOARDING_STEP4_STALLED|ONBOARDING_STILL_VISIBLE|UIA_FLOW_TIMEOUT)$/.test(c.code)) status='FAIL';
      if(status!==c.status) issues.push(`${p.id}/${id}:INVALID_PROOF`);
      return {...c,status};
    });
    return {id:p.id,status:aggregate(results.map(c=>c.status)),checks:results};
  });
  for(const c of checks) if(!selected.some(p=>p.id===c?.packId && p.requiredChecks.includes(c.id))) issues.push('UNEXPECTED_CHECK');
  const structural=issues.some(s=>!s.endsWith('INVALID_PROOF'));
  return {version:1,status:structural?'FAIL':aggregate(packs.map(p=>p.status)),layer,packs,issues};
}
