import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APP_PATHS,
  SOURCE_ROOT,
  createAppPaths,
  isPackagedRuntime,
  listRoleNames,
  packagedRoots,
  parseDataDirArg,
  resolveRoleFile
} from '../src/app-paths.js';

assert.equal(APP_PATHS.sourceRoot, SOURCE_ROOT);
assert.equal(APP_PATHS.resourceRoot, SOURCE_ROOT);
assert.equal(APP_PATHS.dataRoot, SOURCE_ROOT);
assert.equal(APP_PATHS.configFile, path.join(SOURCE_ROOT, 'config.json'));
assert.equal(APP_PATHS.stateDir, path.join(SOURCE_ROOT, 'state'));
assert.equal(APP_PATHS.packaged, false, '源码模式不应被判定为打包运行');
assert.equal(isPackagedRuntime(), false, '普通 Node 进程不是 SEA');

assert.equal(parseDataDirArg(['node', 'core.js', '--worker']), '');
assert.equal(parseDataDirArg(['node', 'core.js', '--worker', '--data-dir', 'D:\\wb data']), 'D:\\wb data');
assert.equal(parseDataDirArg(['node', 'core.js', '--data-dir=E:\\x']), 'E:\\x');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-paths-'));
try {
  const cwd = path.join(tempRoot, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const paths = createAppPaths(
    { WHALEBRIDGE_DATA_DIR: 'profile', WHALEBRIDGE_RESOURCE_DIR: 'bundle' },
    { cwd, sourceRoot: path.join(tempRoot, 'source') }
  );

  assert.equal(paths.dataRoot, path.join(cwd, 'profile'));
  assert.equal(paths.resourceRoot, path.join(cwd, 'bundle'));
  assert.equal(paths.configFile, path.join(cwd, 'profile', 'config.json'));
  assert.equal(paths.publicDir, path.join(cwd, 'bundle', 'public'));
  assert.equal(paths.fileSendCacheDir, path.join(cwd, 'profile', 'state', 'file-send-cache'));

  fs.mkdirSync(paths.bundledRolesDir, { recursive: true });
  fs.mkdirSync(paths.rolesDir, { recursive: true });
  fs.writeFileSync(path.join(paths.bundledRolesDir, '内置.md'), 'bundled');
  fs.writeFileSync(path.join(paths.bundledRolesDir, '覆盖.md'), 'bundled');
  fs.writeFileSync(path.join(paths.rolesDir, '用户.md'), 'user');
  fs.writeFileSync(path.join(paths.rolesDir, '覆盖.md'), 'user override');

  const expectedNames = ['内置', '覆盖', '用户'].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  assert.deepEqual(listRoleNames(paths), expectedNames);
  assert.equal(resolveRoleFile('覆盖', paths), path.join(paths.rolesDir, '覆盖.md'));
  assert.equal(resolveRoleFile('内置', paths), path.join(paths.bundledRolesDir, '内置.md'));
  assert.equal(resolveRoleFile('不存在', paths), null);

  const childDataRoot = path.join(tempRoot, 'child-profile');
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { APP_PATHS } from './src/app-paths.js'; process.stdout.write(JSON.stringify(APP_PATHS));"
    ],
    {
      cwd: SOURCE_ROOT,
      env: { ...process.env, WHALEBRIDGE_DATA_DIR: childDataRoot },
      encoding: 'utf8'
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const childPaths = JSON.parse(child.stdout);
  assert.equal(childPaths.dataRoot, childDataRoot);
  assert.equal(childPaths.resourceRoot, SOURCE_ROOT);
  assert.equal(childPaths.configFile, path.join(childDataRoot, 'config.json'));

  // ------------------------------------------------ 打包（SEA exe）运行分支
  // 用假的 exe 路径模拟 dist/core/WhaleBridgeCore.exe，不需要真的 SEA 进程。
  const installDir = path.join(tempRoot, 'install');
  const exePath = path.join(installDir, 'WhaleBridgeCore.exe');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(exePath, '');
  const localAppData = path.join(tempRoot, 'LocalAppData');
  const packagedEnv = { LOCALAPPDATA: localAppData, PATH: 'C:\\Windows' };

  const noResources = createAppPaths(packagedEnv, { packaged: true, execPath: exePath, argv: [] });
  assert.equal(noResources.packaged, true);
  assert.equal(noResources.resourceRoot, installDir, '无 resources/ 时应回退到 exe 所在目录');
  assert.equal(
    noResources.dataRoot,
    path.join(localAppData, 'WhaleBridge'),
    '打包运行默认数据目录必须是 %LOCALAPPDATA%\\WhaleBridge'
  );
  assert.notEqual(noResources.dataRoot, installDir, '安装目录不得作为默认可写数据目录');

  const resourcesDir = path.join(installDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  const withResources = createAppPaths(packagedEnv, { packaged: true, execPath: exePath, argv: [] });
  assert.equal(withResources.resourceRoot, resourcesDir, '应自动发现 exe 同目录 resources/');
  assert.equal(withResources.publicDir, path.join(resourcesDir, 'public'));
  assert.equal(withResources.bundledRolesDir, path.join(resourcesDir, 'roles'));
  assert.equal(withResources.rolesDir, path.join(localAppData, 'WhaleBridge', 'roles'));

  // --data-dir 优先于 portable.flag 和默认目录。
  const argPaths = createAppPaths(packagedEnv, {
    packaged: true,
    execPath: exePath,
    argv: ['WhaleBridgeCore.exe', '--worker', '--data-dir', path.join(tempRoot, 'arg-data')]
  });
  assert.equal(argPaths.dataRoot, path.join(tempRoot, 'arg-data'));

  // 环境变量优先于 --data-dir 之外的默认值，但 --data-dir 优先于环境变量。
  const envWins = createAppPaths(
    { ...packagedEnv, WHALEBRIDGE_DATA_DIR: path.join(tempRoot, 'env-data') },
    { packaged: true, execPath: exePath, argv: [] }
  );
  assert.equal(envWins.dataRoot, path.join(tempRoot, 'env-data'));
  const argWins = createAppPaths(
    { ...packagedEnv, WHALEBRIDGE_DATA_DIR: path.join(tempRoot, 'env-data') },
    {
      packaged: true,
      execPath: exePath,
      argv: ['WhaleBridgeCore.exe', '--worker', '--data-dir', path.join(tempRoot, 'arg-data')]
    }
  );
  assert.equal(argWins.dataRoot, path.join(tempRoot, 'arg-data'), '--data-dir 应优先于环境变量');

  const resourceOverride = createAppPaths(
    { ...packagedEnv, WHALEBRIDGE_RESOURCE_DIR: path.join(tempRoot, 'custom-res') },
    { packaged: true, execPath: exePath, argv: [] }
  );
  assert.equal(resourceOverride.resourceRoot, path.join(tempRoot, 'custom-res'));

  // 便携模式：exe 同目录存在 portable.flag 时数据写入 exe 同目录 data/。
  fs.writeFileSync(path.join(installDir, 'portable.flag'), '');
  const portable = createAppPaths(packagedEnv, { packaged: true, execPath: exePath, argv: [] });
  assert.equal(portable.portable, true);
  assert.equal(portable.dataRoot, path.join(installDir, 'data'));
  assert.equal(portable.resourceRoot, resourcesDir, '便携模式仍使用 exe 同目录 resources/');
  fs.rmSync(path.join(installDir, 'portable.flag'));

  // packagedRoots 直接返回值。
  const roots = packagedRoots({ env: packagedEnv, execPath: exePath });
  assert.equal(roots.exeDir, installDir);
  assert.equal(roots.resourceRoot, resourcesDir);
  assert.equal(roots.portable, false);

  // 源码模式：即使设置了 LOCALAPPDATA 也不会跳到用户目录。
  const sourceMode = createAppPaths(packagedEnv, { packaged: false, execPath: exePath, argv: [] });
  assert.equal(sourceMode.resourceRoot, SOURCE_ROOT);
  assert.equal(sourceMode.dataRoot, SOURCE_ROOT);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('✅ app-paths：默认兼容、打包分支、数据/资源分离、角色覆盖与兜底均通过');
