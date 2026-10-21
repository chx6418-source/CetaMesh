# 14 Security

Treat Catalog data, packages, manifests, input, and network responses as untrusted. The client requires HTTPS and configured host allowlists, enforces bounded downloads, and verifies package SHA-256. Use minimal permissions and route protected actions through CetaMesh services.

Install disabled after Owner review. Mark local code Unverified / Local and require Developer Mode plus separate first-enable review. Offline Catalog data is view-only. Revocation does not automatically delete installed files or user data. Process isolation is defense in depth, not a complete boundary for hostile native code.
