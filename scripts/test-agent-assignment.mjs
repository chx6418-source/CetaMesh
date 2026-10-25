import assert from 'node:assert/strict';
import { rankTaskAgents } from '../src/router/agent-assignment.js';

const workspaceId = 'workspace-fixture';
const descriptors = {
  cheap: { workspaceBoundary: 'capability-broker', assignment: { taskKinds: ['code'], tools: ['filesystem.read', 'git.diff'], maxDifficulty: 2, estimatedCost: { amount: 0, currency: 'USD', source: 'fixture' }, estimatedLatencyMs: 120 } },
  fast: { workspaceBoundary: 'native-staged', assignment: { taskKinds: ['code'], tools: ['filesystem.read', 'git.diff'], maxDifficulty: 3, estimatedCost: { amount: 0, currency: 'USD', source: 'fixture' }, estimatedLatencyMs: 30 } },
  paid: { workspaceBoundary: 'native-staged', assignment: { taskKinds: ['code'], tools: ['filesystem.read', 'git.diff'], maxDifficulty: 3, estimatedCost: { amount: 3, currency: 'USD', source: 'fixture' }, estimatedLatencyMs: 10 } },
  unknown: { workspaceBoundary: 'capability-broker', assignment: { taskKinds: ['code'], tools: ['filesystem.read', 'git.diff'], maxDifficulty: 3 } }
};
for (const [id, descriptor] of Object.entries(descriptors)) {
  if (descriptor.assignment.estimatedCost) Object.assign(descriptor.assignment.estimatedCost,
    { agentProvider: id, modelProvider: 'fixture-model', model: 'fixture-model-id' });
}
const health = Object.fromEntries(Object.keys(descriptors).map(id => [id, { available: true, installed: true,
  authenticated: true, sessionCapable: true, taskEligible: true, ready: true, reachable: true,
  toolsAvailable: true }]));
const agentBroker = {
  ids: () => Object.keys(descriptors),
  capabilities: id => descriptors[id],
  health: async id => health[id],
  assertExecutionConsent: id => { if (id === 'unknown' && health[id]?.consentRevoked) throw Object.assign(new Error('revoked'), { code: 'AGENT_SECURITY_CONFIRMATION_REQUIRED' }); }
};
const request = { agentBroker, workspaceId, taskKind: 'code', requiredTools: ['filesystem.read', 'git.diff'],
  difficulty: 2, modelProvider: 'fixture-model', model: 'fixture-model-id' };
const ranked = await rankTaskAgents(request);
assert.deepEqual(ranked.map(row => row.provider), ['fast', 'cheap'], 'free verified candidates rank by latency; unknown and paid abstain');
assert.deepEqual((await rankTaskAgents({ ...request, maxCost: { amount: 3, currency: 'USD' } })).map(row => row.provider), ['fast', 'cheap', 'paid']);
assert.deepEqual((await rankTaskAgents({ ...request, difficulty: 3 })).map(row => row.provider), ['fast']);
const codexBroker = { ...agentBroker, ids: () => ['codex'],
  capabilities: () => ({ ...descriptors.fast, assignment: { ...descriptors.fast.assignment,
    estimatedCost: { ...descriptors.fast.assignment.estimatedCost, agentProvider: 'codex' } } }),
  health: async () => ({ ...health.fast, sandboxCapable: false }) };
assert.deepEqual(await rankTaskAgents({ ...request, agentBroker: codexBroker }), [], 'native sandbox refusal excludes auto dispatch');
codexBroker.health = async () => ({ ...health.fast, sandboxCapable: null });
assert.deepEqual(await rankTaskAgents({ ...request, agentBroker: codexBroker }), [], 'unknown native sandbox is not proof');
codexBroker.health = async () => ({ ...health.fast, sandboxCapable: true });
assert.deepEqual((await rankTaskAgents({ ...request, agentBroker: codexBroker })).map(row => row.provider), ['codex']);
assert.deepEqual((await rankTaskAgents({ ...request, requiredTools: ['test.run'] })).map(row => row.provider), []);
assert.deepEqual((await rankTaskAgents({ ...request, explicitProvider: 'paid' })).map(row => row.provider), ['paid'], 'explicit selection is retained');
health.fast.authenticated = false;
assert.deepEqual((await rankTaskAgents(request)).map(row => row.provider), ['cheap']);
health.cheap.disabled = true;
assert.deepEqual(await rankTaskAgents(request), []);
assert.deepEqual(await rankTaskAgents({ ...request, agentEnabled: false }), []);
assert.deepEqual(await rankTaskAgents({ ...request, explicitProvider: 'none' }), []);
await assert.rejects(rankTaskAgents({ ...request, explicitProvider: 'fast' }), error => error.code === 'PROVIDER_UNAVAILABLE', 'explicit unhealthy selection never falls back');
health.unknown.consentRevoked = true;
await assert.rejects(rankTaskAgents({ ...request, explicitProvider: 'unknown' }), error => error.code === 'AGENT_SECURITY_CONFIRMATION_REQUIRED');
assert.deepEqual((await rankTaskAgents({ ...request, maxCost: { amount: 3, currency: 'USD' } })).map(row => row.provider), ['paid'], 'revoked candidate cannot be ranked');
console.log('Agent assignment: explicit/disabled, health, ability, cost and latency guards passed');

const nativeDispatchSecurity={mode:'native-permissions',verified:true,nativeSandboxSupported:false,strictIsolationVerified:false,
 nativeApprovalSupported:true,nativePermissionPolicyVerified:true,allToolsRequireApproval:true,nativeSandboxMode:'none'};
const nativeHealth={available:true,installed:true,compatible:true,taskEligible:true,sessionCapable:true,authenticated:null,
 authConfigured:true,authVerified:false,authentication:'configured-unverified'};
let currentNativeHealth={...nativeHealth},currentNativeSecurity={...nativeDispatchSecurity};
const nativeAssignment={...descriptors.fast,security:currentNativeSecurity,assignment:{...descriptors.fast.assignment,
 estimatedCost:{...descriptors.fast.assignment.estimatedCost,agentProvider:'opencode'}}};
const nativeBroker={ids:()=>['opencode'],capabilities:()=>({...nativeAssignment,security:currentNativeSecurity}),
 health:async()=>({...currentNativeHealth}),assertExecutionConsent:()=>{}};
const nativeRequest={...request,agentBroker:nativeBroker,explicitProvider:'opencode'};
assert.deepEqual((await rankTaskAgents(nativeRequest)).map(row=>row.provider),['opencode'],'explicit Owner selection may verify configured credentials at dispatch without claiming authentication');
assert.deepEqual(await rankTaskAgents({...nativeRequest,explicitProvider:null}),[],'unverified account must not qualify for automatic assignment even with a declared free fixture price');
for(const changes of [{authenticated:false},{authConfigured:false},{authVerified:true},{sessionCapable:false},{compatible:false}]){
 currentNativeHealth={...nativeHealth,...changes};await assert.rejects(rankTaskAgents(nativeRequest),e=>e.code==='PROVIDER_UNAVAILABLE');
}
currentNativeHealth={...nativeHealth};currentNativeSecurity={...nativeDispatchSecurity,verified:false};
await assert.rejects(rankTaskAgents(nativeRequest),e=>e.code==='PROVIDER_UNAVAILABLE');
nativeBroker.health=async()=>{currentNativeSecurity={...nativeDispatchSecurity};return {...nativeHealth};};
assert.equal((await rankTaskAgents(nativeRequest)).length,1,'eligibility reads refreshed capability evidence after asynchronous health');
console.log('PASS explicit configured native Agent routing, no automatic account assumption, current policy evidence');
