// Development-only validation of reviewed PROPOSED DTOs. Never imported by Core/Host.
// A valid sidecar is data, not an install plan, grant, trusted identity or health proof.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const contracts = new URL('../../contracts/', import.meta.url);
export const PROPOSAL_SCHEMAS = Object.freeze(['core-envelope','core-error','agent-descriptor',
  'plugin-interop-intent','memory-reference','health-result','plugin-categories',
  'plugin-composition','plugin-event-subscription','plugin-capability-binding']);
export const CATEGORY_IDS = Object.freeze(['agent-tool','agent-skill','agent-memory','agent-knowledge',
  'agent-workflow','agent-service','agent-connector','agent-model','agent-device','agent-automation',
  'agent-team','agent-identity','agent-ui','agent-guard','agent-inspector','agent-app','agent-os']);
const fail = code => {throw Object.assign(new Error(code), {code});};
const maxBytes = 1048576;

export function readProposalJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('PROPOSAL_INPUT_LIMIT');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {
    const opened=fs.fstatSync(fd);
    if(!opened.isFile()||opened.size>maxBytes) fail('PROPOSAL_INPUT_LIMIT');
    // A file growing after stat must not turn a bounded CLI read into readFileSync's unbounded allocation.
    const buffer=Buffer.alloc(maxBytes+1);let used=0;
    while(used<buffer.length) {
      const count=fs.readSync(fd,buffer,used,buffer.length-used,null);
      if(count===0) break;
      used+=count;
    }
    if(used>maxBytes) fail('PROPOSAL_INPUT_LIMIT');
    const after=fs.fstatSync(fd);
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs) fail('PROPOSAL_INPUT_CHANGED');
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0,used)));
  } finally {fs.closeSync(fd);}
}

function boundInput(data) {
  const pending = [[data,0]], seen = new Set(); let nodes=0, bytes=0;
  while (pending.length) {
    const [value,depth] = pending.pop();
    if (++nodes > 50000 || depth > 40) fail('PROPOSAL_INPUT_LIMIT');
    if (value && typeof value === 'object') {
      if (seen.has(value)) fail('PROPOSAL_INPUT_NOT_JSON');
      seen.add(value);
      const entries=Object.entries(value);
      if(entries.length>50000) fail('PROPOSAL_INPUT_LIMIT');
      for (const [key,child] of entries) {bytes+=Buffer.byteLength(key); pending.push([child,depth+1]);}
    } else if (typeof value === 'string') bytes+=Buffer.byteLength(value);
    else if (value!==null && !['boolean','number'].includes(typeof value)) fail('PROPOSAL_INPUT_NOT_JSON');
    if (bytes > maxBytes) fail('PROPOSAL_INPUT_LIMIT');
  }
}

