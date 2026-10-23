import { defineAgentProvider } from './agent-provider.js';

// These account-wide API operations cannot prove a local Workspace execution binding.
// Keep Broker Task/session methods unsupported until the native binding is verified.
export function createWorkBuddyAgentProvider({ client } = {}) {
  const provider = defineAgentProvider({
    id: 'workbuddy', label: 'WorkBuddy', eventProtocol: null,
    capabilityExtras: {
      workspaceExecution: false, localAssistantApi: Boolean(client), cloudTaskApi: Boolean(client),
      oauthExchange: false, remoteAcp: false, workspaceUpload: false
    },
    methods: {
      async health() {
        return {
          available: false, readyForTask: false,
          reason: client ? 'oauth_exchange_unconfigured' : 'developer_configuration_missing',
          executionScope: 'external-account-api',
          configured: Boolean(client),
          accountApi: client ? 'credential_resolver_required' : 'unconfigured',
          // No readiness object or task configuration is copied into the public DTO.
          oauthExchangeConfigured: false
        };
      }
    }
  });
  return Object.freeze({ ...provider,
    async localStatus() { return requireClient().localStatus(); },
    async sendLocal(input) { return requireClient().sendLocal(input); },
    async localHistory(input) { return requireClient().localHistory(input); },
    async createRemoteTask(input) { return requireClient().createTask(input); },
    async getRemoteTask(id) { return requireClient().getTask(id); }
  });
  function requireClient() {
    if (!client) throw Object.assign(new Error('WorkBuddy: developer_configuration_missing'), { code: 'developer_configuration_missing' });
    return client;
  }
}
