import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { computeAgentExpansionFingerprint } from '../src/agent/expansion-provenance.js';

const root = path.resolve(import.meta.dirname, '..');
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-source-safety-')));
const preload = path.join(temporaryRoot, 'guard.mjs');
const core = path.join(temporaryRoot, 'synthetic-core');
const objectId = 'a'.repeat(40);
const outcomes = [];
fs.mkdirSync(path.join(core, 'resources'), { recursive: true });
const coreBytes = Buffer.from('MZ synthetic input; never executed');
fs.writeFileSync(path.join(core, 'WhaleBridgeCore.exe'), coreBytes);
fs.writeFileSync(path.join(core, 'runtime-manifest.json'), JSON.stringify({
  noWebUi: true, legacyHttp: false, uiDistribution: 'native-no-web', executable: 'WhaleBridgeCore.exe',
  executableSha256: crypto.createHash('sha256').update(coreBytes).digest('hex'),
  agentExpansion: { contractVersion: 1, sourceFingerprint: computeAgentExpansionFingerprint(root) }
}));
fs.writeFileSync(preload, `
import fs from 'node:fs';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spec = JSON.parse(fs.readFileSync(process.env.BUILD_SOURCE_FIXTURE, 'utf8'));
const record = row => { const fd = fs.openSync(spec.effects, 'a'); try { fs.writeSync(fd, JSON.stringify(row) + '\\n'); } finally { fs.closeSync(fd); } };
for (const name of ['mkdirSync', 'mkdtempSync', 'rmSync', 'copyFileSync', 'writeFileSync', 'appendFileSync', 'renameSync']) {
  fs[name] = () => { record({ effect: name }); throw Error('CONTROLLED_BUILD_EFFECT_BOUNDARY'); };
}
child.spawnSync = (program, args) => {
  if (program === 'git') {
    if (spec.scenario === 'spawn-error') return { status: null, error: { code: 'ENOENT' } };
    if (args[0] === 'status') return spec.scenario === 'status-error'
      ? { status: 128, stdout: '', stderr: 'synthetic Git failure' }
      : { status: 0, stdout: spec.dirty ? ' M synthetic-owned-input' : '', stderr: '' };
    if (args.includes('--short')) {
      if (spec.scenario === 'short-error') return { status: 128, stdout: '', stderr: '' };
      return { status: 0, stdout: spec.scenario === 'short-mismatch' ? 'b'.repeat(7) : spec.objectId.slice(0, 7), stderr: '' };
    }
    if (spec.scenario === 'commit-error') return { status: 128, stdout: '', stderr: '' };
    return { status: 0, stdout: spec.scenario === 'commit-empty' ? '' : spec.scenario === 'commit-invalid' ? 'not-an-object-id' : spec.objectId, stderr: '' };
  }
  record({ effect: 'spawn', program: String(program), args });
  return { status: 86, stdout: '', stderr: 'CONTROLLED_BUILD_EFFECT_BOUNDARY' };
};
child.spawn = () => { record({ effect: 'spawn-async' }); throw Error('CONTROLLED_BUILD_EFFECT_BOUNDARY'); };
syncBuiltinESMExports();
`);
function check(name, body) {
  try { body(); outcomes.push({ name, status: 'PASS' }); }
  catch (error) { outcomes.push({ name, status: 'FAIL', message: error.message }); }
}
function run(file, args, scenario = 'ok', dirty = false) {
  const id = crypto.randomUUID(), effects = path.join(temporaryRoot, id + '.effects');
  const config = path.join(temporaryRoot, id + '.json');
  fs.writeFileSync(config, JSON.stringify({ effects, scenario, objectId, dirty }));
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'scripts', file), ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, BUILD_SOURCE_FIXTURE: config, npm_execpath: process.env.npm_execpath || 'synthetic-npm-cli' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, 'fixture must finish, not merely time out');
  return { ...result, text: (result.stdout || '') + (result.stderr || ''), effects: fs.existsSync(effects) ? fs.readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}
const releaseArgs = ['--use-current-build-number', '--core-dir', core, '--shell-exe', path.join(temporaryRoot, 'never-run.exe')];
try {
  for (const dev of [false, true]) {
    for (const scenario of ['spawn-error', 'status-error', 'commit-error', 'commit-empty', 'commit-invalid', 'short-error', 'short-mismatch']) {
      check((dev ? 'DEV' : 'formal') + ' rejects ' + scenario + ' before build effects', () => {
        const result = run('build-release.mjs', [...(dev ? ['--dev'] : []), ...releaseArgs], scenario);
        assert.equal(result.status, 1, result.text);
        assert.match(result.text, /SOURCE_(?:GIT_QUERY_FAILED|COMMIT_INVALID|COMMIT_SHORT_MISMATCH)/);
        assert.deepEqual(result.effects, [], 'unavailable source identity must not dispatch UI, write staging, or package');
      });
    }
  }
  check('known clean formal source reaches controlled UI boundary', () => {
    const result = run('build-release.mjs', releaseArgs);
    assert.match(result.text, /CONTROLLED_BUILD_EFFECT_BOUNDARY/);
    assert.ok(result.effects.some(row => row.args?.includes('build:ui')));
  });
  check('known dirty formal source still rejects before build effects', () => {
    const result = run('build-release.mjs', releaseArgs, 'ok', true);
    assert.equal(result.status, 1);
    assert.match(result.text, /formal Release requires a clean source tree/);
    assert.deepEqual(result.effects, []);
  });
  check('known dirty DEV source retains its controlled UI path', () => {
    const result = run('build-release.mjs', ['--dev', ...releaseArgs], 'ok', true);
    assert.match(result.text, /CONTROLLED_BUILD_EFFECT_BOUNDARY/);
    assert.ok(result.effects.some(row => row.args?.includes('build:ui')));
  });
  for (const [label, args] of [['missing', ['--out']], ['empty', ['--out', '']], ['option-valued', ['--out', '--no-verify']]]) {
    check('Core ' + label + ' output argument rejects before filesystem effects', () => {
      const result = run('build-core.mjs', args);
      assert.equal(result.status, 1);
      assert.match(result.text, /CORE_OUT_ARGUMENT_REQUIRED/);
      assert.deepEqual(result.effects, []);
    });
  }
  for (const [label, args] of [['default', []], ['explicit', ['--out', path.join(temporaryRoot, 'valid-output')]]]) {
    check('Core ' + label + ' output retains its controlled build path', () => {
      const result = run('build-core.mjs', args);
      if (process.platform === 'win32' && process.arch === 'x64') {
        assert.match(result.text, /CONTROLLED_BUILD_EFFECT_BOUNDARY/);
        assert.deepEqual(result.effects.map(row => row.effect), ['mkdirSync']);
      } else {
        assert.equal(result.status, 1, 'unsupported Core build host still rejects');
        assert.deepEqual(result.effects, [], 'unsupported build hosts must not write output');
      }
    });
  }
  for (const row of outcomes) console.log(JSON.stringify(row));
  assert.equal(outcomes.filter(row => row.status === 'FAIL').length, 0, 'actual build-source safety entry regressions failed');
  console.log('PASS actual build source identity and malformed output guards; synthetic inputs and blocked build effects only');
} finally {
  assert.equal(path.dirname(temporaryRoot).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase(), 'cleanup stays within the verified temporary root');
  assert.ok(path.basename(temporaryRoot).startsWith('build-source-safety-'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}