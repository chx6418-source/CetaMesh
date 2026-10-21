import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentProviderError, defineAgentProvider } from './agent-provider.js';

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
  const reason = desktopDetected ? 'unsupported_external_control' : 'not_installed';
  const unavailable = () => {
    throw agentProviderError('PROVIDER_UNAVAILABLE', desktopDetected
      ? 'ZCode is a desktop app without a supported official external Agent control interface'
      : 'ZCode is not installed');
  };
  const provider = defineAgentProvider({
    id: 'zcode',
    label: 'ZCode',
    eventProtocol: null,
    capabilityExtras: {
      available: false,
      reason,
      version: null,
      health: 'external-control-not-supported',
      workspaceBoundary: 'unsupported',
      supportsFreshSession: false,
      supportsResume: false,
      contextUsage: { available: false },
      externalControl: false,
      desktopDetected: desktopDetected === true,
      ...(detectedInstallPath ? { detectedInstallPath: String(detectedInstallPath) } : {})
    },
    methods: {
      createSession: unavailable,
      send: unavailable,
      cancel: unavailable,
      status: unavailable,
      contextUsage: unavailable,
      resume: unavailable,
      closeSession: unavailable,
      selectModel: unavailable,
      health: async () => ({
        provider: 'zcode', available: false, reason,
        status: desktopDetected ? 'external-control-not-supported' : 'unavailable', desktopDetected: desktopDetected === true
      }),
      follow: async function* () { unavailable(); }
    }
  });
  return Object.freeze({
    ...provider,
    configure() {
      return { provider: 'zcode', supported: false, reason };
    }
  });
}
