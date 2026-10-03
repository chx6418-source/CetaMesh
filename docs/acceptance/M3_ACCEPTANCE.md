# M3 acceptance

M3 is authorized by the user's explicit 2026-09-30 request. Prior native gates
remain BLOCKED; no automated check is a substitute for a native/device result.

## Automated evidence — 2026-09-30

| Verification | Result |
| --- | --- |
| `npm run check` | PASS: TypeScript, ESLint 0 errors/warnings, architecture guard, 26 Jest suites / 111 tests, 0 skipped |
| Schema v2→v3 / repeat migration / file-backed reopen | PASS in actual Node SQLite; existing Memory preserved |
| Token expiry, replay after restart and changed invitation ID | PASS; replay rejected before second transmission; only SHA-256 fingerprint persisted |
| Real Node P-256 exchange/confirm and tampered proof | PASS; private test keys stay in test memory, not platform evidence |
| Cancel during SQL insert / removal during final confirm | PASS; rollback or cancellation leaves no stale trust |
| Removed trust cancels authorization / local key binding | PASS in Runtime tests; no real M6 connection implemented |
| RN URL vs Node URL unsafe-origin regression | PASS with the installed RN URL implementation |
| Devices two confirmations and delayed refresh | PASS; no token rendered; trust visible after committed confirmation |
| Android/iOS RN Codegen | PASS, including fingerprint and configured Android Java package |
| Android/iOS release JS bundles | PASS; native compilation not implied |
| Android Debug APK | PASS in CI run 36711723719 on 1f7f89b; all four configured ABIs, native Kotlin and APK upload |
| APK static gate | PASS in CI run 36716374111: v2 signature, SDK/package, permissions, backup/export flags, four ABIs, three M3 native modules, no secret-like files |
| iOS native build / supported hardware / real peer | NOT_RUN_ENVIRONMENT: Linux without Xcode/Pods or native device runtime; no Desktop protocol implementation modified |

Codegen command: `node node_modules/react-native/scripts/generate-codegen-artifacts.js -p . -t all -o /tmp/ceta-m3-final-codegen`.
Both bundle commands use `npx --no-install react-native bundle --platform android`
(or `ios`) `--dev false --entry-file index.js --bundle-output /tmp/ceta-m3-final-android.bundle`
(or iOS equivalent), plus `--assets-dest` and a temporary verification-only Metro
config that watches the real reused node_modules symlink target. Product Metro
configuration is unchanged; fresh CI uses npm ci. RN private-export/NO_COLOR
warnings occurred but did not fail packaging.

Independent review: two Important and one Minor finding addressed, plus parent
token-fingerprint regression. See `M3_REVIEW.md` for evidence and native limits.
M3 Gate remains **BLOCKED**, not PASS. First M3 Android CI run `36711135511`
failed at SDK setup: the package `platforms;android-37` does not exist in the
published repository. Code compilation and npm checks were skipped. The official
[SDK repository metadata](https://dl.google.com/android/repository/repository2-3.xml)
publishes `platforms;android-37.0` and Build Tools 37.0.0; CI now requests the
explicit platform package. Subsequent [run 36711723719](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36711723719)
completed **PASS**: clean npm ci/check, Kotlin/native compilation and assembleDebug
(`BUILD SUCCESSFUL in 17m 15s`), APK upload artifact 11095696570. Artifact archive
SHA-256: f5112e90735a44c1870f55757cccb87c66c4ee1a57d8810ae68eb2f3039d7325.
APK has not been installed or launched; iOS/device/real-peer acceptance remains
NOT_RUN_ENVIRONMENT. The local Linux toolchain is still not provisioned.

The follow-up [run 36716374111](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36716374111)
also completed PASS after adding a required post-build gate. It verifies the APK
Signature Scheme v2 signature, package and SDK levels, required Camera/Internet
permissions, absence of legacy storage/network-state permissions, disabled backup,
non-exported QR activity, all four configured ABIs, and compiled Identity/QR/
Pairing modules before artifact upload. Artifact 11097261367 archive SHA-256 is
d7a4a206af70d1055ef27277fe209021e26782ffb1662d367afe9f16cff02880.
A locally modified copy failed the gate. Static inspection does not replace launch,
hardware-backed key, camera lifecycle, controlled HTTPS or real-peer tests.

## Required native evidence (NOT_RUN_ENVIRONMENT until run)

- Android Debug CI: PASS. APK launch, existing chat/memory usability: NOT_RUN_ENVIRONMENT.
- Android identity remains stable across app restart/update; private key cannot
  be exported; corrupted/missing key metadata fails closed, no silent rotation.
- iOS device with Secure Enclave: same checks; simulator fails unsupported safely.
- QR permission deny, cancel, scan invalid QR, rescan, background/foreground.
- TLS validation and redirects tested against a controlled HTTPS peer.
- Recoverable disconnects and HTTP 408/503 do not retransmit the exchange token;
  verify invalid ports/loopback inputs safely reject in both native transports.
- Expired/used QR rejected both by Mobile and the real peer; signatures verified.
- Confirmation cancelled or expired: no trust; restart preserves used invitation.
- Confirm trust, restart, delete trust, attempt connection: unauthorized.
- No token/private key/raw QR in SQLite, logs, screenshots or crash reporting.
- Restore/backup/reinstall behavior checked: public metadata without key must not
  silently become a new trusted identity. Existing trust cannot authorize a new key.
- Delete trust on one side after peer acceptance; verify peer-side consent/trust
  behavior separately. M3 removal cancels local authorization, not remote state.

The actual Desktop peer is not modified by this task. Its compatibility with
`docs/protocol/M3_PAIRING_V1.md` requires separate end-to-end verification.
