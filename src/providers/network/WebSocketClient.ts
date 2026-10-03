import type {DeviceTrust} from '../../domain/device/DeviceTrust';
import type {MeshHandshake} from '../../protocol/DeviceMeshProtocol';
import {CetaError} from '../../shared/errors/CetaError';

export type MeshFrame = {
  readonly kind: 'event' | 'ack' | 'ping' | 'pong' | 'resume';
  readonly sequence: number;
  readonly cursor?: string;
  readonly payload?: unknown;
};

export type MeshSocket = {
  send(data: string): void;
  close(): void;
};

const FRAME_KINDS = ['event', 'ack', 'ping', 'pong', 'resume'] as const;

function boundedPayload(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CetaError('invalid_protocol', 'WebSocket frame payload is invalid');
  }
  if (!encoded) {
    throw new CetaError('invalid_protocol', 'WebSocket frame payload is invalid');
  }
  if (encoded.length > 65_536) {
    throw new CetaError('invalid_protocol', 'WebSocket frame is too large');
  }
  return encoded;
}

export function validateMeshFrame(value: unknown): MeshFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CetaError('invalid_protocol', 'Invalid WebSocket frame');
  }
  const record = value as Record<string, unknown>;
  if (!FRAME_KINDS.includes(record.kind as MeshFrame['kind']) || !Number.isInteger(record.sequence) || Number(record.sequence) < 0 || Number(record.sequence) > Number.MAX_SAFE_INTEGER) {
    throw new CetaError('invalid_protocol', 'Invalid WebSocket frame');
  }
  if (record.cursor !== undefined && (typeof record.cursor !== 'string' || record.cursor.length > 256 || !/^[A-Za-z0-9._:-]*$/.test(record.cursor))) {
    throw new CetaError('invalid_protocol', 'Invalid WebSocket cursor');
  }
  if (record.payload !== undefined) { boundedPayload(record.payload); }
  return {
    kind: record.kind as MeshFrame['kind'],
    sequence: Number(record.sequence),
    ...(record.cursor === undefined ? {} : {cursor: record.cursor as string}),
    ...(record.payload === undefined ? {} : {payload: record.payload}),
  };
}

export class WebSocketClient {
  constructor(private readonly factory: (url: string) => MeshSocket) {}

  reconnectDelay(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new CetaError('invalid_protocol', 'Invalid reconnect attempt');
    }
    return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  }

  connect(trust: DeviceTrust, handshake: MeshHandshake): MeshSocket {
    if ((trust.trustState ?? 'trusted') !== 'trusted') {
      throw new CetaError('unauthorized', 'Device trust is not active');
    }
    const url = trust.endpoint.replace('https://', 'wss://') + '/mesh/ws';
    const socket = this.factory(url);
    socket.send(JSON.stringify({protocol: 'cetamesh', version: 1, type: 'mesh.handshake', payload: handshake}));
    return socket;
  }

  send(socket: MeshSocket, frame: MeshFrame): void {
    const checked = validateMeshFrame(frame);
    socket.send(JSON.stringify(checked));
  }
}
