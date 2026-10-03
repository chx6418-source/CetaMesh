# M3 device identity and pairing

DevicesScreen calls IdentityRuntime, PairingRuntime and QrScannerRuntime through
MobileServices. The app composition root injects domain ports; Feature and Runtime
never import concrete native/database/network providers. Protocol stays independent
of React Native. No M4 capability rollout, M6 sync, account login or Agent is added.

IdentityRuntime coalesces initialization and returns only validated public metadata.
The New Architecture identity module keeps P-256 private keys in hardware-backed
Android Keystore or iOS Secure Enclave. Signing, verification, secure nonce and
token fingerprint operations are bounded. No private-key export, software fallback,
silent key rotation or repair API is exposed. Device identity is not user identity.

QrScannerRuntime requires a one-use camera.scanQr policy grant and invokes only
the injected QrScanner port. Kotlin uses bundled ZXing; Swift uses AVFoundation.
Platform UI handles OS permission, timeout, cancellation and foreground lifecycle.
Only bounded QR text leaves native code; no image is retained or uploaded.

PairingRuntime has destination and trust confirmation stages. It validates QR,
consumes replay metadata durably, signs an exchange, verifies the peer's challenge,
and waits for explicit final confirmation and signed acceptance before persisting
trust. Every asynchronous boundary rechecks expiry/cancellation. A transaction
guard rolls back cancellation during trust insertion. Failed exchange requires
a fresh QR; it cannot retry a consumed token.

Native HTTPS transport has fixed pairing paths, default OS TLS validation,
redirect/cookie exclusion, 15-second deadline and bounded request/response bodies.
Android disables recovery and marks request bodies one-shot. The protocol uses
canonical DNS/IPv4 origins without relying on RN URL normalization; IPv6 literal
origins are currently unsupported. See the v1 wire contract for exact messages.

Additive SQLite schema v3 preserves chat/memory. device_trust holds public peer,
endpoint and local identity binding. pairing_used holds peer/invitation ID, expiry
and unique SHA-256 token fingerprint, never the token. Test DB is isolated and
file-backed reopen tests establish durable replay and trust persistence in Node.
Consumed fingerprints are retained; pruning/storage quotas are not implemented.

Every future connection must use withTrustedDevice, which reloads current trust,
checks the local identity and cancels an authorization lease on trust removal.
Removal blocks new authorization before deleting the row. No socket is created
in M3. Closing services cancels/drains pairing before closing SQLite.

Android native compilation and APK upload PASS in GitHub CI run 36711723719.
Public data is not secret storage; ordinary SQLite is not encrypted. Actual native
execution, iOS compilation, camera/key lifecycle, TLS behavior and Desktop interoperability are
unverified until the acceptance checklist is executed on supported hardware.
