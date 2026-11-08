# 06 Plugin API

The v1 handler export is CommonJS: module.exports.handlers maps capability ids to async functions. Each handler receives (input, context) and returns bounded JSON-compatible data.

context.log is available for diagnostics. Storage, fetch, memory, and workspace adapters are conditional on Runtime support and reviewed permissions. Protected operations remain behind the Capability Broker. Treat caller input and responses as untrusted; never return credentials or executable code.

Process and trusted VM handlers with `settingsSchema` receive read-only
`context.settings` after an exact host configuration receipt. It contains only
declared public values and defaults. Changed public settings use controlled
restart; equal public settings preserve the host. `secretRef` values are not
included and no secret resolver is available. The Settings UI distinguishes
saved, acknowledged, pending and failed application. See
[Extension settings](../desktop/EXTENSION_SETTINGS.md) for compatibility and retry.
