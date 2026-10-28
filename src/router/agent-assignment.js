import { canDispatchConfiguredNativeAgent, hasNegativeAgentReadiness } from '../agent/execution-security.js';
import { capabilityError } from '../capability/types.js';

const BOUNDARIES = new Set(['capability-broker', 'staged-capability-broker', 'native-staged']);

function eligibleHealth(health, provider, capabilities, explicitProvider) {
  return health?.available === true && health.disabled !== true && health.enabled !== false
    && health.installed !== false && health.ready !== false && health.reachable !== false
    && health.taskEligible !== false && health.compatible !== false
    && !hasNegativeAgentReadiness(health)
    && (provider === 'cetamesh' || (Boolean(explicitProvider) && canDispatchConfiguredNativeAgent(health,capabilities?.security)) || (health.authenticated === true && health.sessionCapable === true
      && (provider === 'codex' ? health.sandboxCapable === true : health.toolsAvailable === true)));
}

function costEstimate(value, provider, modelProvider, model) {
  return Number.isFinite(value?.amount) && value.amount >= 0
    && value.agentProvider === provider && value.modelProvider === modelProvider && value.model === model
    && /^[A-Z]{3}$/.test(value.currency ?? '') && typeof value.source === 'string' && value.source.trim()
    ? { amount: value.amount, currency: value.currency, source: value.source } : null;
}

/** A deterministic projection of the existing Broker's trusted Provider registry.
 * Unknown cost never authorizes an automatic paid dispatch. An explicit Owner
 * selection still passes through fresh health, boundary and consent checks.
 */
export async function rankTaskAgents({ agentBroker, workspaceId, explicitProvider = null,
  agentEnabled = true, taskKind = 'code', requiredTools = [], difficulty = 1, maxCost = null,
  modelProvider = null, model = null,
  exclude = [] } = {}) {
  if (agentEnabled === false || explicitProvider === 'none') return [];
  const ids = explicitProvider ? [explicitProvider] : agentBroker.ids();
  const ranked = [];
  for (const provider of ids) {
    if (exclude.includes(provider)) continue;
    try {
      const health = await agentBroker.health(provider);
      const capabilities = agentBroker.capabilities(provider);
      if (!BOUNDARIES.has(capabilities?.workspaceBoundary)) {
        throw capabilityError('AGENT_BOUNDARY_UNSUPPORTED', 'Provider has no verified Task Workspace boundary');
      }
      if (!eligibleHealth(health, provider, capabilities, explicitProvider)) {
        throw capabilityError('PROVIDER_UNAVAILABLE', 'Provider is not currently eligible');
      }
      agentBroker.assertExecutionConsent?.(provider, { workspaceId });
      const assignment = capabilities.assignment;
      if (!explicitProvider) {
        if (!assignment || !assignment.taskKinds?.includes(taskKind)
          || !Number.isSafeInteger(assignment.maxDifficulty) || assignment.maxDifficulty < difficulty
          || !requiredTools.every(tool => assignment.tools?.includes(tool))) continue;
      }
      // An Agent-wide price is not evidence for the actual selected model.
      const cost = costEstimate(assignment?.estimatedCost, provider, modelProvider, model);
      if (!explicitProvider) {
        if (!cost || (cost.amount > 0 && (!Number.isFinite(maxCost?.amount)
          || maxCost.amount < cost.amount || maxCost.currency !== cost.currency))) continue;
      }
      const latencyMs = Number.isFinite(assignment?.estimatedLatencyMs) && assignment.estimatedLatencyMs >= 0
        ? assignment.estimatedLatencyMs : null;
      ranked.push({ provider, cost, latencyMs });
    } catch (error) {
      if (explicitProvider) throw error;
      // A failed probe, revoked consent or malformed descriptor never qualifies
      // a different Provider by assumption. Other verified candidates remain.
    }
  }
  ranked.sort((a, b) => (a.cost?.amount ?? Infinity) - (b.cost?.amount ?? Infinity)
    || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
    || a.provider.localeCompare(b.provider));
  return ranked;
}
