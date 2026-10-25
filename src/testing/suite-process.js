import { execFile } from 'node:child_process';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupExists(pid, signalProcess) {
  try {
    signalProcess(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs, signalProcess) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid, signalProcess) && Date.now() < deadline) await delay(25);
  return !processGroupExists(pid, signalProcess);
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

function confirmRootExited(pid, signalProcess) {
  try { signalProcess(pid, 0); }
  catch (error) {
    if (error?.code === 'ESRCH') return;
    if (error?.code !== 'EPERM') throw error;
  }
  throw Object.assign(new Error(`suite process group ${pid} is absent but root termination is unconfirmed`),
    { code: 'TREE_TERMINATION_UNCONFIRMED' });
}

export async function terminateSuiteProcessTree(child, {
  graceMs = 750, killWaitMs = 3000, platform = process.platform, signalProcess = process.kill.bind(process)
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('cannot terminate a suite process tree without a child PID');
  if (platform === 'win32') {
    await terminateWindowsTree(pid);
    return;
  }

  try {
    signalProcess(-pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') { confirmRootExited(pid, signalProcess); return; }
    throw error;
  }
  if (await waitForProcessGroupExit(pid, graceMs, signalProcess)) { confirmRootExited(pid, signalProcess); return; }
  try {
    signalProcess(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!(await waitForProcessGroupExit(pid, killWaitMs, signalProcess))) {
    throw new Error(`suite process group ${pid} did not terminate after SIGKILL`);
  }
  confirmRootExited(pid, signalProcess);
}
