# 04 Permissions

Request only what the plugin needs. Permission families include log, storage, network, memory.read, memory.write, filesystem.read, and filesystem.write. Network requires a host allowlist; filesystem requires scoped relative paths. Memory and filesystem work still passes through CetaMesh capability services and Owner policy.

shell, native, download, and process are forbidden. Updates that add permissions require fresh review. A declaration is a request, not arbitrary host access.
