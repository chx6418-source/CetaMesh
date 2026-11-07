import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {createOpenAiCompatibleModelProvider} from '../src/model/index.js';
import {createTaskStore} from '../src/task/store.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const original = 'export const add = (a, b) => a;\n';
const broken = 'export const add = (a, b) => a - b;\n';
const repaired = 'export const add = (a, b) => a + b;\n';
const testInput = {tool: 'npm', args: ['test'], timeoutMs: 30000};

// Only this suite-owned project and immutable verifier run. There is no remote
// model, user project, installation, arbitrary package task or native UI input.
async function scenario(control) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-feedback-')));
  const project = path.join(root, 'project'), stateDir = path.join(root, 'state');
  const requests = [], approvals = [], results = [];
  let services, taskId, modelError, faultInjected = false, accepted = false;
  fs.mkdirSync(project);
  const files = {
    'math.mjs': original,
    'package.json': JSON.stringify({private: true, type: 'module', scripts: {test: 'node verify.mjs'}}) + '\n',
    'verify.mjs': [
      "import assert from 'node:assert/strict'; import {add} from './math.mjs';",
      "import fs from 'node:fs'; fs.appendFileSync('../test-starts.log', 'started\\n');",
      "assert.equal(add(2, 4), 6, 'A03_ADD_POSITIVE');",
      "assert.equal(add(-2, 5), 3, 'A03_ADD_NEGATIVE');",
      "assert.equal(add(0, 0), 0, 'A03_ADD_ZERO');",
      "assert.equal(add(Number.MAX_SAFE_INTEGER - 1, 1), Number.MAX_SAFE_INTEGER, 'A03_ADD_BOUNDARY');",
      "console.log('A03_CURRENT_CODE_VERIFIED');\n"
    ].join('\n')
  };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(project, file), content);
  const protectedHashes = Object.fromEntries(['package.json', 'verify.mjs'].map(file => [file, sha(files[file])]));
  const hashFile = file => sha(fs.readFileSync(path.join(project, file)));
  const testStarts = () => fs.existsSync(path.join(root, 'test-starts.log'))
    ? fs.readFileSync(path.join(root, 'test-starts.log'), 'utf8').trim().split('\n').length : 0;
  const assertProtected = () => {
    for (const [file, digest] of Object.entries(protectedHashes)) assert.equal(hashFile(file), digest, 'immutable verifier: ' + file);
    assert.deepEqual(fs.readdirSync(project).sort(), ['.git', 'math.mjs', 'package.json', 'verify.mjs']);
  };
  const call = (id, capability, input) => ({index: 0, id, type: 'function', function: {
    name: 'cap_' + capability.replace(/[^A-Za-z0-9_-]/g, '_'), arguments: JSON.stringify(input)
  }});
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({data: [{id: 'fixture', capabilities: {tools: true, streaming: true}}]})); return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body); requests.push(request);
      const step = requests.length - 1;
      const receipt = id => JSON.parse(request.messages.findLast(row => row.role === 'tool' && row.tool_call_id === id)?.content ?? 'null');
      let tool;
      if (step === 0) tool = call('introduce-error', 'filesystem.write', {path: 'math.mjs', expectedHash: sha(original), content: broken});
      if (step === 1) {
        assert.equal(hashFile('math.mjs'), sha(broken), 'first approved model write actually introduced the defect');
        assert.equal(receipt('introduce-error')?.status, 'completed');
        tool = call('red-test', 'test.run', testInput);
      }
      if (control === 'repair') {
        if (step === 2) {
          const failed = receipt('red-test');
          assert.equal(failed?.status, 'completed');
          assert.notEqual(failed?.result?.exitCode, 0);
          assert.match(failed.result.stderr + failed.result.stdout, /A03_ADD_POSITIVE/,
            'the next actual HTTP inference request carries the real assertion diagnostic');
          tool = call('repair-error', 'filesystem.write', {path: 'math.mjs', expectedHash: sha(broken), content: repaired});
        }
        if (step === 3) {
          assert.equal(hashFile('math.mjs'), sha(repaired));
          assert.equal(receipt('repair-error')?.status, 'completed');
          tool = call('green-test', 'test.run', testInput);
        }
        if (step === 4) {
          const passed = receipt('green-test');
          assert.equal(passed?.result?.exitCode, 0); assert.match(passed.result.stdout, /A03_CURRENT_CODE_VERIFIED/);
          tool = call('current-diff', 'git.diff', {});
        }
        assert.ok(step <= 5, 'bounded correction must not request another model cycle');
      } else if (control === 'reject' && step === 2) {
        assert.ok(receipt('red-test'), 'rejection feedback reaches the next model request');
      } else if (step > 1) throw Error('unexpected inference after unknown/rejected action');
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const delta = tool ? {tool_calls: [tool]} : {content: 'Report only. Core and Owner retain acceptance authority.'};
      res.write('data: ' + JSON.stringify({choices: [{index: 0, delta, finish_reason: null}]}) + '\n\n');
      res.write('data: ' + JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 4}}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) { modelError = error; res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {message: 'Fixture assertion failed'}})); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    for (const args of [['init', '-q', project], ['-C', project, 'config', 'core.autocrlf', 'false'], ['-C', project, 'add', '.'],
      ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline']]) execFileSync('git', args, {stdio: 'ignore'});
    const providerId = 'verification-loop-fixture';
    const credentials = createProviderSecrets({root: path.join(root, 'credentials')});
    credentials.set({provider: providerId, apiKey: 'synthetic-loopback-only'});
    services = createCetaMeshServices({stateDir, dataRoot: path.join(root, 'data'), agentStagingRoot: path.join(root, 'staging'), providerSecrets: credentials});
    services.modelRegistry.register(createOpenAiCompatibleModelProvider({id: providerId, label: 'Synthetic loopback verifier model',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', defaultModel: 'fixture', supportsTools: true, secrets: credentials}));
    if (control === 'unknown-write') {
      const execute = services.workspaceService.execute.bind(services.workspaceService);
      services.workspaceService.execute = async request => {
        const result = await execute(request);
        if (request.method === 'workspace.write' && !faultInjected) {
          faultInjected = true;
          throw Object.assign(new Error('Fixture lost the real write settlement receipt'), {code: 'FIXTURE_WRITE_RECEIPT_LOST', effectStatus: 'unknown'});
        }
        return result;
      };
    }
    const workspace = (await services.workspaceService.execute({method: 'workspace.create', params: {root: project, name: 'Verification ' + control}})).workspace;
    const created = await services.desktopUiService.execute({method: 'ui.task.create', params: {
      goal: 'Implement add in math.mjs and verify using only the unchanged fixture npm test; report actual evidence.',
      workspaceId: workspace.id, agentProvider: 'cetamesh', modelProvider: providerId, model: 'fixture', requestId: 'feedback-' + control,
      collaboration: {enabled: true, allowUnknownCost: false, prepareNative: false, verification: {editablePaths: ['math.mjs'], testFiles: ['verify.mjs']}}
    }});
    taskId = created.task.id;
    const rt = services.taskService.runtime, originalTask = rt.get({id: taskId}).task;
    const acceptance = structuredClone(originalTask.acceptance), goal = originalTask.goal;
    const grant = services.capabilityService.principalForTask(taskId);
    assert.ok(grant.grants.capabilities.includes('test.run'), 'formal creation explicitly grants request-only tests');
    assert.deepEqual(originalTask.delegationPolicy.verification.unchangedFiles,
      Object.entries(protectedHashes).map(([path, sha256]) => ({path, sha256})), 'Core independently snapshots the fixed verifier');
    const deadline = Date.now() + 25000, decided = new Set();
    let current;
    while (Date.now() < deadline) {
      if (modelError) throw modelError;
      for (const approval of services.capabilityService.broker.approvals.list()) {
        if (approval.status !== 'pending' || approval.request?.taskId !== taskId || decided.has(approval.id)) continue;
        const request = approval.request; assertProtected();
        assert.notEqual(rt.get({id: taskId}).task.status, 'completed', 'a write or model final cannot complete the Task');
        if (request.capability === 'filesystem.write') {
          assert.equal(request.input.path, 'math.mjs');
          assert.equal(hashFile('math.mjs'), request.input.expectedHash, 'approval owns the exact current preimage');
        } else {
          assert.equal(request.capability, 'test.run'); assert.deepEqual(request.input, testInput);
          assert.equal(testStarts(), results.filter(row => row.capability === 'test.run').length,
            'the actual fixed Node verifier never starts before its specific approval');
          assert.equal(results.filter(row => row.capability === 'test.run').length, control === 'repair' && request.input && hashFile('math.mjs') === sha(repaired) ? 1 : 0,
            'pending test has not executed before its own approval');
        }
        decided.add(approval.id);
        approvals.push({id: approval.id, requestId: request.requestId, operationId: request.operationId, capability: request.capability});
        let result;
        try {
          result = await services.capabilityService.execute({method: 'capability.approval.decide', params: {id: approval.id,
            approve: !(control === 'reject' && request.capability === 'test.run')}});
        } catch (error) {
          assert.equal(control, 'unknown-write'); assert.equal(error.effectStatus, 'unknown');
          result = {status: 'outcome-unknown', error: {code: error.code}};
        }
        results.push({capability: request.capability, ...result});
      }
      current = rt.get({id: taskId}).task;
      if (current.executionObservation?.state === 'awaiting-review' || ['unknown', 'cancel-unconfirmed'].includes(current.executionObservation?.state)) break;
      if (control === 'unknown-write' && current.executionEvidence.some(row => row.status === 'outcome-unknown')
        && !(await services.agentBroker.status(current.currentAgent)).running) break;
      await delay(20);
    }
    if (modelError) throw modelError;
    assertProtected();
    assert.equal(current.goal, goal); assert.deepEqual(current.acceptance, acceptance, 'model never marks original acceptance met');
    assert.notEqual(current.status, 'completed');
    const tests = current.executionEvidence.filter(row => row.source === 'core-test');
    if (control === 'repair') {
      assert.equal(current.executionObservation?.state, 'awaiting-review');
      assert.equal(requests.length, 6, 'real write/test/repair/retest/diff/final cycles');
      assert.deepEqual(tests.map(row => row.exitCode === 0), [false, true]);
      assert.notEqual(tests[0].eventId, tests[1].eventId); assert.notEqual(tests[0].operationId, tests[1].operationId);
      const testApprovals = approvals.filter(row => row.capability === 'test.run');
      assert.equal(new Set(testApprovals.map(row => row.requestId)).size, 2);
      assert.equal(new Set(testApprovals.map(row => row.operationId)).size, 2);
      assert.equal(testStarts(), 2, 'two approvals start exactly two actual Node verifiers');
      assert.ok(testApprovals.every(row => row.operationId !== current.delegationPolicy.verification.operationId),
        'red feedback does not consume or replay the prepared final verification operation');
      for (const row of tests) {
        assert.equal(row.runId, current.executionObservation.runId); assert.equal(row.sessionId, current.currentAgent.sessionId);
        assert.match(row.resultSha256, /^[a-f0-9]{64}$/);
      }
      assert.equal(hashFile('math.mjs'), sha(repaired));
      assert.deepEqual(execFileSync('git', ['-C', project, 'diff', '--name-only'], {encoding: 'utf8'}).trim().split(/\r?\n/), ['math.mjs']);
      assert.equal((await services.taskService.execute({method: 'task.outcome.verify', params: {id: taskId, kind: 'code', requireCurrentCodeEvidence: true}})).status,
        'NEEDS_REVIEW', 'current tests do not silently satisfy Owner acceptance');
      for (const item of current.acceptance) {
        current = rt.get({id: taskId}).task;
        await services.taskService.execute({method: 'task.acceptance.set', params: {id: taskId, expectedRev: current.rev, acceptanceId: item.id, met: true}});
      }
      const verified = await services.taskService.execute({method: 'task.outcome.verify', params: {id: taskId, kind: 'code', requireCurrentCodeEvidence: true}});
      assert.equal(verified.status, 'VERIFIED', JSON.stringify(verified));
      assert.ok(verified.evidenceEventIds.includes(tests[1].eventId));
      assert.equal((await services.taskService.execute({method: 'task.outcome.verify', params: {id: taskId, kind: 'file',
        expectedFile: 'math.mjs', expectedSha256: sha(repaired)}})).status, 'VERIFIED',
      'Core independently opens and hashes the current Task artifact against the fixture-owned expected code');
      current = rt.get({id: taskId}).task;
      assert.equal(current.executionObservation.state, 'awaiting-review', 'read-only machine evidence query does not complete the Task');
      const completed = await services.desktopUiService.execute({method: 'ui.task.complete', params: {id: taskId, expectedRev: current.rev, reviewed: true,
        summary: 'Fixture Owner independently verified original criteria, exact source hash, immutable verifier, current Core test and changed-file scope.'}});
      assert.equal(completed.task.status, 'completed'); accepted = true;
      await services.agentBroker.closeSession(current.currentAgent);
      const saved = createTaskStore({stateDir}).get(taskId);
      assert.equal(saved.status, 'completed');
      assert.deepEqual(saved.executionEvidence.filter(row => row.source === 'core-test').map(row => [row.eventId, row.operationId, row.exitCode]),
        tests.map(row => [row.eventId, row.operationId, row.exitCode]), 'reloaded Core store retains both failed and successful test receipts');
      console.log('PASS A03 real local HTTP model -> approved faulty write -> actual Node failure -> next-request diagnostic -> approved repair -> fresh approved pass -> Core current evidence / independent Owner file checks');
    } else if (control === 'reject') {
      assert.equal(current.executionObservation?.state, 'awaiting-review'); assert.equal(requests.length, 3);
      assert.equal(tests.length, 0); assert.equal(hashFile('math.mjs'), sha(broken));
      assert.equal(testStarts(), 0, 'rejection starts no actual Node verifier');
      assert.equal(results.find(row => row.capability === 'test.run')?.status, 'rejected');
      console.log('PASS rejected test approval starts no verifier and cannot complete the Task');
    } else {
      assert.equal(faultInjected, true); assert.equal(hashFile('math.mjs'), sha(broken), 'fault occurs after real write, before receipt');
      assert.equal(requests.length, 1, 'unknown write cannot dispatch another model request or post-write test');
      assert.equal(tests.length, 0); assert.equal(approvals.filter(row => row.capability === 'test.run').length, 0);
      assert.equal(testStarts(), 0, 'unknown write starts no implicit verifier');
      assert.ok(current.executionEvidence.some(row => row.capability === 'filesystem.write' && row.status === 'outcome-unknown'));
      console.log('PASS unknown actual write retains evidence and prevents model correction/test replay');
    }
  } finally {
    if (services && taskId && !accepted) {
      const task = services.taskService.runtime.get({id: taskId}).task;
      if (task.currentAgent) try { await services.agentBroker.cancel(task.currentAgent); } catch {}
      if (!['cancelled', 'completed', 'failed'].includes(task.status)) try { services.taskService.runtime.cancel({id: taskId, expectedRev: task.rev, reason: 'Suite-owned fixture cleanup'}); } catch {}
    }
    if (services) for (const name of ['autonomousHandoff', 'chatService', 'agentService', 'managedAgent', 'capabilityService', 'extensionService']) await services[name].close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}
await scenario('repair');
await scenario('reject');
await scenario('unknown-write');
console.log('NOT_RUN: remote model and native installed product; automatic post-write command/LSP trigger is outside this explicit approved correction loop');
