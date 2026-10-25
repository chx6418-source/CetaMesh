# CetaMesh Mobile — M0 Security Baseline

For current M1 credential/input/network behavior, see
[M1_CHAT_SECURITY.md](M1_CHAT_SECURITY.md). The following M0 record is historical.
Current M2 local-only memory/confirmation/pin boundaries are documented in
[M2_MEMORY_SECURITY.md](M2_MEMORY_SECURITY.md).

This document records security behavior that is actually present in M0. It
does not claim that future native permissions, pairing, secure storage, or
Desktop Sync are implemented.

## Implemented in M0

- Feature code is checked so it cannot import concrete `src/native` providers.
- Protocol types are checked so they do not import React Native or native providers.
- `CetaError` uses a typed `CetaErrorCode` and remains a standard `Error`.
- Structured logs attach a `traceId` and recursively redact API keys, tokens,
  secrets, credentials, passwords, private keys, authorization headers,
  cookies, session fields, and pairing tokens.
- Circular diagnostic objects are rendered as `[CIRCULAR]` so logging cannot
  crash the caller through unbounded recursion.
- API secrets and device private keys have no M0 SQLite schema or ordinary-file
  storage path.
- M0 has no shell execution, dynamic code execution, plugin execution, or
  unrestricted native bridge.
- SQLite migrations validate positive unique versions and run inside the
  connection transaction boundary; there is no destructive reset path.

## Not yet implemented

- Android Keystore and iOS Keychain providers.
- Capability Permission Policy and native capability implementations.
- Device identity, pairing tokens, replay protection, and trust storage.
- HTTPS/WebSocket schema validation and sync-event deduplication.
- Push permissions, background jobs, Camera, Microphone, NFC, and Bluetooth.

These belong to later roadmap tasks and must not be inferred from the M0
interfaces.

## Logging rule

Callers should log event names and metadata, not full user messages, file
contents, Memory text, API keys, tokens, pairing secrets, or private keys.
