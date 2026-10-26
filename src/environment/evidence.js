import fs from 'node:fs';
import path from 'node:path';
import {writeJsonAtomic,readJsonFile,writeTextAtomic} from '../storage/json-file.js';
import {validateBinding,sha256,environmentError,summarizeResults} from './contracts.js';
import {assertOwnedPath,verifyFile,hashFile} from './paths.js';

export function createEvidenceStore({root}) {
  const directory=binding=>assertOwnedPath(root,validateBinding(binding,{allowExpired:true}).runId);
  async function save({binding,report,files=[]}) {
    const dir=directory(binding); const limits=binding.limits;
    if(!Array.isArray(files) || files.some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[0-9a-f]{64}$/.test(f.sha256 || ''))) throw environmentError('ENV_SCHEMA_INVALID','Evidence requires exact size and hash');
    if(files.length+3>limits.maxEvidenceFiles || files.reduce((n,f)=>n+f.bytes,0)>limits.maxEvidenceBytes) throw environmentError('ENV_ARTIFACT_TOO_LARGE','Evidence exceeds quota');
    const destinations=files.map(f=>assertOwnedPath(dir,f.path));
    if(sha256(report.binding)!==sha256(binding)) throw environmentError('ENV_EVIDENCE_BINDING','Report binding differs');
    if(summarizeResults(report.checks)!==report.status) throw environmentError('ENV_RESULT_INVALID','Report summary differs');
    if(new Set(destinations.map(p=>p.toLowerCase())).size!==files.length || files.some(f=>['report.json','report.md','manifest.json'].includes(f.path.toLowerCase()))) throw environmentError('ENV_PATH_DENIED','Duplicate or reserved evidence path');
    const reportText=JSON.stringify(report,null,2)+'\n';
    const markdown=`# Environment test report\n\nStatus: ${report.status}\n\nLayer: ${report.layer}\n\nRun: ${binding.runId}\n`;
    const manifest=files.map(f=>({path:f.path,sha256:f.sha256,bytes:f.bytes}));
    for(const [name,text] of [['report.json',reportText],['report.md',markdown]])manifest.push({path:name,sha256:sha256(text),bytes:Buffer.byteLength(text)});
    const data={version:1,binding,files:manifest},manifestBytes=Buffer.byteLength(JSON.stringify(data,null,2))+1;
    if(manifest.reduce((n,f)=>n+f.bytes,0)+manifestBytes>limits.maxEvidenceBytes)throw environmentError('ENV_ARTIFACT_TOO_LARGE','Evidence including exact metadata exceeds quota');
    fs.mkdirSync(dir,{recursive:true});
    for(let i=0;i<files.length;i++) {
      const f=files[i]; await verifyFile(f.source,{...f,maxBytes:limits.maxEvidenceBytes});
      fs.mkdirSync(path.dirname(destinations[i]),{recursive:true}); fs.copyFileSync(f.source,destinations[i],fs.constants.COPYFILE_EXCL);
      await verifyFile(destinations[i],{...f,maxBytes:limits.maxEvidenceBytes});
    }
    writeJsonAtomic(path.join(dir,'report.json'),report);
    writeTextAtomic(path.join(dir,'report.md'),markdown);
    writeJsonAtomic(path.join(dir,'manifest.json'),data);
    return {runId:binding.runId,bindingDigest:sha256(binding),manifestHash:await hashFile(path.join(dir,'manifest.json'))};
  }
  async function verify(receipt,binding) {
    if(receipt.runId!==binding.runId || receipt.bindingDigest!==sha256(binding)) throw environmentError('ENV_EVIDENCE_BINDING','Evidence belongs to a different execution');
    const dir=directory(binding); await verifyFile(assertOwnedPath(dir,'manifest.json',{mustExist:true}),{sha256:receipt.manifestHash});
    const data=readJsonFile(path.join(dir,'manifest.json'));
    if(sha256(data.binding)!==sha256(binding)) throw environmentError('ENV_EVIDENCE_BINDING','Manifest binding differs');
    if(!Array.isArray(data.files)||data.files.length+1>binding.limits.maxEvidenceFiles||data.files.some(f=>!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[0-9a-f]{64}$/.test(f.sha256 || ''))) throw environmentError('ENV_SCHEMA_INVALID','Invalid evidence manifest');
    if(data.files.reduce((n,f)=>n+f.bytes,0)+fs.statSync(path.join(dir,'manifest.json')).size>binding.limits.maxEvidenceBytes)throw environmentError('ENV_ARTIFACT_TOO_LARGE','Evidence total exceeds quota');
    for(const f of data.files) await verifyFile(assertOwnedPath(dir,f.path,{mustExist:true}),{...f,maxBytes:binding.limits.maxEvidenceBytes});
    return {...receipt,verified:true};
  }
  return {directory,save,verify};
}
