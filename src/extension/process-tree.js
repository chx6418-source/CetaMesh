import path from 'node:path';
import { spawn } from 'node:child_process';

export function waitForChildExit(child, timeoutMs = 1000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once('exit', onExit);
  });
}

/** Wait until the child and all three stdio streams have emitted the final close event. */
export function waitForChildClose(child, timeoutMs = 2000) {
  if (!child) return Promise.resolve(true);
  const streamsClosed = [child.stdin, child.stdout, child.stderr]
    .every((stream) => !stream || stream.closed === true);
  if ((child.exitCode !== null || child.signalCode !== null) && streamsClosed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once('close', onClose);
  });
}

function runTaskkill(pid, systemRoot, timeoutMs) {
  const root = String(systemRoot || 'C:\\Windows');
  const executable = path.join(root, 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer && killer.exitCode === null && killer.signalCode === null) killer.kill();
      resolve(ok);
    };
    let killer;
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: { SystemRoot: root }
      });
      killer.once('error', () => finish(false));
      killer.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

/** Terminate the Worker and every descendant in its process tree/group. */
export async function terminateProcessTree(child, { platform = process.platform, systemRoot, graceMs = 250 } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    const stopped = await runTaskkill(pid, systemRoot, 2000);
    if (!stopped && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildExit(child, Math.max(100, graceMs));
    return stopped;
  }

  let groupSignalled = false;
  try {
    process.kill(-pid, 'SIGTERM');
    groupSignalled = true;
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!groupSignalled && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitForChildExit(child, Math.max(0, graceMs));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await waitForChildExit(child, 1000);
  return true;
}
