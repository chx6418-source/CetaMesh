# 06 Plugin API

The v1 handler export is CommonJS: module.exports.handlers maps capability ids to async functions. Each handler receives (input, context) and returns bounded JSON-compatible data.

context.log is available for diagnostics. Storage, fetch, memory, and workspace adapters are conditional on Runtime support and reviewed permissions. Protected operations remain behind the Capability Broker. Treat caller input and responses as untrusted; never return credentials or executable code.
