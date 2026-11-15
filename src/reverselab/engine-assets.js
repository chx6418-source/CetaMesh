import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseJsonText} from '../storage/json-file.js';

export const reverseLabError=(code,message)=>Object.assign(new Error(message),{code});
export const sha256=data=>crypto.createHash('sha256').update(data).digest('hex');
export async function loadEngineAssets({root,manifestSha256}={}, {signal}={}){
  const manifestFile=path.join(String(root??''),'engine-manifest.json');
  if(!root||!fs.existsSync(manifestFile))throw reverseLabError('REVERSELAB_ENGINE_MISSING','Install the pinned ReverseLab engine assets.');
  const fail=()=>{throw reverseLabError('REVERSELAB_ENGINE_IDENTITY','ReverseLab engine assets differ from the approved lock.');};
  signal?.throwIfAborted();
  if((await fsp.stat(manifestFile)).size>4*1024*1024)fail();
  const manifestBytes=await fsp.readFile(manifestFile,{signal});
  if(!/^[a-f0-9]{64}$/.test(manifestSha256??'')||sha256(manifestBytes)!==manifestSha256)fail();
  const manifest=parseJsonText(manifestBytes.toString('utf8'),{file:manifestFile}),realRoot=await fsp.realpath(root);
  if(manifest.schemaVersion!==1||manifest.engine?.name!=='rea-agents'||manifest.engine?.version!=='6.8.0'
    ||!Array.isArray(manifest.files)||manifest.files.length<2)fail();
  const files=new Map();
  for(const item of manifest.files){
    if(typeof item.path!=='string'||!item.path||item.path.includes('\\')||item.path.includes(':')
      ||item.path.split('/').some(p=>!p||p==='.'||p==='..')||files.has(item.path))fail();
    const absolute=path.join(realRoot,...item.path.split('/'));
    files.set(item.path,absolute);
  }
  if(!files.has(manifest.node)||!files.has(manifest.entry))fail();
  async function verifyFile(item){
    signal?.throwIfAborted();const absolute=files.get(item.path);
    try{
      const [stat,resolved]=await Promise.all([fsp.lstat(absolute),fsp.realpath(absolute)]);
      if(!stat.isFile()||stat.isSymbolicLink()||resolved!==absolute||stat.size!==item.bytes)fail();
      const digest=crypto.createHash('sha256');
      for await(const chunk of fs.createReadStream(absolute,{highWaterMark:256*1024,signal}))digest.update(chunk);
      if(digest.digest('hex')!==item.sha256)fail();
    }catch(error){signal?.throwIfAborted();if(error.code==='REVERSELAB_ENGINE_IDENTITY')throw error;fail();}
  }
  // Bounded asynchronous I/O keeps the Core event loop responsive, including the large Node executable.
  for(let offset=0;offset<manifest.files.length;offset+=8)await Promise.all(manifest.files.slice(offset,offset+8).map(verifyFile));
  async function rejectUnlisted(dir,relative=''){
    signal?.throwIfAborted();
    for(const item of await fsp.readdir(dir,{withFileTypes:true})){
      const rel=relative?relative+'/'+item.name:item.name;
      if(item.isSymbolicLink())fail();
      if(item.isDirectory())await rejectUnlisted(path.join(dir,item.name),rel);
      else if(!item.isFile()||(rel!=='engine-manifest.json'&&!files.has(rel)))fail();
    }
  }
  await rejectUnlisted(realRoot);
  return {root:realRoot,nodePath:files.get(manifest.node),entryPath:files.get(manifest.entry),version:manifest.engine.version,
    assetDigest:manifestSha256,nodeVersion:manifest.nodeVersion};
}
