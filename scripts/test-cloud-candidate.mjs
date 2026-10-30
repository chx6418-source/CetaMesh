import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parse} from 'yaml';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cloud-candidate-'));
try {
 const mod = await import('./ci-candidate.mjs');
 const sha = 'a'.repeat(40);
 const meta = mod.candidateMetadata({productVersion:'1.0.0-rc.2', buildNumber:1124, channel:'dev', commit:sha});
 assert.equal(meta.artifactName, 'cetamesh-desktop-windows-x64-dev-1.0.0-rc.2-aaaaaaaaaaaa');
 assert.match(meta.setup, /^CetaMesh-Setup-/);
 const digest = x => crypto.createHash('sha256').update(x).digest('hex');
 fs.mkdirSync(path.join(root, 'licenses'));
 fs.writeFileSync(path.join(root, 'licenses', 'THIRD-PARTY.md'), 'fixture licenses');
 const body = 'SYNTHETIC_NON_EXECUTABLE_CANDIDATE';
 fs.writeFileSync(path.join(root, meta.setup), body);
 fs.writeFileSync(path.join(root, 'sbom.json'), '{}');
 const manifest = {product:'CetaMesh', version:'1.0.0-rc.2', channel:'dev', buildNumber:1124, sourceCommit:sha, entry:meta.setup, files:{[meta.setup]:digest(body)}};
 const writeManifest = () => {
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), [meta.setup, 'sbom.json', 'release-manifest.json', 'licenses/THIRD-PARTY.md'].map(p => digest(fs.readFileSync(path.join(root, p))) + '  ' + p).join('\n'));
 };
 writeManifest();
 assert.equal(mod.verifyCandidate(root, {commit:sha, channel:'dev'}).entry, meta.setup);
 fs.appendFileSync(path.join(root, meta.setup), 'tamper');
 assert.throws(() => mod.verifyCandidate(root, {commit:sha, channel:'dev'}), /hash|integrity/i);
 fs.writeFileSync(path.join(root, meta.setup), body);
 assert.throws(() => mod.verifyCandidate(root, {commit:'b'.repeat(40), channel:'dev'}), /source|commit/i);
 manifest.entry = 'WhaleBridge-Setup.exe';
 writeManifest();
 assert.throws(() => mod.verifyCandidate(root, {commit:sha, channel:'dev'}), /brand|CetaMesh/i);
 manifest.entry = meta.setup;
 writeManifest();

 // Removing the authenticated Owner/private/run gate must reopen this regression.
 assert.equal(typeof mod.verifyPrivateCandidate, 'function', 'Private candidate must require authenticated Owner dispatch, not just repository.private');
 const env = {
  GITHUB_REPOSITORY:'chx6418-source/whalebridge', GITHUB_REPOSITORY_ID:'1383743267',
  GITHUB_REPOSITORY_OWNER:'chx6418-source', GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_SHA:sha, GITHUB_WORKFLOW_SHA:sha, CANDIDATE_EXPECTED_COMMIT:sha,
  GITHUB_ACTOR:'chx6418-source', GITHUB_TRIGGERING_ACTOR:'chx6418-source',
  GITHUB_RUN_ID:'12345', GITHUB_RUN_ATTEMPT:'1', GITHUB_TOKEN:'SYNTHETIC_READ_ONLY_TOKEN'
 };
 const event = {inputs:{build_candidate:'true', confirm_private_hold:'true', expected_commit:sha, channel:'dev'}};
 const repository = {id:1383743267, full_name:'chx6418-source/whalebridge', private:true, visibility:'private', owner:{login:'chx6418-source', type:'User'}};
 const run = {
  id:12345, run_attempt:1, event:'workflow_dispatch', head_sha:sha,
  path:'.github/workflows/ci.yml@codex/reviewed-source', repository, head_repository:repository,
  actor:{login:'chx6418-source'}, triggering_actor:{login:'chx6418-source'}
 };
 const calls = [];
 const request = async (url, options) => {
  calls.push({url, options});
  if (url === 'https://api.github.com/repos/chx6418-source/whalebridge') return {ok:true, json:async () => repository};
  if (url === 'https://api.github.com/repos/chx6418-source/whalebridge/actions/runs/12345/attempts/1') return {ok:true, json:async () => run};
  throw new Error('Unexpected network destination');
 };
 const verified = await mod.verifyPrivateCandidate({env, event, channel:'dev', request});
 assert.deepEqual(verified, {
  repository:'chx6418-source/whalebridge', repositoryId:'1383743267', repositoryVisibility:'private',
  runId:'12345', runAttempt:'1', owner:'chx6418-source', authorization:'owner-workflow-dispatch', releaseState:'HOLD'
 });
 assert.equal(calls.length, 2);
 for (const call of calls) {
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, 'Bearer SYNTHETIC_READ_ONLY_TOKEN');
 }
 const rejectsBeforeNetwork = async (changes, eventChanges, pattern) => {
  const count = calls.length;
  await assert.rejects(mod.verifyPrivateCandidate({env:{...env, ...changes}, event:{inputs:{...event.inputs, ...eventChanges}}, channel:'dev', request}), pattern);
  assert.equal(calls.length, count, 'Unapproved dispatch must not use the API token');
 };
 await rejectsBeforeNetwork({GITHUB_REPOSITORY:'chx6418-source/CetaMesh'}, {}, /private builder/i);
 await rejectsBeforeNetwork({GITHUB_REPOSITORY_ID:'111'}, {}, /private builder/i);
 await rejectsBeforeNetwork({GITHUB_EVENT_NAME:'push'}, {}, /manual|dispatch/i);
 await rejectsBeforeNetwork({GITHUB_ACTOR:'collaborator'}, {}, /Owner/i);
 await rejectsBeforeNetwork({GITHUB_TRIGGERING_ACTOR:'collaborator'}, {}, /Owner/i);
 await rejectsBeforeNetwork({}, {confirm_private_hold:'false'}, /confirm|HOLD/i);
 await rejectsBeforeNetwork({}, {build_candidate:'false'}, /confirm|candidate/i);
 await rejectsBeforeNetwork({}, {expected_commit:'b'.repeat(40)}, /commit/i);
 await rejectsBeforeNetwork({}, {channel:'rc'}, /channel/i);
 await rejectsBeforeNetwork({GITHUB_WORKFLOW_SHA:'b'.repeat(40)}, {}, /workflow|commit/i);
 await rejectsBeforeNetwork({GITHUB_SHA:'a'.repeat(41), CANDIDATE_EXPECTED_COMMIT:'a'.repeat(41)}, {expected_commit:'a'.repeat(41)}, /commit/i);
 await rejectsBeforeNetwork({GITHUB_RUN_ATTEMPT:'0'}, {}, /run|attempt/i);
 await assert.rejects(mod.verifyPrivateCandidate({env, event, channel:'dev', request:async () => ({ok:false, status:403})}), /verify|API/i);
 await assert.rejects(mod.verifyPrivateCandidate({env, event, channel:'dev', request:async () => { throw new Error('SYNTHETIC_READ_ONLY_TOKEN'); }}), error => !error.message.includes('SYNTHETIC_READ_ONLY_TOKEN'));
 const mutateResponse = async (which, replacement, pattern) => {
  await assert.rejects(mod.verifyPrivateCandidate({env, event, channel:'dev', request:async (url, options) => {
   if (which === 'repository' && url.endsWith('/whalebridge')) return {ok:true, json:async () => ({...repository, ...replacement})};
   if (which === 'run' && url.endsWith('/attempts/1')) return {ok:true, json:async () => ({...run, ...replacement})};
   return request(url, options);
  }}), pattern);
 };
 await mutateResponse('repository', {private:false, visibility:'public'}, /private/i);
 await mutateResponse('repository', {id:111}, /private builder/i);
 await mutateResponse('repository', {owner:{login:'chx6418-source', type:'Organization'}}, /Owner|private builder/i);
 await mutateResponse('run', {head_sha:'b'.repeat(40)}, /run|commit/i);
 await mutateResponse('run', {event:'push'}, /run|dispatch/i);
 await mutateResponse('run', {path:'.github/workflows/other.yml'}, /workflow|run/i);
 await mutateResponse('run', {run_attempt:2}, /run|attempt/i);
 await mutateResponse('run', {actor:{login:'collaborator'}}, /Owner|run/i);
 await mutateResponse('run', {triggering_actor:{login:'collaborator'}}, /Owner|run/i);
 await mutateResponse('run', {head_repository:{...repository, id:111}}, /repository|run/i);


 // Full assembly may contain Core/Shell, but the downloaded bundle has only intended files.
 const rawCore = 'SYNTHETIC_INTERNAL_CORE_DO_NOT_UPLOAD';
 fs.writeFileSync(path.join(root, 'WhaleBridgeCore.exe'), rawCore);
 manifest.files['WhaleBridgeCore.exe'] = digest(rawCore);
 writeManifest();
 fs.appendFileSync(path.join(root, 'SHA256SUMS.txt'), '\n' + digest(rawCore) + '  WhaleBridgeCore.exe');
 const upload = path.join(root, 'upload');
 const receipt = mod.prepareCandidateUpload(root, upload, {source:{sourceCommit:sha, sourceTree:'c'.repeat(40)}, authorization:verified, channel:'dev'});
 assert.equal(receipt.releaseState, 'HOLD');
 assert.equal(receipt.sourceTree, 'c'.repeat(40));
 assert.equal(receipt.releaseManifestSha256, digest(fs.readFileSync(path.join(root, 'release-manifest.json'))));
 assert.equal(receipt.sourceSha256SumsSha256, digest(fs.readFileSync(path.join(root, 'SHA256SUMS.txt'))));
 assert.equal(fs.existsSync(path.join(upload, 'WhaleBridgeCore.exe')), false);
 assert.equal(fs.readFileSync(path.join(upload, meta.setup), 'utf8'), body);
 assert.equal(JSON.stringify(receipt).includes('SYNTHETIC_READ_ONLY_TOKEN'), false);
 const uploadedSums = fs.readFileSync(path.join(upload, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
 assert.equal(uploadedSums.length, 5);
 for (const line of uploadedSums) {
  const [sum, file] = line.split('  ');
  assert.equal(digest(fs.readFileSync(path.join(upload, file))), sum, 'Every download checksum must resolve to an included file');
 }
 assert.throws(() => mod.prepareCandidateUpload(root, path.join(root, 'unapproved'), {source:{sourceCommit:sha, sourceTree:'c'.repeat(40)}, authorization:{...verified, repositoryVisibility:'public'}, channel:'dev'}), /private|authorization/i);
 assert.equal(fs.existsSync(path.join(root, 'unapproved')), false);
 assert.throws(() => mod.prepareCandidateUpload(root, upload, {source:{sourceCommit:sha, sourceTree:'c'.repeat(40)}, authorization:verified, channel:'dev'}), /exist/i);

 // Real Git checkout: a detached exact commit passes; wrong SHA and dirty source fail.
 const gitRoot = path.join(root, 'source');
 fs.mkdirSync(gitRoot);
 const git = args => execFileSync('git', args, {cwd:gitRoot, encoding:'utf8', windowsHide:true}).trim();
 git(['init', '--quiet']);
 fs.writeFileSync(path.join(gitRoot, 'reviewed.txt'), 'reviewed source');
 git(['add', 'reviewed.txt']);
 git(['-c', 'user.name=Candidate Fixture', '-c', 'user.email=candidate@example.invalid', 'commit', '--quiet', '-m', 'reviewed fixture']);
 const actual = git(['rev-parse', 'HEAD']);
 git(['checkout', '--quiet', '--detach', actual]);
 assert.deepEqual(mod.verifyCandidateSource({rootDir:gitRoot, expectedCommit:actual}), {sourceCommit:actual, sourceTree:git(['rev-parse', 'HEAD^{tree}'])});
 assert.throws(() => mod.verifyCandidateSource({rootDir:gitRoot, expectedCommit:sha}), /commit/i);
 fs.appendFileSync(path.join(gitRoot, 'reviewed.txt'), 'unreviewed mutation');
 assert.throws(() => mod.verifyCandidateSource({rootDir:gitRoot, expectedCommit:actual}), /clean|reviewed/i);

 const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
 const candidate = workflow.jobs['release-build'];
 assert.equal(workflow.permissions.contents, 'read');
 assert.equal(candidate.permissions.actions, 'read');
 assert.equal(candidate.permissions.contents, 'read');
 assert.equal(workflow.on.workflow_dispatch.inputs.confirm_private_hold.default, false);
 assert.match(candidate.if, /github\.event\.repository\.private/);
 assert.match(candidate.if, /github\.actor == github\.repository_owner/);
 assert.match(candidate.if, /github\.triggering_actor == github\.repository_owner/);
 const checkout = candidate.steps.find(step => step.uses?.startsWith('actions/checkout@'));
 assert.equal(checkout.with.ref, '${{ inputs.expected_commit }}');
 assert.equal(checkout.with['persist-credentials'], false);
 const gate = candidate.steps.findIndex(step => step.run?.includes('--private-builder') && step.run.includes('--source-only'));
 const install = candidate.steps.findIndex(step => step.run === 'npm ci');
 assert.ok(gate >= 0 && gate < install, 'Private approval must precede install scripts and builds');
 assert.ok(!candidate.env.GITHUB_TOKEN, 'Build subprocesses must not inherit the API token');
 const finalGate = candidate.steps.findIndex(step => step.run?.includes('--private-builder') && step.run.includes('--verify'));
 const uploadIndex = candidate.steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
 assert.equal(finalGate + 1, uploadIndex, 'Visibility and Owner/run identity must be rechecked immediately before private artifact upload');
 assert.match(candidate.steps[uploadIndex].with.path, /candidate-provenance\.json/);
 for (const job of Object.values(workflow.jobs)) for (const permission of Object.values(job.permissions ?? workflow.permissions)) assert.notEqual(permission, 'write', 'Candidate workflow must not acquire publication permissions');
 assert.equal(workflow.jobs.test.steps.some(step => step.run?.includes('--private-builder')), false, 'Public source CI does not require private builder identity');
 assert.ok(!JSON.stringify(workflow).includes('sync-gitcode-release'));
 console.log('PASS candidate hashes/brand, exact real Git source, authenticated Owner/private builder and manual workflow gates; no product binary executed');
} finally {
 fs.rmSync(root, {recursive:true, force:true});
}
