import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Prepare an independent local runtime; never overwrite the user's original package.
export function prepareAgentOsRuntime({source,output}){
 source=fs.realpathSync(source);output=path.resolve(output);
 if(fs.existsSync(output)||output===source||output.startsWith(source+path.sep))throw Error('A fresh output directory outside the source is required.');
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'agentos.system.json'),'utf8'));
 if(manifest.id!=='org.cetamesh.agentos'||manifest.version!=='2.0.0'||manifest.managed?.protocol!=='cetamesh.agentos.managed.v1')throw Error('Only the reviewed AgentOS 2.0.0 managed package is supported.');
 const backend=fs.readFileSync(path.join(source,'server','backends','docker.js'),'utf8');
 const old="      await dockerRunOk([binary(), 'pull', image], { timeoutMs: 900_000 });";
 if(backend.split(old).length!==2)throw Error('Docker backend changed; review compatibility before preparing it.');
 const entries=['agentos.system.json','package.json','server','contracts','catalog','vendor'];
 function check(file){const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('Linked runtime entries are unsupported.');if(stat.isDirectory())for(const name of fs.readdirSync(file))check(path.join(file,name));}
 for(const entry of entries)if(fs.existsSync(path.join(source,entry)))check(path.join(source,entry));
 fs.mkdirSync(output,{recursive:true});
 for(const entry of entries)if(fs.existsSync(path.join(source,entry)))fs.cpSync(path.join(source,entry),path.join(output,entry),{recursive:true,errorOnExist:true,force:false});
 fs.writeFileSync(path.join(output,'server','backends','docker.js'),backend.replace(old,
  "      // Reuse a locally available image; do not contact a registry for it.\n      const local = await dockerRun([binary(), 'image', 'inspect', image], { timeoutMs: 30_000 });\n      if (local.code !== 0) await dockerRunOk([binary(), 'pull', image], { timeoutMs: 900_000 });"));
 fs.writeFileSync(path.join(output,'cetamesh-adaptation.json'),JSON.stringify({version:1,sourceVersion:'2.0.0',changes:['docker-reuse-existing-image-before-pull'],managedProtocol:manifest.managed.protocol},null,2));
 return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [source,output]=process.argv.slice(2);if(!source||!output)throw Error('Usage: prepare-runtime.mjs <existing-package> <new-output-directory>');
 console.log(prepareAgentOsRuntime({source,output}));
}
