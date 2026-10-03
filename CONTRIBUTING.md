# Contributing to CetaMesh

Thanks for helping improve CetaMesh.

## Before you start

Please read README.md, PROJECT_STATE.md, AGENTS.md, and OPEN_SOURCE.md. For architecture-sensitive work, also inspect the relevant files under docs/architecture, docs/protocol, and docs/security.

## Development setup

- Node.js 22.11+
- npm
- Android Studio / Android SDK for Android native work
- macOS / Xcode / CocoaPods for iOS native work

Install dependencies:

    npm ci

Run the repository checks:

    npm run check

## Contribution workflow

1. Fork the repository or create a feature branch.
2. Keep one change set focused on one problem.
3. Add or update tests when behavior changes.
4. Update documentation when a public contract, user flow, permission, protocol, or security behavior changes.
5. Run npm run check.
6. Open a pull request explaining the problem, solution, tests performed, and remaining verification gaps.

## Pull request expectations

A pull request should state what changed, why it changed, relevant issue/task references, tests run, native/device verification status, screenshots for visible UI changes, migration notes for schema/protocol changes, and security impact for permission, identity, networking, plugin, memory, or sync changes.

Do not mark a device/native check as passed when it was not actually executed. Use clear status labels such as PASS, NOT_RUN_ENVIRONMENT, PENDING_NATIVE_VERIFICATION, or BLOCKED.

## Architecture rules

Preserve the current dependency direction: Feature -> Runtime -> Domain interface -> Provider/Repository -> Native/Infrastructure.

- UI/features should not directly depend on concrete native implementations.
- Sensitive device operations must go through Capability Runtime and policy.
- Unknown capabilities default to denial.
- Trust does not imply permission.
- Task state belongs to CetaMesh, not a model-provider session.
- Memory authorization is evaluated before retrieval or synchronization.
- Do not add unrestricted shell access, arbitrary native bridges, or downloaded executable plugin code without an explicitly approved architecture change.
- Do not put secrets in SQLite, logs, events, push payloads, screenshots, or protocol diagnostics.

## Code quality

Before submitting, run npm run check. Avoid unrelated refactors in the same pull request.

## Dependencies

Prefer existing dependencies when practical. For new dependencies, consider maintenance quality, license compatibility, native footprint, security exposure, bundle size, and whether executable/plugin behavior is introduced.

## Protocol and database changes

Protocol fields and persistent schema are compatibility surfaces. Prefer additive evolution, document migrations/versioning, test old-state compatibility, avoid destructive reset paths, and explicitly call out breaking changes.

## UI contributions

Keep the product UI simple and task-focused. Preserve Chat as a primary experience, avoid over-emphasizing engineering configuration, maintain Simplified Chinese coverage where supported, and consider keyboard, safe-area, small-screen, and accessibility behavior.

## Reporting bugs

Use GitHub Issues for ordinary reproducible bugs. Include platform/device, app/build commit, reproduction steps, expected behavior, actual behavior, and sanitized logs.

Do not attach API keys, tokens, pairing secrets, private keys, private chat content, or sensitive personal data. For vulnerabilities, use SECURITY.md.

## License of contributions

By contributing, you agree that your contribution is provided under the project's GPL-3.0-only license unless explicitly agreed otherwise in writing.