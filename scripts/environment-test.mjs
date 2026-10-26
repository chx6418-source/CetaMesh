import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJsonFile,writeJsonAtomic,writeTextAtomic} from '../src/storage/json-file.js';
import {createHyperVBackend} from '../src/environment/hyperv-backend.js';
import {createEnvironmentHostClient} from '../src/environment/host-client.js';
import {createCapabilityService} from '../src/capability/service.js';
import {createWorkspaceService} from '../src/workspace/service.js';
import {createTaskRuntime} from '../src/task/runtime.js';

export async function environmentTestMain(args=process.argv.slice(2)) {
 const values={};for(let i=0;i<args.length;i++){const key=args[i];if(['--preflight','--approve-run'].includes(key))values[key]=true;else if(['--config','--profile','--state-dir','--report'].includes(key)&&args[i+1])values[key]=args[++i];else throw new Error(`Unknown argument: ${key}`);}
 const output=values['--report'] || path.resolve('.superpowers/sdd/environment-tests/latest.json');
 let result;
 if(values['--preflight']) {
  const backend=createHyperVBackend({hostRoot:path.resolve('.superpowers/sdd/environment-tests/host-preflight')});
  result=await backend.preflight({});result.layer='Windows VM E2E';result.executed=false;
 } else {
  if(!values['--approve-run'] || !values['--config'] || !values['--profile'] || !path.isAbsolute(values['--state-dir'] || ''))throw new Error('A run requires --config, --profile, --state-dir <private absolute directory>, and explicit --approve-run');
  const config=readJsonFile(values['--config'],{maxBytes:1048576});
  const client=createEnvironmentHostClient({pipe:config.pipe,token:fs.readFileSync(config.tokenFile,'utf8').trim()});
  const selected=(await client.profiles()).find(p=>p.id===values['--profile']);if(!selected)throw new Error('Approved profile not found');
  const stateDir=values['--state-dir'];
  const workspaceService=createWorkspaceService({stateDir}),taskRuntime=createTaskRuntime({stateDir});
  const service=createCapabilityService({stateDir,workspaceService,taskRuntime,environmentClient:client,ownedArtifactRoot:path.join(stateDir,'artifacts')});
  try {
   const workspace=(await workspaceService.execute({method:'workspace.create',params:{root:path.join(stateDir,'fixture-workspace'),name:'Environment acceptance',createIfMissing:true}})).workspace;
   const task=taskRuntime.create({goal:'Run pinned offline Windows acceptance',workspaceId:workspace.id});
   // Explicit Owner CLI approval, through the same production Capability/Task services.
   const response=await service.broker.execute({actor:{kind:'owner',id:'desktop'},approved:true,taskId:task.id,workspaceId:workspace.id,capability:'environment.test',input:{profileId:selected.id,profileDigest:selected.digest}});
   result=response.result;
  }finally{await service.close();}
 }
 writeJsonAtomic(output,result);writeTextAtomic(output.replace(/\.json$/i,'')+'.md',`# Windows environment acceptance\n\nStatus: ${result.status}\n\nLayer: ${result.layer}\n\n${(result.reasons || []).map(r=>`- ${r}`).join('\n')}\n\nThis report does not convert fixture results into VM acceptance.\n`);
 console.log(JSON.stringify({status:result.status,layer:result.layer,report:output}));
 return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const result=await environmentTestMain();process.exitCode=result.status==='PASS'?0:['BLOCKED_ENV','NOT_RUN'].includes(result.status)?77:1;}
