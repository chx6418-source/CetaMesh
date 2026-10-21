# M3 review disposition — 2026-09-30

An independent read-only review inspected the full M3 diff against local bb14af5,
including TASK-M3-004 working sources. It reported no Critical finding, two
Important findings and one Minor finding. All three were addressed before upload.

| Finding | Change | Evidence / limit |
| --- | --- | --- |
| Android implicit POST retry | Disable retryOnConnectionFailure; one-shot RequestBody also prevents HTTP follow-up resend | OkHttp 4.9.2 contract inspected; native controlled-peer test NOT_RUN_ENVIRONMENT |
| RN URL normalization admits invalid port/loopback | Platform-independent canonical DNS/IPv4 grammar, bounded ports and host checks; native validation and guarded Android Request construction | Actual RN URL and Node URL regression RED→GREEN; native crash/TLS test NOT_RUN_ENVIRONMENT |
| Cancel during trust refresh hides committed trust | End confirmation stage before refresh; authoritative list survives pairing cancellation while mounted | Delayed refresh UI regression RED→GREEN |

Parent security checks also found a token could be reused with a changed invitation
ID. A new regression failed before the fix. Native SHA-256 fingerprint plus durable
unique pairing_used.token_hash now rejects it before a second transmission; no
raw token is stored. The peer must still perform authoritative atomic token
consumption and expiry checks independently.

Other regression coverage includes real Node P-256 DER signatures, key/proof
tampering, cancel during SQL insertion with rollback, trust removal during final
confirmation, cancellation of active trust authorization and file-backed reopen.
No mock/test key establishes platform hardware safety. Native code review/codegen
is not a native build result; device acceptance remains BLOCKED.
