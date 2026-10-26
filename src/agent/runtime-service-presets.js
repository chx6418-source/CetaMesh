// Public endpoint metadata only: no inferred model, key or account compatibility.
export const RUNTIME_SERVICE_PRESETS = Object.freeze([
  {id:'gemini-official',label:'Google Gemini API',baseUrl:'https://generativelanguage.googleapis.com',providers:['gemini']},
  {id:'anthropic-official',label:'Anthropic API',baseUrl:'https://api.anthropic.com',providers:['claude']},
  {id:'openai',label:'OpenAI-compatible API · OpenAI',baseUrl:'https://api.openai.com/v1',providers:['opencode','qwen']},
  {id:'dashscope-cn',label:'阿里云百炼（中国）',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',providers:['opencode','qwen']},
  {id:'dashscope-intl',label:'Alibaba Cloud Model Studio（国际）',baseUrl:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',providers:['opencode','qwen']},
  {id:'custom',label:'自定义 API 服务',baseUrl:null,providers:['gemini','opencode','qwen','claude']}
].map(row=>Object.freeze({...row,providers:Object.freeze(row.providers)})));
export const runtimeServicePresets = provider => RUNTIME_SERVICE_PRESETS.filter(row=>row.providers.includes(provider));
export const presetForEndpoint = (provider,baseUrl) => runtimeServicePresets(provider).find(row=>row.baseUrl===baseUrl)?.id ?? 'custom';
// Source-verified identifiers, not native acceptance. Every account route remains
// disabled in runtime-auth-capabilities until the Windows contract is reviewed.
export const OPENCODE_LOGIN_SELECTIONS = Object.freeze([
  Object.freeze({providerId:'openai',methodId:'chatgpt-headless',label:'OpenAI · Codex device code (legacy)'}),
  Object.freeze({providerId:'openai',methodId:'chatgpt-browser',label:'OpenAI · Codex browser (legacy)'})
]);
