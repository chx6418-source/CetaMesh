// One-off, branch-scoped source preparation. No product or user state is modified.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const branch = 'fix/handoff-context-working-memory-20261019';
if (process.env.GITHUB_REPOSITORY !== 'chx6418-source/whalebridge' || process.env.GITHUB_REF !== `refs/heads/${branch}`) throw new Error('Repair branch only');
const out = path.resolve('output/handoff-repair-20261019');
fs.mkdirSync(out, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
  return result.stdout;
}
run('git', ['bundle', 'create', path.join(out, 'source.bundle'), 'HEAD']);
run('python', ['-c', `import os,zipfile
with zipfile.ZipFile(r'${path.join(out, 'node-dependencies.zip').replaceAll('\\','/')}', 'w', zipfile.ZIP_DEFLATED, compresslevel=5) as z:
 for root,dirs,files in os.walk('node_modules'):
  for name in files:
   p=os.path.join(root,name)
   if not os.path.islink(p): z.write(p,p)
`]);
fs.writeFileSync(path.join(out, 'preparation.json'), JSON.stringify({phase:'source-preparation-only', head:run('git',['rev-parse','HEAD']).trim(), productModified:false, userDataTouched:false, testsRun:false},null,2));
console.log('Source preparation complete; no repair is claimed in this preparation run.');
