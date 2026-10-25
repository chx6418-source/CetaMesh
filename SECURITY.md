# Security Policy

CetaMesh handles model-provider credentials, local memory, device capabilities, pairing, and network communication. Security reports should avoid public disclosure until the issue can be reviewed.

## Supported versions

CetaMesh is currently pre-stable and under active development. Security fixes are applied to the current development line; older commits, experimental branches, forks, and unofficial builds are not guaranteed to receive fixes.

## Reporting a vulnerability

Please do **not** open a public GitHub issue containing exploit details, credentials, private data, or a working proof of concept.

Preferred reporting method:

1. Use GitHub's **Private vulnerability reporting** feature for this repository if it is enabled.
2. If private reporting is unavailable, open a minimal public issue stating only that you need a private channel for a security report. Do not include sensitive technical details.

A useful private report includes the affected commit/version, platform, vulnerability class, reproduction steps, impact, proof of concept when safe to share privately, and suggested mitigation if known.

Never include real API keys, user secrets, private keys, access tokens, or unrelated personal data.

## High-priority security areas

- credential leakage
- secure-storage bypass
- device identity/private-key exposure
- pairing authentication
- capability-policy bypass
- remote capability execution
- memory-scope or authorization bypass
- arbitrary code/plugin execution
- update-channel compromise
- path traversal or workspace escape
- sync authorization or replay issues
- sensitive information written to logs

## Disclosure process

The project will try to confirm receipt, reproduce and assess the issue, develop a fix or mitigation, verify the fix where the environment permits, and coordinate disclosure after remediation is available.

Because CetaMesh is currently an early-stage open-source project, no fixed response-time SLA is promised.

## Security expectations for contributors

Preserve deny-by-default behavior, keep secrets out of ordinary persistence and logs, require explicit scopes for memory/sync access, do not introduce unrestricted shell/native execution, validate and bound remote inputs, and document native checks that have not actually been run.

## Scope limitations

The project cannot guarantee the security, privacy, availability, or retention practices of third-party model providers and services configured by users.