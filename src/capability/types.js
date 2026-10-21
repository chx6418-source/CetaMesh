import crypto from 'node:crypto';
export const OWNER_ACTOR = Object.freeze({kind:'owner',id:'desktop'});
export const PERMISSIONS = Object.freeze(['filesystem.read','filesystem.write','filesystem.search','workspace.create','git.status','git.diff','git.commit','test.run','memory.read','memory.write','memory.link','task.create','network','web.search','agent.run','extension.invoke','message.send','publish','log','storage']);
export const FORBIDDEN_PERMISSIONS = Object.freeze(['shell','native','download','process']);
export const RISK_RANK = Object.freeze({low:0,medium:1,high:2,critical:3,forbidden:99});
export function capabilityError(code,message){return Object.assign(new Error(message),{code});}
export function normalizeRequest(value){
 if(!value || typeof value!=='object')throw capabilityError('INVALID_REQUEST','Capability request required');
 if(!value.actor || !['owner','agent','external','extension','device'].includes(value.actor.kind) || !String(value.actor.id??'').trim())throw capabilityError('UNAUTHORIZED','Trusted actor required');
 if(!String(value.capability??'').trim())throw capabilityError('INVALID_REQUEST','Capability required');
 const copy=structuredClone(value);
 return {...copy,requestId:String(copy.requestId||crypto.randomUUID()),actor:copy.actor,capability:String(copy.capability),input:copy.input??{},scope:copy.scope??null,risk:copy.risk??null,reason:String(copy.reason??'').slice(0,1000)};
}
