// The desktop worker owns Core composition and both native pipes. Optional
// QQ/Bionic children start only through the explicit Core Channel lifecycle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_PATHS } from '../app-paths.js';
import { readRawConfig } from '../config/loader.js';
import { startDataIpcServer, resolveDataPipeName } from '../control/data-ipc.js';
import { bootstrapCetaMesh } from './bootstrap.js';
import { createApplicationOwnershipHold } from './lifecycle.js';
import { createDesktopIpcRuntime } from './ipc-runtime.js';
import { createDshCoreConnector } from '../agent/dsh-core-connector.js';
import { agentPrivilegeAllows } from '../bridge-privilege.js';
import { parseJsonText } from '../storage/json-file.js';

function serviceToken(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'agent-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(file, 'utf8').trim();
  }
  return token;
}

function coreDataHandler(token, services, isStopping = () => false) {
  return async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (isStopping()) {
      reply(503, { ok: false, code: 'APPLICATION_STOPPING', error: 'Core is stopping' });
      return;
    }
    if (!token || req.headers['x-console-token'] !== token) {
      reply(401, { ok: false, error: '未授权：请提供服务令牌' });
      return;
    }
    if (pathname !== '/api/status' && agentPrivilegeAllows(req.method, pathname)) {
      try {
        if (!(await services.bionicService.health()).running) {
          reply(403, { ok: false, code: 'BIONIC_UNAVAILABLE', error: req.headers['x-agent-token'] !== undefined
            ? 'Core 数据面不接受 Legacy 会话令牌' : 'Core 数据面不提供此 Legacy 接口' }); return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) { reply(413, { ok: false, code: 'REQUEST_TOO_LARGE' }); return; }
          chunks.push(Buffer.from(chunk));
        }
        const url = new URL(req.url, 'http://localhost');
        const result = await services.bionicService.dataCall({ method: req.method, path: pathname,
          query: Object.fromEntries(url.searchParams), token, sessionToken: req.headers['x-agent-token'],
          body: size ? parseJsonText(Buffer.concat(chunks).toString('utf8')) : undefined });
        res.writeHead(result.status, result.headers);
        res.end(result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : result.body);
      } catch (error) { reply(503, { ok: false, code: error.code ?? 'BIONIC_UNAVAILABLE', error: 'Bionic request unavailable; verify pending effects before retrying' }); }
      return;
    }
    if (req.headers['x-agent-token'] !== undefined) {
      reply(403, { ok: false, error: 'Core 数据面不接受 Legacy 会话令牌' });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      reply(200, { ok: true, mode: 'core', tokenModel: 'service-only', agentSurface: { agentAllowedExact: ['/api/status'] }, connectors: 'optional' });
      return;
    }
    reply(403, { ok: false, error: 'Core 数据面不提供此 Legacy 接口' });
  };
}