function validateComposition(c) {
  const index=new Map(), paths=new Map(), children=new Map();
  for (const v of c.components) {
    if(v.key==='root') fail('RESERVED_COMPONENT_KEY');
    if(index.has(v.key)) fail('DUPLICATE_COMPONENT_KEY');
    index.set(v.key,v);
  }
  for (const v of c.components) {
    if(v.key===v.parent) fail('SELF_PARENT');
    if(v.parent!=='root'&&!index.has(v.parent)) fail('MISSING_PARENT');
    const count=(children.get(v.parent)||0)+1; children.set(v.parent,count);
    if(count>8) fail('FANOUT_LIMIT');
    if(v.pluginId===c.rootPlugin) fail('ROOT_AS_CHILD');
    if(v.mode==='embedded') {
      const segments=v.packagePath.split('/');
      if(segments.some(s=>s==='.'||s==='..'||s.endsWith('.')||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) fail('UNSAFE_PACKAGE_PATH');
      const canonical=v.packagePath.toLowerCase();
      if(paths.has(canonical)) fail('PACKAGE_PATH_COLLISION');
      paths.set(canonical,v.key);
      if(v.parent!=='root') {
        const parent=index.get(v.parent);
        if(parent.mode!=='embedded') fail('EMBEDDED_UNDER_EXTERNAL');
        if(!canonical.startsWith(parent.packagePath.toLowerCase()+'/')) fail('EMBEDDED_ESCAPED_PARENT');
      }
    }
  }
  const ancestors=new Map();
  for(const v of c.components) {
    let cur=v.key,levels=1;const seen=new Set();
    while(cur!=='root') {
      if(seen.has(cur)) fail('COMPOSITION_CYCLE');
      seen.add(cur);cur=index.get(cur).parent;
      if(++levels>5) fail('NESTING_DEPTH_LIMIT');
    }
    ancestors.set(v.key,seen);
  }
  // Physical containment must follow the declared parent graph, including Windows aliases.
  for(const [a,keyA] of paths) for(const [b,keyB] of paths) {
    if(a!==b&&b.startsWith(a+'/')&&!ancestors.get(keyB).has(keyA)) fail('PACKAGE_PATH_OVERLAP');
  }
  const edges=new Map();
  for(const edge of c.bindings) {
    if(edge.from!=='root'&&!index.has(edge.from)) fail('UNKNOWN_BINDING_SOURCE');
    if(!index.has(edge.to)) fail('UNKNOWN_BINDING_TARGET');
    if(edge.from===edge.to) fail('SELF_BINDING');
    const targetId=index.get(edge.to).pluginId,prefix='extension.'+targetId+'.';
    if(!edge.targetCapability.startsWith(prefix)) fail('BINDING_TARGET_ID_MISMATCH');
    const localId=edge.targetCapability.slice(prefix.length);
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(localId)) fail('BINDING_CAPABILITY_INVALID');
    // Both plugin IDs and capability names permit dots. No registry is available here:
    // reject competing declared namespaces rather than guessing which plugin owns a name.
    const candidates=new Set([c.rootPlugin,...c.components.map(v=>v.pluginId)]);
    if([...candidates].some(id=>id!==targetId&&edge.targetCapability.startsWith('extension.'+id+'.')))
      fail('AMBIGUOUS_BINDING_TARGET');
    if(!edges.has(edge.from)) edges.set(edge.from,[]);
    edges.get(edge.from).push(edge.to);
  }
  const visiting=new Set(),done=new Set();
  function visit(key) {
    if(visiting.has(key)) fail('BINDING_CYCLE');
    if(done.has(key)) return;
    visiting.add(key);
    for(const next of edges.get(key)||[]) visit(next);
    visiting.delete(key);done.add(key);
  }
  for(const key of edges.keys()) visit(key);
}

export function createProposalValidator() {
  // Compile only repository-owned schemas. No loadSchema/network resolver or schema from plugins.
  const ajv = new Ajv2020({allErrors:true,strict:true,strictRequired:false});
  addFormats(ajv);
  const schemas={},validators=new Map();
  for(const name of PROPOSAL_SCHEMAS) {
    const schema=readProposalJson(new URL('schemas/'+name+'.schema.json',contracts));
    schemas[name]=schema; validators.set(name,ajv.compile(schema));
  }
  return {schemas,validate(name,data) {
    if(!validators.has(name)) fail('UNKNOWN_PROPOSAL_SCHEMA');
    boundInput(data);
    const validator=validators.get(name);
    if(!validator(data)) return {ok:false,errors:validator.errors.slice(0,20).map(e=>({code:'SCHEMA_INVALID',path:e.instancePath,rule:e.keyword}))};
    try {
      if(name==='plugin-composition') validateComposition(data);
      if(name==='plugin-categories'&&data.categories.map(x=>x.id).join('|')!==CATEGORY_IDS.join('|')) fail('TAXONOMY_ID_OR_ORDER_MISMATCH');
      return {ok:true,errors:[]};
    } catch(e) {return {ok:false,errors:[{code:e.code||'PROPOSAL_INVALID'}]};}
  }};
}

export function validateProposalFixtures() {
  const {validate}=createProposalValidator();
  const manifest=readProposalJson(new URL('fixtures/fixture-manifest.json',contracts));
  const seen=new Set(); const results=[];
  for(const item of manifest.fixtures) {
    if(!/^[a-z0-9][a-z0-9.-]+\.json$/.test(item.file)||seen.has(item.file)||!['PASS','FAIL'].includes(item.expected)) fail('FIXTURE_MANIFEST_INVALID');
    seen.add(item.file);
    const outcome=validate(item.schema,readProposalJson(new URL('fixtures/'+item.file,contracts)));
    results.push({file:item.file,expected:item.expected,actual:outcome.ok?'PASS':'FAIL',matched:outcome.ok===(item.expected==='PASS')});
  }
  const files=fs.readdirSync(fileURLToPath(new URL('fixtures/',contracts))).filter(n=>n.endsWith('.json')&&n!=='fixture-manifest.json');
  if(files.length!==seen.size||files.some(n=>!seen.has(n))) fail('UNREGISTERED_PROPOSAL_FIXTURE');
  return {total:results.length,failed:results.filter(r=>!r.matched).length,results};
}
