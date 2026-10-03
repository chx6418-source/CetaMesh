# CetaMesh Open-Source Policy

This document explains how the CetaMesh repository is intended to be used and contributed to. It is a project guide, not a replacement for the legal text of the license.

## License

Unless a file or bundled third-party component states otherwise, the source code in this repository is licensed under the **GNU General Public License version 3 only (GPL-3.0-only)**.

The authoritative license text is [LICENSE](LICENSE).

In practical terms, GPL-3.0 generally allows personal, research, educational, internal, and commercial use; source inspection and modification; and redistribution of original or modified versions.

When distributing covered binaries or modified versions, GPL-3.0 also imposes obligations, including providing corresponding source under GPL-3.0 and preserving applicable notices. The exact legal requirements are defined by the license text itself.

## Commercial use

Commercial use is not prohibited by this repository license. Distributors remain responsible for GPL-3.0 and third-party license obligations.

## Contributions

Unless explicitly agreed otherwise in writing, contributions submitted to this repository are provided under the same **GPL-3.0-only** terms.

By opening a pull request, you represent that you have the right to submit the contribution, that it does not knowingly include code you are not permitted to license, and that third-party material is clearly identified.

CetaMesh currently does **not** require a Contributor License Agreement (CLA).

## Third-party dependencies

Third-party packages, SDKs, and bundled components remain subject to their own licenses. The project license does not relicense separately licensed third-party software.

When adding a dependency, use a legitimate upstream source, preserve required notices, avoid unclear/incompatible licensing, and explain unusual constraints in the pull request.

## Model providers and external services

The GPL license for CetaMesh does not grant rights to third-party model APIs, hosted services, model weights, or subscriptions. Users are responsible for those providers' terms, privacy policies, pricing, and usage restrictions.

No provider API key should be committed to the repository.

## Trademarks and branding

The source-code license does not automatically grant trademark rights. CetaMesh names, logos, release branding, and visual identity may be governed separately.

You may accurately state that software is based on or compatible with CetaMesh, but a modified or third-party distribution should not be presented as an official CetaMesh release.

## Forks and modified distributions

Forks are permitted under GPL-3.0. Modified public distributions should clearly identify modifications, avoid implying official endorsement, preserve notices, publish corresponding source as required, and document material security changes.

## Security-sensitive changes

Changes involving device identity, secure storage, permissions, remote execution, sync, pairing, plugins/extensions, updates, secrets, or sandbox/workspace boundaries receive additional review attention.

Do not weaken deny-by-default behavior merely to simplify integration.

## No warranty

CetaMesh is under active development. The software is provided without warranty to the extent permitted by GPL-3.0. Do not assume a feature is production-ready merely because code exists.

## Questions

For development questions, use GitHub Issues or Discussions when enabled. For vulnerabilities or sensitive security reports, follow [SECURITY.md](SECURITY.md).