import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { OWNER_ACTOR } from '../src/capability/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-integration-'));
let schema = {type:'object',properties:{query:{type:'string',minLength:1,maxLength:40},count:{type:'integer',minimum:1,maximum:5}},required:['query'],additionalProperties:false};
let calls = [];
let nextInput;
let nextCapability;
let sent = false;
const services = createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:path.join(root,'data'),
  integrationTransportFactory: () => ({
    onClose() {},
    async listTools() { return ['web_search','web_fetch'].map(name => ({name,inputSchema:structuredClone(schema)})); },
    async callTool(name,input) { calls.push({name,input}); return {content:[{type:'text',text:'fixture target result'}]}; },
    async close() {}
  })});
try {
  services.modelRegistry.register({id:'comm-model',label:'COMM model fixture',defaultModel:'fixture',supportsTools:true,
    health:async()=>({available:true,configured:true}),listModels:async()=>[{id:'fixture'}],chat:async()=>({text:'done'}),
    stream:async function*() {
      if (!sent) { sent=true; yield {type:'assistant/tool-calls',data:{toolCalls:[{id:'call',capabilityId:nextCapability,arguments:JSON.stringify(nextInput)}]}}; }
      else yield {type:'assistant/message',data:{message:{content:[{type:'text',text:'done'}]}}};
      yield {type:'turn/end',data:{reason:{kind:'completed'}}};
    }});
  services.providerSecrets.set({provider:'comm-model',apiKey:'synthetic-not-a-real-key'});
  await services.integrationService.execute({method:'mcp.start',params:{id:'web-search-safe',approved:true}});
  let turn=0;
  async function model(input, capability='integration.tool.write') {
    nextInput=input; nextCapability=capability; sent=false;
    const entry=services.capabilityService.broker.registry.require(capability);
    return services.toolExecutionCoordinator.run({providerId:'comm-model',model:'fixture',actor:OWNER_ACTOR,
      sessionId:'fixture-session',turnId:'turn-'+(++turn),manifest:[{id:entry.id,description:entry.description,inputSchema:entry.inputSchema}],messages:[]});
  }
  const toolId='mcp__web-search-safe__web_search';
  const success=await model({toolId,input:{query:'fixture'}});
  assert.equal(calls.length,1,'legitimate nested input must reach registered MCP target');
  assert.equal(success.status,'completed');
  console.log('PASS COMM03 production model entry forwards validated nested target input');
  for (const input of [{toolId,input:{}},{toolId,input:{query:5}},{toolId,input:{query:'x'.repeat(41)}},
    {toolId,input:{query:'x',unknown:true}},{toolId,input:{query:'x',count:6}},
    {toolId,input:{query:'x',actor:{kind:'owner'}}},{toolId,input:{query:'x'},approved:true},
    {toolId:'missing',input:{query:'x'}},{toolId,input:null},
    {toolId,input:Object.fromEntries(Array.from({length:65},(_,i)=>['key'+i,i]))}]) {
    const before=calls.length;
    const denied=await model(input);
    assert.equal(calls.length,before);
    assert.ok(denied.messages.some(m=>m.role==='tool' && /INVALID|OVERRIDE|UNKNOWN_TOOL/.test(m.content)));
  }
  console.log('PASS COMM03 unknown, missing, wrong type, limits, authority and wrapper overrides denied');
  const before=calls.length;
  await model({toolId:'mcp__web-search-safe__web_fetch',input:{query:'fixture'}},'integration.tool.read');
  assert.equal(calls.length,before,'read wrapper cannot dispatch admin target');
  assert.equal(services.capabilityService.broker.approvals.list().length,0);
  console.log('PASS COMM03 target capability mismatch denied before approval');
  const invalidAdmin=await model({toolId:'mcp__web-search-safe__web_fetch',input:{}},'integration.tool.admin');
  assert.notEqual(invalidAdmin.status,'pending');
  assert.equal(services.capabilityService.broker.approvals.list().length,0,'invalid target input must never create approval');
  const pending=await model({toolId:'mcp__web-search-safe__web_fetch',input:{query:'fixture'}},'integration.tool.admin');
  assert.equal(pending.status,'pending');
  const row=services.capabilityService.broker.approvals.get(pending.approvalId);
  assert.equal(typeof row.request.integrationBinding.schemaHash,'string');
  assert.equal(typeof row.request.integrationBinding.inputHash,'string');
  // Restart changes discovered schema without changing the valid input or capability.
  schema={...schema,properties:{...schema.properties,extra:{type:'boolean'}}};
  await services.integrationService.execute({method:'mcp.restart',params:{id:'web-search-safe',approved:true}});
  await assert.rejects(services.capabilityService.broker.decide({id:pending.approvalId,approve:true,actor:OWNER_ACTOR}),{code:'TOOL_SCHEMA_CHANGED'});
  assert.equal(calls.length,before);
  console.log('PASS COMM03 approval binds target input and discovered schema version; changes block dispatch');
  const validPending=await model({toolId:'mcp__web-search-safe__web_fetch',input:{query:'fixture'}},'integration.tool.admin');
  const approvedRequest=services.capabilityService.broker.approvals.get(validPending.approvalId).request;
  await assert.rejects(services.capabilityService.broker.execute({...approvedRequest,approvalId:validPending.approvalId,
    input:{...approvedRequest.input,input:{query:'changed'}}}),{code:'APPROVAL_MISMATCH'});
  assert.equal(calls.length,before);
  const completed=await services.capabilityService.broker.decide({id:validPending.approvalId,approve:true,actor:OWNER_ACTOR});
  assert.equal(completed.status,'completed');
  assert.equal(calls.length,before+1);
  console.log('PASS COMM03 changed approval input rejected; unchanged approval executes target once');
} finally {
  await services.integrationService.close();
  fs.rmSync(root,{recursive:true,force:true});
}
