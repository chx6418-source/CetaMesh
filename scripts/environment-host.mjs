import fs from 'node:fs';
import path from 'node:path';
import {readJsonFile} from '../src/storage/json-file.js';
import {createHyperVBackend} from '../src/environment/hyperv-backend.js';
import {createEnvironmentHost} from '../src/environment/host.js';
import {listenEnvironmentHost} from '../src/environment/host-client.js';

const args=process.argv.slice(2);
if(args.length!==2 || args[0]!=='--config' || !path.isAbsolute(args[1]))throw new Error('Usage: node scripts/environment-host.mjs --config <absolute protected developer config>');
const config=readJsonFile(args[1],{maxBytes:1048576});
const backend=createHyperVBackend({hostRoot:config.root});
// No UAC escalation, image download, Windows feature changes or VM creation at startup.
for(const profile of config.profiles || []) {
 const result=await backend.preflight({profile});
 if(result.status!=='PASS')console.log(JSON.stringify({status:'BLOCKED_ENV',reasons:result.reasons,mode:'recovery-queries-available'}));
}
{
 if(!config.profiles?.length)throw new Error('At least one approved profile is required');
 const token=fs.readFileSync(config.tokenFile,'utf8').trim();
 const host=createEnvironmentHost({root:config.root,profiles:config.profiles,backend});
 const server=await listenEnvironmentHost({pipe:config.pipe,token,host});
 console.log('Environment Host listening on configured private pipe; profiles pinned; no VM started.');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();});
}
