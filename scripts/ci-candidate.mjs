import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {loadReleaseVersion,formatArtifactName,releaseArtifactDirectory} from '../src/release/version.js';
export function candidateMetadata({productVersion,buildNumber,channel,commit}){
 if(!['dev','rc'].includes(channel)||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(productVersion)||!Number.isSafeInteger(buildNumber)||buildNumber<0||!/^[a-f0-9]{40,64}$/.test(commit))throw Error('Invalid candidate source metadata');
 return {artifactName:`cetamesh-desktop-windows-x64-${channel}-${productVersion}-${commit.slice(0,12)}`,setup:formatArtifactName({productVersion,buildNumber,platform:'windows-x64'})};
}
export function verifyCandidate(directory,{commit,channel}){
 const base=fs.realpathSync(directory),read=rel=>{
  if(typeof rel!=='string'||!rel||path.isAbsolute(rel)||rel.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('Invalid candidate path');
  let current=base;for(const part of rel.split(/[\\/]/)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Linked candidate path');}
  return fs.readFileSync(current);
 };
 const manifest=JSON.parse(read('release-manifest.json'));
 const meta=candidateMetadata({productVersion:manifest.version,buildNumber:manifest.buildNumber,channel:manifest.channel,commit:manifest.sourceCommit});
 if(manifest.product!=='CetaMesh'||manifest.entry!==meta.setup||/WhaleBridge/i.test(manifest.entry))throw Error('CetaMesh outer brand required');
 if(manifest.sourceCommit!==commit||manifest.channel!==channel)throw Error('Candidate source commit/channel mismatch');
 const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
 const sums=new Map(read('SHA256SUMS.txt').toString('utf8').trim().split(/\r?\n/).map(line=>{const m=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!m)throw Error('Invalid candidate hash manifest');return [m[2],m[1]];}));
 for(const file of [meta.setup,'release-manifest.json','sbom.json','licenses/THIRD-PARTY.md'])if(!sums.has(file))throw Error('Missing candidate hash entry');
 for(const [file,expected]of sums)if(hash(read(file))!==expected)throw Error('Candidate hash integrity mismatch');
 for(const [file,expected]of Object.entries(manifest.files??{}))if(hash(read(file))!==expected)throw Error('Candidate manifest hash mismatch');
 JSON.parse(read('sbom.json'));return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),args=process.argv.slice(2),channel=args[args.indexOf('--channel')+1]||'dev';
 const commit=process.env.GITHUB_SHA;
 const release=loadReleaseVersion({rootDir:root}),meta=candidateMetadata({...release,channel,commit});
 const directory=releaseArtifactDirectory({rootDir:root,...release,channel});
 if(args.includes('--verify')){verifyCandidate(directory,{commit,channel});console.log('PASS candidate structure, hashes and source; security/native acceptance remain HOLD');}
 else {const outputs={...meta,directory};if(process.env.GITHUB_OUTPUT)for(const [k,v]of Object.entries(outputs))fs.appendFileSync(process.env.GITHUB_OUTPUT,`${k}=${v}\n`);console.log(JSON.stringify(outputs));}
}
