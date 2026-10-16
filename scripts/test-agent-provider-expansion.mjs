// Agent Provider Expansion acceptance tests. Run only through `npm test`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultAgentService } from '../src/agent/service.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentService } from '../src/agent/service.js';
import { defineAgentProvider } from '../src/agent/agent-provider.js';
import { CliAgentProcess, createMinimalAgentEnv, findCliExecutable } from '../src/agent/cli-agent-process.js';
import { createCodexAgentProvider } from '../src/agent/codex-agent-provider.js';
import { createZCodeAgentProvider } from '../src/agent/zcode-agent-provider.js';
import { createCapabilityService } from '../src/capability/service.js';
import { createChatService } from '../src/desktop/chat-service.js';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createMemoryService } from '../src/memory/service.js';
import { createWorkspaceService } from '../src/workspace/service.js';
import { createStagingWorkspace } from '../src/workspace/staging.js';
import { createContinuityService } from '../src/continuity/index.js';
import { createDesktopPlatformRuntime } from '../src/desktop/platform-runtime.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';

async function waitFor(read, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Condition was not met before timeout; last value: ${JSON.stringify(value)}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-agent-expansion-'));
try {
  const workspace = path.join(root, 'workspace');
  const otherWorkspace = path.join(root, 'other-workspace');
  const nestedWorkspace = path.join(workspace, 'nested-workspace');
  const stageRoot = path.join(root, 'staging');
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherWorkspace);
  fs.mkdirSync(nestedWorkspace);
  fs.writeFileSync(path.join(workspace, 'main.txt'), 'from-task-workspace');
  fs.writeFileSync(path.join(workspace, '.env'), 'WORKSPACE_SECRET=do-not-copy');
  fs.writeFileSync(path.join(workspace, '.env.local'), 'WORKSPACE_SECRET=do-not-copy');
  fs.writeFileSync(path.join(workspace, '.git'), 'not-a-directory fixture');
  fs.writeFileSync(path.join(otherWorkspace, 'private.txt'), 'OTHER_WORKSPACE_SECRET');
  fs.writeFileSync(path.join(nestedWorkspace, 'private.txt'), 'NESTED_WORKSPACE_SECRET');

  const staged = await createStagingWorkspace({
    taskId: 'task-1', workspaceId: 'workspace-1', sourceRoot: workspace,
    stagingRoot: stageRoot, additionalWorkspaceRoots: [otherWorkspace, nestedWorkspace]
  });
  assert.equal(fs.readFileSync(path.join(staged.root, 'main.txt'), 'utf8'), 'from-task-workspace');
  assert.equal(fs.existsSync(path.join(staged.root, '.env')), false);
  assert.equal(fs.existsSync(path.join(staged.root, '.env.local')), false);
  assert.equal(fs.existsSync(path.join(staged.root, '.git')), false);
  assert.equal(fs.existsSync(path.join(staged.root, 'private.txt')), false);
  assert.equal(fs.existsSync(path.join(staged.root, 'nested-workspace')), false, 'a separately registered nested Workspace is not copied into this Task stage');
  assert.notEqual(path.resolve(staged.root), path.resolve(workspace));

  const stateDir = path.join(root, 'state');
  const authoritativeRoot = path.join(root, 'authoritative-workspace');
  const workspaceService = createWorkspaceService({ stateDir });
  const authoritative = (await workspaceService.execute({ method: 'workspace.create', params: {
    name: 'task workspace', root: authoritativeRoot, createIfMissing: true
  } })).workspace;
  const taskRuntime = createTaskRuntime({ stateDir });
  const task = taskRuntime.create({ goal: 'Provider workspace import', workspaceId: authoritative.id });
  taskRuntime.attachAgent({ id: task.id, expectedRev: task.rev, provider: 'codex', sessionId: 'fixture-session' });
  const capabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime });
  const agent = capabilities.grantTask(task.id, { capabilities: ['filesystem.read', 'filesystem.write'] });
  fs.writeFileSync(path.join(authoritativeRoot, 'existing.txt'), 'before');
  fs.writeFileSync(path.join(authoritativeRoot, 'remove.txt'), 'delete-me');
  const beforeHash = value => crypto.createHash('sha256').update(value).digest('hex');
  const importResult = await capabilities.applyAgentWorkspaceChanges({
    taskId: task.id,
    workspaceId: authoritative.id,
    provider: 'codex', sessionId: 'fixture-session',
    requestId: 'provider-import-1',
    summary: { added: 0, modified: 1, deleted: 1 },
    changes: [
      { action: 'write', path: 'existing.txt', content: 'after', expectedHash: beforeHash('before'), hash: beforeHash('after') },
      { action: 'delete', path: 'remove.txt', expectedHash: beforeHash('delete-me'), hash: null }
    ]
  });
  assert.equal(importResult.status, 'pending');
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'existing.txt'), 'utf8'), 'before', 'real Workspace stays unchanged while approval is pending');
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'remove.txt'), 'utf8'), 'delete-me');
  assert.equal(capabilities.workspaceImportStatus(importResult.approvalId).status, 'pending');
  const decision = await capabilities.execute({ method: 'capability.approval.decide', params: {
    id: importResult.approvalId, approve: true
  } });
  assert.equal(decision.status, 'completed');
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'existing.txt'), 'utf8'), 'after');
  assert.equal(fs.existsSync(path.join(authoritativeRoot, 'remove.txt')), false);
  assert.equal(capabilities.workspaceImportStatus(importResult.approvalId).status, 'completed');
  await assert.rejects(() => capabilities.applyAgentWorkspaceChanges({
    taskId: task.id, workspaceId: authoritative.id, provider: 'codex', sessionId: 'fixture-session', requestId: 'provider-import-stale',
    changes: [{ action: 'write', path: 'existing.txt', content: 'stale', expectedHash: beforeHash('before'), hash: beforeHash('stale') }]
  }), error => error.code === 'WORKSPACE_CONFLICT');
  await assert.rejects(() => capabilities.applyAgentWorkspaceChanges({
    taskId: task.id, workspaceId: authoritative.id, provider: 'codex', sessionId: 'fixture-session', requestId: 'provider-import-secret',
    changes: [{ action: 'write', path: '.env', content: 'SECRET=x', expectedHash: null, hash: beforeHash('SECRET=x') }]
  }), error => error.code === 'SENSITIVE_RESOURCE_DENIED');

  let dshStageRoot = null;
  let dshSequence = 0;
  const dshSessions = new Map();
  const dshApi = {
    async callEndpoint(endpoint, args) {
      if (endpoint === 'session/create') {
        dshStageRoot = args.request.cwd;
        const sessionId = `dsh-task-fixture-${++dshSequence}`;
        dshSessions.set(sessionId, { cwd: args.request.cwd, running: false, followSubscriptions: 0 });
        return { sessionId };
      }
      if (endpoint === 'session/list') return { items: [...dshSessions].map(([sessionId, session]) => ({
        sessionId, running: session.running, projections: { values: {} }
      })) };
      if (endpoint === 'session/prompt') {
        const session = dshSessions.get(args.request.sessionId);
        session.running = true;
        const prompt = JSON.stringify(args.request.content ?? []);
        session.bootstrapOnly = prompt.includes('此回合只确认恢复事实');
        if (prompt.includes('Task-level follow')) {
          session.outputName = 'task-follow-result.txt';
          session.duplicateTurnEnd = true;
        }
        return {};
      }
      if (endpoint === 'session/cancel') { dshSessions.get(args.request.sessionId).running = false; return {}; }
      return {};
    },
    async *openRemoteStream(_endpoint, args, { signal } = {}) {
      const sessionId = args.request.address.sessionId;
      const session = dshSessions.get(sessionId);
      while (!session.running && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 2));
      if (signal?.aborted) return;
      session.followSubscriptions += 1;
      if (!session.bootstrapOnly) fs.writeFileSync(path.join(session.cwd, session.outputName ?? 'dsh-result.txt'), `dsh fake edit ${sessionId}`);
      yield { type: 'turn/start', data: { turn: 'dsh-turn-1' } };
      yield { type: 'assistant/message', data: { turn: 'dsh-turn-1', message: { content: [{ type: 'text', text: 'DSH fixture response' }] } } };
      yield { type: 'turn/end', data: { turn: 'dsh-turn-1', reason: { kind: 'completed' } } };
      if (session.duplicateTurnEnd) yield { type: 'turn/end', data: { turn: 'dsh-turn-1', reason: { kind: 'completed' } } };
      session.running = false;
    }
  };
  const taskFollowStateDir = path.join(root, 'task-follow-capabilities');
  const followAudit = [];
  let taskFollowCapabilityService = null;
  const dshService = createDefaultAgentService({ api: dshApi, dshOptions: {
    stagingRoot: path.join(root, 'dsh-staging'),
    resolveTaskWorkspace: async ({ taskId } = {}) => ({ task: taskRuntime.get({ id: taskId ?? task.id }).task, workspace: authoritative }),
    listWorkspaceRoots: async () => [authoritativeRoot],
    applyChanges: request => taskFollowCapabilityService.applyAgentWorkspaceChanges(request),
    approvalStatus: approvalId => taskFollowCapabilityService.workspaceImportStatus(approvalId),
    cancelApproval: approvalId => taskFollowCapabilityService.cancelWorkspaceImportApproval(approvalId)
  } });
  assert.equal(dshService.broker.capabilities('dsh').workspaceBoundary, 'capability-broker',
    'the product DSH provider advertises a Broker boundary only when the staging/import adapter is installed');

  const followTask = taskRuntime.create({ goal: 'Task-level Agent completion must import its Workspace changes', workspaceId: authoritative.id });
  taskFollowCapabilityService = createCapabilityService({ stateDir: taskFollowStateDir, workspaceService,
    memoryService: createMemoryService({ stateDir: taskFollowStateDir }), taskRuntime, agentBroker: dshService.broker,
    audit: event => followAudit.push(event) });
  taskFollowCapabilityService.grantTask(task.id, { capabilities: ['filesystem.read', 'filesystem.write'] });
  assert.equal(dshService.broker.capabilities('dsh').requiresSessionCleanup, true);
  const followRun = await taskFollowCapabilityService.execute({ method: 'capability.execute', params: {
    requestId: 'task-follow-agent-run', capability: 'agent.run', taskId: followTask.id, workspaceId: authoritative.id,
    input: { agentProvider: 'dsh', content: 'Task-level follow fixture edit' }, reason: 'Task-scoped DSH fixture'
  } });
  assert.equal(followRun.status, 'completed');
  assert.equal(followRun.result.accepted, true);
  const followPendingState = await waitFor(() => ({
    rows: taskFollowCapabilityService.broker.approvals.list(),
    subscriptions: dshSessions.get(followRun.result.sessionId)?.followSubscriptions,
    audit: followAudit,
    stageRoot: dshService.broker.require('dsh')._sessions.get(followRun.result.sessionId)?.stage.root,
    stagedFile: (() => {
      const stageRoot = dshService.broker.require('dsh')._sessions.get(followRun.result.sessionId)?.stage.root;
      return stageRoot ? fs.existsSync(path.join(stageRoot, 'task-follow-result.txt')) : false;
    })()
  }), state => state.rows.find(row => row.request?.capability === 'workspace.apply' && row.request?.taskId === followTask.id));
  const followPending = followPendingState.rows.find(row => row.request?.capability === 'workspace.apply' && row.request?.taskId === followTask.id);
  const followSession = dshSessions.get(followRun.result.sessionId);
  assert.equal(followSession.followSubscriptions, 1, 'agent.run starts exactly one task-level Follow with no Chat UI subscriber');
  assert.equal(fs.existsSync(path.join(authoritativeRoot, 'task-follow-result.txt')), false,
    'task-level Follow still routes staged changes through Owner approval');
  const approvalDecision = await taskFollowCapabilityService.execute({ method: 'capability.approval.decide', params: {
    id: followPending.id, approve: true
  } });
  assert.equal(approvalDecision.status, 'completed');
  await waitFor(() => fs.existsSync(path.join(authoritativeRoot, 'task-follow-result.txt')), exists => exists);
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'task-follow-result.txt'), 'utf8'), `dsh fake edit ${followRun.result.sessionId}`);
  assert.equal(followSession.followSubscriptions, 1, 'a duplicate turn/end cannot trigger a second Follow or duplicate import');
  await dshService.broker.closeSession({ provider: 'dsh', sessionId: followRun.result.sessionId });
  console.log('PASS model agent.run consumes task-level DSH Follow without Chat UI and preserves approval + one-import semantics');

  await assert.rejects(() => dshService.broker.createSession('dsh', { workspaceId: authoritative.id }), error => error.code === 'TASK_REQUIRED');
  const dshSession = await dshService.broker.createSession('dsh', { taskId: task.id, workspaceId: authoritative.id });
  taskRuntime.attachAgent({ id: task.id, expectedRev: taskRuntime.get({ id: task.id }).task.rev, provider: 'dsh', sessionId: dshSession.sessionId });
  const dshEvents = [];
  const dshFollow = (async () => {
    for await (const event of dshService.broker.follow({ provider: 'dsh', sessionId: dshSession.sessionId })) dshEvents.push(event);
  })();
  await dshService.broker.send({ provider: 'dsh', sessionId: dshSession.sessionId, content: 'Edit staged workspace' });
  const dshWaiting = await waitFor(() => dshService.broker.status({ provider: 'dsh', sessionId: dshSession.sessionId }), status => status.waitingForApproval);
  assert.equal(fs.existsSync(path.join(authoritativeRoot, 'dsh-result.txt')), false, 'DSH writes staging until Broker approval');
  await taskFollowCapabilityService.execute({ method: 'capability.approval.decide', params: { id: dshWaiting.approvalId, approve: true } });
  await waitFor(() => dshEvents, events => events.some(event => event.type === 'turn/end'));
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'dsh-result.txt'), 'utf8'), `dsh fake edit ${dshSession.sessionId}`);
  await dshFollow;
  const approvedDshStageRoot = dshStageRoot;
  const cancelledDshSession = await dshService.broker.createSession('dsh', { taskId: task.id, workspaceId: authoritative.id });
  taskRuntime.attachAgent({ id: task.id, expectedRev: taskRuntime.get({ id: task.id }).task.rev, provider: 'dsh', sessionId: cancelledDshSession.sessionId });
  const cancelledDshEvents = [];
  const cancelledDshFollow = (async () => {
    for await (const event of dshService.broker.follow({ provider: 'dsh', sessionId: cancelledDshSession.sessionId })) cancelledDshEvents.push(event);
  })();
  const cancelledDshStagePath = dshService.broker.require('dsh')._sessions.get(cancelledDshSession.sessionId).stage.root;
  await dshService.broker.send({ provider: 'dsh', sessionId: cancelledDshSession.sessionId, content: 'Cancel pending Workspace import' });
  const cancelledDshWaiting = await waitFor(() => dshService.broker.status({ provider: 'dsh', sessionId: cancelledDshSession.sessionId }), status => status.waitingForApproval);
  await dshService.broker.cancel({ provider: 'dsh', sessionId: cancelledDshSession.sessionId });
  assert.equal(taskFollowCapabilityService.workspaceImportStatus(cancelledDshWaiting.approvalId)?.status, 'cancelled',
    'cancelling DSH while an import is pending revokes the Owner approval');
  await assert.rejects(() => taskFollowCapabilityService.execute({ method: 'capability.approval.decide', params: {
    id: cancelledDshWaiting.approvalId, approve: true
  } }), error => error.code === 'APPROVAL_ALREADY_DECIDED', 'a cancelled DSH import cannot be approved later');
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'dsh-result.txt'), 'utf8'), `dsh fake edit ${dshSession.sessionId}`,
    'cancelling DSH leaves the authoritative Workspace unchanged');
  await cancelledDshFollow;
  await dshService.broker.closeSession({ provider: 'dsh', sessionId: cancelledDshSession.sessionId });
  assert.equal(fs.existsSync(cancelledDshStagePath), false, 'closing the cancelled DSH session cleans its staged Workspace');
  const expectedDshStageRoot = fs.realpathSync.native(path.join(root, 'dsh-staging'));
  const canonicalDshStageRoot = fs.realpathSync.native(approvedDshStageRoot);
  const dshStageRelative = path.relative(expectedDshStageRoot, canonicalDshStageRoot);
  assert.ok(dshStageRelative && dshStageRelative !== '..'
    && !dshStageRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(dshStageRelative),
  'DSH Task staging must stay below the canonical configured staging root');
  await dshService.broker.closeSession({ provider: 'dsh', sessionId: dshSession.sessionId });
  assert.equal(fs.existsSync(approvedDshStageRoot), false, 'DSH staging is cleaned after the Task session closes');

  const rolloverSession = await dshService.broker.createSession('dsh', { taskId: task.id, workspaceId: authoritative.id });
  const rolloverStage = rolloverSession.cwd;
  const currentTask = taskRuntime.get({ id: task.id }).task;
  const attachedTask = taskRuntime.attachAgent({ id: task.id, expectedRev: currentTask.rev,
    provider: 'dsh', sessionId: rolloverSession.sessionId }).task;
  taskRuntime.start({ id: task.id, expectedRev: attachedTask.rev });
  const dshContinuity = createContinuityService({ taskRuntime, stateDir, agentBroker: dshService.broker, canRollover: () => true });
  const dshRolled = await dshContinuity.runtime.rollover({ taskId: task.id, reason: 'dsh-fresh-session-cleanup' });
  assert.equal(dshRolled.to.provider, 'dsh');
  assert.equal(fs.existsSync(rolloverStage), false, 'Continuity closes the prior staged DSH session after Fresh Session rollover');
  dshContinuity.close();
  const dshTaskAfterRollover = taskRuntime.get({ id: task.id }).task;
  taskRuntime.detachAgent({ id: task.id, expectedRev: dshTaskAfterRollover.rev, note: 'DSH fixture cleanup' });
  await taskFollowCapabilityService.close();
  dshService.close();

  const cliFixture = path.join(root, 'fake-cli.mjs');
  fs.writeFileSync(cliFixture, [
    "let input = '';",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), input, apiKey: process.env.OPENAI_API_KEY ?? null, cetameshSecret: process.env.CETAMESH_SESSION_SECRET ?? null }) + '\\n'));"
  ].join('\n'));
  const longFixture = path.join(root, 'fake-cli-long.mjs');
  fs.writeFileSync(longFixture, 'setInterval(() => {}, 1000);\n');
  const interactiveFixture = path.join(root, 'fake-cli-interactive.mjs');
  fs.writeFileSync(interactiveFixture, [
    "let input = '';",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(input));"
  ].join('\n'));
  const cliProcess = new CliAgentProcess({ name: 'fixture', executable: process.execPath,
    envSource: { ...process.env, OPENAI_API_KEY: 'must-not-inherit', CETAMESH_SESSION_SECRET: 'must-not-inherit' } });
  assert.equal(cliProcess.health().available, true);
  assert.equal(cliProcess.version().available, true);
  assert.ok(cliProcess.version().version.length > 0);
  let fixtureOutput = '';
  const fixtureRun = cliProcess.startSession({ sessionId: 'fixture-output', cwd: staged.root, args: [cliFixture],
    input: 'fixture input', timeoutMs: 3000, onStdout: chunk => { fixtureOutput += chunk; } });
  const fixtureResult = await fixtureRun.done;
  const fixtureValue = JSON.parse(fixtureOutput.trim());
  assert.equal(fixtureResult.exitCode, 0);
  assert.equal(fixtureValue.cwd, staged.root);
  assert.equal(fixtureValue.input, 'fixture input');
  assert.equal(fixtureValue.apiKey, null);
  assert.equal(fixtureValue.cetameshSecret, null);
  let interactiveOutput = '';
  cliProcess.startSession({ sessionId: 'fixture-interactive', cwd: staged.root, args: [interactiveFixture],
    input: 'first-', inputMode: 'open', timeoutMs: 3000, onStdout: chunk => { interactiveOutput += chunk; } });
  assert.equal(cliProcess.send('fixture-interactive', 'second-').sent, true);
  assert.equal(cliProcess.send('fixture-interactive', 'done', { end: true }).sent, true);
  await waitFor(() => interactiveOutput, value => value.length > 0);
  assert.equal(interactiveOutput, 'first-second-done');
  const cancelRun = cliProcess.startSession({ sessionId: 'fixture-cancel', cwd: staged.root, args: [longFixture], timeoutMs: 5000 });
  await new Promise(resolve => cancelRun.child.once('spawn', resolve));
  assert.equal(cancelRun.cancel().cancelled, true);
  assert.equal((await cancelRun.done).cancelled, true);
  const timeoutRun = cliProcess.startSession({ sessionId: 'fixture-timeout', cwd: staged.root, args: [longFixture], timeoutMs: 1000 });
  assert.equal((await timeoutRun.done).timedOut, true);
  await cliProcess.shutdown();

  const allowedEnv = createMinimalAgentEnv({
    PATH: process.env.PATH, HTTP_PROXY: 'http://proxy.example:8080', HTTPS_PROXY: 'https://user:password@proxy.example:8443',
    NO_PROXY: 'localhost,127.0.0.1,.example.test', OPENAI_API_KEY: 'source-secret-openai-key', CETAMESH_SECRET: 'never-copy'
  });
  assert.equal(allowedEnv.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(allowedEnv.NO_PROXY, 'localhost,127.0.0.1,.example.test');
  assert.equal(Object.hasOwn(allowedEnv, 'HTTPS_PROXY'), false, 'proxy credentials embedded in a URL are rejected');
  assert.equal(Object.hasOwn(allowedEnv, 'OPENAI_API_KEY'), false, 'API credentials are never copied from the full source environment');
  assert.equal(Object.hasOwn(allowedEnv, 'CETAMESH_SECRET'), false);
  const authorizedEnv = createMinimalAgentEnv({}, {
    OPENAI_API_KEY: 'explicitly-authorized-openai-key', OPENAI_BASE_URL: 'http://127.0.0.1:8181/v1'
  }, { authorizedEnvKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] });
  assert.equal(authorizedEnv.OPENAI_API_KEY, 'explicitly-authorized-openai-key');
  assert.equal(authorizedEnv.OPENAI_BASE_URL, 'http://127.0.0.1:8181/v1');
  assert.equal(Object.hasOwn(createMinimalAgentEnv({}, { OPENAI_BASE_URL: 'http://remote.example/v1' }, { authorizedEnvKeys: ['OPENAI_BASE_URL'] }), 'OPENAI_BASE_URL'), false);

  const appDataRoot = path.join(root, 'User Profile With Spaces');
  const shimRoot = path.join(appDataRoot, 'npm');
  const shimExecutable = path.join(shimRoot, 'codex.cmd');
  const shimScript = path.join(shimRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(shimScript), { recursive: true });
  fs.writeFileSync(shimExecutable, '@echo off\r\n');
  assert.equal(findCliExecutable('codex', {
    platform: 'win32', env: { PATH: '', PATHEXT: '.EXE', APPDATA: appDataRoot },
    whereImpl: () => ({ status: 1, stdout: '', stderr: '' })
  }), path.resolve(shimExecutable), 'Windows CLI discovery includes %APPDATA%\\npm\\codex.cmd even when GUI PATH and PATHEXT omit it');
  fs.writeFileSync(shimScript, [
    "if (process.argv.includes('--version')) { console.log('codex-cli 9.9.9-shim-fixture'); process.exit(0); }",
    "process.stdout.write('shim-started\\n');",
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  const windowsShimCli = new CliAgentProcess({ name: 'codex', executable: shimExecutable, platform: 'win32' });
  assert.equal(windowsShimCli.health().available, true);
  assert.equal(windowsShimCli.version().version, 'codex-cli 9.9.9-shim-fixture');
  const shimOutput = [];
  const shimRun = windowsShimCli.startSession({ sessionId: 'windows-shim-cancel', cwd: root, args: ['exec'], input: 'fixture prompt',
    timeoutMs: 5000, onStdout: chunk => shimOutput.push(chunk) });
  await waitFor(() => shimOutput.join(''), output => output.includes('shim-started'));
  assert.equal(shimRun.cancel().cancelled, true);
  assert.equal((await shimRun.done).cancelled, true, 'npm codex.cmd launches the resolved JS target directly and remains cancellable');
  await windowsShimCli.shutdown();

  const fakeRuns = [];
  let fakeExitCode = 0;
  let fakeStderr = '';
  let fakeTurnFailed = false;
  let omitFinalNewline = false;
  let taskCapabilities;
  const fakeCli = {
    executable: () => 'codex-fixture',
    probe(args) {
      if (args[0] === '--version') return { available: true, stdout: 'codex-cli 9.9.9-fixture', stderr: '' };
      if (args[0] === '--help') return { available: true, stdout: '--config --ask-for-approval --cd', stderr: '' };
      if (args[0] === 'exec' && args[1] === '--help') return { available: true, stdout: '--json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check', stderr: '' };
      if (args[0] === 'exec' && args[1] === 'resume') return { available: true, stdout: 'exec resume [SESSION_ID] --json', stderr: '' };
      if (args[0] === 'login' && args[1] === 'status') return { available: true, stdout: 'Logged in with Codex fixture account', stderr: '' };
      return { available: false, stdout: '', stderr: '' };
    },
    startSession({ sessionId, cwd, args, input, env, authorizedEnvKeys, onStdout }) {
      const number = fakeRuns.length + 1;
      fakeRuns.push({ sessionId, cwd, args: [...args], input, env: { ...(env ?? {}) }, authorizedEnvKeys: [...(authorizedEnvKeys ?? [])] });
      if (number === 1) fs.writeFileSync(path.join(cwd, `codex-result-${number}.txt`), `fake edit ${number}`);
      if (fakeTurnFailed) fs.writeFileSync(path.join(cwd, 'codex-failed-result.txt'), 'must not import after turn.failed');
      const records = [
        { type: 'thread.started', thread_id: `thread-${number}` },
        { type: 'item.completed', item: { type: 'agent_message', text: `fixture response ${number}` } },
        ...(fakeTurnFailed ? [{ type: 'turn.failed', error: { message: 'fixture turn failed' } }] : []),
        ...(fakeExitCode === 0 ? [{ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }] : [])
      ];
      const serialized = records.map(record => JSON.stringify(record)).join('\n');
      onStdout(serialized + (omitFinalNewline ? '' : '\n'));
      omitFinalNewline = false;
      return { done: Promise.resolve({ sessionId, exitCode: fakeExitCode, timedOut: false, cancelled: false, stdout: '', stderr: fakeStderr }),
        cancel: () => ({ cancelled: true, sessionId }), shutdown() {} };
    },
    async shutdown() {}
  };
  const codexStagingRoot = path.join(root, 'codex-staging');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "fixture-inherited-model"',
    'model_provider = "fixture-local"',
    '',
    '[model_providers.fixture-local]',
    'name = "Fixture Local Gateway"',
    'base_url = "https://gateway.example.test/v1"',
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'requires_openai_auth = true',
    '',
    '[mcp_servers.untrusted_user_mcp]',
    'command = "must-not-be-inherited"',
    '',
    '[permissions.untrusted-user-profile]',
    'sandbox_mode = "danger-full-access"'
  ].join('\n'));
  const codexEnvironment = { ...process.env, CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'codex-environment-secret-fixture', OPENAI_BASE_URL: 'https://authorized-gateway.example.test/v1' };
  const codexProvider = createCodexAgentProvider({ cliProcess: fakeCli, stagingRoot: codexStagingRoot,
    codexHome, environment: codexEnvironment, authorizeOpenAiEnvironment: () => false,
    excludedRoots: [stateDir],
    resolveTaskWorkspace: ({ taskId, workspaceId }) => {
      const boundTask = taskRuntime.get({ id: taskId }).task;
      if (boundTask.workspaceId !== workspaceId) return null;
      return { task: boundTask, workspace: workspaceService.describeWorkspace(workspaceId) };
    },
    listWorkspaceRoots: async () => [authoritativeRoot, otherWorkspace, nestedWorkspace],
    applyChanges: request => taskCapabilities.applyAgentWorkspaceChanges(request),
    approvalStatus: approvalId => taskCapabilities.workspaceImportStatus(approvalId)
  });
  assert.equal(codexProvider.capabilities().available, true);
  assert.equal(codexProvider.capabilities().supportsResume, true);
  const agentBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [codexProvider] }) });
  const taskAgentService = createAgentService({ broker: agentBroker });
  await assert.rejects(() => taskAgentService.execute({ method: 'agent.createSession', params: { provider: 'codex', cwd: workspace } }),
    error => error.code === 'TASK_REQUIRED');
  await assert.rejects(() => agentBroker.createSession('codex', { taskId: task.id, workspaceId: 'wrong-workspace' }),
    error => error.code === 'TASK_WORKSPACE_MISMATCH');
  await assert.rejects(() => agentBroker.createSession('codex', {
    taskId: task.id, workspaceId: authoritative.id, modelProvider: 'different-authorized-provider'
  }), error => error.code === 'MODEL_PROVIDER_UNSUPPORTED',
  'Codex must not silently replace a Task authorized model provider with its inherited default');
  taskCapabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime, agentBroker });
  const assignment = await taskCapabilities.broker.execute({
    actor: { kind: 'owner', id: 'desktop' }, taskId: task.id, workspaceId: authoritative.id,
    capability: 'agent.run', input: { provider: 'codex', content: 'Edit the Task staging copy' }, reason: 'provider test'
  });
  assert.equal(assignment.status, 'completed');
  const codexSessionId = assignment.result.sessionId;
  const waitingStatus = await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: codexSessionId }), status => status.waitingForApproval);
  assert.equal(waitingStatus.lastRunStatus, 'waiting-for-approval');
  assert.equal(fs.existsSync(path.join(authoritativeRoot, 'codex-result-1.txt')), false, 'Codex writes staging only until Owner approval');
  await taskCapabilities.execute({ method: 'capability.approval.decide', params: { id: waitingStatus.approvalId, approve: true } });
  const completedStatus = await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: codexSessionId }),
    status => status.lastRunStatus === 'completed');
  assert.equal(completedStatus.running, false);
  assert.equal((await agentBroker.health('codex')).sandboxCapable, true,
    'Codex is eligible for automatic routing only after its required sandbox has actually executed');
  const codexCheckpoint = await waitFor(() => taskRuntime.get({ id: task.id }).task.checkpoint,
    checkpoint => checkpoint?.summary?.includes('fixture response 1'));
  assert.match(codexCheckpoint.summary, /fixture response 1/,
    'Task Follow consumes Codex events and persists the Agent result even without Chat');
  assert.equal(fs.readFileSync(path.join(authoritativeRoot, 'codex-result-1.txt'), 'utf8'), 'fake edit 1');
  const firstArgs = fakeRuns[0].args;
  assert.ok(firstArgs.includes('--json'));
  assert.ok(firstArgs.includes('--strict-config'));
  assert.ok(firstArgs.includes('--skip-git-repo-check'), 'controlled non-Git staging explicitly skips only Codex git-root trust detection');
  assert.ok(firstArgs.includes('--ignore-user-config'), 'untrusted MCP and shell configuration remain excluded');
  assert.ok(firstArgs.some(arg => arg === 'model_provider="fixture-local"'), 'the selected user model provider is inherited explicitly');
  assert.ok(firstArgs.some(arg => arg.includes('model_providers."fixture-local".base_url="https://gateway.example.test/v1"')));
  assert.ok(firstArgs.some(arg => arg === '--model') && firstArgs[firstArgs.indexOf('--model') + 1] === 'fixture-inherited-model');
  assert.equal(firstArgs.some(arg => arg.startsWith('permissions.cetamesh-task.workspace_roots.')), false,
    'Codex does not encode an absolute Windows workspace root as a CLI config path');
  const filesystemOverrides = firstArgs.filter(arg => arg.startsWith('permissions.cetamesh-task.filesystem'));
  assert.equal(filesystemOverrides.length, 1, 'Codex filesystem permissions are passed as one inline table for CLI parser compatibility');
  assert.match(filesystemOverrides[0] ?? '', /^permissions\.cetamesh-task\.filesystem=\{/);
  assert.ok(filesystemOverrides[0]?.includes('":workspace_roots"={"."="write"'),
    'the active -C staging workspace remains the only writable workspace root');
  assert.ok(!firstArgs.some(arg => arg.includes('mcp_servers') || arg.includes('danger-full-access') || arg.includes('must-not-be-inherited')));
  assert.equal(Object.hasOwn(fakeRuns[0].env, 'OPENAI_API_KEY'), false, 'a provider key is not inherited until the Owner enables the setting');
  assert.ok(!firstArgs.includes('danger-full-access'));
  const firstExecIndex = firstArgs.indexOf('exec');
  assert.ok(firstExecIndex > firstArgs.indexOf('--ask-for-approval'), 'top-level approval policy precedes exec');
  assert.ok(firstArgs.indexOf('--ignore-user-config') > firstExecIndex, 'exec flags follow the exec command');
  assert.ok(firstArgs.indexOf('--ignore-rules') > firstExecIndex, 'exec flags follow the exec command');
  assert.equal(firstArgs.at(-1), '-', 'Codex reads the prompt from stdin');
  const canonicalCodexStageRoot = fs.realpathSync.native(codexStagingRoot);
  const canonicalCodexRunRoot = fs.realpathSync.native(fakeRuns[0].cwd);
  const codexRunRelative = path.relative(canonicalCodexStageRoot, canonicalCodexRunRoot);
  assert.ok(codexRunRelative && codexRunRelative !== '..'
    && !codexRunRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(codexRunRelative),
  'Codex runs inside the canonical isolated Task staging root');
  await agentBroker.send({ provider: 'codex', sessionId: codexSessionId, content: 'Continue with the retained provider session' });
  await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: codexSessionId }),
    status => !status.running && status.lastRunStatus === 'completed');
  assert.ok(fakeRuns[1].args.includes('resume'), 'inspected resume CLI interface is used for a same-session continuation');
  const resumeArgs = fakeRuns[1].args;
  assert.ok(resumeArgs.indexOf('exec') < resumeArgs.indexOf('resume'));
  assert.ok(resumeArgs.indexOf('--ignore-user-config') > resumeArgs.indexOf('exec'));

  const continuity = createContinuityService({ stateDir, taskRuntime, agentBroker, canRollover: () => true });
  const rolled = await continuity.runtime.rollover({ taskId: task.id, reason: 'fresh-session-fixture' });
  const freshSessionId = rolled.task.currentAgent.sessionId;
  assert.notEqual(freshSessionId, codexSessionId);
  assert.ok(!fakeRuns[2].args.includes('resume'), 'Continuity starts a fresh CLI session from the Task checkpoint');
  assert.equal(fs.readFileSync(path.join(codexProvider._sessions.get(freshSessionId).stage.root, 'codex-result-1.txt'), 'utf8'), 'fake edit 1');
  await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: freshSessionId }),
    status => !status.running && status.lastRunStatus === 'completed');
  assert.equal(rolled.to.sessionId, freshSessionId,
    'the completed read-only bootstrap turn establishes the new authoritative Session');

  omitFinalNewline = true;
  await agentBroker.send({ provider: 'codex', sessionId: freshSessionId, content: 'Flush a final JSONL record without a newline' });
  const flushedFinalRecord = await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: freshSessionId }),
    status => !status.running && status.lastRunStatus === 'completed');
  assert.equal(flushedFinalRecord.errorCode, null, 'unterminated final turn.completed JSONL is flushed before finalization');

  fakeTurnFailed = true;
  await agentBroker.send({ provider: 'codex', sessionId: freshSessionId, content: 'Emit a failed Codex turn record' });
  const failedTurnStatus = await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: freshSessionId }),
    status => !status.running && status.lastRunStatus === 'failed');
  assert.equal(failedTurnStatus.errorCode, 'CODEX_TURN_FAILED');
  const failedTurnEvent = codexProvider._sessions.get(freshSessionId).events.filter(event => event.type === 'turn/end').at(-1);
  assert.deepEqual(failedTurnEvent.data.reason.error, { code: 'CODEX_TURN_FAILED', message: 'Codex execution failed' });
  assert.equal(fs.existsSync(path.join(authoritativeRoot, 'codex-failed-result.txt')), false,
    'Codex turn.failed never imports stage changes even if the CLI exits zero');
  fakeTurnFailed = false;

  fakeExitCode = 1;
  fakeStderr = 'ERROR failed to prepare fs sandbox: windows unelevated restricted-token sandbox cannot enforce split filesystem read restrictions directly; refusing to run unsandboxed at C:\\Users\\private\\workspace (secret marker)';
  await agentBroker.send({ provider: 'codex', sessionId: freshSessionId, content: 'Simulate a crashed CLI process' });
  const sandboxFailureStatus = await waitFor(() => agentBroker.status({ provider: 'codex', sessionId: freshSessionId }),
    status => status.lastRunStatus === 'failed');
  assert.equal(sandboxFailureStatus.errorCode, 'CODEX_SANDBOX_UNAVAILABLE');
  const sandboxFailureEvent = codexProvider._sessions.get(freshSessionId).events.filter(event => event.type === 'turn/end').at(-1);
  assert.deepEqual(sandboxFailureEvent.data.reason.error, {
    code: 'CODEX_SANDBOX_UNAVAILABLE',
    message: 'Codex Windows sandbox cannot enforce the configured workspace read restrictions'
  });
  assert.equal(JSON.stringify(sandboxFailureEvent).includes('C:\\Users\\private'), false,
    'Codex sandbox failure details never expose a user path or raw stderr');
  const previousTaskAgent = taskRuntime.get({ id: task.id }).task.currentAgent;
  await codexProvider.shutdown();
  fakeExitCode = 0;
  fakeStderr = '';

  const restartedProvider = createCodexAgentProvider({ cliProcess: fakeCli, stagingRoot: codexStagingRoot,
    excludedRoots: [stateDir],
    resolveTaskWorkspace: ({ taskId, workspaceId }) => {
      const boundTask = taskRuntime.get({ id: taskId }).task;
      if (boundTask.workspaceId !== workspaceId) return null;
      return { task: boundTask, workspace: workspaceService.describeWorkspace(workspaceId) };
    },
    listWorkspaceRoots: async () => [authoritativeRoot, otherWorkspace, nestedWorkspace],
    applyChanges: request => restartedCapabilities.applyAgentWorkspaceChanges(request),
    approvalStatus: approvalId => restartedCapabilities.workspaceImportStatus(approvalId)
  });
  const restartedBroker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [restartedProvider] }) });
  const restartedCapabilities = createCapabilityService({ stateDir, workspaceService, taskRuntime, agentBroker: restartedBroker });
  const recoveredAssignment = await restartedCapabilities.broker.execute({
    actor: { kind: 'owner', id: 'desktop' }, taskId: task.id, workspaceId: authoritative.id,
    capability: 'agent.run', input: { provider: 'codex', content: 'Recover from the lost CLI process' }, reason: 'crash recovery test'
  });
  assert.equal(recoveredAssignment.status, 'completed');
  assert.notEqual(recoveredAssignment.result.sessionId, previousTaskAgent.sessionId);
  await waitFor(() => restartedBroker.status({ provider: 'codex', sessionId: recoveredAssignment.result.sessionId }),
    status => !status.running && status.lastRunStatus === 'completed');

  const harborAgentSession = await restartedBroker.createSession('codex', {
    taskId: task.id, workspaceId: authoritative.id
  });
  const harborEvents = [];
  const harborAgentConfigCalls = [];
  const harborChat = createChatService({
    agentProviders: [{ id: 'codex', label: 'Codex', eventProtocol: 'agent-turn-events-v1', workspaceBoundary: 'staged-capability-broker' }],
    agentExecute: async request => {
      harborAgentConfigCalls.push(request);
      if (request.method === 'agent.selectModel') return restartedBroker.selectModel({
        provider: request.params.provider, sessionId: request.params.sessionId,
        model: request.params.model, reasoningEffort: request.params.reasoningEffort
      });
      throw new Error(`unexpected Agent method: ${request.method}`);
    },
    agentFollow: request => restartedBroker.follow({ provider: 'codex', sessionId: request.sessionId, signal: request.signal }),
    platformRoute: async ({ record, text }) => {
      await restartedBroker.send({ provider: 'codex', sessionId: harborAgentSession.sessionId, content: text });
      return { kind: 'agent', provider: 'codex', sessionId: harborAgentSession.sessionId,
        taskId: task.id, workspaceId: authoritative.id };
    },
    defaults: {}, stateDir: path.join(stateDir, 'harbor-codex-stream'), onEvent: event => harborEvents.push(event)
  });
  const harborSession = await harborChat.execute({ method: 'chat.sessions.create', params: {} });
  await harborChat.execute({ method: 'chat.config.set', params: { id: harborSession.id, config: { agentProvider: 'codex' } } });
  const expectedHarborRun = fakeRuns.length + 1;
  await harborChat.execute({ method: 'chat.send', params: { id: harborSession.id, text: 'stream a Codex answer into Harbor' } });
  await waitFor(async () => harborChat.execute({ method: 'chat.status', params: { id: harborSession.id } }), status => status.turn === null);
  assert.ok(harborEvents.some(event => event.event === 'chat.streaming' && event.data.delta === `fixture response ${expectedHarborRun}`),
    'Codex provider output enters the Harbor Chat streaming event protocol');
  assert.equal((await harborChat.execute({ method: 'chat.history', params: { id: harborSession.id } })).messages.at(-1).text,
    `fixture response ${expectedHarborRun}`);
  await harborChat.execute({ method: 'chat.config.set', params: { id: harborSession.id,
    config: { model: 'harbor-codex-model', reasoning: 'high' } } });
  assert.ok(harborAgentConfigCalls.some(call => call.method === 'agent.selectModel'
    && call.params.provider === 'codex' && call.params.sessionId === harborAgentSession.sessionId),
  'Chat applies Model and reasoning changes through the active Codex session contract');
  const beforeSecondHarborRun = fakeRuns.length;
  await harborChat.execute({ method: 'chat.send', params: { id: harborSession.id, text: 'use my new Codex settings' } });
  await waitFor(async () => harborChat.execute({ method: 'chat.status', params: { id: harborSession.id } }), status => status.turn === null);
  const secondHarborRun = fakeRuns.slice(beforeSecondHarborRun).find(run => run.sessionId.startsWith(harborAgentSession.sessionId + ':'));
  assert.ok(secondHarborRun.args.includes('--model')
    && secondHarborRun.args[secondHarborRun.args.indexOf('--model') + 1] === 'harbor-codex-model');
  assert.ok(secondHarborRun.args.some(arg => arg.includes('model_reasoning_effort="high"')));
  fakeExitCode = 1;
  await harborChat.execute({ method: 'chat.send', params: { id: harborSession.id, text: 'surface a structured Codex error' } });
  const harborError = await waitFor(async () => harborChat.execute({ method: 'chat.status', params: { id: harborSession.id } }),
    status => status.turn === null && status.lastErrorCode);
  assert.equal(harborError.lastErrorCode, 'PROVIDER_ERROR');
  assert.equal(harborError.lastError, 'Codex execution failed');
  fakeExitCode = 0;
  harborChat.close();

  const isolatedA = await restartedProvider.createSession({ taskId: task.id, workspaceId: authoritative.id,
    model: 'requested-model-a', reasoningEffort: 'low' });
  const isolatedB = await restartedProvider.createSession({ taskId: task.id, workspaceId: authoritative.id,
    model: 'requested-model-b', reasoningEffort: 'high' });
  await restartedProvider.selectModel({ sessionId: isolatedA.sessionId, model: 'selected-model-a', reasoningEffort: 'medium' });
  await restartedBroker.send({ provider: 'codex', sessionId: isolatedA.sessionId, content: 'session A config' });
  await waitFor(() => restartedBroker.status({ provider: 'codex', sessionId: isolatedA.sessionId }),
    status => !status.running && status.lastRunStatus === 'completed');
  await restartedBroker.send({ provider: 'codex', sessionId: isolatedB.sessionId, content: 'session B config' });
  await waitFor(() => restartedBroker.status({ provider: 'codex', sessionId: isolatedB.sessionId }),
    status => !status.running && status.lastRunStatus === 'completed');
  const runA = fakeRuns.find(run => run.sessionId.startsWith(isolatedA.sessionId + ':'));
  const runB = fakeRuns.find(run => run.sessionId.startsWith(isolatedB.sessionId + ':'));
  assert.ok(runA.args.includes('--model') && runA.args[runA.args.indexOf('--model') + 1] === 'selected-model-a');
  assert.ok(runA.args.some(arg => arg.includes('model_reasoning_effort="medium"')));
  assert.ok(runB.args.includes('--model') && runB.args[runB.args.indexOf('--model') + 1] === 'requested-model-b');
  assert.ok(runB.args.some(arg => arg.includes('model_reasoning_effort="high"')));
  assert.ok(!runB.args.includes('selected-model-a'), 'model selection in session A does not alter session B');
  assert.ok(!runB.args.some(arg => arg.includes('model_reasoning_effort="medium"')),
    'reasoning selection in session A does not alter session B');
  await restartedProvider.closeSession({ sessionId: isolatedA.sessionId });
  await restartedProvider.closeSession({ sessionId: isolatedB.sessionId });
  await restartedProvider.shutdown();
  await restartedProvider.shutdown();

  const cancelledApprovals = [];
  let pendingApplyCalls = 0;
  const cancelApprovalProvider = createCodexAgentProvider({
    cliProcess: fakeCli,
    stagingRoot: path.join(root, 'codex-cancel-staging'),
    createStage: async options => {
      const stage = await createStagingWorkspace(options);
      fs.writeFileSync(path.join(stage.root, 'pending-import.txt'), 'must-clean-on-cancel');
      return stage;
    },
    resolveTaskWorkspace: ({ taskId, workspaceId }) => {
      const boundTask = taskRuntime.get({ id: taskId }).task;
      return boundTask.workspaceId === workspaceId ? { task: boundTask, workspace: workspaceService.describeWorkspace(workspaceId) } : null;
    },
    listWorkspaceRoots: async () => [authoritativeRoot],
    applyChanges: async request => {
      pendingApplyCalls += 1;
      return taskCapabilities.applyAgentWorkspaceChanges(request);
    },
    approvalStatus: approvalId => taskCapabilities.workspaceImportStatus(approvalId),
    cancelApproval: async id => {
      cancelledApprovals.push(id);
      return taskCapabilities.cancelWorkspaceImportApproval(id);
    }
  });
  const cancelSession = await cancelApprovalProvider.createSession({ taskId: task.id, workspaceId: authoritative.id });
  taskRuntime.attachAgent({ id: task.id, expectedRev: taskRuntime.get({ id: task.id }).task.rev,
    provider: 'codex', sessionId: cancelSession.sessionId });
  await cancelApprovalProvider.send({ sessionId: cancelSession.sessionId, content: 'wait for Workspace import approval' });
  await waitFor(() => cancelApprovalProvider.status({ sessionId: cancelSession.sessionId }), status => status.waitingForApproval);
  const cancelStagePath = cancelApprovalProvider._sessions.get(cancelSession.sessionId).stage.root;
  const approvalCancelResult = await cancelApprovalProvider.cancel({ sessionId: cancelSession.sessionId });
  assert.equal(approvalCancelResult.state, 'cancelled');
  assert.deepEqual(cancelledApprovals, [approvalCancelResult.approvalId]);
  assert.equal(pendingApplyCalls, 1);
  assert.equal(fs.existsSync(cancelStagePath), false, 'cancel during import approval removes the staged Workspace');
  assert.equal(cancelApprovalProvider._sessions.has(cancelSession.sessionId), false, 'cancelled staging Session cannot be reused');
  assert.equal(taskCapabilities.workspaceImportStatus(approvalCancelResult.approvalId).status, 'cancelled');
  await assert.rejects(() => taskCapabilities.execute({ method: 'capability.approval.decide', params: {
    id: approvalCancelResult.approvalId, approve: true
  } }), error => error.code === 'APPROVAL_ALREADY_DECIDED',
  'a cancelled real Workspace import approval cannot be approved later');
  assert.equal(fs.existsSync(path.join(authoritativeRoot, 'pending-import.txt')), false,
    'approval cancellation prevents delayed import into the authoritative Workspace');

  let codexInstalled = false;
  let codexLoggedIn = false;
  const reprobeCli = {
    executable: () => codexInstalled ? 'codex-fixture' : null,
    probe(args) {
      if (!codexInstalled) return { available: false, stdout: '', stderr: '' };
      if (args[0] === '--version') return { available: true, stdout: 'codex-cli 9.9.9-reprobe', stderr: '' };
      if (args[0] === '--help') return { available: true, stdout: '--config --ask-for-approval --cd', stderr: '' };
      if (args[0] === 'exec' && args[1] === '--help') return { available: true, stdout: '--json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check', stderr: '' };
      if (args[0] === 'exec' && args[1] === 'resume') return { available: true, stdout: 'exec resume [SESSION_ID] --json', stderr: '' };
      if (args[0] === 'login' && args[1] === 'status') return { available: codexLoggedIn, stdout: codexLoggedIn ? 'Logged in' : 'Not logged in', stderr: '' };
      return { available: false, stdout: '', stderr: '' };
    }
  };
  const reprobeProvider = createCodexAgentProvider({ cliProcess: reprobeCli });
  assert.equal((await reprobeProvider.health()).available, false);
  codexInstalled = true;
  codexLoggedIn = true;
  const reprobeService = createAgentService({ broker: createAgentBroker({ registry: createAgentProviderRegistry({ providers: [reprobeProvider] }) }) });
  const reprobedHealth = await reprobeService.execute({ method: 'agent.health', params: { provider: 'codex', refresh: true } });
  assert.equal(reprobedHealth.available, true);
  assert.equal(reprobedHealth.installed, true, 'explicit refresh reports installed independently from authentication');
  assert.equal(reprobedHealth.authenticated, true, 'install and login after Core startup become visible through explicit reprobe');

  const authorizedProvider = createCodexAgentProvider({
    cliProcess: fakeCli, stagingRoot: path.join(root, 'codex-authorized-staging'), codexHome,
    environment: codexEnvironment, authorizeOpenAiEnvironment: () => true,
    resolveTaskWorkspace: ({ taskId, workspaceId }) => {
      const boundTask = taskRuntime.get({ id: taskId }).task;
      return boundTask.workspaceId === workspaceId ? { task: boundTask, workspace: workspaceService.describeWorkspace(workspaceId) } : null;
    },
    listWorkspaceRoots: async () => [authoritativeRoot],
    applyChanges: async () => ({ status: 'completed' })
  });
  const authorizedSession = await authorizedProvider.createSession({ taskId: task.id, workspaceId: authoritative.id });
  await authorizedProvider.send({ sessionId: authorizedSession.sessionId, content: 'use explicitly authorized environment credentials' });
  await waitFor(() => authorizedProvider.status({ sessionId: authorizedSession.sessionId }), status => !status.running);
  const authorizedRun = fakeRuns.find(run => run.sessionId.startsWith(authorizedSession.sessionId + ':'));
  assert.equal(authorizedRun.env.OPENAI_API_KEY, 'codex-environment-secret-fixture');
  assert.equal(authorizedRun.env.OPENAI_BASE_URL, 'https://authorized-gateway.example.test/v1');
  assert.deepEqual(authorizedRun.authorizedEnvKeys, ['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
  await authorizedProvider.closeSession({ sessionId: authorizedSession.sessionId });
  await authorizedProvider.shutdown();

  const unavailable = await createCodexAgentProvider({ executable: null });
  assert.equal(unavailable.capabilities().available, false);
  assert.equal(unavailable.capabilities().reason, 'not_installed');
  const zcode = await createZCodeAgentProvider({ executable: null, desktopDetected: true });
  assert.equal(zcode.id, 'zcode');
  assert.equal(zcode.capabilities().available, false);
  assert.equal(zcode.capabilities().reason, 'unsupported_external_control');
  const zcodeMissing = await createZCodeAgentProvider({ desktopDetected: false });
  assert.equal(zcodeMissing.capabilities().available, false);
  assert.equal(zcodeMissing.capabilities().reason, 'not_installed');

  const service = createDefaultAgentService({ api: null, codexExecutable: null,
    zcodeOptions: { desktopDetected: false }, zcodeExecutable: null });
  const listed = await service.execute({ method: 'agent.list' });
  assert.deepEqual(listed.providers.map(({ id }) => id), ['dsh', 'codex', 'zcode']);
  assert.equal(listed.providers.find(({ id }) => id === 'dsh').available, false);
  assert.equal(listed.providers.find(({ id }) => id === 'codex').reason, 'not_installed');
  assert.equal(listed.providers.find(({ id }) => id === 'zcode').reason, 'not_installed');
  const health = await service.execute({ method: 'agent.health', params: { provider: 'codex' } });
  assert.equal(health.available, false);
  assert.equal(health.reason, 'not_installed');
  await assert.rejects(() => service.execute({ method: 'agent.createSession', params: { provider: 'dsh', cwd: workspace } }),
    error => error.code === 'AGENT_BOUNDARY_UNSUPPORTED');
  await assert.rejects(() => service.broker.createSession('dsh', { cwd: workspace }),
    error => error.code === 'AGENT_BOUNDARY_UNSUPPORTED');
  await assert.rejects(() => service.execute({ method: 'agent.createSession', params: { provider: 'codex', cwd: workspace } }),
    error => error.code === 'TASK_REQUIRED');
  await assert.rejects(() => service.execute({ method: 'agent.configure', params: { provider: 'codex', settings: { cwd: workspace } } }),
    error => error.code === 'INVALID_PARAMS' || error.code === 'AGENT_BOUNDARY_UNSUPPORTED');
  service.close();

  const liveHealth = {
    stale: { available: true, status: 'ready' }
  };
  const fixtureProvider = (id, capabilityExtras, health) => defineAgentProvider({
    id, label: `${id} fixture`, capabilityExtras, methods: { health }
  });
  const uiAgentRegistry = createAgentProviderRegistry({ providers: [
    fixtureProvider('ready', { available: true, reason: null }, async () => ({ provider: 'ready', available: true, status: 'ready' })),
    fixtureProvider('setup', { available: true, reason: null }, async () => ({ provider: 'setup', available: false, status: 'needs_auth', reason: 'needs_auth' })),
    fixtureProvider('missing', { available: false, reason: 'not_installed' }, async () => ({ provider: 'missing', available: false, reason: 'not_installed' })),
    fixtureProvider('offline', { available: true, reason: null }, async () => ({ provider: 'offline', available: false, status: 'unavailable', reason: 'connection_lost' })),
    fixtureProvider('stale', { available: true, reason: null }, async () => liveHealth.stale),
    fixtureProvider('throwing', { available: true, reason: null, executablePath: path.join(root, 'private', 'agent.exe'), apiKey: 'sk-agent-fixture-secret' }, async () => {
      throw Object.assign(new Error('private diagnostic path and sk-agent-fixture-secret'), { code: 'PROVIDER_UNAVAILABLE' });
    }),
    fixtureProvider('dsh', { available: null, reason: null }, async () => ({ provider: 'dsh', available: false, status: 'unavailable', reason: 'not_connected' }))
  ] });
  const uiAgentService = createAgentService({
    broker: createAgentBroker({ registry: uiAgentRegistry }),
    desktopStatus: async () => ({ status: 'installed', installed: true, running: false, version: '1.0.0' })
  });
  const uiAgent = createDesktopUiService({ services: { agentService: uiAgentService } });
  const uiAgents = await uiAgent.execute({ method: 'ui.agent.list', params: {} });
  const uiAgentById = Object.fromEntries(uiAgents.agents.map(agent => [agent.id, agent]));
  assert.equal(uiAgentById.ready.status, 'ready');
  assert.equal(uiAgentById.setup.status, 'needs-setup', 'auth readiness must not be projected as ready');
  assert.equal(uiAgentById.setup.available, false);
  assert.equal(uiAgentById.missing.status, 'not-installed');
  assert.equal(uiAgentById.offline.status, 'unavailable');
  assert.equal(uiAgentById.stale.status, 'ready', 'the cached Registry readiness starts as installed');
  assert.equal(uiAgentById.throwing.status, 'unavailable', 'a thrown health check overrides stale installed readiness');
  assert.equal(uiAgentById.dsh.status, 'unavailable');
  assert.equal(uiAgentById.dsh.desktopApp.installed, true, 'DSH Desktop installation is independent from Agent availability');
  assert.doesNotMatch(JSON.stringify(uiAgents), /agent\.exe|sk-agent-fixture-secret|private diagnostic path/);
  liveHealth.stale = { provider: 'stale', available: false, status: 'not-installed', reason: 'not_installed' };
  const refreshedAgent = await uiAgent.execute({ method: 'ui.agent.health', params: { provider: 'stale' } });
  assert.equal(refreshedAgent.id, 'stale', 'the refresh path returns the registered Provider identity');
  assert.equal(refreshedAgent.status, 'not-installed', 'a refresh corrects stale ready state when the executable disappears');
  assert.equal(refreshedAgent.available, false);

  const taskRouteCalls = [];
  const chat = createChatService({
    agentProviders: [{ id: 'codex', label: 'Codex', eventProtocol: 'agent-turn-events-v1', workspaceBoundary: 'staged-capability-broker' }],
    agentExecute: async () => { throw new Error('Task-bound Codex must not use an unbound agent session API'); },
    agentFollow: async function* ({ signal }) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    platformRoute: async request => {
      taskRouteCalls.push(request);
      return { kind: 'agent', provider: 'codex', sessionId: 'codex-task-session', taskId: 'task-1', workspaceId: 'workspace-1' };
    },
    defaults: {}, stateDir: path.join(root, 'chat-state'), sleep: async () => {}
  });
  const chatSession = await chat.execute({ method: 'chat.sessions.create', params: {} });
  await chat.execute({ method: 'chat.config.set', params: { id: chatSession.id, config: { agentProvider: 'codex' } } });
  await chat.execute({ method: 'chat.send', params: { id: chatSession.id, text: 'Use the selected task provider' } });
  assert.equal(taskRouteCalls.length, 1);
  assert.equal(taskRouteCalls[0].decision.agentIntent, true);
  assert.equal(taskRouteCalls[0].record.config.agentProvider, 'codex');
  chat.close();

  const switchCalls = [];
  const providerSwitchRuntime = createDesktopPlatformRuntime({
    capabilityService: { broker: { execute: async () => assert.fail('Provider switch must use Continuity') } },
    workspaceService: { execute: async () => ({ activeId: 'workspace-switch' }) },
    taskRuntime: { get: () => ({ task: { id: 'task-switch', workspaceId: 'workspace-switch', status: 'running',
      currentAgent: { provider: 'dsh', sessionId: 'dsh-old-session' } } }) },
    agentBroker: { capabilities: () => ({ workspaceBoundary: 'staged-capability-broker' }),
      send: async request => { switchCalls.push({ kind: 'send', request }); return { accepted: true }; } },
    continuityRuntime: { rollover: async request => {
      switchCalls.push({ kind: 'rollover', request });
      return { to: { provider: 'codex', sessionId: 'codex-fresh-session' } };
    } },
    legacyModel: 'legacy-model'
  });
  const switched = await providerSwitchRuntime.route({ decision: { agentIntent: true },
    record: { taskId: 'task-switch', config: { workspaceId: 'workspace-switch', agentProvider: 'codex' } },
    text: 'Continue this Task on Codex' });
  assert.equal(switchCalls[0].kind, 'rollover');
  assert.equal(switchCalls[0].request.taskId, 'task-switch');
  assert.equal(switchCalls[0].request.targetProvider, 'codex');
  assert.equal(switchCalls[1].kind, 'send');
  assert.equal(switchCalls[1].request.provider, 'codex');
  assert.equal(switchCalls[1].request.content, 'Continue this Task on Codex');
  assert.equal(switched.provider, 'codex');
  assert.equal(switched.sessionId, 'codex-fresh-session');

  console.log('PASS provider catalog registers DSH/Codex/ZCode and gracefully reports unavailable CLIs');
  console.log('PASS Task staging copies only the selected Workspace and excludes credential/Git paths');
  console.log('PASS staged Workspace imports require Owner approval and reject stale or sensitive paths');
  console.log('PASS Task-bound Chat providers use Task assignment instead of unbound sessions');
  console.log('PASS switching providers for an existing Task goes through Continuity Fresh Session');
  console.log('PASS fake CLI execution uses minimal environment, supports cancel/timeout/resume, broker import, Fresh Session, and crash recovery');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
