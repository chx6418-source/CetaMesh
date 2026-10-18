import { createChannelProcessLink } from '../channel/qq/process-link.js';
import { channelError } from '../channel/delivery-journal.js';
import { executeDataCall } from '../control/data-ipc.js';
import { createBionicPolicyHost } from '../bridge.js';
import { createBionicChannelFacade } from './channel-facade.js';

export function runBionicWorker({ processRef = process } = {}) {
  let policy = null;
  let accountId = null;
  const link = createChannelProcessLink({ input: processRef.stdin, output: processRef.stdout,
    maxFrameBytes: 16 * 1024 * 1024,
    onClose: () => { policy?.stop(); processRef.exit(0); },
    onRequest: async (method, params = {}) => {
      if (method === 'start') {
        if (policy) return policy.status();
        accountId = params.accountId;
        const channel = createBionicChannelFacade({ request: (...args) => link.request(...args), accountId });
        policy = await createBionicPolicyHost({ config: params.config, channel, serviceToken: params.serviceToken,
          log: message => processRef.stderr.write(`${message}\n`) });
        return policy.status();
      }
      if (method === 'health') return policy?.status() ?? { running: false, ready: false };
      if (method === 'stop') { policy?.stop(); return { stopped: true }; }
      if (!policy) throw channelError('BIONIC_UNAVAILABLE', 'Bionic policy is not running');
      if (method === 'receive') {
        if (params.accountId !== accountId) throw channelError('CHANNEL_ACCOUNT_MISMATCH', 'Bionic account scope mismatch');
        await policy.receive(params.native);
        return { acknowledged: true };
      }
      if (method === 'api') return executeDataCall(params, { handleApiRequest: policy.handleApiRequest });
      throw channelError('CHANNEL_METHOD_DENIED', 'Bionic method not allowed');
    } });
  processRef.once('SIGTERM', () => { policy?.stop(); processRef.exit(0); });
  return { close: () => { policy?.stop(); link.close(); } };
}
