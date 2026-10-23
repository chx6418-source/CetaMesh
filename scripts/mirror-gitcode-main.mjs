#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_REPO = 'https://github.com/chx6418-source/CetaMesh.git';
const GITCODE_REPO = 'https://gitcode.com/ygdnn/CetaMesh.git';
const SHA = /^[0-9a-f]{40}$/;

function git(repositoryPath, env, ...args) {
  const result = spawnSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = (result.stderr || result.error?.message || '').trim()
      .replaceAll(env.GITCODE_MIRROR_TOKEN || '\0', '[REDACTED_SECRET]');
    throw new Error(`git ${args[0]} failed (${result.status}): ${diagnostic}`);
  }
  return result.stdout.trim();
}

function readRemoteMain(repositoryPath, env, url) {
  const result = git(repositoryPath, env, 'ls-remote', '--exit-code', url, 'refs/heads/main');
  const match = result.match(/^([0-9a-f]{40})\trefs\/heads\/main$/);
  if (!match) throw new Error('Remote main returned an unexpected ref');
  return match[1];
}

export async function syncGitcodeMain({ repositoryPath, sourceUrl, targetUrl, expectedSourceSha, env = process.env }) {
  if (!SHA.test(expectedSourceSha || '')) throw new Error('Expected source SHA must be a full commit SHA');
  const sourceSha = git(repositoryPath, env, 'rev-parse', 'HEAD');
  if (sourceSha !== expectedSourceSha) throw new Error('Checkout differs from the triggering GitHub SHA');
  const latestSourceSha = readRemoteMain(repositoryPath, env, sourceUrl);
  if (sourceSha !== latestSourceSha) throw new Error('GitHub main advanced; refusing a stale mirror run');

  const sourceTree = git(repositoryPath, env, 'rev-parse', `${sourceSha}^{tree}`);
  git(repositoryPath, env, 'fetch', '--no-tags', targetUrl, 'refs/heads/main');
  const targetBefore = git(repositoryPath, env, 'rev-parse', 'FETCH_HEAD');
  const targetTree = git(repositoryPath, env, 'rev-parse', `${targetBefore}^{tree}`);
  if (sourceTree === targetTree) {
    // Make the unchanged result conditional on GitCode still pointing at the fetched commit.
    // A normal no-op push rejects a concurrent advance, including one between fetch and check.
    git(repositoryPath, env, 'push', '--no-follow-tags', targetUrl, `${targetBefore}:refs/heads/main`);
    if (readRemoteMain(repositoryPath, env, targetUrl) !== targetBefore) {
      throw new Error('GitCode main moved during the unchanged mirror check');
    }
    return { status: 'unchanged', sourceSha, targetBefore, targetAfter: targetBefore, treeSha: sourceTree };
  }

  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: 'CetaMesh Mirror',
    GIT_AUTHOR_EMAIL: 'mirror@cetamesh.com',
    GIT_COMMITTER_NAME: 'CetaMesh Mirror',
    GIT_COMMITTER_EMAIL: 'mirror@cetamesh.com',
  };
  const proposed = git(repositoryPath, commitEnv, 'commit-tree', sourceTree,
    '-p', targetBefore, '-p', sourceSha,
    '-m', 'mirror: align GitCode main tree with public GitHub main');
  if (git(repositoryPath, env, 'rev-parse', `${proposed}^{tree}`) !== sourceTree) {
    throw new Error('Proposed mirror tree differs from GitHub main');
  }
  // A normal push rejects any concurrent GitCode update; never force or push tags.
  git(repositoryPath, env, 'push', '--no-follow-tags', targetUrl, `${proposed}:refs/heads/main`);
  const targetAfter = readRemoteMain(repositoryPath, env, targetUrl);
  if (targetAfter !== proposed) throw new Error('GitCode main moved again after the mirror push');
  return { status: 'updated', sourceSha, targetBefore, targetAfter, treeSha: sourceTree };
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'chx6418-source/CetaMesh' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Mirror can run only for public CetaMesh main');
  }
  const token = process.env.GITCODE_MIRROR_TOKEN;
  if (!token) throw new Error('GITCODE_MIRROR_TOKEN secret is missing');
  const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-gitcode-askpass-'));
  const askPass = path.join(credentialDir, 'askpass.sh');
  fs.writeFileSync(askPass, `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'ygdnn' ;;\n  *Password*) printf '%s\\n' "$GITCODE_MIRROR_TOKEN" ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o700 });
  try {
    const result = await syncGitcodeMain({
      repositoryPath: process.cwd(),
      sourceUrl: PUBLIC_REPO,
      targetUrl: GITCODE_REPO,
      expectedSourceSha: process.env.GITHUB_SHA,
      env: { ...process.env, GIT_ASKPASS: askPass, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    });
    console.log(`GitCode main ${result.status}: ${result.targetAfter}; public tree ${result.treeSha}`);
  } finally {
    fs.rmSync(credentialDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message.replaceAll(process.env.GITCODE_MIRROR_TOKEN || '\0', '[REDACTED_SECRET]'));
    process.exitCode = 1;
  });
}
