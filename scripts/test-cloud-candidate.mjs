import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-cloud-candidate-'));
try{
 const mod=await import('./ci-candidate.mjs');
 const sha='a'.repeat(40),meta=mod.candidateMetadata({productVersion:'1.0.0-rc.2',buildNumber:1124,channel:'dev',commit:sha});
 assert.match(meta.artifactName,/^cetamesh-desktop-windows-x64-dev-1.0.0-rc.2-aaaaaaaaaaaa$/);assert.match(meta.setup,/^CetaMesh-Setup-/);
 const digest=x=>crypto.createHash('sha256').update(x).digest('hex');fs.mkdirSync(path.join(root,'licenses'));fs.writeFileSync(path.join(root,'licenses','THIRD-PARTY.md'),'fixture licenses');
 const body='SYNTHETIC_NON_EXECUTABLE_CANDIDATE';fs.writeFileSync(path.join(root,meta.setup),body);fs.writeFileSync(path.join(root,'sbom.json'),'{}');
 const manifest={product:'CetaMesh',version:'1.0.0-rc.2',channel:'dev',buildNumber:1124,sourceCommit:sha,entry:meta.setup,files:{[meta.setup]:digest(body)}};
 fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(root,'SHA256SUMS.txt'),[meta.setup,'sbom.json','release-manifest.json','licenses/THIRD-PARTY.md'].map(p=>digest(fs.readFileSync(path.join(root,p)))+'  '+p).join('\n'));
 assert.equal(mod.verifyCandidate(root,{commit:sha,channel:'dev'}).entry,meta.setup);
 fs.appendFileSync(path.join(root,meta.setup),'tamper');assert.throws(()=>mod.verifyCandidate(root,{commit:sha,channel:'dev'}),/hash|integrity/i);
 fs.writeFileSync(path.join(root,meta.setup),body);assert.throws(()=>mod.verifyCandidate(root,{commit:'b'.repeat(40),channel:'dev'}),/source|commit/i);
 manifest.entry='WhaleBridge-Setup.exe';fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify(manifest));assert.throws(()=>mod.verifyCandidate(root,{commit:sha,channel:'dev'}),/brand|CetaMesh/i);
 const workflow=fs.readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');assert.ok(!workflow.includes('name: whalebridge-rc'));assert.match(workflow,/build_candidate:/);assert.match(workflow,/if:.*workflow_dispatch/);assert.match(workflow,/if: always\(\)/);assert.match(workflow,/ci-candidate.mjs --verify/);assert.ok(!workflow.includes('sync-gitcode-release'));
 const installer=fs.readFileSync(new URL('./package-installer.mjs',import.meta.url),'utf8');assert.ok(!installer.includes("let outputName = 'WhaleBridge-Setup-x64.exe'"));
 console.log('PASS synthetic candidate metadata, CetaMesh brand, hash/source conflict rejection and manual cloud workflow contract; no product binary executed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
