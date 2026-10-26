import {createNativeAcpRuntime} from '../native-acp-runtime.js';
import {createAcpProcessLauncher} from '../acp-provider-descriptors.js';
import {createClaudeRuntimeVerifier} from '../claude-runtime.js';
import {agentProviderError as fault} from '../agent-provider.js';
import {createGeminiAuthAdapter} from './gemini.js';
import {createOpenCodeAuthAdapter} from './opencode.js';
import {createClaudeAuthAdapter} from './claude.js';
// Constructing adapters does not discover, inspect, authenticate or launch.
export function createProviderAuthAdapters({configuration,resourceRoot}={}) {
 const native=id=>{
  const detector=createNativeAcpRuntime({id,runtimeConfiguration:configuration,launchFactory:createAcpProcessLauncher});
  return async ownership=>{const evidence=await detector.inspect(ownership);return {...evidence,validate:evidence.validateRuntime};};
 };
 const verifier=createClaudeRuntimeVerifier({resourceRoot});
 return Object.freeze({gemini:createGeminiAuthAdapter({runtime:native('gemini')}),
  opencode:createOpenCodeAuthAdapter({configuration,runtime:native('opencode')}),
  claude:createClaudeAuthAdapter({runtime:async ownership=>{
   const identity=configuration.identity('claude'),config=configuration.get('claude'),evidence=await verifier.inspect(config.runtimePath,ownership);
   return {...evidence,async validate(){const checked=await verifier.inspect(configuration.get('claude').runtimePath,ownership);
    if(configuration.identity('claude')!==identity||checked.binaryHash!==evidence.binaryHash||checked.sdkHash!==evidence.sdkHash||checked.version!==evidence.version||checked.reason)throw fault('AGENT_RUNTIME_CHANGED','Claude runtime changed before authentication');
   }};
  }})});
}
