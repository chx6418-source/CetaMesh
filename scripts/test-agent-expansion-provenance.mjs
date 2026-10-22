import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeAgentExpansionFingerprint, assertAgentExpansionSourceUnchanged, verifyAgentExpansionArtifact, AGENT_EXPANSION_SOURCE_FILES, hasPinnedClaudeSdkMetadata, isExpectedAbsentSdkError } from '../src/agent/expansion-provenance.js';
import { writeJsonAtomic } from '../src/storage/json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-provenance-'));
try {
  assert.equal(hasPinnedClaudeSdkMetadata({}), false);
  assert.equal(hasPinnedClaudeSdkMetadata({optionalAgentSdk:{version:'0.3.308',file:'agent-sdk/claude-0.3.308.cjs',sha256:'735c7dd4729ac39bdb58c26e8139548ead25cfe47f8164c3493439bf4482ef0c'}}), true);
  assert.throws(() => hasPinnedClaudeSdkMetadata({optionalAgentSdk:{version:'other'}}), /SDK_METADATA_INVALID/);
  assert.equal(isExpectedAbsentSdkError({code:'RPC_REMOTE_ERROR',rpcCode:-32603}, false), true);
  assert.equal(isExpectedAbsentSdkError({code:'RPC_REMOTE_ERROR',rpcCode:-32603}, true), false);
  assert.equal(isExpectedAbsentSdkError({code:'RPC_TIMEOUT'}, false), false);
  for (const file of AGENT_EXPANSION_SOURCE_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `fixture:${file}`);
  }
  const fingerprint = computeAgentExpansionFingerprint(root);
  assert.equal(assertAgentExpansionSourceUnchanged(root, fingerprint), fingerprint);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const artifact = path.join(root, 'artifact'); fs.mkdirSync(artifact);
  const bytes = Buffer.from('fixture executable, never launched');
  fs.writeFileSync(path.join(artifact, 'WhaleBridgeCore.exe'), bytes);
  const manifest = { executable: 'WhaleBridgeCore.exe', executableSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    agentExpansion: { contractVersion: 1, sourceFingerprint: fingerprint } };
  const save = () => writeJsonAtomic(path.join(artifact, 'runtime-manifest.json'), manifest);
  save(); assert.equal(verifyAgentExpansionArtifact(artifact, root).sourceFingerprint, fingerprint);
  fs.appendFileSync(path.join(root, 'src/agent/service.js'), '// changed');
  assert.throws(() => assertAgentExpansionSourceUnchanged(root, fingerprint), /SOURCE_CHANGED_DURING_BUILD/);
  assert.throws(() => verifyAgentExpansionArtifact(artifact, root), /SOURCE_MISMATCH/);
  manifest.agentExpansion.sourceFingerprint = computeAgentExpansionFingerprint(root); save();
  fs.appendFileSync(path.join(artifact, 'WhaleBridgeCore.exe'), 'tamper');
  assert.throws(() => verifyAgentExpansionArtifact(artifact, root), /SHA_MISMATCH/);
  fs.writeFileSync(path.join(artifact, 'WhaleBridgeCore.exe'), bytes);
  delete manifest.agentExpansion; save();
  assert.throws(() => verifyAgentExpansionArtifact(artifact, root), /CONTRACT_MISMATCH/);
  manifest.executable = '../WhaleBridgeCore.exe'; save();
  assert.throws(() => verifyAgentExpansionArtifact(artifact, root), /EXECUTABLE_INVALID/);
  fs.rmSync(path.join(root, AGENT_EXPANSION_SOURCE_FILES[0]));
  assert.throws(() => computeAgentExpansionFingerprint(root), /ENOENT/);
  console.log('Agent expansion source fingerprint, stale metadata, tamper and fixed-path contracts PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
