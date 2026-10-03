# M3 pairing v1 wire contract

This is the Mobile-side integration contract, not a claim that the read-only
Desktop repository already implements it. Envelope keys remain protocol, version,
id, type, timestamp, payload. Version is exactly 1. Unknown message types fail
closed. Payloads are bounded and projected to known properties before use.

QR uses type `pairing.invitation`; payload: invitationId, endpoint (HTTPS origin
only, optional port; no credentials/query/fragment/path), token (32 random bytes,
base64), expiresAt (ISO UTC), peer {deviceId, deviceName, publicKey}. Public keys:
uncompressed P-256 X9.63 (65 bytes), base64. Private keys never cross the bridge.
QR maximum 8192 characters. Invitation TTL at receipt cannot exceed 5 minutes.
Canonical endpoints use lowercase ASCII DNS labels (punycode if needed), or full
decimal IPv4 with no leading zeroes. Explicit ports are 1–65535, excluding 443
(omit the default port). No trailing dot, IPv6 literal, integer/hex/octal/short IP,
localhost or 0/127 IPv4 network; no URL normalization dependent on RN's URL class.
DNS names must resolve to the intended peer; this is not a DNS/IP sandbox.
No localhost/credentials/cleartext fallback. LAN HTTPS is permitted with normal
system certificate validation, never trust-all certificates.

After user confirms the destination, Mobile consumes the peer/invitationId and
SHA-256 fingerprint of the canonical token's UTF-8 base64 text durably before
any network request. The fingerprint has a unique SQLite constraint: changing
the invitation ID or peer ID cannot retransmit the same token from this install.
Raw token is never persisted. Endpoint owner MUST also atomically consume token
at exchange time and reject reuse/expiry independently of Mobile. A transport
failure requires a fresh invitation; no automatic exchange retry.

POST /cetamesh/v1/pairing/exchange: `pairing.exchange` envelope with payload
{invitationId, token, nonce, device, signature}. Device is public identity only.
Nonce is 32 secure random bytes base64. Client signature signs JSON.stringify of
['cetamesh-pairing-v1','exchange',invitationId,endpoint,peer.deviceId,
peer.publicKey,device.deviceId,device.publicKey,nonce,expiresAt].

Response `pairing.challenge`: {invitationId,nonce,peer,expiresAt,signature}.
All fields must match the invitation/client request. Peer signs same transcript
with phase 'challenge'. All signatures are DER ECDSA-SHA256 base64. This binds
the QR key to the response and prevents swapping the peer, endpoint or client.

Mobile displays peer and key for explicit trust confirmation. POST
/cetamesh/v1/pairing/confirm: `pairing.confirm` payload {invitationId, nonce,
deviceId, signature}, signature over same transcript phase 'confirm'.
Response `pairing.accepted`: {invitationId,nonce,peer,expiresAt,signature},
signed over same transcript phase 'accepted'. Revalidate expiry after every
asynchronous boundary and before SQLite persistence. Persist only public trust
metadata, never token, raw QR, transcript, or temporary signature.

HTTPS redirects, cookies and response bodies >32768 bytes are forbidden. Requests
are cancellable, bounded to 15 seconds; raw networking errors/bodies are never
logged. Native transport uses default certificate validation.
Android disables connection retries and marks each POST body one-shot, including
HTTP follow-ups. Controlled native-network acceptance still must verify no resend.

Removing trust immediately invalidates local authorizations and cancels associated
in-flight pairing work. Future M6 transports must acquire current trust for every
connection rather than cache a trust row indefinitely. No M6 socket is implemented.
