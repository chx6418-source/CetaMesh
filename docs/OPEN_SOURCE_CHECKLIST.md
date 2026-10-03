# Open-Source Release Checklist

## Repository
- [ ] README accurately describes what is implemented today.
- [ ] PROJECT_STATE distinguishes implemented, verified, pending, and blocked work.
- [ ] LICENSE is present and unchanged unless a deliberate license decision was made.
- [ ] OPEN_SOURCE.md matches the current license.
- [ ] CONTRIBUTING.md reflects the actual development workflow.
- [ ] SECURITY.md points to a usable private reporting path.
- [ ] CODE_OF_CONDUCT.md is present.

## Secrets and sensitive data
- [ ] No provider API keys or GitHub tokens.
- [ ] No signing/private keys or production keystores.
- [ ] No pairing secrets or local database contents.
- [ ] No personal chat/memory data.
- [ ] No private endpoints that should remain private.
- [ ] No sensitive logs or screenshots.

## Build and verification
- [ ] npm ci works in a clean environment.
- [ ] npm run check passes.
- [ ] Android CI passes.
- [ ] Standalone APK verification passes for any published APK.
- [ ] Native/device checks are documented honestly.
- [ ] Release artifacts are traceable to a commit.

## Licensing
- [ ] New dependencies have identifiable licenses.
- [ ] Required third-party notices are preserved.
- [ ] No copied source with unknown provenance.
- [ ] Contributions are compatible with GPL-3.0-only.
- [ ] Separately licensed bundled components are identified when needed.

## Public documentation
- [ ] Installation/build prerequisites are current.
- [ ] Known limitations are visible.
- [ ] Security-sensitive features are not overstated.
- [ ] Experimental APIs/protocols are labeled.
- [ ] External-provider privacy/cost responsibility is explained.

## Release hygiene
- [ ] Version number decided.
- [ ] Tag/release commit decided.
- [ ] Release notes prepared.
- [ ] APK/source archive checksums recorded when publishing binaries.
- [ ] Debug-only signing behavior is not confused with production signing.
- [ ] No unsupported production-readiness claim is made.