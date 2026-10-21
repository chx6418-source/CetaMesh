# Camera capability providers

## camera.capture

`CameraCaptureProvider` is registered in the M4 Capability Runtime. It can
only be reached after `CapabilityPolicy` authorizes `camera.capture`. The
Android Kotlin module and iOS Swift module launch the platform camera UI and
return a JPEG in the app cache. The provider validates the URI, MIME type and
size, reads bounded image bytes, then removes the temporary file.

The capability does not accept a caller-supplied path or URI. Camera images
are returned as bounded attachment data to the Runtime; the native module does
not expose a camera object to JavaScript.

## camera.scanQr

Native QR UI is launched only by QrScannerRuntime after QrScanPolicy grants one
use. Android uses bundled ZXing Android Embedded 4.3.0; no Play Services or
runtime-downloaded scanner is required. This dependency is isolated inside Kotlin,
uses camera permission only, and its API was checked against upstream source.
Its release cadence is slow; native SDK 37 compilation/device checks are required.
iOS uses Swift AVFoundation, with a small codegen ObjC++ adapter. Camera images
are not returned, stored or uploaded; only bounded QR text reaches the runtime.
Both camera providers offer cancellation and stop or cancel when their host
leaves the foreground. `camera.capture` additionally uses a FileProvider on
Android so the external camera receives only a one-use app-cache URI.

M4 camera Codegen PASS. Android native compile, iOS compile, merged-permission
review, OS denial, capture lifecycle and hardware acceptance remain
`NOT_RUN_ENVIRONMENT` until CI/device execution.
