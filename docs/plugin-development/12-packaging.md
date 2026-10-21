# 12 Packaging

A distributable is a ZIP archive with the .cetamesh-plugin extension. Include the validated manifest, entry module, and required runtime files only. Exclude .git, node_modules, build output, environment files, credentials, and signing keys.

The client bounds package bytes and entries, rejects unsafe paths and sensitive files, verifies declared byte count and SHA-256, stages extraction privately, and delegates installation to the Extension Runtime. The suffix does not imply trust.
