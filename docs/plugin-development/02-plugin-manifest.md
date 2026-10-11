# 02 Plugin manifest

The Runtime accepts extension.json and legacy manifest.json. Version 1 fields include manifestVersion, stable lower-case id, name, publisher, description, plugin SemVer, type, relative entry, capabilities, permissions, and optional minCetaMeshVersion/maxCetaMeshVersion inclusive bounds. network.hosts scopes network permission; scope.paths scopes filesystem permissions.

Unknown or forbidden permissions fail validation. Use examples/plugin-template/extension.json as the reference. Manifest metadata is not a cryptographic publisher signature.
