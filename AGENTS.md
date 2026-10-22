# CetaMesh — Agent repository rules

## Start here

1. Read RULES.md, PROJECT_STATE.md and the affected platform's architecture docs.
2. Desktop owns root src/, desktop-shell/, desktop-ui/, scripts/, plugins/ and extensions/.
3. For apps/mobile/** also read apps/mobile/AGENTS.md and apps/mobile/PROJECT_STATE.md.
4. For docs/protocol/, fixtures/pairing/ and packages/, check both platform implementations. Trust does not grant capability access.

## Build and safety

- Run Desktop tests through root npm test. Register new scripts/test-*.mjs in scripts/run-all-tests.mjs.
- Run Mobile tests from apps/mobile (npm test). Do not hoist React Native dependencies into the Desktop root.
- Preserve Desktop JSON storage primitives, Mobile local-only memory defaults, native permission boundaries, and independent release artifacts.
- Do not turn unknown authorization into implied approval. Keep secrets, local state, API keys and private credentials out of Git, logs and publication artifacts.
- SnowLuma binaries and restricted SDK/MCP are not redistributed. The owned OneBot adapter only interoperates with a separately installed compatible gateway; do not reintroduce upstream SDK code or automatic third-party deployment.
- Keep GitCode and existing-client update endpoints stable unless a separate, tested release migration is authorized.

## Public-repository hygiene

- Public repository: chx6418-source/CetaMesh. Do not import private Git histories or unreviewed third-party sources.
- Publish product source, essential tests, protocols, contribution and architecture documentation only.
- Keep obsolete UI mocks, theme exploration, internal audit/repair reports, handoff notes, raw CI logs and debug screenshots in the private development archive, not the public repository.
- Use scripts/test-public-repository-hygiene.mjs and docs/development/PUBLIC_REPOSITORY_POLICY.md when changing tracked content.
- Preserve existing public Git history. Deleting a file from the active tree does not erase it from earlier public commits.
- Work in review branches; do not merge to main, force-push rewritten history, publish Releases or remove backups without explicit owner approval.

## Workflow

Inspect Git status and diffs first. Prefer focused, reversible changes; run available tests and label unrun environment-dependent checks accurately. Do not use destructive Git cleanup/reset commands to resolve conflicts.
