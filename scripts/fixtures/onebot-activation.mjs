import { createIntegrationStore } from '../../src/integrations/store.js';

// Fixture authority is explicit and confined to the test's own StateDir.
export function enableOneBotFixture(stateDir, { bionic = false } = {}) {
  return createIntegrationStore({ stateDir }).update(value => ({ ...value,
    mcp: { ...value.mcp, onebot: { enabled: true } },
    plugins: { ...value.plugins, 'cetamesh-onebot': { enabled: true },
      ...(bionic ? { 'cetamesh-bionic-chat': { enabled: true } } : {}) } }));
}
