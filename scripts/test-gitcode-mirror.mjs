#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncGitcodeMain } from './mirror-gitcode-main.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-mirror-test-'));
const source = path.join(root, 'public');
const target = path.join(root, 'gitcode.git');
const targetWork = path.join(root, 'gitcode-work');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

try {
  fs.mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(source, 'README.md'), 'Public source\n');
  fs.mkdirSync(path.join(source, 'apps', 'mobile'), { recursive: true });
  fs.writeFileSync(path.join(source, 'apps', 'mobile', 'entry.txt'), 'mobile\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'public main');
  git(source, 'tag', '-a', 'V1.0.0-rc2-2', '-m', 'Public release tag with the same name');
  git(source, 'tag', '-a', 'V1.1.2', '-m', 'Public-only release tag');
  git(source, 'config', 'push.followTags', 'true');
  const publicHead = git(source, 'rev-parse', 'HEAD');
  const publicTree = git(source, 'rev-parse', 'HEAD^{tree}');

  execFileSync('git', ['init', '--bare', target], { encoding: 'utf8' });
  execFileSync('git', ['clone', target, targetWork], { encoding: 'utf8' });
  git(targetWork, 'checkout', '-b', 'main');
  git(targetWork, 'config', 'user.name', 'Fixture');
  git(targetWork, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(targetWork, 'README.md'), 'Existing GitCode history\n');
  git(targetWork, 'add', '.');
  git(targetWork, 'commit', '-m', 'GitCode main');
  git(targetWork, 'tag', 'V1.0.0-rc2-2');
  git(targetWork, 'push', 'origin', 'main', 'V1.0.0-rc2-2');
  const oldGitcodeHead = git(targetWork, 'rev-parse', 'HEAD');
  const releaseTag = git(target, 'rev-parse', 'refs/tags/V1.0.0-rc2-2');

  const first = await syncGitcodeMain({
    repositoryPath: source,
    sourceUrl: source,
    targetUrl: target,
    expectedSourceSha: publicHead,
  });
  assert.equal(first.status, 'updated');
  const mirroredHead = git(target, 'rev-parse', 'refs/heads/main');
  assert.equal(git(target, 'rev-parse', `${mirroredHead}^{tree}`), publicTree);
  assert.equal(git(target, 'rev-list', '--parents', '-n', '1', mirroredHead),
    `${mirroredHead} ${oldGitcodeHead} ${publicHead}`);
  assert.equal(git(target, 'rev-parse', 'refs/tags/V1.0.0-rc2-2'), releaseTag);
  assert.equal(git(target, 'tag', '--list'), 'V1.0.0-rc2-2');

  const second = await syncGitcodeMain({
    repositoryPath: source,
    sourceUrl: source,
    targetUrl: target,
    expectedSourceSha: publicHead,
  });
  assert.equal(second.status, 'unchanged');
  assert.equal(git(target, 'rev-parse', 'refs/heads/main'), mirroredHead);

  // A different GitCode writer advances main while the unchanged push is in flight.
  // The pre-push hook makes the race deterministic, so success cannot hide divergence.
  git(targetWork, 'fetch', 'origin', 'main');
  git(targetWork, 'checkout', '-b', 'concurrent', 'origin/main');
  fs.writeFileSync(path.join(targetWork, 'README.md'), 'Concurrent GitCode edit\n');
  git(targetWork, 'add', 'README.md');
  git(targetWork, 'commit', '-m', 'concurrent edit');
  git(targetWork, 'push', 'origin', 'HEAD:refs/heads/race-fixture');
  const concurrentHead = git(targetWork, 'rev-parse', 'HEAD');
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  const hookMarker = path.join(hooks, 'race-executed');
  fs.writeFileSync(path.join(hooks, 'pre-push'),
    `#!/bin/sh\ngit -C "${target}" update-ref refs/heads/main ${concurrentHead} && printf 'executed' > "${hookMarker}"\n`,
    { mode: 0o700 }); // POSIX Git ignores non-executable hooks.
  git(source, 'config', 'core.hooksPath', hooks);
  await assert.rejects(syncGitcodeMain({
    repositoryPath: source,
    sourceUrl: source,
    targetUrl: target,
    expectedSourceSha: publicHead,
  }), /git push failed|GitCode main moved/);
  assert.equal(fs.readFileSync(hookMarker, 'utf8'), 'executed', 'concurrent writer hook must actually run');
  assert.equal(git(target, 'rev-parse', 'refs/heads/main'), concurrentHead);
  console.log('PASS GitCode mirror keeps prior history and tag, matches public tree, and is idempotent');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
