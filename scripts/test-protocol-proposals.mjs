import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {createProposalValidator, validateProposalFixtures, readProposalJson} from './lib/protocol-proposals.mjs';
import {EXTENSION_TYPES, PERMISSIONS} from '../src/extension/types.js';
import {assertManifest} from '../src/extension/manifest.js';
import {MEMORY_TYPES, MEMORY_SOURCES, SCOPE_KINDS} from '../src/memory/types.js';

const {validate, schemas} = createProposalValidator();
const fixture = name => JSON.parse(fs.readFileSync(new URL('../contracts/fixtures/' + name + '.json', import.meta.url)));
const composition = () => fixture('plugin-composition.valid');
const check = (schema, value, expected) => {
  const before = structuredClone(value);
  const result = validate(schema, value);
  assert.equal(result.ok, expected, JSON.stringify(result.errors));
  assert.deepEqual(value, before, 'validation must not coerce, remove fields or mutate input');
  return result;
};
const rejectComposition = (mutate, code) => {
  const data = composition(); mutate(data);
  const result = check('plugin-composition', data, false);
  if (code) assert.ok(result.errors.some(error => error.code === code), JSON.stringify(result.errors));
};

const summary = validateProposalFixtures();
assert.equal(summary.failed, 0, JSON.stringify(summary.results));
assert.equal(summary.total, 26, 'all supplied positive and negative vectors must run');
assert.equal(Object.keys(schemas).length, 10);

const envelope = fixture('core-envelope.valid');
check('core-envelope', {...envelope, timestamp: '2026-02-31T25:00:00Z'}, false);
check('core-envelope', {...envelope, principal: {kind: 'owner'}}, false);
check('core-envelope', {...envelope, protocolVersion: '2.0'}, false);
assert.throws(() => validate('../../outside', {}), {code: 'UNKNOWN_PROPOSAL_SCHEMA'});
assert.throws(() => validate('core-envelope', {payload: 'a'.repeat(1048576)}), {code: 'PROPOSAL_INPUT_LIMIT'});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-proposal-read-'));
try {
  const file=path.join(temp,'input.json');
  fs.writeFileSync(file,'{}');assert.deepEqual(readProposalJson(file),{});
  fs.writeFileSync(file,Buffer.alloc(1048577,32));
  assert.throws(()=>readProposalJson(file),{code:'PROPOSAL_INPUT_LIMIT'});
  fs.writeFileSync(file,Buffer.from([0xff,0xfe]));
  assert.throws(()=>readProposalJson(file),TypeError);
  fs.writeFileSync(file,'{"unclosed":');assert.throws(()=>readProposalJson(file),SyntaxError);
  assert.throws(()=>readProposalJson(temp),{code:'PROPOSAL_INPUT_LIMIT'});
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(temp,{recursive:true,force:true});
}
for (const field of ['actor','grants','approvalId','operationId','taskId','workspaceId']) {
  check('plugin-interop-intent', {...fixture('plugin-interop-intent.valid'), [field]: 'forged'}, false);
}
check('plugin-event-subscription', {...fixture('plugin-event-subscription.valid'), grants: ['*']}, false);
check('memory-reference', {...fixture('memory-reference.valid'), scope: {kind: 'workspace', id: null}}, false);
assert.deepEqual(schemas['memory-reference'].properties.type.enum, [...MEMORY_TYPES]);
assert.deepEqual(schemas['memory-reference'].properties.source.enum, [...MEMORY_SOURCES]);
assert.deepEqual(schemas['memory-reference'].properties.scope.properties.kind.enum, [...SCOPE_KINDS]);

