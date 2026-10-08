import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Hash all regular package files with stable relative paths; symlinks fail closed. */
export function fingerprintExtensionPackage(rootDir) {
  const root = fs.realpathSync(rootDir);
  const files = [];

  function visit(relative = '') {
    const directory = relative ? path.join(root, relative) : root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, child);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error(`Extension package contains a symlink: ${child}`), { code: 'SYMLINK_NOT_ALLOWED' });
      }
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) files.push(child);
    }
  }

  visit();
  const hash = crypto.createHash('sha256');
  for (const relative of files.sort()) {
    hash.update(relative, 'utf8');
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
