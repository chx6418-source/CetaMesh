# TASK-M3-001 native identity contract

TurboModule registry name: `CetaDeviceIdentity`. Import the default export and
`Spec` type from `./NativeCetaDeviceIdentity`. The default export is `Spec | null`;
the runtime must map absence to `unsupported`. No legacy NativeModules fallback.

| Method | Result |
| --- | --- |
| `getIdentity(): Promise<string>` | JSON string containing exactly `deviceId`, `deviceName`, `platform`, `publicKey`, `createdAt` |
| `sign(data: string): Promise<string>` | Canonical padded base64 of DER ECDSA P-256/SHA-256 signature |
| `verify(publicKey: string, data: string, signature: string): Promise<boolean>` | Public verification, without reading or creating the local identity |
| `randomNonce(): Promise<string>` | Canonical padded base64 of 32 CSPRNG bytes, without identity initialization |
| `fingerprint(token: string): Promise<string>` | Lowercase SHA-256 hex of canonical 32-byte token's UTF-8 base64 text; no identity initialization or persistence |

`deviceId` is a lowercase CSPRNG UUID v4. `deviceName` is stable public metadata,
max 100 UTF-16 code units with no ASCII controls (Android initial model label is
sanitized and capped at 64; iOS uses `iOS device`). `platform` is `android` or `ios`.
`createdAt` is a UTC ISO-8601 string with milliseconds (`yyyy-MM-ddTHH:mm:ss.SSSZ`).
`publicKey` is canonical padded standard base64 of a **65-byte uncompressed X9.63
P-256 point**, byte `0x04` followed by 32-byte big-endian X and Y. Not SPKI/PEM.

`data` is a message, not base64 or a precomputed hash. Native code signs/verifies
its UTF-8 bytes using SHA-256. Both operations accept empty strings and at most
16,384 UTF-8 bytes; no Unicode normalization. Callers should pass well-formed
Unicode (Android rejects malformed surrogate sequences). No key export/deletion,
rotation, arbitrary aliases, or custom signing algorithm is exposed.

Input bounds: public key base64 at most 88 characters, decoded exactly 65 bytes;
signature base64 at most 96 characters, decoded 8–72 bytes. Base64 must round-trip
canonically. Malformed encodings, off-curve points, and oversized input reject
`invalid_protocol`. Bounded signatures that fail DER parsing/cryptographic
verification resolve `false`; valid signatures resolve `true`.

Native promise rejections use only safe fixed messages and standard CetaError
codes (the runtime constructs the JS CetaError):

| Code | Message |
| --- | --- |
| `invalid_protocol` | `Invalid identity input` |
| `unsupported` | `Secure device identity is unsupported` |
| `storage_error` | `Device identity is unavailable` |

Android uses the fixed AndroidKeyStore P-256 alias
`com.cetameshmobile.identity.p256.v1`, and **requires hardware backing** via
KeyInfo; this deliberately excludes software-backed Keystores/emulators. iOS
uses a permanent Secure Enclave Security.framework key with the same application
tag and `WhenUnlockedThisDeviceOnly` accessibility; no software fallback or
biometric prompt. Locked/unavailable stored keys fail closed. Public verification
and nonce generation can still work when identity hardware is unsupported.

Each platform has one process-wide serial queue, including across React host
reloads. Public metadata is persisted only after key creation, in one JSON
preference record, and is checked against the actual public key on every use.
Missing, partial, corrupted or mismatched metadata/key pairs reject
`storage_error`, **never recover by rotating or inventing a new device ID**.
Interrupted creation, failed preference persistence, iOS reinstall with retained
Keychain keys, or restored metadata without its device-bound key can therefore
make identity unavailable. A failed synchronous preference write is latched for
the process because preferences may already have changed in RAM. There is no
repair API in this task. Android software-only generation can leave an unusable
alias; no deletion is attempted. Preferences contain public metadata only.

## Verification and outstanding native gates

Local RN 0.87 Node codegen generates the Java spec, ObjC++ protocol/JSI adapter,
and iOS module provider registration. Gradle codegen reads the package's Android
javaPackageName; the generic all-platform Node artifact CLI instead uses its
default Java package, so also check using `generate-specs-cli.js` with
`--javaPackageName com.cetameshmobile.identity`.

Android native compile: **PASS** in GitHub CI run 36711723719, including configured
codegen and Kotlin module compilation. Device crypto/identity smoke and iOS build:
**NOT_RUN_ENVIRONMENT** (no supported hardware or Xcode in the local Linux host).
Build/codegen/TypeScript do not establish hardware behavior. No mocked key bytes
are used as evidence of native crypto correctness.

Before native acceptance, on hardware-backed Android and Secure Enclave iOS:

- Issue concurrent first getIdentity/sign calls and verify one stable identity;
  repeat after host reload and process restart.
- Cross-verify real Android/iOS signatures and raw public keys (DER, not raw r||s),
  changed data/key/signature rejection, and independent known-good vectors.
- Exercise 16,384 versus 16,385 UTF-8 bytes including multibyte strings, malformed
  base64/points/DER and nonce size/randomness.
- Exercise unavailable hardware, locked keys, corrupt/partial preferences,
  missing keys, interrupted creation and failed metadata persistence; confirm no
  silent rotation or private material in JS/errors/logs.

QR, runtime/policy integration and domain tests belong to the separate owner.
