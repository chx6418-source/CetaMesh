import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineAgentProvider } from './agent-provider.js';

function detectOfficialDesktop({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return false;
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'Programs', 'ZCode', 'ZCode.exe'),
    path.join(localAppData, 'Programs', 'ZCode')
  ];
  return candidates.some((candidate) => {
    try { return exists(candidate); } catch { return false; }
  });
}

export function createZCodeAgentProvider({ desktopDetected = detectOfficialDesktop(), detectedInstallPath = null } = {}) {
  const reason = desktopDetected ? 'external_protocol_unverified' : 'not_installed';
  const provider = defineAgentProvider({
    id: 'zcode',
    label: 'ZCode',
    eventProtocol: null,
    capabilityExtras: {
      available: false,
      reason,
      version: null,
      health: 'external-protocol-unverified',
      workspaceBoundary: 'unsupported',
      supportsFreshSession: false,
      supportsResume: false,
      contextUsage: { available: false },
      externalControl: false,
      protocolPresent: true,
      protocolSource: 'https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md',
      desktopDetected: desktopDetected === true,
      ...(detectedInstallPath ? { detectedInstallPath: String(detectedInstallPath) } : {})
    },
    methods: {
      health: async () => ({
        provider: 'zcode', available: false, reason,
        status: desktopDetected ? 'external-protocol-unverified' : 'unavailable', desktopDetected: desktopDetected === true
      })
    }
  });
  return Object.freeze({
    ...provider,
    configure() {
      return { provider: 'zcode', supported: false, reason };
    }
  });
}
