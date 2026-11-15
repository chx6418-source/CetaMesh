// Produce installable external ZIPs from separately supplied, already built runtimes.
// Never download dependencies or copy these third-party assets into product source.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {Zip,ZipDeflate} from 'fflate';
import {loadEngineAssets} from '../src/reverselab/engine-assets.js';

export async function packageLocalPlugin({id,source,output,node,nodeLicense,license}){
 if(!['agentos','reverselab'].includes(id))throw Error('Choose agentos or reverselab.');
 source=await fsp.realpath(source);output=path.resolve(output);
 if(fs.existsSync(output)||output.startsWith(source+path.sep))throw Error('Choose a fresh output outside the runtime directory.');
 const files=[];
 async function walk(directory,relative=''){
  for(const entry of await fsp.readdir(directory,{withFileTypes:true})){
   const full=path.join(directory,entry.name),name=relative?relative+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink()||await fsp.realpath(full)!==full)throw Error('Linked package files are unsupported.');
   if(entry.isDirectory())await walk(full,name);else if(entry.isFile())files.push({name,full});else throw Error('Special package files are unsupported.');
  }
 }
 if(id==='agentos'){
  const manifest=JSON.parse(await fsp.readFile(path.join(source,'agentos.system.json'),'utf8'));
  if(manifest.id!=='org.cetamesh.agentos'||manifest.managed?.protocol!=='cetamesh.agentos.managed.v1')throw Error('Prepared AgentOS managed runtime required.');
  await walk(source);
  if(!node||!nodeLicense)throw Error('Supply the existing Node binary and its license; installation needs no separate Node setup.');
  files.push({name:'runtime/'+(process.platform==='win32'?'node.exe':'node'),full:await fsp.realpath(node)});
 }else{
  const lock=JSON.parse(await fsp.readFile(path.join(source,'engine.lock.json'),'utf8'));
  await loadEngineAssets({root:path.join(source,'engine'),manifestSha256:lock.manifestSha256});
  await walk(source);
 }
 if(nodeLicense)files.push({name:'Node-LICENSE.txt',full:await fsp.realpath(nodeLicense)});
 if(license&&!files.some(row=>/^license(?:\.|$)/i.test(row.name)))files.push({name:'LICENSE',full:await fsp.realpath(license)});
 if(files.length>20000||new Set(files.map(row=>row.name.toLowerCase())).size!==files.length)throw Error('Duplicate or excessive package files.');
 await fsp.mkdir(path.dirname(output),{recursive:true});const fd=fs.openSync(output,'wx',0o600),hash=crypto.createHash('sha256');let bytes=0,finished=false,failure;
 const zip=new Zip((cause,data,final)=>{if(cause){failure=cause;return;}hash.update(data);bytes+=data.length;let offset=0;while(offset<data.length)offset+=fs.writeSync(fd,data,offset,data.length-offset);if(final)finished=true;});
 try{
  for(const file of files){
   const entry=new ZipDeflate(file.name,{level:3});zip.add(entry);
   for await(const data of fs.createReadStream(file.full,{highWaterMark:128*1024})){entry.push(data,false);if(failure)throw failure;await yieldIO();}
   entry.push(new Uint8Array(),true);
  }
  zip.end();if(failure)throw failure;if(!finished)throw Error('ZIP completion was not acknowledged.');
 }finally{fs.closeSync(fd);}
 return {id,file:output,files:files.length,bytes,sha256:hash.digest('hex')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const[id,source,output,node,nodeLicense,license]=process.argv.slice(2);
 console.log(JSON.stringify(await packageLocalPlugin({id,source,output,node:node==='-'?null:node,nodeLicense,license}),null,2));
}
