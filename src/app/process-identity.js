import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A PID is only a lookup key. Birth identities remain exact strings: Windows
// DateTime ticks exceed Number.MAX_SAFE_INTEGER, and /proc ticks are not dates.
export function isProcessIdentity(value) {
  if (!value || typeof value !== 'object' || typeof value.value !== 'string') return false;
  if (value.kind === 'windows-start-time-utc') return /^[1-9][0-9]{17,18}$/.test(value.value);
  if (value.kind === 'linux-proc-start') return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[1-9][0-9]*$/.test(value.value);
  return false;
}

function liveness(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

export function probeProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  const state = liveness(pid);
  if (state !== 'alive') return { state };
  let identity;
  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return { state: 'unknown' };
      const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Only the validated integer PID enters this fixed command. No process
      // names, command lines, executable paths or credentials are collected.
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop';try{(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}catch{exit 1}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, timeout: 3000, maxBuffer: 4096 });
      if (!result.error && result.status === 0) identity = { kind: 'windows-start-time-utc', value: result.stdout.trim() };
    } else if (process.platform === 'linux') {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      if (end !== -1) {
        const fields = stat.slice(end + 1).trim().split(/\s+/);
        identity = { kind: 'linux-proc-start', value: `${boot}:${fields[19]}` };
      }
    }
  } catch { identity = undefined; /* Recheck liveness without claiming a birth identity. */ }
  if (isProcessIdentity(identity)) return { state: 'alive', identity };
  // A failed/unsupported identity lookup is not evidence that an alive owner
  // disappeared. Only the OS's explicit ESRCH result authorizes dead recovery.
  return { state: liveness(pid) === 'dead' ? 'dead' : 'unknown' };
}
