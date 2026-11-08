# ADR — Optional Desktop Extension public settings profile

- Status: ACCEPTED for the Desktop source profile; installed release acceptance is separate.
- Scope: current Desktop Worker v1 producer and consumer; CP-020 remains PROPOSED.
- Decision: retain v1 JSON-line framing and add an opt-in `public-settings-v1`
  configuration handshake for executable manifests with nonempty `settingsSchema`.

## Authority and compatibility

Settings remains desired authority and Runtime remains host/generation authority.
No additional grants, external protocol, Runtime, or credential resolution API is
introduced. All existing invoke/result/error/cancel/ping/pong/shutdown frames keep
their current shape. No-settings packages continue using only those legacy
frames. Package handlers need no lifecycle hook; the controlled host installs
immutable public settings before making a handler callable.

| Producer | Consumer | Result |
| --- | --- | --- |
| Current Core, no settings | Current or legacy Worker v1 | Existing protocol unchanged |
| Current Core, settings profile | Current Worker | Exact configuration ACK required before capabilities become effective |
| Current Core, settings profile | Legacy or unsupported Worker | Error or timeout; no effective receipt, even if ping succeeds |
| Legacy Core | Current Worker, no settings | Existing invocation path |
| Legacy Core | Current Worker, settings profile | Invocation rejects with settings pending; no inference from saved data |
| Current Core | Trusted VM | Same configuration validation and receipt, without process wire |
| Current Core | HTTP/event data host | Unsupported settings consumption |
| Current Core | Memory Pack / Skill content | Not applicable; no execution authority |

## Frames and semantic schema

Core sends `{v:1,id,kind:"configure",configuration}`. `configuration` has exactly:
`profile`, `id` (Extension id), `version`, `packageFingerprint`,
`schemaFingerprint`, `revision`, `generation`, and `values`.
`profile` is `public-settings-v1`; generation is a positive safe integer;
configuration is bounded to 160 KiB. Values contain exactly declared nonsecret
fields, validated against the package's normalized settings schema. Missing
optional values use null; required public values must be present. Revision is
the SHA-256 of the exact binding and canonical schema-order public values.

The Worker answers `{v:1,id,kind:"configured",receipt}` only after installing
those values. Receipt carries the same identity, schema, revision and generation,
without `values`. Rejection uses the existing error frame with capability
`$settings` and a fixed error message. A duplicate configuration requires a new
host. Configuration and receipt never carry secrets or filesystem paths.
Validation is implemented in `src/extension/settings-protocol.js` and exercised
by positive/negative vectors in the registered Extension runtime suite's
`scripts/test-support/extension-settings-cases.mjs`.

The host owns timeout and exact request-id matching. Runtime independently
checks the receipt and rechecks installed review, enabled state, current desired
revision, host identity and generation. Late ACK cannot override disable,
uninstall, version change or a newer save. No ACK means no effective capability
publication; a transport ping is not an alternative receipt.

## Storage migration and rollback

Public schemaVersion 1 keeps its `values` field and adds optional binding/edit
revision metadata. Legacy readers ignore metadata. Legacy bytes are not rewritten
on read. Unbound or differently bound values require explicit Owner save before
delivery; partial edits do not consent to untouched legacy values. An older
writer that removes metadata causes current code to require review again.
The private key/value store is unchanged and raw credentials are never delivered.

Rollback to an older Core retains readable public/private files, but does not
provide this configuration effect feature. Rolling an Extension package to a
different version requires settings review for that exact package. Failure to
save does not claim application; failed private writes do not publish cache,
and public-write failure restores completed private changes or reports explicit
recovery failure. Existing stored values and invocation evidence are retained.

## Verification limits

Registered Desktop tests cover real Worker configuration results and no-op PID,
other-host isolation, current-revision retry, mismatched/late ACK, disable,
unconfirmed stop, partial persistence and legacy envelope compatibility.
No Mobile wire implementation is changed. Installed binaries, SEA packaging,
native user acceptance and release safety require independent environment gates.
