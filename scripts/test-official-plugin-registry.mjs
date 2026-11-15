import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {normalizeCatalog} from '../src/plugin-center/catalog.js';
import {createPluginCenterService} from '../src/plugin-center/service.js';
import {createLocalEngineService} from '../src/plugin-center/local-engines.js';
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-official-registry-')));
const catalogUrl='https://registry.example.test/api/v1/plugins',origin=new URL(catalogUrl).origin;
const bytes=Buffer.from(zipSync({
 'plugin/agentos.system.json':strToU8(JSON.stringify({id:'org.cetamesh.agentos',name:'AgentOS',version:'2.0.0',managed:{protocol:'cetamesh.agentos.managed.v1',entry:'server/managed/stdio.mjs'}})),
 'plugin/package.json':strToU8('{"type":"module"}'),
 'plugin/server/managed/stdio.mjs':strToU8('throw Error("catalog review must not execute a plugin");'),
 'plugin/catalog/images.json':strToU8('{}'),
 'plugin/contracts/agentos-managed-v1.json':new Uint8Array(fs.readFileSync(new URL('../src/agentos/managed-v1.json',import.meta.url)))
}));
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const latest={version:'2.0.0',compatibility:{cetamesh:'>=0.1.0'},permissions:['network','filesystem.read','filesystem.write','shell','tasks'],filename:'agentos-2.0.0.zip',filesize:bytes.length,sha256,publishedAt:'2026-11-12T13:02:40.638Z',downloadAuthorization:'/api/v1/plugins/agentos/versions/2.0.0/download'};
const raw={registry:'CetaMesh Official Plugin Registry',version:'v1',signingAvailable:true,plugins:[{id:'agentos',name:'AgentOS',description:'Actual registry contract',author:'Fixture author',category:'general',featured:true,status:'published',latest}]};
const normalized=normalizeCatalog(raw,{catalogUrl});
assert.equal(normalized.plugins[0].name,'AgentOS');assert.equal(normalized.plugins[0].distribution.kind,'lighthouse-v1');
assert.equal(normalized.plugins[0].verified,false,'HTTPS/digest is not a publisher signature');
assert.deepEqual(normalizeCatalog(normalized,{catalogUrl}),normalized,'offline cache preserves signed-download metadata');
assert.throws(()=>normalizeCatalog({...raw,plugins:[{...raw.plugins[0],latest:{...latest,downloadAuthorization:'https://other.example.test/download'}}]},{catalogUrl}),{code:'CATALOG_URL_HOST_NOT_ALLOWED'});
const owner={kind:'owner',id:'fixture'},engines=createLocalEngineService({stateDir:path.join(base,'state')});
const requests=[];let failure=null;
const fetchImpl=async(url,options)=>{
 requests.push({url,options});assert.equal(options.redirect,'error');
 if(url===catalogUrl)return Response.json(raw);
 if(url===origin+latest.downloadAuthorization){
  assert.equal(options.method,'POST');assert.equal(options.headers.origin,origin);
  return Response.json({ok:true,plugin:'agentos',version:'2.0.0',filename:latest.filename,filesize:bytes.length,sha256,
   expiresInSeconds:600,url:failure==='foreign-url'?'https://other.example.test/plugin.zip':`/plugins/packages/agentos/2.0.0/${latest.filename}?expires=9999999999&signature=fixture`,...(failure==='wrong-version'?{version:'2.1.0'}:{})});
 }
 assert.ok(url.startsWith(origin+'/plugins/packages/agentos/2.0.0/'+latest.filename+'?'));
 if(failure==='403')return new Response('Forbidden',{status:403});
 return new Response(failure==='hash'?Buffer.alloc(bytes.length):bytes,{headers:{'content-length':String(bytes.length)}});
};
const service=createPluginCenterService({stateDir:path.join(base,'state'),catalogUrl,currentVersion:'1.1.0-rc.2',fetchImpl,localEngineService:engines});
try {
 const list=await service.execute({method:'plugin-center.catalog.list'});assert.equal(list.available,true);assert.equal(list.plugins[0].id,'agentos');
 const staged=await service.execute({method:'plugin-center.package.stage',params:{id:'agentos'}});
 const review=staged.externalPackageReview;assert.equal(review.id,'agentos');assert.equal(review.sourceSha256,sha256);
 assert.deepEqual((await engines.execute({actor:owner,method:'engines.list'})).engines,[],'download and review do not install, launch or grant a plugin');
 await engines.execute({actor:owner,method:'engines.package.cancel',params:{token:review.token}});
 for(const [kind,code] of [['foreign-url','PLUGIN_DOWNLOAD_AUTHORIZATION_INVALID'],['wrong-version','PLUGIN_DOWNLOAD_AUTHORIZATION_INVALID'],['hash','PACKAGE_SHA256_MISMATCH'],['403','PLUGIN_DOWNLOAD_FORBIDDEN']]){
  failure=kind;const before=requests.length;
  await assert.rejects(service.execute({method:'plugin-center.package.stage',params:{id:'agentos'}}),{code});
  if(['foreign-url','wrong-version'].includes(kind))assert.equal(requests.length-before,2,'mismatched authorization cannot trigger a package request');
 }
 assert.equal(requests.some(row=>row.url.startsWith('https://other.example.test')),false);
 console.log('PASS real Registry v1 shape, offline metadata, exact POST/download identity, external ZIP review, SHA refusal and actionable server 403');
}finally{service.close();await engines.close();fs.rmSync(base,{recursive:true,force:true});}
