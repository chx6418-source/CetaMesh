import fs from 'node:fs';
import path from 'node:path';
import { createQqConnectorHost } from '../channel/qq/connector-host.js';
import { channelError } from '../channel/delivery-journal.js';
import { isBionicChatEnabled } from '../integrations/tool-policy.js';
import { readJsonFile } from '../storage/json-file.js';
import { createBionicReadiness } from './readiness.js';
import { createQqSendLedger } from '../channel/qq/send-ledger.js';

const LEGACY_SOCIAL_FILES = ['social-v2.json', 'sessions.json', 'current-role.json', 'slang.json',
  'slang-session.json', 'stickers.json', 'social-v2-cards.json'];
export function createBionicService({ dataRoot, stateDir, config, channelService, executable, serviceToken = () => '' } = {}) {
  let child = null;
  let detach = null;
  let accountId = null;
  let starting = null;
  let accountRoot = null;
  let startedAt = null;
  const checkEnvironment = createBionicReadiness({ config });
  async function start() {
    if (starting) return starting;
    if (child) return health();
    starting = (async () => {
      if (!isBionicChatEnabled({ stateDir })) throw channelError('QQ_BIONIC_DISABLED', 'Bionic Chat is disabled');
      const status = await channelService.execute({ method: 'channel.qq.health' });
      if (!status.ready || !/^\d{1,20}$/.test(status.accountId)) throw channelError('QQ_UNAVAILABLE', 'A verified QQ Connector is required before Bionic starts');
      const legacy = LEGACY_SOCIAL_FILES.filter(name => fs.existsSync(path.join(stateDir, name)));
      if (fs.existsSync(path.join(dataRoot, 'roles')) && fs.readdirSync(path.join(dataRoot, 'roles')).length) legacy.push('roles/');
      if (legacy.length) throw channelError('BIONIC_MIGRATION_APPROVAL_REQUIRED', `Legacy social data lacks account ownership: ${legacy.join(', ')}. Owner-reviewed inventory and Dry Run required.`);
      accountId = status.accountId;
      accountRoot = path.join(dataRoot, 'channel', 'qq', accountId, 'bionic');
      fs.mkdirSync(accountRoot, { recursive: true });
      try {
        for (const name of LEGACY_SOCIAL_FILES) {
          const file = path.join(accountRoot, 'state', name);
          if (!fs.existsSync(file)) continue;
          const value = readJsonFile(file);
          if (!value || typeof value !== 'object') throw channelError('BIONIC_STATE_UNAVAILABLE', 'Invalid Social data');
          if (name === 'social-v2.json' && (!value.conversations || typeof value.conversations !== 'object' || Array.isArray(value.conversations))) throw channelError('BIONIC_STATE_UNAVAILABLE', 'Invalid Social conversations');
          if (name === 'sessions.json' && (!value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions))) throw channelError('BIONIC_STATE_UNAVAILABLE', 'Invalid Social Sessions');
        }
      } catch (error) { throw Object.assign(channelError('BIONIC_STATE_UNAVAILABLE', 'Bionic account state cannot be trusted; original files preserved'), { cause: error }); }
      const current = createQqConnectorHost({ config, dataRoot: accountRoot, stateDir: path.join(accountRoot, 'state'), executable,
        workerMode: '--bionic-runtime', startParams: { accountId, serviceToken: serviceToken() },
        onChildRequest: (method, params) => {
          if (child !== current || !isBionicChatEnabled({ stateDir })) throw channelError('QQ_BIONIC_DISABLED', 'Bionic runtime authority expired');
          if (method === 'read') return channelService.read(params.action, params.params, { envelope: params.envelope === true });
          if (method === 'receipt') {
            if (String(params.accountId) !== accountId) throw channelError('QQ_ACCOUNT_MISMATCH', 'Receipt account differs from Bionic identity');
            return channelService.sendReceipt(params.requestId, accountId);
          }
          if (method === 'send') return channelService.send({ requestId: params.options?.requestId,
            actor: { kind: 'extension', id: `bionic:${accountId}`, grants: { capabilities: ['channel.qq.send'] } },
            input: { accountId, action: params.action, kind: params.kind, params: params.params,
              options: { ...params.options, source: 'bionic' } } });
          throw channelError('CHANNEL_METHOD_DENIED', 'Bionic child cannot access Core control methods');
        }, onExit: () => { if (child === current) { detach?.(); detach = null; child = null; } } });
      child = current;
      startedAt = Date.now();
      try {
        await current.start();
        detach = channelService.registerConsumer({ id: `bionic-${accountId}`,
          authorize: event => event.accountId === accountId && isBionicChatEnabled({ stateDir }),
          handle: event => current.request('receive', event) });
        void channelService.drain?.();
        return health();
      } catch (error) { await current.stop(); child = null; throw error; }
    })().finally(() => { starting = null; });
    return starting;
  }
  async function stop() {
    if (starting) await starting.catch(() => { /* A failed start owns no active Social consumer. */ });
    detach?.(); detach = null;
    const current = child; child = null;
    startedAt = null;
    await current?.stop();
    return { stopped: true };
  }
  function activity() {
    const receive = { state: 'unavailable', total: null, acknowledged: null, outcomeUnknown: null, lastAt: null };
    const send = { state: 'unavailable', sent: null, acknowledged: null, outcomeUnknown: null, lastAt: null };
    if (!accountId) return { receive, send };
    try {
      const snapshot = channelService.deliverySnapshot();
      const rows = snapshot.events.filter(row => row.accountId === accountId);
      const deliveries = snapshot.consumers?.[`bionic-${accountId}`]?.deliveries ?? {};
      Object.assign(receive, { state: 'observed', total: rows.length,
        acknowledged: rows.filter(row => deliveries[row.eventId] === 'acknowledged').length,
        outcomeUnknown: rows.filter(row => deliveries[row.eventId] === 'outcome-unknown').length,
        lastAt: rows.length ? new Date(rows.at(-1).createdAt).toISOString() : null });
    } catch { Object.assign(receive,{state:'unavailable',total:null,acknowledged:null,outcomeUnknown:null,lastAt:null}); }
    try {
      const rows = createQqSendLedger(path.join(stateDir, 'qq-send-ledger.json')).snapshot().records
        .filter(row => row.accountId === accountId);
      Object.assign(send, { state: 'observed', sent: rows.filter(row => row.status === 'sent').length,
        acknowledged: rows.filter(row => row.status === 'acknowledged').length,
        outcomeUnknown: rows.filter(row => row.status === 'outcome-unknown').length,
        lastAt: rows.length ? rows.at(-1).updatedAt : null });
    } catch { Object.assign(send,{state:'unavailable',sent:null,acknowledged:null,outcomeUnknown:null,lastAt:null}); }
    return { receive, send };
  }
  async function health() {
    const current = child;
    const [policyResult, channelResult, environment] = await Promise.all([
      current ? current.health().catch(() => ({ running: false, ready: false })) : { running: false, ready: false },
      channelService.execute({ method: 'channel.qq.health' }).catch(() => ({ ready: false })),
      checkEnvironment({ accountRoot, startedAt })
    ]);
    const enabled = isBionicChatEnabled({ stateDir });
    const running = current !== null && current === child && policyResult.running === true;
    const qqReady = channelResult.ready === true && /^\d{1,20}$/.test(String(channelResult.accountId ?? '')) &&
      (!accountId || channelResult.accountId === accountId);
    const ready = enabled && running && policyResult.ready === true && qqReady && environment.ready;
    const code = !enabled ? 'QQ_BIONIC_DISABLED' : !qqReady ? 'QQ_UNAVAILABLE'
      : !running ? 'BIONIC_STOPPED' : environment.code ?? (policyResult.ready !== true ? 'BIONIC_POLICY_UNAVAILABLE' : null);
    return { ...policyResult, running, ready, accountId, activity: activity(),
      state: ready ? 'ready' : !enabled ? 'disabled' : running ? 'degraded' : 'stopped',
      error: code ? { code, message: 'Bionic dependencies require verification; inspect readiness checks.' } : null,
      readiness: { ...environment, ready, canStart: enabled && qqReady && environment.canStart,
        enabled, qq: { ready: qqReady, accountId: channelResult.accountId ?? null },
        policy: { running, ready: policyResult.ready === true } } };
  }
  async function reconnect() { await stop(); return start(); }
  return { start, stop, reconnect, close: stop, health,
    dataCall: params => child ? child.request('api', params, 750000) : Promise.reject(channelError('BIONIC_UNAVAILABLE', 'Bionic runtime is stopped')) };
}
