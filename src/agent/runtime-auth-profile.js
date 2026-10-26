import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {agentProviderError as fault} from './agent-provider.js';
const providers=new Set(['gemini','opencode','claude']);
const validId=value=>typeof value==='string' && /^[a-f0-9-]{36}$/.test(value);
const invalid=()=>{throw fault('AGENT_AUTH_PROFILE_INVALID','Owned authentication profile is invalid; preserve it for review');};
// Do not follow reparse points / symlinks anywhere under the owned root. Native
// Windows ACL acceptance is separate: this POSIX mode is not an ACL claim.
function safeTree(root) {
 let count=0;
 function visit(file) {
  const stat=fs.lstatSync(file);if(stat.isSymbolicLink() || (!stat.isDirectory()&&!stat.isFile()) || ++count>4096) invalid();
  if(stat.isDirectory())for(const name of fs.readdirSync(file))visit(path.join(file,name));
 }
 visit(root);if(fs.realpathSync(root)!==path.resolve(root))invalid();
}
export function createRuntimeAuthProfileStore({stateDir,connectionLeases}={}) {
 if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))invalid();
 const root=path.join(stateDir,'agent-auth');
 function directory(provider) {
  if(!providers.has(provider))invalid();
  // Validate existing ancestors before recursive mkdir so a link cannot redirect
  // writes to another profile, including when the parent StateDir was replaced.
  let parent=root;
  while(!fs.existsSync(parent)){const next=path.dirname(parent);if(next===parent)invalid();parent=next;}
  let cursor=parent;while(true){if(fs.lstatSync(cursor).isSymbolicLink())invalid();const next=path.dirname(cursor);if(next===cursor)break;cursor=next;}
  fs.mkdirSync(root,{recursive:true,mode:0o700});if(fs.lstatSync(root).isSymbolicLink()||!fs.lstatSync(root).isDirectory())invalid();
  const dir=path.join(root,provider);if(fs.existsSync(dir)&&(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory()))invalid();fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;
 }
 function readGeneration(provider,generationId) {
  if(!validId(generationId))invalid();
  const dir=directory(provider),owned=path.join(dir,generationId);safeTree(owned);
  const owner=readJsonFile(path.join(owned,'.owned.json'),{maxBytes:4096});
  if(owner.provider!==provider||owner.generationId!==generationId||owner.version!==1)invalid();
  return Object.freeze({provider,generationId,root:owned,validate(){directory(provider);safeTree(owned);}});
 }
 return Object.freeze({
  createGeneration(provider) {
   const dir=directory(provider),generationId=crypto.randomUUID(),owned=path.join(dir,generationId);
   fs.mkdirSync(owned,{mode:0o700});writeJsonAtomic(path.join(owned,'.owned.json'),{version:1,provider,generationId});
   return readGeneration(provider,generationId);
  },
  current(provider) {
   const dir=directory(provider),file=path.join(dir,'current.json');if(!fs.existsSync(file))return null;
   if(fs.lstatSync(file).isSymbolicLink()||!fs.lstatSync(file).isFile())invalid();
   const pointer=readJsonFile(file,{maxBytes:4096});
   if(pointer.version!==1 || !validId(pointer.attemptId) || !Number.isSafeInteger(pointer.epoch))invalid();
   return readGeneration(provider,pointer.generationId);
  },
  promote({provider,generationId,attemptId,expectedEpoch,lease,exitConfirmed,cancelled}) {
   if(!validId(attemptId)||exitConfirmed!==true||cancelled!==false||lease?.kind!=='auth'||lease?.provider!==provider||connectionLeases.epoch(provider)!==expectedEpoch)invalid();
   lease.assertCurrent();const profile=readGeneration(provider,generationId);profile.validate();
   writeJsonAtomic(path.join(directory(provider),'current.json'),{version:1,generationId,attemptId,epoch:expectedEpoch+1});
   lease.advance();return profile;
  }
 });
}
