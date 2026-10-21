import { spawnSync } from 'node:child_process';
import { writeJsonAtomic } from 'file:///C:/Users/Administrator/.codex/worktrees/product-context-main-merge/src/storage/json-file.js';
const exe = process.env.SystemRoot + '/System32/wsl.exe';
function decode(buffer) {
  if (!buffer?.length) return '';
  let zeros = 0; for (let i = 1; i < Math.min(buffer.length, 200); i += 2) if (buffer[i] === 0) zeros++;
  return buffer.toString(zeros > 12 || (buffer[0] === 255 && buffer[1] === 254) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').trim();
}
const results = [];
for (const args of [['--status'], ['--list', '--verbose'], ['--version']]) {
  const result = spawnSync(exe, args, { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
  const row = { command: 'wsl.exe ' + args.join(' '), exit: result.status, signal: result.signal,
    error: result.error?.code, stdout: decode(result.stdout), stderr: decode(result.stderr) };
  results.push(row); console.log(JSON.stringify(row));
}
writeJsonAtomic('D:/GIT- CetaMesh/live-model-repair/wsl-preflight-20261020.json', results);
