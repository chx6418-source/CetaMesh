import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile } from '../storage/json-file.js';

// Contract v1 fingerprints this bounded Agent runtime domain, not the entire product.
// Add new runtime inputs here when extending the adapter/runner domain.
export const AGENT_EXPANSION_SOURCE_FILES = Object.freeze([
  'src/agent/acp-agent-provider.js', 'src/agent/acp-provider-descriptors.js',
  'src/agent/native-acp-runtime.js', 'src/agent/gemini-qwen-runtime.js',
  'src/agent/native-approval-bridge.js', 'src/agent/runtime-configuration.js',
  'src/agent/claude-runtime.js', 'src/agent/installation-discovery.js',
  'src/capability/service.js', 'src/settings/schema.js', 'src/router/agent-assignment.js',
  'src/agent/agent-provider.js', 'src/agent/broker.js', 'src/agent/registry.js',
  'src/agent/service.js', 'src/agent/managed-agent-provider.js', 'src/agent/execution-security.js',
  'src/agent/cli-agent-process.js', 'src/agent/codex-agent-provider.js',
  'src/agent/codex-app-server-provider.js', 'src/agent/codex-provider-router.js',
  'src/agent/claude-agent-provider.js', 'src/agent/claude-sdk-runner.js',
  'src/agent/claude-sdk-resource.js', 'src/agent/dsh-agent-provider.js',
  'src/agent/staged-dsh-agent-provider.js', 'src/agent/zcode-agent-provider.js',
  'src/agent/workbuddy-agent-provider.js', 'src/agent/workbuddy-api-client.js',
  'src/agent/protocol/json-rpc-transport.js', 'src/agent/protocol/agent-event-buffer.js',
  'src/agent/protocol/agent-permission-bridge.js', 'src/agent/expansion-provenance.js',
  'src/core-dispatch.js', 'src/core-entry.js', 'src/core-sea.js',
  'src/app/service-container.js', 'src/storage/json-file.js',
  'src/desktop/chat-service.js', 'src/desktop/platform-runtime.js',
  'scripts/claude-sdk-resource.mjs', 'scripts/build-core.mjs'
]);

export function computeAgentExpansionFingerprint(root) {
  const hash = crypto.createHash('sha256').update('agent-expansion-contract-v1\0');
  for (const file of AGENT_EXPANSION_SOURCE_FILES) {
    const bytes = fs.readFileSync(path.join(root, file));
    hash.update(file).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

export function assertAgentExpansionSourceUnchanged(root, capturedFingerprint) {
  if (computeAgentExpansionFingerprint(root) !== capturedFingerprint) {
    throw new Error('AGENT_EXPANSION_SOURCE_CHANGED_DURING_BUILD');
  }
  return capturedFingerprint;
}

export function verifyAgentExpansionArtifact(directory, sourceRoot) {
  const manifest = readJsonFile(path.join(directory, 'runtime-manifest.json'));
  if (manifest.executable !== 'WhaleBridgeCore.exe') throw new Error('AGENT_EXPANSION_EXECUTABLE_INVALID');
  if (manifest.agentExpansion?.contractVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.agentExpansion?.sourceFingerprint ?? '')) {
    throw new Error('AGENT_EXPANSION_CONTRACT_MISMATCH');
  }
  const sourceFingerprint = computeAgentExpansionFingerprint(sourceRoot);
  if (manifest.agentExpansion.sourceFingerprint !== sourceFingerprint) throw new Error('AGENT_EXPANSION_SOURCE_MISMATCH');
  const executable = path.join(directory, manifest.executable);
  const executableSha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (manifest.executableSha256 !== executableSha256) throw new Error('AGENT_EXPANSION_SHA_MISMATCH');
  return { executable, executableSha256, sourceFingerprint, sdkBundled: hasPinnedClaudeSdkMetadata(manifest) };
}

export function hasPinnedClaudeSdkMetadata(manifest) {
  if (manifest.optionalAgentSdk == null) return false;
  const sdk = manifest.optionalAgentSdk;
  if (sdk.version !== '0.3.308' || sdk.file !== 'agent-sdk/claude-0.3.308.cjs' ||
      sdk.sha256 !== '735c7dd4729ac39bdb58c26e8139548ead25cfe47f8164c3493439bf4482ef0c') {
    throw new Error('AGENT_EXPANSION_SDK_METADATA_INVALID');
  }
  return true;
}

export function isExpectedAbsentSdkError(error, sdkBundled) {
  return !sdkBundled && error?.code === 'RPC_REMOTE_ERROR' && error?.rpcCode === -32603;
}
