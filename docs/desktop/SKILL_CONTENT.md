# Desktop Skill reference content

Desktop content Skills use the existing Extension Installer, Store, Review and Runtime.
A Skill is untrusted reference data. Selecting it does not change Task grants,
approval mode, Memory policy or the available execution tools. Memory records of
type `skill` remain Memory records and continue through the Memory policy.

## Package contract and compatibility decision

The Desktop Manifest keeps its existing `workflow` type. The optional
`contentProfile: "skill-reference-v1"` identifies a strict data profile. It requires
`entry: "SKILL.md"`, exactly one `skill-reference` capability with no input schema,
and the sole Desktop permission `skill.read`. The capability must require that
permission. Network hosts, filesystem scope, delegates and settings are prohibited.

```json
{
  "manifestVersion": 1,
  "id": "example.reference",
  "name": "Example reference",
  "version": "1.0.0",
  "type": "workflow",
  "contentProfile": "skill-reference-v1",
  "entry": "SKILL.md",
  "minCetaMeshVersion": "1.0.0-rc.2",
  "permissions": ["skill.read"],
  "capabilities": [
    {"id": "reference", "kind": "skill-reference", "requires": ["skill.read"]}
  ]
}
```

`skill.read` grants only the read of exact reviewed package bytes through the
content host. It is not a Capability Broker filesystem permission and is not added
to any Task grant. A normal executable workflow cannot request it. The content
host creates no Worker or VM and never evaluates package text. A partial or
unsupported content declaration is refused before host selection; there is no
fallback to a JavaScript host. Packages may contain only nonsensitive UTF-8
reference files (`md`, `txt`, `json`, `yaml`, `yml`, `csv`, `tsv`) and the existing
Extension manifest. Script and secret files are rejected. An explicit review token
binds installation and version changes to the full package hash.

This is a Desktop-only contract decision. It does not extend the signed shared
Manifest, Mobile permissions, seven technical Extension types, Worker framing or
CP proposals. Existing executable workflows retain their old contract. Historical
Desktop validators reject the new `skill.read` permission as unknown, before a
host can load Markdown; this is the compatibility fence. The minimum product
version is also required metadata. That version field alone cannot retroactively
protect historical raw installers that did not enforce it. A host configured with
`supportedSkillContent: false` rejects the profile explicitly.

## Discovery and reads

`createSkillContentService` derives one index for manual selection and automatic
context. Its sources are the registered Workspace's
`.cetamesh/skills/<directory>/SKILL.md`, explicitly Owner-registered user roots
injected by the composition root, and reviewed enabled installed content. It does
not search parent directories, system skills or unrelated application folders.
Registration and removal of a manual source change existing configuration; they do
not copy or delete the user's files.

Project and user source authorization must settle before Skill metadata or file
reads. With no source authorizer, those sources are unavailable. Registration
metadata such as `authorizedBy` is not authority. Installed content is checked
against the current enabled state, reviewed package hash and persisted content
generation. A trusted composition can further restrict it with the same source
authorizer. Callers cannot supply arbitrary absolute file paths to `read`.

The precedence is project, registered user, then reviewed installed content.
Within a kind, source IDs and relative paths provide stable ordering. Names compare
without case, and losing entries report a shadowing reason. Duplicate registered
source IDs refuse both ambiguous roots. Missing descriptions, malformed bounded
scalar frontmatter, links, secret resources and limits produce omissions used by
the same index and picker. `allowed-tools` metadata has no grant effect.

The default limits are 128 selected entries, 64 KiB per file, 8 KiB per read page,
3,000 characters for the automatic index, 4,000 characters per `always` body and
12,000 characters for all Skill context. The existing ProductContext and model
budgets further constrain that context. Text remains explicitly labeled as
untrusted reference data. Source discovery hashes local reference files to bind
identity; it does not automatically send their bodies to a model.

`list({principal,taskId,workspaceId,signal})` returns
`{indexRevision,entries,shadowed,omissions}`. Each entry binds `skillId`,
`sourceKind`, `sourceId`, `sourceRevision` and SHA-256. `read` requires that exact
Skill identity and source revision, and optionally a resource name and byte page.
It returns content, SHA-256, revision and the next byte offset. UTF-8 characters are
not split across pages. A changed, disabled, unregistered, revoked or uninstalled
source cannot be replaced by a namesake. Reselect the current reviewed source to
recover a stale reference.

Update, rollback, disable/re-enable and restart invalidate earlier enabled content
generations. Catalog revocations add a persisted denial to the existing Extension
record. Files and history remain available for Owner recovery, while that revoked
version cannot regain content authority through rollback. Uninstall removes only
the existing managed package area and preserves the original manual source.

## Runtime facts

Extension and Plugin Center observations distinguish installed, enabled, loaded,
runtime generation, discovered capabilities and latest call outcome. Skill content
has `connection` and `authentication` set to `not-applicable`. Unobserved executable
Extension connection or authentication facts remain `unknown`. Errors contain a
stable stage and code; call observations exclude arguments and returned content.

MCP observations keep connection generation, saved and live configuration revisions,
tool discovery and recent call outcome separate. A connection that initialized and
completed tool discovery can be ready while exposing zero tools; readiness does not
prove a successful business call or authenticated account identity. Authentication
remains `unknown` without independent protocol evidence.

An unchanged effective MCP configuration preserves the same transport. Notes and
equivalent map or allowed-tool order do not reconnect it. A changed active server
is stopped and recreated independently, with old tools withdrawn first. Failed or
unconfirmed cleanup retains the exact old transport and its error; saved and live
revisions show the mismatch. Retrying the current configuration can finish cleanup
and reconnect. Late calls and close events from an old generation cannot alter a
replacement generation. Cancellation and stale calls preserve an unknown-effect
result where completion cannot be established.

The registered `test-skill-content-core` suite exercises owned local files,
Installer/Runtime/ProductContext/Plugin Center/Integration entries, injected local
transports and an actual owned stdio peer. These source and fixture checks do not
substitute for native picker interaction, an installed release, paid models or a
real remote MCP service.
