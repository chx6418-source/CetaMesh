import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeJsonAtomic,readJsonFile} from '../../src/storage/json-file.js';
import {sha256,reverseLabError} from '../../src/reverselab/engine-assets.js';

// Build-time only. No dependency install or download is performed by this packager.
export function packageEngine({reaRoot,nodePath,outputRoot,nodeLicensePath}){
  if(fs.existsSync(outputRoot))throw reverseLabError('REVERSELAB_OUTPUT_EXISTS','Choose a fresh engine output directory.');
  const pkg=readJsonFile(path.join(reaRoot,'package.json'));
  if(pkg.name!=='rea-agents'||pkg.version!=='6.8.0')throw Error('Expected original REA 6.8.0');
  const nodeVersion=spawnSync(nodePath,['--version'],{encoding:'utf8',windowsHide:true});
  if(nodeVersion.status!==0||nodeVersion.stdout.trim()!=='v24.22.1')throw Error('Expected private Node 24.22.1');
  const nodeNotices=fs.readFileSync(nodeLicensePath,'utf8');
  if(!nodeNotices.includes('Node.js')||!nodeNotices.includes('Permission is hereby granted'))throw Error('Node redistribution notices are unavailable.');
  const lock=readJsonFile(path.join(reaRoot,'package-lock.json'));
  fs.mkdirSync(path.join(outputRoot,'rea'),{recursive:true});
  for(const relative of [...pkg.files,'package.json','package-lock.json']){
    const source=path.join(reaRoot,relative);
    if(!fs.existsSync(source))throw Error('Missing declared REA runtime asset: '+relative);
    fs.cpSync(source,path.join(outputRoot,'rea',relative),{recursive:true,dereference:true});
  }
  for(const [relative,entry] of Object.entries(lock.packages)){
    if(!relative.startsWith('node_modules/')||entry.dev===true)continue;
    const source=path.join(reaRoot,relative);
    if(!fs.existsSync(source)){if(entry.optional)continue;throw Error('Missing runtime dependency: '+relative);}
    fs.cpSync(source,path.join(outputRoot,'rea',relative),{recursive:true,dereference:true});
  }
  fs.mkdirSync(path.join(outputRoot,'runtime'));
  const nodeRelative=process.platform==='win32'?'runtime/node.exe':'runtime/node';
  fs.copyFileSync(nodePath,path.join(outputRoot,nodeRelative));
  fs.writeFileSync(path.join(outputRoot,'runtime','LICENSE'),nodeNotices);
  const files=[];
  function walk(dir,relative=''){
    for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){
      const rel=relative?relative+'/'+item.name:item.name,full=path.join(dir,item.name);
      if(item.isDirectory())walk(full,rel);
      else if(item.isFile()){const bytes=fs.readFileSync(full);files.push({path:rel,bytes:bytes.length,sha256:sha256(bytes)});}
      else throw Error('Non-regular runtime file: '+rel);
    }
  }
  walk(outputRoot);
  const manifest={schemaVersion:1,engine:{name:pkg.name,version:pkg.version},nodeVersion:'24.22.1',node:nodeRelative,
    entry:'rea/scripts/rea.mjs',sourceArchiveSha256:'4dfacaabd8350b68fccef543c90747e461263dda852e4166e1582cb03a0eedcb',files};
  const manifestPath=path.join(outputRoot,'engine-manifest.json');writeJsonAtomic(manifestPath,manifest);
  const manifestSha256=sha256(fs.readFileSync(manifestPath));
  const result={schemaVersion:1,version:'6.8.0',manifestSha256};
  writeJsonAtomic(path.join(path.dirname(outputRoot),'engine.lock.json'),result);
  return {...result,root:outputRoot,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0)};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [reaRoot,nodePath,outputRoot,nodeLicensePath]=process.argv.slice(2).map(p=>path.resolve(p));
  console.log(JSON.stringify(packageEngine({reaRoot,nodePath,outputRoot,nodeLicensePath})));
}
