/** Simulation assets are content, never security principals. */
export const SIMULATION_LIMITS=Object.freeze({rooms:100,rolesPerRoom:12,messagesPerRoom:1000,requestsPerRoom:1000,tasksPerRoom:64,storeBytes:16*1024*1024,messageChars:16000,outputChars:32000,contextChars:24000,activeCalls:4});
export const SIMULATION_SCENES=Object.freeze([
 {id:'free',name:'自由聊天',description:'角色按兴趣参与日常交流，也可保持沉默。'},
 {id:'brainstorm',name:'头脑风暴',description:'共同提出想法、比较方案并保留待验证假设。'},
 {id:'product',name:'产品需求',description:'澄清用户、范围、约束与验收标准。'},
 {id:'project',name:'项目开发团队',description:'讨论形成建议；真实执行与交付由项目任务独立验证。'},
 {id:'review',name:'代码审查与诊断',description:'分析证据、风险、复现方法与待验证修复。'}
]);
export const simulationError=(code,message=code)=>Object.assign(new Error(message),{code});
export const localId=value=>typeof value==='string'&&/^[A-Za-z0-9._:@-]{1,128}$/.test(value);
export function boundedText(value,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||/[\x00]/.test(value)||(!empty&&!value.trim()))throw simulationError('SIMULATION_INPUT_INVALID');return value.trim();}
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function normalizeBudget(input={},previous={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw simulationError('SIMULATION_BUDGET_INVALID','预算必须是有效的参数对象。请展开高级预算检查。');
 const b={maxTurns:6,maxOutputTokens:768,maxTotalTokens:65536,maxDurationMs:120000,maxModelCalls:60,maxCost:null,pricing:null,...previous};
 for(const key of Object.keys(b))if(Object.hasOwn(input,key))b[key]=input[key];
 for(const[key,min,max,label]of [['maxTurns',1,6,'最多发言数'],['maxOutputTokens',1,4096,'每次输出 tokens'],['maxTotalTokens',1,1000000,'总 tokens 上限'],['maxDurationMs',10,600000,'最长运行时长（毫秒）'],['maxModelCalls',1,1000,'最多模型调用']]){
  if(!integer(b[key],min,max))throw simulationError('SIMULATION_BUDGET_INVALID',`${label}须为 ${min} 至 ${max} 的整数。`);
 }
 if(b.maxCost!==null&&!number(b.maxCost))throw simulationError('SIMULATION_BUDGET_INVALID','费用上限须为空或有限的非负数。');
 if(b.pricing!==null){const p=b.pricing;if(!p||typeof p!=='object'||!localId(p.providerId)||!(typeof p.model==='string'&&p.model.trim()&&p.model.length<=300&&!/[\x00-\x1f]/.test(p.model))||!(/^[A-Z]{3}$/).test(p.currency??'')||!['source','version'].every(k=>typeof p[k]==='string'&&p[k].trim()&&p[k].length<=300&&!/[\x00-\x1f]/.test(p[k]))||!['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion'].every(k=>number(p[k])))throw simulationError('SIMULATION_BUDGET_INVALID','模型价格信息不完整或格式无效。请填写模型服务、模型、币种、价格来源、版本和四项非负价格，或取消价格确认。');b.pricing=Object.fromEntries(['providerId','model','currency','source','version','inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion'].map(k=>[k,p[k]]));}
 return b;
}
export function initialUsage(){return {modelCalls:0,completedCalls:0,inputTokens:0,outputTokens:0,reservedTokens:0,reservedCost:0,accounting:'complete',cost:{status:'unknown',amount:null,knownAmount:0,currency:null},unknownCalls:0};}
