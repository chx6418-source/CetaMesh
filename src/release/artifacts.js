import fs from 'node:fs';
import path from 'node:path';

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoLinks(root, relativePath) {
  let current = root;
  for (const part of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT') return current;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`release artifact path contains a symlink or junction: ${current}`);
  }
  return current;
}

function assertNoLinksBelow(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('release staging path must be a real directory');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const childStat = fs.lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error(`release staging contains a symlink or junction: ${child}`);
    if (childStat.isDirectory()) assertNoLinksBelow(child);
  }
}

function resolvedPaths(rootDir, stagingDirectory) {
  const root = fs.realpathSync(rootDir);
  const stageRoot = path.join(root, 'artifacts', '.staging');
  const stage = path.resolve(stagingDirectory);
  if (path.dirname(stage) !== stageRoot || !isWithin(stageRoot, stage)) {
    throw new Error('release staging directory must be a direct child of artifacts/.staging');
  }
  return { root, stageRoot, stage };
}

export function assertSafeStagingDirectory({ rootDir, stagingDirectory }) {
  const { root, stageRoot, stage } = resolvedPaths(rootDir, stagingDirectory);
  const stageRelative = path.relative(root, stage);
  assertNoLinks(root, stageRelative);
  for (const directory of [path.join(root, 'artifacts'), stageRoot]) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`release staging ancestry must be real directories: ${directory}`);
    }
  }
  return { stageRoot, stage };
}

export function cleanupStagingDirectory({ rootDir, stagingDirectory }) {
  const { root, stage } = resolvedPaths(rootDir, stagingDirectory);
  const stageRelative = path.relative(root, stage);
  assertNoLinks(root, stageRelative);
  if (!fs.existsSync(stage)) return { removed: false };
  assertNoLinksBelow(stage);
  fs.rmSync(stage, { recursive: true, force: false });
  return { removed: true };
}

export function publishStagedArtifact({ rootDir, stagingDirectory, finalDirectory }) {
  const { root, stage } = resolvedPaths(rootDir, stagingDirectory);
  const finalPath = path.resolve(finalDirectory);
  const finalRelative = path.relative(root, finalPath).split(path.sep).join('/');
  if (!/^artifacts\/(dev|rc|beta|stable)\/[0-9A-Za-z.+-]+\/build-\d+$/.test(finalRelative)) {
    throw new Error('release destination does not match artifacts/channel/version/build layout');
  }
  const stageRelative = path.relative(root, stage);
  const finalParentRelative = path.relative(root, path.dirname(finalPath));
  assertNoLinks(root, stageRelative);
  assertNoLinks(root, finalParentRelative);
  assertNoLinksBelow(stage);
  if (fs.existsSync(finalPath)) throw new Error(`release artifact already exists; refusing to overwrite: ${finalPath}`);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  if (fs.existsSync(finalPath)) throw new Error(`release artifact appeared before publish: ${finalPath}`);
  fs.renameSync(stage, finalPath);
  return finalPath;
}
