import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defineAgentProvider} from '../src/agent/agent-provider.js';
import {createStagedDshAgentProvider} from '../src/agent/staged-dsh-agent-provider.js';

let stages = 0, sessions = 0;
const raw = defineAgentProvider({id: 'dsh', label: 'Uncontrolled HTTP fixture', capabilityExtras: {
  nativePresetRequiresPolicy: false, workspaceBoundary: 'unverified'
}, methods: {
  createSession: async () => {sessions++; return {sessionId: 'unsafe'};},
  health: async () => ({available: true, ready: true, sessionCapable: true, authenticated: true}),
  async *follow() {}
}});
const staged = createStagedDshAgentProvider({provider: raw,
  resolveTaskWorkspace: () => ({task: {id: 'task', workspaceId: 'ws'}, workspace: {id: 'ws', root: process.cwd()}}),
  createStage: () => {stages++; return {root: process.cwd()};}, applyChanges: () => ({status: 'completed'})});
assert.equal((await staged.health()).taskEligible, false, 'a local preset and Session Ready cannot establish Core tool interception');
assert.equal(staged.capabilities().workspaceBoundary, 'unverified');
await assert.rejects(staged.createSession({taskId: 'task', workspaceId: 'ws'}), {code: 'DSH_TOOL_APPROVAL_UNAVAILABLE'});
assert.equal(stages, 0, 'unsupported tools fail before claiming staging');
assert.equal(sessions, 0, 'unsupported tools fail before creating a remote Session');
console.log('PASS uncontrolled HTTP/local-persona DSH is rejected before Workspace or Session creation');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dsh-staging-approval-')));
const source = path.join(root, 'project'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'source.txt'), 'original');
const security = {mode: 'native-permissions', verified: true, nativeSandboxSupported: false, strictIsolationVerified: false,
  nativeApprovalSupported: true, nativePermissionPolicyVerified: true, allToolsRequireApproval: true, nativeSandboxMode: 'none'};
let imported;
const sdkFixture = defineAgentProvider({id: 'dsh', label: 'Trusted SDK staging fixture', capabilityExtras: {taskTransport: 'sdk', security}, methods: {
  createSession: async () => ({sessionId: 'sdk-stage-session'}),
  send: async ({onRequestId}) => {onRequestId?.('early-prompt-id'); return {accepted: true, requestId: 'early-prompt-id', turnId: 'core-placeholder'};},
  status: async () => ({state: 'waiting', running: true, waitingForApproval: true}),
  closeSession: async () => ({closed: true, stopped: true}),
  async *follow() {yield {type: 'event', event: {type: 'turn/end', seq: 1,
    data: {turn: 9, runId: 'controlled-run', phase: 'user', reason: {kind: 'completed'}}}};}
}});
const controlled = createStagedDshAgentProvider({provider: sdkFixture, stagingRoot: path.join(root, 'staging'),
  resolveTaskWorkspace: () => ({task: {id: 'task', workspaceId: 'ws'}, workspace: {id: 'ws', root: source}}),
  applyChanges: async request => {imported = request; return {status: 'pending', approvalId: 'rejected-import'};},
  approvalStatus: () => ({status: 'rejected'})});
try {
  const session = await controlled.createSession({taskId: 'task', workspaceId: 'ws'});
  assert.equal((await controlled.status({sessionId: session.sessionId})).waitingForApproval, true, 'native tool approval waiting must survive staging projection');
  await controlled.send({sessionId: session.sessionId, content: 'fixture', runId: 'controlled-run', phase: 'user'});
  fs.writeFileSync(path.join(session.cwd, 'result.txt'), 'unimported result');
  for await (const event of controlled.follow({sessionId: session.sessionId})) assert.equal(event.event.data.reason.kind, 'error');
  assert.equal(imported.runId, 'controlled-run', 'an early prompt ACK cannot detach the import from its trusted Core run');
  assert.equal(imported.phase, 'user');
  assert.equal(fs.existsSync(path.join(source, 'result.txt')), false);
  const closed = await controlled.closeSession({sessionId: session.sessionId});
  assert.equal(closed.stagingRetained, true, 'declined import keeps its staging evidence after confirmed stop');
  assert.equal(fs.readFileSync(path.join(session.cwd, 'result.txt'), 'utf8'), 'unimported result');
  console.log('PASS staged native waiting, early-ACK Core attribution and declined-import evidence retention');
} finally {
  await controlled.shutdown();
  fs.rmSync(root, {recursive: true, force: true});
}
