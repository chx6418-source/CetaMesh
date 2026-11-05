import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createWorkspaceRegistry, workspaceRegistryFile } from '../src/workspace/registry.js';
import { workspaceJournalDir } from '../src/workspace/transaction.js';

// Real non-Git files, transaction manifests and storage. No model or native UI.
const parent = fs.realpathSync.native(os.tmpdir());
const base = fs.mkdtempSync(path.join(parent, 'cetamesh-import-recovery-'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const journals = new Set(), cases = [], test = (name, run) => cases.push([name, run]);
function fixture(name, live = 'third-party') {
  const root = path.join(base, name), project = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'input.txt'), live);
  const workspace = createWorkspaceRegistry({ file: workspaceRegistryFile(stateDir) }).create({ root: project, name });
  const journal = workspaceJournalDir(project); journals.add(journal);
  const batch = path.join(journal, 'batch-original'); fs.mkdirSync(batch, { recursive: true });
  const manifest = { schemaVersion: 1, root: project, status: 'committing', rows: [
    { action: 'write', path: 'input.txt', originalHash: hash('original'), stagedHash: hash('staged'), backup: '0.preimage' }
  ] };
  fs.writeFileSync(path.join(batch, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(batch, '0.preimage'), 'original');
  return { root, project, stateDir, workspace, journal, batch, manifest,
    build: () => createWorkspaceService({ stateDir }) };
}

test('F0 normal interrupted import restores verified original bytes', async () => {
  const f = fixture('rollback', 'staged'), service = f.build();
  assert.equal(service.describeWorkspace(f.workspace.id).root, f.project);
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.journal), []);
  assert.equal((await service.collectRecoveryProof(f.workspace.id)).kind, 'filtered-workspace-v1');
});

test('F0 conflicting bytes retain project ownership and original recovery evidence', async () => {
  const f = fixture('conflict'), manifest = fs.readFileSync(path.join(f.batch, 'manifest.json'));
  const service = f.build();
  assert.equal(service.describeWorkspace(f.workspace.id), null);
  await assert.rejects(service.collectRecoveryProof(f.workspace.id), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(f.project, 'input.txt'), 'utf8'), 'third-party');
  assert.deepEqual(fs.readFileSync(path.join(f.batch, 'manifest.json')), manifest);
});

try {
  for (const [name, run] of cases) { const start = performance.now(); await run(); console.log('PASS', name, Math.round(performance.now() - start) + 'ms'); }
} finally {
  for (const journal of journals) {
    assert.equal(path.dirname(path.resolve(journal)), path.join(os.tmpdir(), 'CetaMesh', 'workspace-import-journal'));
    assert.match(path.basename(journal), /^[a-f0-9]{32}$/); fs.rmSync(journal, { recursive: true, force: true });
  }
  assert.equal(path.dirname(path.resolve(base)), parent); assert.ok(path.basename(base).startsWith('cetamesh-import-recovery-'));
  fs.rmSync(base, { recursive: true, force: true });
}
