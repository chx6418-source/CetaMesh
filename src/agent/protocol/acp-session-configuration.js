import {agentProviderError as fault} from '../agent-provider.js';

// Only controls observed in the pinned native providers are exposed. ACP modes
// and arbitrary vendor options may change permissions and are never forwarded.
const CONTROL_IDS = Object.freeze({opencode:{model:'model',reasoning:'effort'},qwen:{model:'model'}});
const bounded = value => typeof value==='string' && value.length>0 && value.length<=256 && !/[\u0000-\u001f\u007f]/.test(value);
export function acpSessionConfiguration(provider, options) {
  const ids=CONTROL_IDS[provider];
  const control={status:'unsupported',source:'acp-session',application:'requires-new-session',
    selection:{model:null,reasoningEffort:null},model:{options:[]},reasoning:{options:[]}};
  if(!ids || options===undefined) return control;
  if(!Array.isArray(options) || options.length>64)throw fault('ACP_CONFIGURATION_INVALID','Invalid ACP session configuration');
  for(const [key,id] of Object.entries(ids)) {
    const matching=options.filter(item=>item?.id===id);
    if(!matching.length)continue;
    const option=matching[0],category=key==='model'?'model':'thought_level';
    if(matching.length!==1 || option.category!==category || option.type!=='select' || !bounded(option.currentValue)
      || !Array.isArray(option.options) || option.options.length>256)throw fault('ACP_CONFIGURATION_INVALID','Invalid ACP model control');
    const values=option.options.flatMap(item=>Array.isArray(item?.options)?item.options:[item]);
    if(values.length>256 || values.some(item=>!bounded(item?.value)||item.value.length>(key==='model'?160:40)||!bounded(item?.name))
      || new Set(values.map(item=>item.value)).size!==values.length || !values.some(item=>item.value===option.currentValue))
      throw fault('ACP_CONFIGURATION_INVALID','Invalid ACP model options');
    control[key]={configId:id,options:values.map(item=>({value:item.value,label:item.name}))};
    control.selection[key==='model'?'model':'reasoningEffort']=option.currentValue;
  }
  if(control.model.options.length){control.status='available';control.application='runtime-confirmed';}
  return control;
}
