# Third-party notices and review scope

CetaMesh retains the public repository's GPL-3.0 license. This does not relicense third-party components.

- SnowLuma SDK and MCP npm packages are excluded from package.json, lockfile and Core bundle. The postinstall patch is removed. An independently implemented OneBot v11 transport uses the MIT-licensed ws package; external gateway software is user-installed and is not distributed. The existing process/authorization/ownership boundaries remain.
- src/kugou-api.js retains its Mineradio/kugou.rs attribution. Upstream source version and redistribution license have not been independently established. Its fixed protocol signing constant is not represented as a personal API credential. Owner explicitly instructed retaining and pushing this section on 2026-10-21 after the unresolved provenance was disclosed. That instruction is recorded; it is not evidence of an upstream license grant.
- Unverified illustrative image, demonstration video and generated protocol schema ZIP are excluded from this public snapshot and preserved in the private recovery source. The optional self-image endpoint remains and can read a user-supplied, properly licensed assets/deepseek娘.png. No default illustration is distributed.
- Root/renderer/Mobile dependency license metadata was reviewed. Mobile exit omits a lockfile license field but its installed package contains the MIT grant. Windows Cargo metadata covers 212 packages with no missing license field on registry dependencies.
- Dependency metadata is not a complete binary redistribution audit. Before a binary Release, preserve complete notices and source obligations for Node.js, bundled npm packages, Rust crates, fonts and Unicode data. No Release is authorized here.
