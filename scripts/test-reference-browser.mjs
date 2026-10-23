import { spawnSync } from 'node:child_process';
const run = spawnSync('cargo', ['test', '--offline', '--manifest-path', 'desktop-shell/Cargo.toml', 'reference_browser_', '--', '--nocapture'], { encoding: 'utf8', timeout: 300000 });
process.stdout.write(run.stdout ?? '');
if (run.status !== 0) process.stderr.write(run.stderr ?? run.error?.message ?? 'Native tests failed');
process.exitCode = run.status ?? 1;
