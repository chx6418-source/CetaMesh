import assert from 'node:assert/strict';
import { defineModelProvider, createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider } from '../src/model/index.js';
const profile = { status: 'declared', contextWindowTokens: 1000, maxOutputTokens: 200, defaultOutputTokens: 100, source: 'fixture-capacity-v1', version: 'fixture-1' };
const calls = [];
function runtime(capabilities = profile, counter = null) {
 const provider = defineModelProvider({ id:'fixture', label:'fixture', defaultModel:'fixture', supportsTools:true,
  contextCapabilities: () => capabilities, countInputTokens:counter,
  methods:{listModels:async()=>[],chat:async o=>{calls.push(o);return {text:'ok'};},stream:async function*(o){calls.push(o);yield {type:'turn/end',data:{}};}} });
 return createModelRuntimeService({registry:createModelProviderRegistry({providers:[provider]}),secrets:{list:()=>[{provider:'fixture'}]}});
}
const messages=[{role:'user',content:'x'.repeat(1100)}];
const rt=runtime();
await assert.rejects(rt.chat({messages}), {code:'MODEL_CONTEXT_BUDGET_EXCEEDED'});
await assert.rejects(async()=>{for await(const ignored of rt.stream({messages})){}}, {code:'MODEL_CONTEXT_BUDGET_EXCEEDED'});
assert.equal(calls.length,0,'overflow rejected before provider execution');
const request={messages:[{role:'user',content:'hi'},{role:'assistant',tool_calls:[{id:'native-1',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'native-1',content:'evidence'}]};
const original=JSON.stringify(request);
const result=await rt.chat(request);
assert.equal(result.contextBudget.counting,'estimated');
assert.equal(result.contextBudget.reservedOutputTokens,100);
assert.equal(calls.at(-1).maxOutputTokens,100);
assert.equal(JSON.stringify(request),original);
assert.equal(calls.at(-1).messages,request.messages);
for await (const ignored of rt.stream(request)) {}
assert.equal(calls.at(-1).maxOutputTokens,100);
assert.equal(calls.at(-1).messages,request.messages);
const exact=runtime(profile,()=>({tokens:30,exact:true,tokenizer:'fixture-v1'}));
assert.equal(exact.contextBudget(null,null,request).counting,'exact');
assert.equal(exact.contextBudget(null,null,request).inputTokens,30);
const unknown=runtime({status:'unknown'});
assert.equal((await unknown.chat({messages})).contextBudget.status,'unknown');
assert.equal(calls.at(-1).maxOutputTokens,undefined);
await assert.rejects(rt.chat({...request,maxOutputTokens:201}),{code:'MODEL_CONTEXT_BUDGET_INVALID'});
await assert.rejects(rt.chat({...request,tools:[{name:'huge',description:'a'.repeat(1100)}]}),{code:'MODEL_CONTEXT_BUDGET_EXCEEDED'});
await assert.rejects(rt.chat({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'fixture'}}]}]}),{code:'MODEL_CONTEXT_COUNT_UNAVAILABLE'});
await assert.rejects(runtime({...profile,contextWindowTokens:NaN}).chat(request),{code:'MODEL_CONTEXT_BUDGET_INVALID'});
await assert.rejects(runtime(profile,()=>({tokens:30,exact:false})).chat(request),{code:'MODEL_CONTEXT_BUDGET_INVALID'});
const bodies=[];
let endpoint='https://api.openai.com/v1';
const provider=createOpenAiCompatibleModelProvider({id:'openai',label:'OpenAI',baseUrl:endpoint,defaultModel:'gpt-4o-mini',secrets:{raw:()=>({apiKey:'fixture',baseUrl:endpoint})},fetchImpl:async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}));}});
const official=createModelRuntimeService({registry:createModelProviderRegistry({providers:[provider]}),secrets:{list:()=>[{provider:'openai'}]}});
assert.equal(official.contextBudget(null,null,request).contextWindowTokens,128000);
await official.chat({messages:[{role:'user',content:'hello'}],maxOutputTokens:123});
assert.equal(bodies.at(-1).max_tokens,123);
await assert.rejects(official.chat({messages:[{role:'user',content:'x'.repeat(128000)}]}),{code:'MODEL_CONTEXT_BUDGET_EXCEEDED'});
assert.equal(bodies.length,1);
endpoint='https://custom.example/v1';
assert.equal(official.contextBudget(null,null,request).status,'unknown');
assert.equal(provider.contextCapabilities('gpt-5').status,'unknown');
console.log('PASS model context budget: overflow chat/stream, exact/estimated/unknown, framing/tools/output, native IDs, endpoint isolation');

for (const invalidProfile of [{source:''},{source:'   '},{version:''},{version:null}]) {
 await assert.rejects(runtime({...profile,...invalidProfile}).chat(request),{code:'MODEL_CONTEXT_BUDGET_INVALID'});
}
function configured(outputTokenParameter) {
 const profiles={'o3':{...profile,baseUrl:'https://api.openai.com/v1',outputTokenParameter}};
 const p=createOpenAiCompatibleModelProvider({id:'openai',label:'OpenAI',baseUrl:'https://api.openai.com/v1',defaultModel:'o3',contextProfiles:profiles,secrets:{raw:()=>({apiKey:'fixture'})},fetchImpl:async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}));}});
 return createModelRuntimeService({registry:createModelProviderRegistry({providers:[p]}),secrets:{list:()=>[{provider:'openai'}]}});
}
await assert.rejects(configured('max_tokens').chat({messages:[{role:'user',content:'hi'}]}),{code:'MODEL_CONTEXT_BUDGET_INVALID'});
await configured('max_completion_tokens').chat({messages:[{role:'user',content:'hi'}]});
assert.equal(bodies.at(-1).max_completion_tokens,100);
assert.equal(bodies.at(-1).max_tokens,undefined);
console.log('PASS model context profiles: provenance version/source validation and reasoning output compatibility');
