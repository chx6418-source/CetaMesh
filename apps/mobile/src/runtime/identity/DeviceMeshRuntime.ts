import type {DeviceHealth} from '../../domain/device/DeviceHealth';
import type {DeviceTrust, TrustRepository} from '../../domain/device/DeviceTrust';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier} from '../../protocol/PairingProtocol';

export interface ReachabilityProbe {
  check(trust: DeviceTrust, signal: AbortSignal): Promise<boolean>;
}

export type DeviceMeshRuntimeOptions = {
  readonly timeoutMs?: number;
};

export class DeviceMeshRuntime {
  private readonly timeoutMs: number;

  constructor(
    private readonly repository: TrustRepository,
    private readonly probe?: ReachabilityProbe,
    options: DeviceMeshRuntimeOptions = {},
  ) {
    this.timeoutMs = Number.isInteger(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.min(Number(options.timeoutMs), 15_000)
      : 5_000;
  }

  async getHealth(deviceId: string): Promise<DeviceHealth> {
    identifier(deviceId);
    const trust = await this.repository.get(deviceId);
    if (!trust) {
      throw new CetaError('unauthorized', 'Device is not paired');
    }

    const trustState = trust.trustState ?? 'trusted';
    const trusted = trustState === 'trusted';
    let reachable = false;
    let lastErrorCode: string | undefined;
    if (trusted && this.probe) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        reachable = await Promise.race([
          this.probe.check({...trust}, controller.signal),
          new Promise<boolean>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new CetaError('timeout', 'Device reachability timed out'));
            }, this.timeoutMs);
          }),
        ]);
      } catch (error) {
        lastErrorCode = error instanceof CetaError ? error.code : 'network_unavailable';
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        controller.abort();
      }
    }

    return {
      deviceId: trust.deviceId,
      paired: true,
      trusted,
      reachable: trusted && reachable,
      trustState,
      ...(trust.lastSeenAt ? {lastSeen: trust.lastSeenAt} : {}),
      transport: trust.transportType ?? 'unknown',
      protocolVersion: trust.protocolVersion ?? 1,
      peerRole: trust.peerRole ?? 'desktop-node',
      capabilityCount: trust.capabilityCount ?? 0,
      ...(lastErrorCode ? {lastErrorCode} : {}),
    };
  }
}