export async function runCoreWorker({ paths = APP_PATHS, processRef = process, log = message => process.stdout.write(`${message}\n`) } = {}) {
  // A damaged QQ/Legacy config is optional to Core. Never write it back here.
  let config = {};
  let configLoadError = null;
  try { config = readRawConfig(paths.configFile); }
  catch (error) {
    // Optional legacy data never blocks Core, but DSH setup retains the failure.
    configLoadError = error?.code === 'CONFIG_MISSING' ? 'LEGACY_CONFIG_UNAVAILABLE' : 'LEGACY_CONFIG_INVALID';
  }
  const dsh = createDshCoreConnector({ config, configLoadError, env: processRef.env, stateDir: paths.stateDir, configFile: paths.configFile, dataRoot: paths.dataRoot });
  const application = bootstrapCetaMesh({
    config, dataRoot: paths.dataRoot, stateDir: paths.stateDir,
    sourceRoot: paths.sourceRoot, resourceRoot: paths.resourceRoot,
    api: dsh.api, dshPresetConfig: dsh.presetConfig, dshConfiguration: dsh.configuration, processRef, log,
    channelServiceToken: () => serviceToken(paths.stateDir)
  });
  let shutdownPromise = null;
  let exitCode = 0;
  let ownershipHold = null;
  function retainUncertainOwnership(report) {
    processRef.exitCode = 1;
    log('Core shutdown is incomplete; StateDir ownership is retained until resource cleanup is confirmed.');
    // A dead PID lock is reclaimable. Keep this Core alive when a child or other
    // owned resource may still be active; a stale lock alone cannot protect it.
    ownershipHold ??= createApplicationOwnershipHold();
    return report;
  }
  function shutdown(code = 0) {
    exitCode = Math.max(exitCode, code);
    if (!shutdownPromise) shutdownPromise = application.lifecycle.stop().then(report => {
      if (!report.ok) return retainUncertainOwnership(report);
      processRef.exit(exitCode);
      return report;
    });
    return shutdownPromise;
  }
  try {
    const token = serviceToken(paths.stateDir);
    const ipcRuntime = createDesktopIpcRuntime({ services: application.services, processRef, log,
      isStopping: application.lifecycle.isStopping,
      onFatalError: error => shutdown(error?.code === 'EADDRINUSE' ? 2 : 1) });
    application.lifecycle.register(() => ipcRuntime.stop(), { name: 'Native UI IPC' });
    ipcRuntime.start();

    const pipeName = resolveDataPipeName({ dataRoot: paths.dataRoot, env: processRef.env });
    const dataServer = startDataIpcServer({ handleApiRequest: coreDataHandler(token, application.services, application.lifecycle.isStopping), pipeName, log });
    const dataSockets = new Set();
    dataServer.on('connection', socket => {
      if (application.lifecycle.isStopping()) { socket.destroy(); return; }
      dataSockets.add(socket);
      socket.once('close', () => dataSockets.delete(socket));
    });
    dataServer.on('error', error => {
      log(`Core data IPC failed: ${error?.message ?? error}`);
      void shutdown(error?.code === 'EADDRINUSE' ? 2 : 1);
    });
    application.lifecycle.register(() => new Promise((resolve, reject) => {
      for (const socket of dataSockets) socket.destroy();
      dataServer.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    }), { name: 'Core data IPC' });
    dataServer.listen(pipeName, () => log(`Core data IPC is ready (${pipeName}).`));
    application.lifecycle.bind();
    processRef.once('beforeExit', () => { void shutdown(); });
    const stop = () => { void shutdown(); };
    processRef.once('SIGINT', stop);
    processRef.once('SIGTERM', stop);
    // Rust supervisor owns stdin. EOF means the shell released its child;
    // close only Core-owned resources, then exit without touching connectors.
    if (processRef.env?.WHALEBRIDGE_SUPERVISED === '1') {
      processRef.stdin.resume();
      processRef.stdin.once('end', () => { log('启动器已退出（stdin 关闭），Core 退出。'); stop(); });
      processRef.stdin.once('error', error => {
        log(`Core supervisor stdin failed: ${error?.message ?? error}`);
        void shutdown(1);
      });
      const parentPid = processRef.ppid;
      if (parentPid > 0) {
        let timer;
        const checkParent = () => {
          try { process.kill(parentPid, 0); }
          catch (error) {
            if (error?.code === 'ESRCH') { log('启动器进程已消失，Core 退出。'); stop(); return; }
          }
          timer = setTimeout(checkParent, 5000);
          timer.unref?.();
        };
        timer = setTimeout(checkParent, 5000);
        timer.unref?.();
        application.lifecycle.register(() => clearTimeout(timer), { name: 'Supervisor monitor' });
      }
    }
    return { ...application, ipcRuntime, dataServer, shutdown };
  } catch (error) {
    const report = await application.lifecycle.stop();
    if (!report.ok) retainUncertainOwnership(report);
    throw error;
  }
}

