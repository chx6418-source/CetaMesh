# CetaMesh change record

## 2026-10-21 — Desktop-primary private monorepo migration

- Desktop `main` history imported without rewriting commits; root architecture retained.
- Mobile production integration history retained; complete project moved to `apps/mobile`.
- Independent dependencies, versions, update sources, licenses and safety rules retained.
- Split Desktop/Mobile CI with working-directory and cache/artifact path corrections.
- Added paired-fixture and workflow isolation checks through Desktop `npm test`.
- Mobile `npm test` includes all existing verification gates.

Desktop and Mobile currently each declare `1.0.0-rc.2`, but these are independent
release lines. This migration does not increment either product version or declare
a production release. Existing platform reports remain historical evidence.
