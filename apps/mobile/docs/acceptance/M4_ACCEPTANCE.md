# M4 Capability Acceptance

Current status: `BLOCKED`

## Task records

### TASK-M4-001 — Capability Runtime

Status: `DONE` for implementation and automated verification.

Implemented:

- versioned, platform-independent Capability descriptors;
- roadmap capability catalog with unknown-name rejection;
- active-platform Provider registration and enumeration;
- policy-before-provider invocation ordering;
- unsupported-platform result mapping;
- duplicate-provider and malformed-result fail-closed behavior;
- standard `CetaError` mapping for provider failures.

Verification:

- `npm run typecheck` — PASS;
- `npm run lint` — PASS;
- `npm run test:architecture` — PASS (5 Node checks);
- `npm run test:unit -- --runInBand` — PASS (27 suites / 117 tests).

### TASK-M4-002 — Capability Policy

Status: `DONE` for implementation and automated verification.

Implemented:

- in-memory `deny`, `ask` and `allow-once` modes;
- unknown capability default deny, including direct Policy configuration;
- explicit one-time prompt decisions;
- expiring, single-use grants with no SQLite or file persistence;
- prompt failure normalization to `permission_denied`;
- concrete Runtime integration proving Policy runs before Provider access.

Verification:

- `npm run check` — PASS (28 suites / 126 tests);
- native OS prompt and platform behavior — `NOT_RUN_ENVIRONMENT`.

### TASK-M4-003 — Camera

Status: `DONE` for implementation, JavaScript verification and Codegen.

Implemented:

- `camera.capture` descriptor and Provider registration;
- bounded JPEG validation, app-cache URI validation and cleanup;
- Android Kotlin TurboModule with non-exported capture Activity and scoped
  `FileProvider` URI;
- iOS Swift camera picker and Objective-C++ New Architecture adapter;
- Runtime Policy prompt and production service composition;
- cancellation, timeout, unsupported-device and OS permission error mapping.

Verification:

- `npm run check` — PASS (29 suites / 131 tests);
- React Native Android/iOS Codegen — PASS;
- Android native compile and APK static gate — PASS in Android CI run
  [36730384479](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36730384479);
- iOS compile, OS prompt behavior and physical camera lifecycle —
  `NOT_RUN_ENVIRONMENT`.

### TASK-M4-004 — Microphone

Status: `DONE` for implementation, JavaScript verification and Codegen.

Implemented:

- `microphone.record` descriptor and Provider registration through the
  Capability Runtime and Permission Policy;
- bounded `audio/mp4` result validation, 60-second/8 MiB limits, base64
  validation, encoded path-traversal rejection and cache cleanup;
- Android Kotlin TurboModule with a non-exported, visible foreground recording
  Activity, runtime `RECORD_AUDIO` permission, cancellation on pause and a
  60-second safety timeout;
- iOS Swift `AVAudioRecorder` provider with a visible stop surface,
  `NSMicrophoneUsageDescription`, foreground cancellation and audio-session
  cleanup;
- New Architecture TurboModule adapters and production service composition;
- standard mapping for permission denial, cancellation, unsupported platform,
  storage and protocol failures.

Verification:

- `npm run check` — PASS (30 suites / 136 tests);
- targeted microphone tests — PASS (5 tests), including encoded path
  traversal rejection and temporary-file cleanup;
- React Native Android/iOS Codegen — PASS;
- Android and iOS Metro release bundles — PASS;
- Android native compile/APK static gate, iOS compile, OS microphone prompt,
  foreground lifecycle and physical microphone behavior —
  `NOT_RUN_ENVIRONMENT` locally.

### TASK-M4-005 — File / Photos

Status: `DONE` for implementation and automated verification.

Implemented:

- `file.pick` and `photos.select` descriptors registered in the shared
  Capability Runtime for Android and iOS;
- `AttachmentCapabilityProvider` adapter over the existing bounded
  `PickerProvider`, with no caller-supplied URI/path input;
- revalidation of attachment MIME, size, content signature and bounded data
  before returning a `CapabilityResult`;
- Chat UI now calls only `services.capabilityRuntime`, parses the typed result,
  and no longer opens the legacy attachment Provider path directly;
- production Policy prompt and explicit `ask` modes for both capabilities.

Verification:

- `npm run check` — PASS (31 suites / 141 tests);
- targeted file/photos adapter, attachment policy and Chat UI regression tests
  — PASS (13 tests);
- Android/iOS Metro release bundle verification — PASS;
- Android/iOS system picker, permission and native build behavior —
  `NOT_RUN_ENVIRONMENT` locally.

### TASK-M4-006 — Notification

Status: `DONE` for implementation, JavaScript verification and Codegen.

Implemented:

- `notification.send` descriptor and Provider registration through the shared
  Capability Runtime and Permission Policy;
- title/body-only payload with bounded UTF-8 size, length and control-character
  validation; arbitrary URL, intent, userInfo and executable fields are not
  accepted;
- Android Kotlin TurboModule with a non-exported foreground permission
  Activity, `POST_NOTIFICATIONS` handling, a dedicated notification channel,
  local notification delivery and permission/error mapping;
- iOS Swift `UNUserNotificationCenter` provider with explicit authorization,
  bounded local request content and cancellation support;
- New Architecture adapters and production service composition, including
  Provider cancellation during service shutdown.

Verification:

- `npm run check` — PASS (32 suites / 146 tests);
- targeted notification and Capability Runtime tests — PASS (12 tests);
- React Native Android/iOS Codegen — PASS, including
  `NativeCetaNotificationSend`;
- Android/iOS Metro release bundles — PASS;
- Android native compile/APK static gate, iOS compile, OS notification prompt
  and delivery behavior — Android compile and APK static gate PASS in CI run
  [36730384479](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36730384479);
  iOS compile, OS prompt and delivery behavior are `NOT_RUN_ENVIRONMENT`.

## M4 Gate

Android CI run [36730384479](https://github.com/chx6418-source/cetamesh-mobile/actions/runs/36730384479)
passed `npm ci`, `npm run check`, Android Debug APK compilation, APK static
verification and Debug APK upload for commit `4c11c4ca6cfd336850ab967cc8113853bb7aba9b`.
Artifact `11104509585` was uploaded successfully.

The M4 phase gate remains `BLOCKED`: iOS compilation, Android/iOS OS prompts,
installed-app system picker and notification behavior, camera/microphone
hardware and device lifecycle acceptance are `NOT_RUN_ENVIRONMENT`. No M4 Gate
PASS is claimed until those platform checks can run.
