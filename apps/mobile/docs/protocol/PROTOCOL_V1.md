# CetaMesh Protocol — M0 Boundary

M0 reserves the platform-independent protocol boundary for future Mobile and
Desktop communication. It does not implement Desktop Sync or execute incoming
events.

## Envelope

```ts
type ProtocolEnvelope = {
  protocol: 'cetamesh';
  version: number;
  id: string;
  type: string;
  timestamp: string;
  payload: unknown;
};
```

The type lives in `src/protocol/ProtocolEnvelope.ts` and has no React Native
or platform-provider dependency.

## Compatibility rules reserved by M0

- Protocol version is independent from SQLite schema version.
- Breaking protocol changes require a new protocol version.
- Unknown fields should be ignored when a later decoder is introduced.
- Unknown events must not execute side effects.
- Payload validation, event deduplication, revision handling, and acknowledgements
  are deferred until the Sync tasks.

## Current status

No network transport, WebSocket client, Desktop pairing, or sync queue is
implemented in M0.
