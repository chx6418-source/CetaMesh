import { execFile } from 'node:child_process';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) await delay(25);
  return !processGroupExists(pid);
}

function terminateWindowsTree(pid) {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16_384
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`taskkill could not confirm suite process-tree termination: ${stderr || stdout || error.message}`));
        return;
      }
      resolve();
    });
  });
}

export async function terminateSuiteProcessTree(child, { graceMs = 750, killWaitMs = 3000 } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('cannot terminate a suite process tree without a child PID');
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  if (await waitForProcessGroupExit(pid, graceMs)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!(await waitForProcessGroupExit(pid, killWaitMs))) {
    throw new Error(`suite process group ${pid} did not terminate after SIGKILL`);
  }
}
