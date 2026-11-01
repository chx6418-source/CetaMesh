/** Simulation assets are content, never security principals. */
export const SIMULATION_LIMITS=Object.freeze({rooms:100,rolesPerRoom:12,messagesPerRoom:1000,requestsPerRoom:1000,tasksPerRoom:64,storeBytes:16*1024*1024,messageChars:16000,outputChars:32000,contextChars:24000,activeCalls:4});
export const SIMULATION_SCENES=Object.freeze([
 {id:'free',name:'自由聊天',description:'角色按兴趣参与日常交流，也可保持沉默。'},
 {id:'brainstorm',name:'头脑风暴',description:'共同提出想法、比较方案并保留待验证假设。'},
 {id:'product',name:'产品需求',description:'澄清用户、范围、约束与验收标准。'},
 {id:'project',name:'项目开发团队',description:'讨论形成建议；真实执行与交付由项目任务独立验证。'},
 {id:'review',name:'代码审查与诊断',description:'分析证据、风险、复现方法与待验证修复。'}
]);
export const simulationError=code=>Object.assign(new Error(code),{code});
export const localId=value=>typeof value==='string'&&/^[A-Za-z0-9._:@-]{1,128}$/.test(value);
export function boundedText(value,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||/[\x00]/.test(value)||(!empty&&!value.trim()))throw simulationError('SIMULATION_INPUT_INVALID');return value.trim();}
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function normalizeBudget(input={},previous={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw simulationError('SIMULATION_BUDGET_INVALID');
 const b={maxTurns:6,maxOutputTokens:768,maxTotalTokens:65536,maxDurationMs:120000,maxModelCalls:60,maxCost:null,pricing:null,...previous};
 for(const key of Object.keys(b))if(Object.hasOwn(input,key))b[key]=input[key];
 if(!integer(b.maxTurns,1,6)||!integer(b.maxOutputTokens,1,4096)||!integer(b.maxTotalTokens,1,1000000)||!integer(b.maxDurationMs,10,600000)||!integer(b.maxModelCalls,1,1000)||(b.maxCost!==null&&!number(b.maxCost)))throw simulationError('SIMULATION_BUDGET_INVALID');
 if(b.pricing!==null){const p=b.pricing;if(!p||typeof p!=='object'||!localId(p.providerId)||!(typeof p.model==='string'&&p.model.trim()&&p.model.length<=300&&!/[\x00-\x1f]/.test(p.model))||!(/^[A-Z]{3}$/).test(p.currency??'')||!['source','version'].every(k=>typeof p[k]==='string'&&p[k].trim()&&p[k].length<=300&&!/[\x00-\x1f]/.test(p[k]))||!['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion'].every(k=>number(p[k])))throw simulationError('SIMULATION_BUDGET_INVALID');b.pricing=Object.fromEntries(['providerId','model','currency','source','version','inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion'].map(k=>[k,p[k]]));}
 return b;
}
export function initialUsage(){return {modelCalls:0,completedCalls:0,inputTokens:0,outputTokens:0,reservedTokens:0,reservedCost:0,accounting:'complete',cost:{status:'unknown',amount:null,knownAmount:0,currency:null},unknownCalls:0};}
