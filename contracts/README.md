# PROPOSED Core DTO contracts

These schemas describe proposed domain projections. They **do not replace** Native IPC,
Agent ACP/Codex JSONL, Extension Manifest/Worker v1, signed Pairing v1.1 or current
diagnostic report storage. See the [protocol index and conformance matrix](../docs/protocol/README.md).
Passing validation does not create authority, install plugins or prove runtime readiness.

## Run

```sh
npm run contracts:validate
npm run contracts:validate -- plugin-composition path/to/composition.json
npm test -- --suite test-protocol-proposals
```

The Node validator uses reviewed repository schemas with [Ajv 2020](https://ajv.js.org/json-schema.html)
and explicit [format validation](https://ajv.js.org/guide/formats.html) for
[JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12).
Both dependencies are pinned development dependencies using existing locked package content.
No Python installation, network resolver, external schema loading or runtime service is needed.
The tool reads at most 1 MiB of JSON, bounds tree depth and nodes, does not coerce
values/remove fields, and reports stable errors without echoing input content.
It writes no files and never scans packages, follows component paths, executes code,
issues grants, sends events or changes production state.

## Scope

| Schema | Draft meaning / limits of validation |
| --- | --- |
| `core-envelope` | Future domain message metadata; no change to native framing/signature |
| `core-error` | Normalized display error; no proof of effect state or retry permission |
| `agent-descriptor` | Adapter/readiness projection; no self-attested execution grant |
| `plugin-interop-intent` | Restricted caller input; actor/grants/approval/context injected by Core later |
| `memory-reference` | Scoped provenance reference; shape alone cannot authorize retrieval |
| `health-result` | Illustrative report projection; not the existing local report or real health evidence |
| `plugin-categories` | Exactly 17 product category IDs, ordered and unique; not Manifest v1 types |
| `plugin-composition` | Future sidecar; JSON shape + bounded parent/binding DAG and lexical path ownership |
| `plugin-event-subscription` | Subscription intent, never a lease or grant |
| `plugin-capability-binding` | Proposed capability descriptor, not a runtime registry response |

The single [fixture manifest](fixtures/fixture-manifest.json) combines 26 distinct
positive and negative vectors from the supplied v1.1 draft. Every fixture must be
registered and every expected rejection must actually occur. The registered test
adds boundary/abuse cases and exercises the existing Manifest parser and Memory vocabulary.
The product taxonomy is maintained at [plugin-categories.v1.json](../docs/protocol/plugin-categories.v1.json);
its matching golden vector guards drift, not runtime implementation status.

## Composition graph checks

Root plus at most 31 children, 5 levels including root, at most 8 direct children;
unique keys with `root` reserved; existing parents; no parent or binding cycles;
declared target namespace and valid local capability suffix, rejecting competing
declared plugin-ID prefixes; no self binding/root as child; embedded-only physical
parent containment; case-insensitive path collision/overlap rejection; no dot
segments, Windows device aliases or trailing-dot aliases. External dependencies
do not carry embedded package paths/hashes.

These are **lexical/structural** checks only. They do not verify real package
SHA-256, publisher identity, symlinks/hardlinks/reparse points, child manifests,
installed versions, real registry capability existence/Descriptor ownership, permissions,
resource isolation, migrations or shared dependency
reference counts. Those remain required before a future installer can activate a
composition. Binding DAG checks here do not establish a production runtime loop guard.
Package nesting limits also do not modify the current 8-hop runtime delegation limit.

Production schemas/goldens remain with their existing implementations and tests.
Changing a draft DTO does not authorize a persistent data migration or wire adapter.