rejectComposition(c => {c.components[0].key = 'root';}, 'RESERVED_COMPONENT_KEY');
rejectComposition(c => {c.components[0].parent = c.components[0].key;}, 'SELF_PARENT');
rejectComposition(c => {c.components[0].pluginId = c.rootPlugin;}, 'ROOT_AS_CHILD');
for (const badPath of ['..','components/..','components/.','components/CON','components/aux.txt','components/name.']) {
  rejectComposition(c => {c.components[0].packagePath = badPath;});
}
rejectComposition(c => {c.components[1].packagePath = 'components/not-owned';}, 'EMBEDDED_ESCAPED_PARENT');
rejectComposition(c => {
  const copy = structuredClone(c.components[0]); copy.key = 'alias'; copy.packagePath = copy.packagePath.toUpperCase(); c.components.push(copy);
}, 'PACKAGE_PATH_COLLISION');
rejectComposition(c => {
  const copy = structuredClone(c.components[0]); copy.key = 'overlap'; copy.packagePath += '/unowned'; c.components.push(copy);
}, 'PACKAGE_PATH_OVERLAP');
rejectComposition(c => {c.bindings.push({...c.bindings[0], from: c.bindings[0].to, to: c.bindings[0].to});}, 'SELF_BINDING');
for(const suffix of ['', '-run', '_run', 'prefix.'+'a'.repeat(75)]) {
  rejectComposition(c=>{c.bindings[0].targetCapability='extension.'+c.components[0].pluginId+'.'+suffix;}, 'BINDING_CAPABILITY_INVALID');
}
rejectComposition(c=>{
  const [a]=c.components;
  c.components.push({key:'ambiguous',parent:'root',pluginId:a.pluginId+'.child',version:'1.0.0',mode:'external',required:false});
  c.bindings[0].targetCapability='extension.'+a.pluginId+'.child.run';
}, 'AMBIGUOUS_BINDING_TARGET');
rejectComposition(c=>{
  const [a]=c.components;
  c.rootPlugin=a.pluginId+'.child';
  c.bindings[0].targetCapability='extension.'+a.pluginId+'.child.run';
}, 'AMBIGUOUS_BINDING_TARGET');
rejectComposition(c => {
  c.bindings.push({from: c.components[0].key, to: 'missing', targetCapability: 'extension.cetamesh.missing.run', dataClass: 'public', purpose: 'fixture'});
}, 'UNKNOWN_BINDING_TARGET');
rejectComposition(c => {
  const [a,b] = c.components;
  c.bindings.push({from:a.key,to:b.key,targetCapability:'extension.'+b.pluginId+'.run',dataClass:'public',purpose:'fixture'});
  c.bindings.push({from:b.key,to:a.key,targetCapability:'extension.'+a.pluginId+'.run',dataClass:'public',purpose:'fixture'});
}, 'BINDING_CYCLE');
rejectComposition(c => {c.components = Array.from({length:9}, (_,i) => ({key:'child'+i,parent:'root',pluginId:'fixture.child'+i,version:'1.0.0',mode:'external',required:false})); c.bindings=[];}, 'FANOUT_LIMIT');
const chain = count => ({compositionVersion:1,rootPlugin:'fixture.root',rootVersion:'1.0.0',bindings:[],components:Array.from({length:count},(_,i)=>({key:'child'+i,parent:i?'child'+(i-1):'root',pluginId:'fixture.child'+i,version:'1.0.0',mode:'embedded',packagePath:Array.from({length:i+1},(_,j)=>'child'+j).join('/'),sha256:'a'.repeat(64),required:true}))});
check('plugin-composition', chain(4), true); // root + four children = five levels
check('plugin-composition', chain(5), false);
const tree = chain(1); tree.components = Array.from({length:31},(_,i)=>({key:'node'+i,parent:i<8?'root':'node'+Math.floor((i-8)/8),pluginId:'fixture.node'+i,version:'1.0.0',mode:'external',required:false}));
check('plugin-composition', tree, true);
check('plugin-composition', {...tree,components:[...tree.components,{...tree.components[0],key:'extra'}]}, false);
const catalog = JSON.parse(fs.readFileSync(new URL('../docs/protocol/plugin-categories.v1.json', import.meta.url)));
check('plugin-categories', catalog, true);
assert.deepEqual(catalog, fixture('plugin-categories.valid'));
const swapped = structuredClone(catalog); [swapped.categories[0],swapped.categories[1]]=[swapped.categories[1],swapped.categories[0]];
check('plugin-categories', swapped, false);

// Execute the current production parser: category tags and sidecars confer no v1 permissions.
assert.equal(EXTENSION_TYPES.length, 7);
for (const key of ['shell','native','download','process']) assert.equal(PERMISSIONS[key].risk, 'forbidden');
const legacy = JSON.parse(fs.readFileSync(new URL('../extensions/cetamesh-hello-tool/extension.json', import.meta.url)));
const parsed = assertManifest(legacy);
assert.deepEqual(assertManifest({...legacy, composition:composition(), categories:['agent-os'], actor:{kind:'owner'}}), parsed);
assert.throws(() => assertManifest({...legacy,type:'agent-os'}), {code:'INVALID_EXTENSION_TYPE'});
assert.throws(() => assertManifest({...legacy,manifestVersion:2}), {code:'UNSUPPORTED_MANIFEST_VERSION'});

// Imported documentation must lead to real owners, not names inferred from proposals.
const repo=fileURLToPath(new URL('../',import.meta.url));
for(const name of fs.readdirSync(path.join(repo,'docs/protocol')).filter(n=>n.endsWith('.md'))) {
  const file=path.join(repo,'docs/protocol',name),body=fs.readFileSync(file,'utf8');
  for(const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    if(/^(https?:|mailto:|#)/i.test(match[1])) continue;
    const relative=match[1].split('#')[0];
    const target=path.resolve(path.dirname(file),relative);
    assert.ok(target.startsWith(repo), 'protocol link escapes repository');
    assert.ok(fs.existsSync(target), name+' -> '+relative);
  }
  if(['CP-020-EXTENSION.md','CP-025-PLUGIN-SDK-DEVELOPMENT.md'].includes(name)) {
    const examples=[...body.matchAll(/```json\s+([\s\S]*?)```/g)].map(m=>JSON.parse(m[1]));
    assert.ok(examples.length>0);
    for(const example of examples) assert.equal(assertManifest(example).manifestVersion,1);
  }
}
const cli=fileURLToPath(new URL('./validate-protocol-proposals.mjs',import.meta.url));
for(const [args,exit] of [
  [[],0],
  [['plugin-composition',path.join(repo,'contracts/fixtures/plugin-composition.valid.json')],0],
  [['plugin-composition',path.join(repo,'contracts/fixtures/plugin-composition.invalid-cycle.json')],1],
  [['../../outside',path.join(repo,'contracts/fixtures/plugin-composition.valid.json')],1],
  [['extra'],2]
]) {
  const child=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(child.status,exit,child.stderr+child.stdout);
}
console.log('PASS: 26 draft vectors, graph/security boundaries and current Manifest/Memory contracts; no runtime installation or authorization claims.');
