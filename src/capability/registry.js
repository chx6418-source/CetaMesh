import {capabilityError} from './types.js';
export function createCapabilityRegistry(){
 const entries=new Map();
 return {register(definition){if(!definition?.id||typeof definition.execute!=='function')throw capabilityError('INVALID_CAPABILITY','id and execute required');if(entries.has(definition.id))throw capabilityError('CAPABILITY_EXISTS',definition.id);entries.set(definition.id,Object.freeze({...definition}));return definition.id;}, require(id){const entry=entries.get(id);if(!entry)throw capabilityError('UNKNOWN_CAPABILITY','Unknown capability: '+id);return entry;},has:id=>entries.has(id),list:()=>[...entries.values()].map(({id,permission,risk='low',provider='adapter',workspace=false})=>({id,permission,risk,provider,workspace}))};
}
