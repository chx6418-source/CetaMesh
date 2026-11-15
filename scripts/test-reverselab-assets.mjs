import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {writeJsonAtomic} from '../src/storage/json-file.js';
import {loadEngineAssets} from '../src/reverselab/engine-assets.js';

// Catches an unpinned, incomplete or tampered package being admitted for execution.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverselab-assets-'));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const manifest={schemaVersion:1,engine:{name:'rea-agents',version:'6.8.0'},nodeVersion:'24.22.1',
  node:'runtime/node.exe',entry:'rea/scripts/rea.mjs',files:[]};
function seal(){writeJsonAtomic(path.join(root,'engine-manifest.json'),manifest);return sha(fs.readFileSync(path.join(root,'engine-manifest.json')));}
try{
  await assert.rejects(loadEngineAssets({root,manifestSha256:'0'.repeat(64)}),{code:'REVERSELAB_ENGINE_MISSING'});
  fs.mkdirSync(path.join(root,'runtime'));
  fs.mkdirSync(path.join(root,'rea','scripts'),{recursive:true});
  for(const [relative,data] of [['runtime/node.exe','test-only-package-bytes'],['rea/scripts/rea.mjs','// no execution in package validation test']]){
    fs.writeFileSync(path.join(root,relative),data);manifest.files.push({path:relative,bytes:Buffer.byteLength(data),sha256:sha(data)});
  }
  const trusted=seal();
  await assert.rejects(loadEngineAssets({root,manifestSha256:'0'.repeat(64)}),{code:'REVERSELAB_ENGINE_IDENTITY'});
  assert.equal((await loadEngineAssets({root,manifestSha256:trusted})).version,'6.8.0');
  const readAgain=fs.readFileSync;
  fs.readFileSync=(file,...args)=>String(file)===path.join(root,'engine-manifest.json')
    ?JSON.stringify({...manifest,engine:{name:'rea-agents',version:'9.9.9'}}):readAgain(file,...args);
  try{assert.equal((await loadEngineAssets({root,manifestSha256:trusted})).version,'6.8.0','Parse the exact bytes covered by the approved SHA, not a replacement second read');}
  finally{fs.readFileSync=readAgain;}
  const extra=path.join(root,'rea','scripts','unreviewed-module.js');fs.writeFileSync(extra,'// unexpected executable module');
  await assert.rejects(loadEngineAssets({root,manifestSha256:trusted}),{code:'REVERSELAB_ENGINE_IDENTITY'},'An unlisted module cannot join the fixed engine');
  fs.unlinkSync(extra);
  fs.appendFileSync(path.join(root,'rea','scripts','rea.mjs'),'tampered');
  await assert.rejects(loadEngineAssets({root,manifestSha256:trusted}),{code:'REVERSELAB_ENGINE_IDENTITY'});
  const changed=fs.readFileSync(path.join(root,'rea','scripts','rea.mjs'));manifest.files[1].bytes=changed.length;manifest.files[1].sha256=sha(changed);seal();
  await assert.rejects(loadEngineAssets({root,manifestSha256:trusted}),{code:'REVERSELAB_ENGINE_IDENTITY'},'Changing files and their manifest together must not bypass the external lock');
  manifest.files[1].path='../outside';
  await assert.rejects(loadEngineAssets({root,manifestSha256:seal()}),{code:'REVERSELAB_ENGINE_IDENTITY'});
  console.log('PASS ReverseLab assets require pinned manifest, contained paths and unchanged complete file bytes');
}finally{fs.rmSync(root,{recursive:true,force:true});}
