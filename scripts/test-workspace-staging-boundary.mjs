import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStagingWorkspace, collectStagedChanges, cleanupStagingWorkspace, refreshStagingBaseline } from '../src/workspace/staging.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-stage-boundary-'));
const source = path.join(root, 'parent', 'source');
const nested = path.join(source, 'nested');
const other = path.join(root, 'other');
const stageRoot = path.join(root, 'stages');
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(other);
fs.writeFileSync(path.join(source, 'safe.txt'), 'safe');
fs.writeFileSync(path.join(nested, 'private.txt'), 'nested-secret');
fs.writeFileSync(path.join(other, 'private.txt'), 'other-secret');

const stage = async (options = {}) => createStagingWorkspace({
  taskId: 'task', workspaceId: 'workspace', sourceRoot: source, stagingRoot: stageRoot,
  additionalWorkspaceRoots: [nested, other], ...options
});

try {
  const gitSource=path.join(root,'git-project');fs.mkdirSync(gitSource);
  const git=(...args)=>execFileSync('git',['-c','core.fsmonitor=false','-C',gitSource,...args],{stdio:'pipe',windowsHide:true});
  git('init','-q');
  fs.writeFileSync(path.join(gitSource,'.gitignore'),'dist/\ntarget/\n.worktrees/\nignored.tmp\n');
  fs.writeFileSync(path.join(gitSource,'main.ts'),'source');
  for(const name of ['dist','target','.worktrees']){fs.mkdirSync(path.join(gitSource,name));fs.writeFileSync(path.join(gitSource,name,'large.bin'),Buffer.alloc(512));}
  fs.writeFileSync(path.join(gitSource,'dist','tracked.ts'),'tracked');
  fs.writeFileSync(path.join(gitSource,'ignored.tmp'),Buffer.alloc(512));
  fs.writeFileSync(path.join(gitSource,'new.ts'),'new');
  git('add','.gitignore','main.ts');git('add','-f','dist/tracked.ts');
  const gitStage=await createStagingWorkspace({taskId:'git-snapshot',workspaceId:'git',sourceRoot:gitSource,stagingRoot:stageRoot,maxBytes:128});
  assert.deepEqual([...gitStage.baseline.keys()].sort(),['.gitignore','dist/tracked.ts','main.ts','new.ts']);
  assert.equal(fs.existsSync(path.join(gitStage.root,'dist','large.bin')),false);
  assert.deepEqual(collectStagedChanges(gitStage).changes,[]);
  fs.appendFileSync(path.join(gitStage.root,'.gitignore'),'main.ts\nnew.ts\n');
  fs.unlinkSync(path.join(gitStage.root,'new.ts'));
  assert.equal(collectStagedChanges(gitStage).changes.some(row=>row.path==='new.ts'&&row.action==='delete'),true,'new ignore rules cannot hide baseline deletions');
  cleanupStagingWorkspace(gitStage);
  fs.writeFileSync(path.join(gitSource,'real-source.bin'),Buffer.alloc(256));
  await assert.rejects(createStagingWorkspace({taskId:'real-limit',workspaceId:'git',sourceRoot:gitSource,stagingRoot:stageRoot,maxBytes:128}),error=>error.code==='STAGING_TOO_LARGE','nonignored source still obeys byte limit');
  console.log('PASS Git-ignored build outputs excluded, tracked ignored paths and new source retained, selection fixed for comparisons');

  for (const trackedOutput of [false, true]) {
    const project=path.join(root, 'late-output-'+trackedOutput); fs.mkdirSync(project);
    const gitLate=(...args)=>execFileSync('git',['-c','core.fsmonitor=false','-C',project,...args],{stdio:'pipe',windowsHide:true});
    gitLate('init','--quiet');
    fs.writeFileSync(path.join(project,'.gitignore'),'dist/\n');
    fs.writeFileSync(path.join(project,'main.ts'),'source');
    gitLate('add','.gitignore','main.ts');
    if (trackedOutput) { fs.mkdirSync(path.join(project,'dist')); fs.writeFileSync(path.join(project,'dist','tracked.ts'),'tracked'); gitLate('add','-f','dist/tracked.ts'); }
    const pending=await createStagingWorkspace({taskId:'late-output',workspaceId:'git',sourceRoot:project,stagingRoot:stageRoot,maxBytes:128});
    assert.deepEqual(collectStagedChanges(pending).changes,[], 'tracked files in ignored directories remain visible');
    for (const base of [project,pending.root]) { fs.mkdirSync(path.join(base,'dist'),{recursive:true}); fs.writeFileSync(path.join(base,'dist','new.bin'),Buffer.alloc(512)); }
    fs.writeFileSync(path.join(pending.root,'main.ts'),'edited');
    assert.deepEqual(collectStagedChanges(pending).changes.map(row=>row.path),['main.ts']);
    fs.writeFileSync(path.join(project,'main.ts'),'edited');
    assert.equal(refreshStagingBaseline(pending).files,trackedOutput?3:2);
    cleanupStagingWorkspace(pending);
  }
  console.log('PASS late-created ignored outputs stay outside collection and baseline refresh');

  for (const sourceSubdir of ['', 'package']) {
    const project=path.join(root,'nested-ignore-'+(sourceSubdir||'root')); fs.mkdirSync(project);
    execFileSync('git',['init','--quiet',project],{stdio:'pipe',windowsHide:true});
    fs.writeFileSync(path.join(project,'.gitignore'),(sourceSubdir?'package/':'')+'build/*\n!'+(sourceSubdir?'package/':'')+'build/keep/\n');
    const input=path.join(project,sourceSubdir); fs.mkdirSync(path.join(input,'build','keep'),{recursive:true});
    fs.writeFileSync(path.join(input,'build','keep','.gitignore'),'*.tmp\n!retained.tmp\n');
    fs.writeFileSync(path.join(input,'build','keep','main.ts'),'source');
    const pending=await createStagingWorkspace({taskId:'nested-ignore',workspaceId:'git',sourceRoot:input,stagingRoot:stageRoot,maxBytes:256});
    for (const base of [input,pending.root]) {
      fs.mkdirSync(path.join(base,'build','output'),{recursive:true});
      fs.writeFileSync(path.join(base,'build','output','big.bin'),Buffer.alloc(512));
      fs.writeFileSync(path.join(base,'build','keep','scratch.tmp'),Buffer.alloc(512));
    }
    fs.writeFileSync(path.join(pending.root,'build','keep','retained.tmp'),'new source');
    fs.writeFileSync(path.join(pending.root,'build','keep','main.ts'),'edited');
    fs.appendFileSync(path.join(pending.root,'build','keep','.gitignore'),'main.ts\nretained.tmp\n');
    const selected=collectStagedChanges(pending).changes;
    assert.deepEqual(selected.map(row=>row.path),['build/keep/.gitignore','build/keep/main.ts','build/keep/retained.tmp']);
    for (const change of selected) fs.writeFileSync(path.join(input,change.path),change.content);
    assert.equal(refreshStagingBaseline(pending).files,sourceSubdir?3:4);
    assert.deepEqual(collectStagedChanges(pending).changes,[]);
    cleanupStagingWorkspace(pending);
  }
  console.log('PASS frozen nested ignore rules, negations and repository subdirectory snapshots');

  const emptyProject=path.join(root,'git-empty-directory'); fs.mkdirSync(path.join(emptyProject,'src'),{recursive:true});
  execFileSync('git',['init','--quiet',emptyProject],{stdio:'pipe',windowsHide:true});
  fs.writeFileSync(path.join(emptyProject,'main.ts'),'source');
  const nestedRepo=path.join(emptyProject,'packages','vendor');fs.mkdirSync(nestedRepo,{recursive:true});
  execFileSync('git',['init','--quiet',nestedRepo],{stdio:'pipe',windowsHide:true});
  fs.writeFileSync(path.join(nestedRepo,'other.ts'),'other repository');
  const emptyStage=await createStagingWorkspace({taskId:'new-directory',workspaceId:'git',sourceRoot:emptyProject,stagingRoot:stageRoot,maxBytes:128});
  assert.equal(fs.existsSync(path.join(emptyStage.root,'packages','vendor')),false);
  fs.mkdirSync(path.join(emptyStage.root,'packages','vendor'),{recursive:true});fs.writeFileSync(path.join(emptyStage.root,'packages','vendor','other.ts'),'nested write');
  fs.mkdirSync(path.join(emptyStage.root,'src'),{recursive:true});fs.writeFileSync(path.join(emptyStage.root,'src','new.ts'),'new source');
  assert.deepEqual(collectStagedChanges(emptyStage).changes.map(row=>row.path),['src/new.ts'],'initially empty source directory must allow new staged files');
  fs.writeFileSync(path.join(emptyProject,'src','new.ts'),'new source');
  assert.equal(refreshStagingBaseline(emptyStage).files,2);cleanupStagingWorkspace(emptyStage);
  console.log('PASS initially empty nonignored directories accept new source files');

  const configProject=path.join(root,'git-exclude-config');fs.mkdirSync(configProject);
  const configGit=(...args)=>execFileSync('git',['-C',configProject,...args],{stdio:'pipe',windowsHide:true});
  configGit('init','--quiet');
  const globalIgnore=path.join(root,'global-ignore');fs.writeFileSync(globalIgnore,'global-build/\n');
  configGit('config','core.excludesFile',globalIgnore);
  fs.appendFileSync(path.join(configProject,'.git','info','exclude'),'local-build/\n');
  fs.writeFileSync(path.join(configProject,'main.ts'),'source');
  const configStage=await createStagingWorkspace({taskId:'git-excludes',workspaceId:'git',sourceRoot:configProject,stagingRoot:stageRoot,maxBytes:128});
  for (const base of [configProject,configStage.root]) for (const dir of ['global-build','local-build']) { fs.mkdirSync(path.join(base,dir));fs.writeFileSync(path.join(base,dir,'output.bin'),Buffer.alloc(512)); }
  fs.writeFileSync(path.join(configStage.root,'main.ts'),'edited');
  assert.deepEqual(collectStagedChanges(configStage).changes.map(row=>row.path),['main.ts']);
  fs.writeFileSync(path.join(configProject,'main.ts'),'edited');
  assert.equal(refreshStagingBaseline(configStage).files,1);cleanupStagingWorkspace(configStage);
  console.log('PASS frozen Git global and repository-local exclusion rules');
  const noisySource = path.join(root, 'noisy-project'); fs.mkdirSync(noisySource);
  fs.writeFileSync(path.join(noisySource, 'main.ts'), 'source');
  for (const dir of ['node_modules', '.pnpm-store', '.npm-cache']) {
    fs.mkdirSync(path.join(noisySource, dir));
    fs.writeFileSync(path.join(noisySource, dir, 'large.bin'), Buffer.alloc(512));
  }
  const browser = path.join(noisySource, '.edge-fixture'); fs.mkdirSync(path.join(browser, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(browser, 'Local State'), 'browser profile metadata');
  fs.writeFileSync(path.join(browser, 'Default', 'Cookies'), Buffer.alloc(512));
  const filtered = await createStagingWorkspace({ taskId: 'filtered', workspaceId: 'noisy', sourceRoot: noisySource, stagingRoot: stageRoot, maxBytes: 64 });
  assert.deepEqual([...filtered.baseline.keys()], ['main.ts'], 'dependency caches and real browser profiles are not Task input');
  assert.equal(fs.existsSync(path.join(filtered.root, '.edge-fixture')), false, 'browser profile data never enters Agent staging');
  assert.deepEqual(collectStagedChanges(filtered).changes, []);
  fs.writeFileSync(path.join(filtered.root, 'main.ts'), 'updated');
  assert.equal(collectStagedChanges(filtered).changes[0].path, 'main.ts');
  fs.writeFileSync(path.join(noisySource, 'main.ts'), 'updated');
  assert.equal(refreshStagingBaseline(filtered).files, 1, 'import refresh uses the same fixed snapshot exclusions');
  fs.mkdirSync(path.join(filtered.root, 'Default'));
  fs.writeFileSync(path.join(filtered.root, 'Local State'), 'new marker must not hide original source files');
  assert.equal(collectStagedChanges(filtered).changes.some(change => change.action === 'delete'), false);
  cleanupStagingWorkspace(filtered);
  await assert.rejects(createStagingWorkspace({ taskId: 'profile', workspaceId: 'profile', sourceRoot: browser, stagingRoot: stageRoot }),
    error => error.code === 'STAGING_PATH_DENIED', 'a browser profile root must not become Agent input');
  fs.writeFileSync(path.join(noisySource, 'real-data.bin'), Buffer.alloc(128));
  await assert.rejects(createStagingWorkspace({ taskId: 'too-big', workspaceId: 'noisy', sourceRoot: noisySource, stagingRoot: stageRoot, maxBytes: 64 }),
    error => error.code === 'STAGING_TOO_LARGE' && /项目|子目录/.test(error.message), 'real source data still respects the bound and explains recovery');
  console.log('PASS generated dependencies/browser profiles excluded, real source size limit preserved');

  const normal = await stage();
  assert.equal(fs.readFileSync(path.join(normal.root, 'safe.txt'), 'utf8'), 'safe');
  assert.equal(fs.existsSync(path.join(normal.root, 'nested')), false);
  cleanupStagingWorkspace(normal);
  console.log('PASS normal staging excludes another nested Workspace');

  const liveSource = path.join(root, 'live-source'); fs.mkdirSync(liveSource);
  fs.writeFileSync(path.join(liveSource, 'runtime.txt'), 'before');
  const readOnlyStage = await createStagingWorkspace({ taskId: 'read-only', workspaceId: 'live', sourceRoot: liveSource, stagingRoot: stageRoot });
  fs.writeFileSync(path.join(liveSource, 'runtime.txt'), 'external update');
  assert.deepEqual(collectStagedChanges(readOnlyStage).changes, [], 'read-only turn has nothing to import and must not fail on source drift');
  fs.writeFileSync(path.join(readOnlyStage.root, 'runtime.txt'), 'agent update');
  assert.throws(() => collectStagedChanges(readOnlyStage), error => error.code === 'WORKSPACE_RECONCILIATION_REQUIRED', 'real staged writes still reject source conflicts');
  cleanupStagingWorkspace(readOnlyStage);
  const scanStage = await createStagingWorkspace({ taskId: 'read-only-scan', workspaceId: 'live', sourceRoot: liveSource, stagingRoot: stageRoot });
  const originalReadDir = fs.readdirSync;
  const checkedSource = fs.realpathSync.native(liveSource);
  try {
    fs.readdirSync = function(target, ...args) {
      // The production walk canonicalizes roots. Windows runners can return a
      // different drive-letter case or alias than the temp path spelling.
      if (fs.realpathSync.native(String(target)) === checkedSource) throw Object.assign(new Error('synthetic live directory unavailable'), { code: 'EACCES' });
      return originalReadDir.call(this, target, ...args);
    };
    assert.deepEqual(collectStagedChanges(scanStage).changes, [], 'no-op turn must not rescan live source or be blocked by transient source reads');
    fs.writeFileSync(path.join(scanStage.root, 'new.txt'), 'needs import');
    assert.throws(() => collectStagedChanges(scanStage), error => error.code === 'STAGING_READ_FAILED', 'actual imports still fail closed when source cannot be checked');
  } finally { fs.readdirSync = originalReadDir; cleanupStagingWorkspace(scanStage); }
  console.log('PASS read-only turns survive live source drift/read failures while real imports retain conflict/read guards');


  // Missing stagingRoot formerly resolved to cwd inside isInsideRoot(), allowing
  // provider shutdown to recursively delete the caller's current directory.
  const originalCwd = process.cwd();
  const protectedRoot = path.join(root, 'protected-cleanup-target');
  fs.mkdirSync(protectedRoot);
  const protectedFile = path.join(protectedRoot, 'keep.txt');
  fs.writeFileSync(protectedFile, 'must survive invalid cleanup');
  try {
    process.chdir(protectedRoot);
    for (const malformed of [
      { root: protectedRoot },
      { root: protectedRoot, stagingRoot: null },
      { root: protectedRoot, stagingRoot: 7 },
      { root: protectedRoot, stagingRoot: root + '\0' },
      { root: '', stagingRoot: root },
      { root: null, stagingRoot: root },
      { root: 7, stagingRoot: root },
      { root: protectedRoot + '\0', stagingRoot: root },
      { root: protectedRoot, stagingRoot: '' },
      { root: protectedRoot, stagingRoot: '.' },
      { root: '.', stagingRoot: root },
      { root: protectedRoot, stagingRoot: protectedRoot },
      { root: protectedRoot + path.sep + '.', stagingRoot: protectedRoot },
      { stagingRoot: root }
    ]) {
      assert.throws(() => cleanupStagingWorkspace(malformed),
        error => error.code === 'STAGING_PATH_INVALID',
        'invalid stage ownership must fail before filesystem removal');
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'must survive invalid cleanup');
    }
  } finally { process.chdir(originalCwd); }
  console.log('PASS malformed cleanup metadata cannot remove cwd or an aliased staging base');

  const disposable = await stage();
  cleanupStagingWorkspace(disposable);
  assert.equal(fs.existsSync(disposable.root), false);
  assert.deepEqual(cleanupStagingWorkspace(disposable), { removed: false });
  console.log('PASS owned staging cleanup remains idempotent');

  if (process.platform === 'win32') {
    const cased = await stage({ additionalWorkspaceRoots: [nested.toUpperCase(), other] });
    assert.equal(fs.existsSync(path.join(cased.root, 'nested')), false);
    cleanupStagingWorkspace(cased);
    console.log('PASS Windows case alias excludes nested Workspace');

    try {
      const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${nested}") do @echo %~sI`], { encoding: 'utf8' }).trim();
      if (!short || !short.includes('~') || !fs.existsSync(short)) {
        console.log('NOT_RUN_ENVIRONMENT Windows 8.3 alias fixture unavailable on this volume');
      } else {
        const aliased = await stage({ additionalWorkspaceRoots: [short, other] });
        assert.equal(fs.existsSync(path.join(aliased.root, 'nested')), false);
        cleanupStagingWorkspace(aliased);
        console.log('PASS Windows 8.3 alias excludes nested Workspace');
      }
    } catch (error) {
      console.log(`NOT_RUN_ENVIRONMENT Windows 8.3 alias fixture unavailable: ${error?.code ?? 'unknown'}`);
    }
  }

  await assert.rejects(stage({ stagingRoot: path.join(source, '..', 'source', 'stages') }),
    error => error.code === 'STAGING_ROOT_OVERLAPS_WORKSPACE');
  await assert.rejects(stage({ additionalWorkspaceRoots: [path.dirname(source)] }),
    error => error.code === 'WORKSPACE_OVERLAP');
  console.log('PASS path escape and parent Workspace fail closed');

  for (const kind of ['junction', 'dir']) {
    const alias = path.join(root, `${kind}-alias`);
    try { fs.symlinkSync(source, alias, kind); }
    catch (error) {
      console.log(`NOT_RUN_ENVIRONMENT ${kind} fixture unavailable: ${error?.code ?? 'unknown'}`);
      continue;
    }
    await assert.rejects(stage({ stagingRoot: path.join(alias, 'stages') }),
      error => error.code === 'STAGING_ROOT_OVERLAPS_WORKSPACE');
    assert.throws(() => cleanupStagingWorkspace({ root: alias, stagingRoot: root }),
      error => error.code === 'STAGING_PATH_INVALID', 'cleanup must not follow an unowned stage link');
    assert.equal(fs.readFileSync(path.join(source, 'safe.txt'), 'utf8'), 'safe');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.throws(() => cleanupStagingWorkspace({ root: source, stagingRoot: alias }),
      error => error.code === 'STAGING_PATH_INVALID', 'canonical aliases cannot remove the staging base itself');
    const stageAlias = path.join(stageRoot, `${kind}-escape`);
    fs.symlinkSync(source, stageAlias, kind);
    assert.throws(() => cleanupStagingWorkspace({ root: path.join(stageAlias, 'nested'), stagingRoot: stageRoot }),
      error => error.code === 'STAGING_PATH_INVALID', 'an intermediate link cannot redirect cleanup outside staging');
    assert.equal(fs.readFileSync(path.join(nested, 'private.txt'), 'utf8'), 'nested-secret');
    console.log(`PASS ${kind} alias cannot place staging inside source Workspace`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

