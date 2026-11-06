import {runtimeServicePresets,OPENCODE_LOGIN_SELECTIONS} from './runtime-service-presets.js';
// This catalog is not derived from untrusted ACP auth-method advertisements.
// Native account routes are deliberately release-gated until Windows profile,
// process ownership and pinned policy contracts have passed. No renderer flag,
// environment variable or saved configuration can switch this gate on.
const ACCOUNT_METHODS = Object.freeze({
  gemini: { id: 'oauth-personal', label: 'Google 官方账号登录', reason: 'gemini_auth_status_unverified', documentation: 'https://geminicli.com/docs/get-started/authentication/' },
  opencode: { label: '模型服务官方登录', reason: 'windows_auth_contract_unverified', documentation: 'https://opencode.ai/v2/docs/cli/auth/' },
  claude: { id: 'claude-subscription', label: 'Claude 订阅账号登录', reason: 'windows_auth_contract_unverified', documentation: 'https://code.claude.com/docs/en/cli-reference' }
});
export function describeRuntimeAuth({provider, runtimeEvidence = {}} = {}) {
  if (!['gemini','qwen','opencode','claude'].includes(provider)) throw new TypeError('Unsupported Agent runtime provider');
  const method = ACCOUNT_METHODS[provider];
  // Pinned 2.1.4 Console policies are applied after the isolated system policy,
  // and its guarded Console loader can supply MCP and provider packages. The
  // actual no-prompt native probe reproduced both local deny overrides. Do not
  // infer compatibility from newer documentation or weaken the existing policy.
  // https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/managed-policy.ts
  const nativeAccountReason=provider==='opencode'&&runtimeEvidence.compatible===true&&runtimeEvidence.version==='opencode v2.1.4'
    ? 'opencode_native_policy_override_unsupported' : method?.reason ?? 'qwen_oauth_discontinued';
  return { servicePresets:runtimeServicePresets(provider).map(({id,label,baseUrl})=>({id,label,baseUrl})),providerSelections:provider==='opencode'?OPENCODE_LOGIN_SELECTIONS:[], methods: [{id:'api-key',label:'API Key',supported:true,reason:null},
    ...(provider==='opencode'?OPENCODE_LOGIN_SELECTIONS.map(selection=>({id:selection.methodId,label:selection.label,supported:false,reason:'windows_auth_contract_unverified'})):method ? [{...method,supported:false}] : [])],
    accountReason: nativeAccountReason,
    nativeCliSupported: provider==='claude' && runtimeEvidence.version==='2.1.308' && runtimeEvidence.binaryVerified===true && runtimeEvidence.sdkResourcesVerified===true,
    modelRequired: provider !== 'claude' || !(runtimeEvidence.compatible === true && runtimeEvidence.binaryVerified === true && runtimeEvidence.sdkResourcesVerified === true) };
}
export function runtimeConnectionEvidence({provider, runtimeEvidence = {}, configuration = {}, taskEligible = false, reason = null} = {}) {
  const capability = describeRuntimeAuth({provider,runtimeEvidence});
  return { runtime: {installed: typeof runtimeEvidence.installed === 'boolean' ? runtimeEvidence.installed : Boolean(runtimeEvidence.executable),
    protocolVerified: runtimeEvidence.compatible === true, version: runtimeEvidence.version ?? null},
    authentication: {mode: configuration.authMode ?? 'api-key', state: configuration.authMode==='native-cli'
      ? runtimeEvidence.nativeAuthenticated===true?'native-cli-authenticated':runtimeEvidence.nativeAuthenticated===false?'native-cli-not-authenticated':'unknown'
      : configuration.authMode!=='provider-login' && configuration.credentialConfigured ? 'configured-unverified' : 'not-configured',
      verified:configuration.authMode==='native-cli'&&runtimeEvidence.nativeAuthenticated===true},
    execution: {eligible:taskEligible === true,reason}, ...capability };
}
