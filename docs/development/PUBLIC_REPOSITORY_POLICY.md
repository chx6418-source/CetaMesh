# Public repository content policy

**Purpose:** keep the CetaMesh public monorepo understandable, auditable and buildable without publishing unnecessary internal work history.

## Include

- Maintained Desktop and Mobile application source, protocols, fixtures, tools, tests and build configuration.
- Current technical architecture, installation and release instructions, open-source license, contributor and security policies.
- Public-facing plugin/developer documentation and narrowly scoped architecture/contract references.

## Keep in private development history

- Abandoned themes, static HTML UI mockups, early proposal galleries and screenshot batches.
- Internal repair/audit/handoff reports, long-form review ledgers, local migration plans, old Desktop acceptance worksheets and obsolete design specifications.
- Raw environment diagnostics, package validation logs, failure screenshots and test outputs.
- Personal/local paths, credentials, private state, user data, unreviewed third-party code or other materials not approved for publication.

Current production UI lives in desktop-ui/ and desktop-shell/src/theme/. Do **not** remove it while removing historical design-demos/. Keep runtime protocols, actual test fixtures and their assertions intact.

## Required check

- Run root npm test (includes scripts/test-public-repository-hygiene.mjs).
- Review the Git diff; no source, CI, runtime assets, locks or installation configs should disappear as part of a document-only cleanup.
- On changes to shared protocols or platform logic, run both platform checks and applicable native builds.
- Make the cleanup a review PR. Do not merge to main until tests and content review are accepted.

## Cleanup backup and history

On 2026-10-22, candidate material was checked by public Git blob SHA against a private source tree. The private review branch archive/public-cleanup-20261022 contains the original objects and a file-by-file manifest (with public-only variations separately copied). The original public main commit 350c1fc4 also remains a recoverable public reference.

A deletion commit is *not* historical erasure. If earlier public commits disclosed true secrets or restricted content, investigate that separately, rotate credentials where necessary and follow an approved historical remediation process. Do not force-push merely to make the repository look tidy.
