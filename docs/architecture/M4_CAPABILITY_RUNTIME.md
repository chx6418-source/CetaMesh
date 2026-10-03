# CetaMesh Mobile — M4 Capability Runtime

This record covers the platform-independent Capability contract, the routing
runtime, and the first native providers delivered in M4. Native capability
implementations remain separate task records even though they share this
runtime boundary.

## Contract

`src/domain/capability/Capability.ts` owns the public types:

- `CapabilityDescriptor` names a versioned capability and the platforms that
  implement it.
- `CapabilityRequest` carries a semantic capability name, bounded input owned
  by the provider contract, and optional correlation context.
- `CapabilityResult` returns the capability name with provider output.
- `CapabilityProvider` lists and invokes capabilities without exposing Android
  or iOS objects to features.

The catalog contains only the roadmap capability names. An unrecognized name
is not a routable extension point.

## Runtime boundary

`CapabilityRouterRuntime` registers descriptors for the active platform and
selects exactly one provider for each capability. Its invocation order is:

```text
request
  ↓
known capability check
  ↓
platform/provider lookup
  ↓
Permission Policy authorization and grant consumption
  ↓
CapabilityProvider.invoke
  ↓
bounded CapabilityResult validation
```

Unknown names fail with `permission_denied` before Policy or Provider access.
Known names without an active provider fail with `unsupported`. Provider
errors are converted to the standard `CetaError` model, and malformed results
fail with `invalid_protocol`.

The router requires a `CapabilityPolicy` port. `TASK-M4-002` supplies its
deny/ask/allow-once implementation. There is no allow-all fallback.

`TASK-M4-003` registers `camera.capture` through the same router. Its native
provider returns only a bounded JPEG attachment from an app-owned cache file;
it rejects caller-supplied paths and removes the temporary file after reading.

`TASK-M4-004` registers `microphone.record` through the same router. Its native
provider presents an explicit foreground recording surface, limits a recording
to 60 seconds and 8 MiB, returns bounded base64 audio from an app-owned cache
file, and stops plus cleans up when the recording is cancelled or the app
leaves the foreground. It rejects caller-supplied paths and encoded path
traversal before reading the cache file.

`TASK-M4-005` registers `file.pick` and `photos.select` through an adapter over
the existing bounded `PickerProvider`. The adapter rejects caller-supplied
input, revalidates the typed attachment result, and lets the shared Runtime
consume the one-time Policy grant before opening the Android or iOS system
picker. Chat UI receives only the validated `CapabilityResult`; it does not
call the picker Provider directly.

`TASK-M4-006` registers `notification.send` with a title/body-only input
contract. The Provider revalidates the bounded JSON before delegating to the
Android notification manager or iOS `UNUserNotificationCenter`. Both native
implementations require the platform notification permission, expose no
arbitrary intent, URL, userInfo or executable payload, and map an OS denial to
`permission_denied`.

## Platform rule

The runtime accepts the platform as a value (`android` or `ios`) and does not
import React Native or a platform SDK. Kotlin and Swift implementations remain
behind `NativeCapabilityProvider`, which extends the same provider contract.
