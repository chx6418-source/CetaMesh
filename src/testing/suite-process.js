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

function exitedWindowsTreeMembers(pid, error, stdout, stderr) {
  // A nonzero aggregate can mean a descendant exited during taskkill's walk.
  // Require the root's affirmative termination and recognize only this exact
  // benign diagnostic. Other locales/errors remain unconfirmed, never ignored.
  if (!Number.isInteger(error.code) || error.killed || error.signal) return null;
  const output = String(stdout).replace(/\r\n/g, '\n'), diagnostic = String(stderr).replace(/\r\n/g, '\n');
  const success = /^SUCCESS: The process with PID (\d+)(?: \(child process of PID \d+\))? has been terminated\.[ \t]*(?:\n|$)/gm;
  const missing = /^ERROR: The process with PID (\d+) \(child process of PID \d+\) could not be terminated\.[ \t]*\n[ \t\n]*Reason: There is no running instance of the task\.[ \t]*(?:\n|$)/gm;
  const terminated = [...output.matchAll(success)].map(match => Number(match[1]));
  const absent = [...diagnostic.matchAll(missing)].map(match => Number(match[1]));
  if (!terminated.includes(pid) || !absent.length || absent.includes(pid)
    || output.replace(success, '').trim() || diagnostic.replace(missing, '').trim()) return null;
  const members = [...new Set([...terminated, ...absent])];
  return members.every(member => Number.isSafeInteger(member) && member > 0) ? members : null;
}

async function confirmWindowsMembersExited(members, timeoutMs, signalProcess) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const gone = members.every(pid => {
      try { signalProcess(pid, 0); return false; }
      catch (error) { if (error?.code === 'ESRCH') return true; if (error?.code === 'EPERM') return false; throw error; }
    });
    if (gone) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
}

function terminateWindowsTree(pid, killWaitMs, signalProcess) {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16_384
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = Object.assign(new Error(`taskkill could not confirm suite process-tree termination: stdout=${stdout}; stderr=${stderr || error.message}`), { code: 'TREE_TERMINATION_UNCONFIRMED' });
        const members = exitedWindowsTreeMembers(pid, error, stdout, stderr);
        if (members) {
          // Probe only; never issue another termination against parsed PIDs.
          void confirmWindowsMembersExited(members, killWaitMs, signalProcess).then(
            confirmed => confirmed ? resolve() : reject(failure), reject);
          return;
        }
        reject(failure);
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
    await terminateWindowsTree(pid, killWaitMs, signalProcess);
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
