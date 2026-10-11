import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(path.join(root, 'src')).filter((file) => /\.(tsx?|css)$/.test(file));
const issues = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (/dangerouslySetInnerHTML|\beval\s*\(|new Function\s*\(/.test(source)) issues.push(`${path.relative(root, file)}: dynamic HTML or code execution`);
  if (/onClick=\{\s*\(\)\s*=>\s*window\.open\s*\(/.test(source)) issues.push(`${path.relative(root, file)}: external links must use the secure bridge helper`);
}
if (issues.length) {
  process.stderr.write(`${issues.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`UI source hygiene passed (${files.length} files)\n`);
