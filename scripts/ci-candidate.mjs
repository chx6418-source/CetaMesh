import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadReleaseVersion, formatArtifactName, releaseArtifactDirectory} from '../src/release/version.js';

// This identity is intentionally fixed. A copied workflow or a public fork is not a builder.
const BUILDER = Object.freeze({repository:'chx6418-source/whalebridge', id:'1383743267', owner:'chx6418-source'});
const isCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function verifyCandidateSource({rootDir, expectedCommit} = {}) {
 if (!isCommit(expectedCommit)) throw Error('Explicit candidate source commit is required');
 const git = args => {
  try { return execFileSync('git', args, {cwd:rootDir, encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:1024 * 1024}).trim(); }
  catch { throw Error('Candidate source checkout cannot be verified'); }
 };
 const sourceCommit = git(['rev-parse', 'HEAD']);
 const sourceTree = git(['rev-parse', 'HEAD^{tree}']);
 if (sourceCommit !== expectedCommit) throw Error('Candidate source commit does not match the actual checkout');
 if (!isCommit(sourceTree) || git(['status', '--porcelain', '--untracked-files=normal'])) throw Error('Candidate source must be a clean reviewed checkout');
 return {sourceCommit, sourceTree};
}

export async function verifyPrivateCandidate({env = process.env, event, channel, request = globalThis.fetch} = {}) {
 if (env.GITHUB_REPOSITORY !== BUILDER.repository || env.GITHUB_REPOSITORY_ID !== BUILDER.id || env.GITHUB_REPOSITORY_OWNER !== BUILDER.owner) throw Error('Candidate requires the designated private builder');
 if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw Error('Candidate requires an explicit manual dispatch');
 if (env.GITHUB_ACTOR !== BUILDER.owner || env.GITHUB_TRIGGERING_ACTOR !== BUILDER.owner) throw Error('Candidate dispatch and rerun must be authorized by the Owner');
 const inputs = event?.inputs;
 const confirmed = value => value === true || value === 'true';
 if (!confirmed(inputs?.build_candidate) || !confirmed(inputs?.confirm_private_hold)) throw Error('Owner must confirm private internal candidate and RELEASE HOLD');
 if (!isCommit(env.GITHUB_SHA) || env.CANDIDATE_EXPECTED_COMMIT !== env.GITHUB_SHA || inputs.expected_commit !== env.GITHUB_SHA || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) throw Error('Candidate source/workflow commit must match the exact Owner-reviewed commit');
 if (!['dev', 'rc'].includes(channel) || inputs.channel !== channel) throw Error('Candidate dispatch channel mismatch');
 if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw Error('Candidate run identity/attempt is required');
 if (!env.GITHUB_TOKEN || typeof request !== 'function') throw Error('Candidate GitHub API verification is unavailable');
 const read = async suffix => {
  try {
   const response = await request(`https://api.github.com/repos/${BUILDER.repository}${suffix}`, {
    method:'GET', redirect:'error', signal:AbortSignal.timeout(15000),
    headers:{Accept:'application/vnd.github+json', Authorization:`Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version':'2022-11-28'}
   });
   if (!response.ok) throw Error('API request failed');
   return await response.json();
  } catch {
   // Do not emit response bodies, request errors, or credentials from network diagnostics.
   throw Error('Candidate GitHub API verification failed; no build/upload authorized');
  }
 };
 const matchesRepository = value => value?.full_name === BUILDER.repository && String(value?.id) === BUILDER.id && value?.private === true;
 const repository = await read('');
 if (!matchesRepository(repository) || repository.visibility !== 'private' || repository.owner?.login !== BUILDER.owner || repository.owner?.type !== 'User') throw Error('Candidate private builder identity/Owner/visibility mismatch');
 const run = await read(`/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`);
 if (String(run?.id) !== env.GITHUB_RUN_ID || String(run?.run_attempt) !== env.GITHUB_RUN_ATTEMPT || run?.event !== 'workflow_dispatch' || run?.head_sha !== env.GITHUB_SHA || !/^\.github\/workflows\/ci\.yml(?:@[^\r\n]+)?$/.test(run?.path ?? '') || !matchesRepository(run.repository) || !matchesRepository(run.head_repository) || run.actor?.login !== BUILDER.owner || run.triggering_actor?.login !== BUILDER.owner) throw Error('Candidate API run/source/workflow/Owner identity mismatch');
 return {
  repository:BUILDER.repository, repositoryId:BUILDER.id, repositoryVisibility:'private',
  runId:env.GITHUB_RUN_ID, runAttempt:env.GITHUB_RUN_ATTEMPT, owner:BUILDER.owner,
  authorization:'owner-workflow-dispatch', releaseState:'HOLD'
 };
}

export function candidateMetadata({productVersion, buildNumber, channel, commit}) {
 if (!['dev', 'rc'].includes(channel) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(productVersion) || !Number.isSafeInteger(buildNumber) || buildNumber < 0 || !isCommit(commit)) throw Error('Invalid candidate source metadata');
 return {artifactName:`cetamesh-desktop-windows-x64-${channel}-${productVersion}-${commit.slice(0, 12)}`, setup:formatArtifactName({productVersion, buildNumber, platform:'windows-x64'})};
}

function candidateReader(directory) {
 const base = fs.realpathSync(directory);
 return rel => {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw Error('Invalid candidate path');
  let current = base;
  for (const part of rel.split(/[\\/]/)) {
   current = path.join(current, part);
   if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked candidate path');
  }
  return fs.readFileSync(current);
 };
}
function candidateSums(read) {
 const sums = new Map();
 for (const line of read('SHA256SUMS.txt').toString('utf8').trim().split(/\r?\n/)) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match || sums.has(match[2])) throw Error('Invalid candidate hash manifest');
  sums.set(match[2], match[1]);
 }
 return sums;
}
export function verifyCandidate(directory, {commit, channel}) {
 const read = candidateReader(directory);
 const manifest = JSON.parse(read('release-manifest.json'));
 const meta = candidateMetadata({productVersion:manifest.version, buildNumber:manifest.buildNumber, channel:manifest.channel, commit:manifest.sourceCommit});
 if (manifest.product !== 'CetaMesh' || manifest.entry !== meta.setup || /WhaleBridge/i.test(manifest.entry)) throw Error('CetaMesh outer brand required');
 if (manifest.sourceCommit !== commit || manifest.channel !== channel) throw Error('Candidate source commit/channel mismatch');
 const sums = candidateSums(read);
 for (const file of [meta.setup, 'release-manifest.json', 'sbom.json', 'licenses/THIRD-PARTY.md']) if (!sums.has(file)) throw Error('Missing candidate hash entry');
 for (const [file, expected] of sums) if (digest(read(file)) !== expected) throw Error('Candidate hash integrity mismatch');
 for (const [file, expected] of Object.entries(manifest.files ?? {})) if (digest(read(file)) !== expected) throw Error('Candidate manifest hash mismatch');
 JSON.parse(read('sbom.json'));
 return manifest;
}

export function prepareCandidateUpload(directory, destination, {source, authorization, channel}) {
 if (!isCommit(source?.sourceCommit) || !isCommit(source?.sourceTree) || authorization?.releaseState !== 'HOLD' || authorization?.repository !== BUILDER.repository || authorization?.repositoryId !== BUILDER.id || authorization?.repositoryVisibility !== 'private' || authorization?.authorization !== 'owner-workflow-dispatch') throw Error('Verified private candidate source and Owner authorization required');
 const manifest = verifyCandidate(directory, {commit:source.sourceCommit, channel});
 const read = candidateReader(directory);
 const sums = candidateSums(read);
 const selected = [manifest.entry, 'release-manifest.json', 'sbom.json', ...[...sums.keys()].filter(file => /^licenses\/(?:[^/\\]+\/)*[^/\\]+\.(?:md|txt|json)$/i.test(file))].sort();
 // Refuse replacement rather than removing or overlaying a previous candidate.
 fs.mkdirSync(destination, {recursive:false});
 const files = {};
 for (const file of selected) {
  const bytes = read(file);
  if (digest(bytes) !== sums.get(file)) throw Error('Candidate changed during upload preparation');
  const output = path.join(destination, file);
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, bytes, {flag:'wx'});
  files[file] = digest(bytes);
 }
 const provenance = {
  schemaVersion:1, product:'CetaMesh', ...source, ...authorization, channel,
  version:manifest.version, buildNumber:manifest.buildNumber,
  releaseManifestSha256:files['release-manifest.json'], sourceSha256SumsSha256:digest(read('SHA256SUMS.txt')),
  files, notVerified:['malware clearance', 'code signing', 'native installation', 'WebView2', 'Guest', 'real QQ/DSH']
 };
 const receipt = `${JSON.stringify(provenance, null, 2)}\n`;
 fs.writeFileSync(path.join(destination, 'candidate-provenance.json'), receipt, {flag:'wx'});
 const uploadSums = {...files, 'candidate-provenance.json':digest(receipt)};
 fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), Object.keys(uploadSums).sort().map(file => `${uploadSums[file]}  ${file}`).join('\n') + '\n', {flag:'wx'});
 return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
 const args = process.argv.slice(2);
 const channelIndex = args.indexOf('--channel');
 const channel = channelIndex >= 0 ? args[channelIndex + 1] : 'dev';
 const commit = process.env.GITHUB_SHA;
 const expected = process.env.CANDIDATE_EXPECTED_COMMIT;
 if (args.includes('--require-expected') && (!expected || expected !== commit)) throw Error('Candidate dispatch requires the exact published source commit');
 const source = verifyCandidateSource({rootDir:root, expectedCommit:commit});
 let authorization;
 if (args.includes('--private-builder')) {
  let event;
  try { event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); }
  catch { throw Error('Candidate manual dispatch event cannot be verified'); }
  authorization = await verifyPrivateCandidate({event, channel});
 }
 if (args.includes('--source-only')) {
  console.log(JSON.stringify({...source, ...authorization, releaseState:'HOLD'}));
  process.exit(0);
 }
 const release = loadReleaseVersion({rootDir:root});
 if (channel === 'rc' && release.channel !== 'rc') throw Error('RC candidate requires the canonical RC release channel');
 const meta = candidateMetadata({...release, channel, commit});
 const releaseDirectory = releaseArtifactDirectory({rootDir:root, ...release, channel});
 const uploadParent = path.join(root, 'artifacts', 'private-candidates');
 const directory = path.join(uploadParent, meta.artifactName);
 if (args.includes('--verify')) {
  if (!authorization) throw Error('Candidate upload requires verified private builder authorization');
  fs.mkdirSync(uploadParent, {recursive:true});
  prepareCandidateUpload(releaseDirectory, directory, {source, authorization, channel});
  console.log('PASS private candidate structure, hashes, Owner authorization and source; security/native acceptance remain HOLD');
 } else {
  const outputs = {...meta, directory};
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(outputs)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(outputs));
 }
}
