# M1 Chat Security

## Credentials

ProviderSettings validates endpoints before touching credentials.
API keys are stored through react-native-keychain in Android Keystore/iOS Keychain.
iOS accessibility uses WHEN_UNLOCKED_THIS_DEVICE_ONLY. There is no plaintext fallback.
Provider rows contain only a credential reference.
When editing a key, a new reference is staged securely before publishing metadata;
secure-write or SQLite failure cannot pair an old key with a changed endpoint.
Staged secrets are removed after a database failure, and previous references are
retired after successful publication. Cleanup is best-effort if secure storage
itself fails; an unreachable key may remain in the OS store, never SQLite/files.
Deleting a provider key resolves its current reference and verifies deletion.
No device identity/private key is created in M1.

## Network and errors

Only user-configured HTTPS base URLs are accepted. Credentials in URLs, query
strings and fragments are rejected. RN platform networking performs TLS validation.
Errors shown to users use CetaError codes and fixed safe messages.
Raw provider bodies and raw native exceptions are never included in error messages.
SSE frames and total response size are bounded. Requests support timeout and abort.
No real paid model request is made by tests; API key values in tests are fixtures.
Live TLS/redirect/certificate behavior still needs native device acceptance.

## Local content and input

SQLite stores local chat history and selected attachment bytes. It is not a secret store.
A one-time app confirmation plus the system picker scopes access to the user-selected resource.
Unknown capability → permission_denied; grant replay/expiration → permission_denied.
No Capability input accepts an arbitrary file path.
File size and MIME are checked before reading and content is validated after reading.
The selected resource is copied through the picker into a local cache file, then
statted and read; that copy is cleaned up on completion/failure. Content URI IDs
are opaque, while decoded file paths reject traversal and control characters.
Only safe picker URI schemes are accepted; images have basic MIME/signature checks.
The application never evaluates attachments as JS, shell, plugins or executable code.
Attachment contents are sent only when the user sends a turn; sent conversation history
is included in later model requests. Staged unsent attachments stay in UI memory.

## Native scope

Android's merged Manifest removes blob utility wake-lock, network-state,
Wi-Fi-state, broad read/write storage, silent-download permission and file provider.
Only INTERNET is declared by the app; selected-resource access comes from OS pickers.
The final merged Manifest must be checked in the first native build.
iOS includes a photo-library purpose string. No camera or microphone is enabled.
No unrestricted bridge, WebView, shell, dynamic executable or agent runtime exists.

## Observability

Use event names, IDs and typed codes, not messages, attachments, API keys or responses.
The structured logger redacts credential keys and circular objects.
M1 does not log model request/response bodies or attachment content.
Memory, pairing and cross-device sync remain unimplemented, with no default upload path.
