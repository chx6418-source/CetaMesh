import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPackagedRuntime } from '../../app-paths.js';
import { createChannelProcessLink } from './process-link.js';
import { channelError } from '../delivery-journal.js';

export function createQqConnectorHost({ config, dataRoot, stateDir, onMessage, onExit = () => {},
  executable, sourceEntry, ownershipDir, workerMode = '--qq-connector', startParams = {}, onChildRequest, log = () => {} } = {}) {
  let child = null;
  let link = null;
  let stopping = null;
  let childClosed = Promise.resolve();
  const packaged = executable || isPackagedRuntime();
  const entry = packaged ? null : sourceEntry ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core-entry.js');
  async function start() {
    if (child) return health();
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(OPENAI_|ANTHROPIC_|DEEPSEEK_|WHALEBRIDGE_UI_|WHALEBRIDGE_CONSOLE_TOKEN)/i.test(key)) delete env[key];
    }
    delete env.WHALEBRIDGE_UI_AUTH_TOKEN; delete env.WHALEBRIDGE_UI_PIPE;
    delete env.WHALEBRIDGE_SUPERVISED;
    env.WHALEBRIDGE_DATA_DIR = dataRoot;
    child = spawn(executable ?? process.execPath, [...(packaged ? [] : [entry]), workerMode, '--data-dir', dataRoot],
      { env, cwd: dataRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const current = child;
    childClosed = new Promise(resolve => current.once('close', resolve));
    current.stderr.on('data', data => log(String(data).slice(0, 2000)));
    current.once('error', error => { log(error.message); link?.close(); });
    current.once('close', () => { if (child === current) { link?.close(); child = null; link = null; onExit(); } });
    link = createChannelProcessLink({ input: current.stdout, output: current.stdin,
      maxFrameBytes: workerMode === '--bionic-runtime' ? 16 * 1024 * 1024 : 1024 * 1024,
      onRequest: (method, params) => {
        if (child !== current) throw channelError('CHANNEL_CONNECTOR_EXPIRED', 'Child identity expired');
        if (onChildRequest) return onChildRequest(method, params);
        if (method !== 'ingress') throw channelError('CHANNEL_METHOD_DENIED', 'Only Channel ingress is accepted from a Connector');
        return onMessage(params);
      } });
    const wireConfig = workerMode === '--qq-connector'
      ? { snowluma: config.snowluma, allow: config.allow, deny: config.deny,
        allowAllWhenEmpty: config.allowAllWhenEmpty, socialV2: config.socialV2, fileSend: config.fileSend }
      : { ...config, consoleToken: undefined, snowluma: { ...config.snowluma, accessToken: undefined, httpAccessToken: undefined } };
    return link.request('start', { config: wireConfig, ownershipDir, ...startParams }, 20000);
  }
  async function health() {
    if (!child || !link) return { ready: false, state: 'stopped', accountId: null };
    const current = child;
    const result = await link.request('health', {});
    return { ...result, processId: current.pid };
  }
  async function stop() {
    if (stopping) return stopping;
    if (!child) return { stopped: true };
    const current = child;
    const closed = childClosed;
    stopping = (async () => {
      let stopped = false;
      let commandError = null;
      try { stopped = (await link.request('stop', {}, 70000))?.stopped === true; }
      catch (error) { commandError = error?.code ?? 'CHANNEL_PROCESS_CLOSED'; }
      finally {
        current.stdin.end();
        const timer = setTimeout(() => { current.kill(); }, 3000);
        await closed;
        clearTimeout(timer);
      }
      return { stopped: true, ...(stopped ? {} : { previousEffectUnconfirmed: true }), ...(commandError ? { code: commandError } : {}) };
    })().finally(() => { stopping = null; });
    return stopping;
  }
  return { start, stop, health,
    request: (method, params, timeoutMs) => link ? link.request(method, params, timeoutMs) : Promise.reject(channelError('QQ_UNAVAILABLE', 'Child stopped')),
    send: params => link ? link.request('send', params, 65000) : Promise.reject(channelError('QQ_UNAVAILABLE', 'Connector stopped')),
    read: (action, params, options = {}) => link ? link.request('read', { action, params, envelope: options.envelope === true }) : Promise.reject(channelError('QQ_UNAVAILABLE', 'Connector stopped')) };
}
