import fs from 'node:fs';
import path from 'node:path';
import { taskError } from './types.js';

const ALLOWED_EXTENSIONS = new Set(['.csv', '.jpeg', '.jpg', '.md', '.pdf', '.png', '.txt']);
const OWNED_ARTIFACT_PREFIX = 'cetamesh-artifact:';
const MAX_REF_CHARS = 1000;

function fail(code, message) {
  throw taskError(code, message);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realDirectory(root, label) {
  if (typeof root !== 'string' || !root.trim()) fail('ARTIFACT_ROOT_UNAVAILABLE', `${label} 未配置`);
  try {
    if (fs.lstatSync(root).isSymbolicLink()) fail('ARTIFACT_ROOT_UNAVAILABLE', `${label} 不可使用符号链接或 junction`);
    const canonical = fs.realpathSync.native(root);
    if (!fs.statSync(canonical).isDirectory()) fail('ARTIFACT_ROOT_UNAVAILABLE', `${label} 不可用`);
    return canonical;
  } catch (error) {
    if (error?.code === 'ARTIFACT_ROOT_UNAVAILABLE') throw error;
    fail('ARTIFACT_ROOT_UNAVAILABLE', `${label} 不可用`);
  }
}

function parseReference(ref, { workspaceRoot, ownedArtifactRoot }) {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > MAX_REF_CHARS || ref.includes('\0')) {
    fail('ARTIFACT_REFERENCE_INVALID', 'Artifact 引用无效');
  }

  let relative = ref.trim();
  let root = null;
  let rootLabel = '';
  if (relative.toLowerCase().startsWith(OWNED_ARTIFACT_PREFIX)) {
    relative = relative.slice(OWNED_ARTIFACT_PREFIX.length);
    root = ownedArtifactRoot;
    rootLabel = 'CetaMesh Artifact 根目录';
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(relative)) {
      fail('ARTIFACT_REFERENCE_INVALID', 'Artifact 只允许本地 Workspace 路径或 CetaMesh Artifact 引用');
    }
    const hasWorkspaceRoot = typeof workspaceRoot === 'string' && workspaceRoot.trim().length > 0;
    root = hasWorkspaceRoot ? workspaceRoot : ownedArtifactRoot;
    rootLabel = hasWorkspaceRoot ? 'Workspace 根目录' : 'CetaMesh Artifact 根目录';
  }

  if (!relative || /^[\\/]{2}/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    fail('ARTIFACT_PATH_DENIED', 'Artifact 必须使用授权根目录内的相对路径');
  }
  const segments = relative.replace(/\\/g, '/').split('/');
  if (segments.some(segment => !segment || segment === '..' || segment.includes(':'))) {
    fail('ARTIFACT_PATH_DENIED', 'Artifact 路径包含不允许的路径段');
  }
  return { root, rootLabel, relative: path.join(...segments) };
}

/** Resolve a persisted Task Artifact reference only inside its owning local root. */
export function resolveTaskArtifactOpen({ artifact, workspaceRoot = null, ownedArtifactRoot = null, forPreview = false } = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    fail('ARTIFACT_NOT_FOUND', 'Artifact 不存在');
  }
  const { root, rootLabel, relative } = parseReference(artifact.ref, { workspaceRoot, ownedArtifactRoot });
  const canonicalRoot = realDirectory(root, rootLabel);
  const lexicalPath = path.resolve(canonicalRoot, relative);
  if (!inside(canonicalRoot, lexicalPath)) fail('ARTIFACT_PATH_DENIED', 'Artifact 路径越出授权根目录');

  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync.native(lexicalPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      fail('ARTIFACT_FILE_NOT_FOUND', 'Artifact 文件不存在');
    }
    fail('ARTIFACT_FILE_UNAVAILABLE', 'Artifact 文件无法访问');
  }
  if (!inside(canonicalRoot, canonicalPath)) fail('ARTIFACT_PATH_DENIED', 'Artifact 经 realpath 解析后越出授权根目录');

  let stat;
  try {
    stat = fs.statSync(canonicalPath);
  } catch {
    fail('ARTIFACT_FILE_UNAVAILABLE', 'Artifact 文件无法访问');
  }
  if (!stat.isFile()) fail('ARTIFACT_NOT_A_FILE', 'Artifact 必须是本地文件');

  const extension = path.extname(canonicalPath).toLowerCase();
  if (!forPreview && !ALLOWED_EXTENSIONS.has(extension)) fail('ARTIFACT_TYPE_UNSUPPORTED', 'Artifact 文件类型不受支持');
  return { canonicalPath, extension };
}

export { ALLOWED_EXTENSIONS as TASK_ARTIFACT_OPEN_EXTENSIONS };
