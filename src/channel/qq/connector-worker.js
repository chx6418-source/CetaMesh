import path from 'node:path';
import os from 'node:os';
import { APP_PATHS } from '../../app-paths.js';
import { createQqRuntime } from './runtime.js';
import { createChannelProcessLink } from './process-link.js';
import { channelError } from '../delivery-journal.js';
import { assertQqSendPolicy } from './send-policy.js';
import { assertMcpToolEnabled, isBionicChatEnabled, isQqConnectorEnabled } from '../../integrations/tool-policy.js';
import { QQ_READ_ACTIONS } from './request.js';
import { assertQqAttachments } from './attachments.js';

export function runQqConnectorWorker({ paths = APP_PATHS, processRef = process } = {}) {
  let runtime = null;
  let closing = false;
  let config = {};
  const permits = new Set();
  const finish = async () => {
    if (closing) return;
    closing = true;
    await runtime?.stop();
    processRef.exit(0);
  };
  const link = createChannelProcessLink({ input: processRef.stdin, output: processRef.stdout,
    onClose: () => { void finish(); },
    onRequest: async (method, params = {}) => {
      if (method === 'start') {
        if (runtime) return runtime.health();
        config = params.config ?? {};
        if (!config.snowluma?.wsUrl) throw channelError('QQ_CONFIG_REQUIRED', 'Explicit QQ gateway configuration required');
        runtime = createQqRuntime({ config,
          ownershipDir: params.ownershipDir ?? path.join(os.tmpdir(), 'cetamesh-qq-ownership'),
          // Core's durable append is the receipt authority. A transport-local
          // pre-claim could permanently suppress ingress that Core never saved.
          outboundFile: path.join(paths.stateDir, 'qq-send-ledger.json'),
          log: message => processRef.stderr.write(`${message}\n`),
          onPrivateMessage: event => link.request('ingress', event),
          onGroupMessage: event => link.request('ingress', event),
          authorizeSend: async request => {
            if (!permits.has(request.requestId)) throw channelError('QQ_CORE_AUTH_REQUIRED', 'Core dispatch authorization required');
            assertQqSendPolicy(request, { config,
              qqEnabled: isQqConnectorEnabled({ stateDir: paths.stateDir }),
              bionicEnabled: isBionicChatEnabled({ stateDir: paths.stateDir }),
              toolEnabled: name => assertMcpToolEnabled(['qq_send_file', 'qq_send_audio_from_url'].includes(name) ? 'qq-file-send' : 'snowluma', name, { stateDir: paths.stateDir }) });
            await assertQqAttachments(request.params, { config, dataRoot: paths.dataRoot });
          } });
        await runtime.connect();
        return runtime.health();
      }
      if (method === 'health') return runtime?.health() ?? { ready: false, state: 'stopped', accountId: null };
      if (method === 'stop') { const result = await runtime?.stop(); return { ...result, stopped: result?.ok !== false }; }
      if (method === 'reconnect') { await runtime?.reconnect(); return runtime?.health(); }
      if (!runtime?.health().ready) throw channelError('QQ_UNAVAILABLE', 'QQ Connector is not ready');
      if (method === 'read') {
        if (!QQ_READ_ACTIONS.has(params.action)) throw channelError('QQ_READ_ACTION_DENIED', 'Connector read action is not allowlisted');
        return params.envelope ? runtime.client.request(params.action, params.params ?? {}) : runtime.client.raw(params.action, params.params ?? {});
      }
      if (method === 'send') {
        const { action, params: payload, options = {} } = params;
        if (!options.requestId || params.accountId !== runtime.health().accountId) throw channelError('QQ_CORE_AUTH_REQUIRED', 'Account-bound Core request identity required');
        permits.add(options.requestId);
        try {
          if (['send_private_msg', 'send_group_msg', 'upload_private_file', 'upload_group_file'].includes(action)) return await runtime.sendOneBot(action, payload, options);
          if (['group_poke', 'send_poke', 'click_inline_keyboard_button'].includes(action)) return await runtime.rawWrite(action, payload, options);
          if (['add_custom_face', 'modify_custom_face'].includes(action)) return await runtime.requestWrite(action, payload, options);
          throw channelError('QQ_ACTION_UNSUPPORTED', 'Unsupported QQ write action');
        } finally { permits.delete(options.requestId); }
      }
      throw channelError('CHANNEL_METHOD_DENIED', 'Connector method not allowed');
    } });
  processRef.once('SIGTERM', () => { void finish(); });
  processRef.once('SIGINT', () => { void finish(); });
  return { close: finish };
}
