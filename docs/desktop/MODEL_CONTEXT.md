# Model request context and tool schemas

The Core projects one current authorized capability set for each Chat or Managed
turn. Its returned `manifest` contains the complete approved input schemas, risk
and approval metadata. The existing coordinator uses that manifest to prepare
the actual model `tools` field and still dispatches every call through the
Capability Broker. A context projection cannot grant a missing capability.

For the structured-tools transport, Product Context reference JSON carries a
descriptive capability index and `schemaChannel: "structured-tools"`. It omits
duplicate `inputSchema` bodies from that JSON only. The returned manifest and
real structured model tools retain the exact full schemas. This prevents a large
optional exploration schema from crowding already granted ordinary file or test
operations out of the turn merely because it sorts earlier.

Compaction retains already granted Core file read/search/write, test and operation
controls for a Managed Task. It does not synthesize those descriptors when they
were absent or remove their approval requirements. Other optional facts can be
omitted with counts. If Task, permission and required control facts cannot fit,
the request remains explicitly refused rather than acquiring a reduced schema.

Explicitly selected Skill bodies precede the optional automatic Skill index.
Under global compaction they have a bounded share of at most 4,000 characters,
with truncation visible. Exact stale or unavailable selected references retain
their omission codes. Skill text is low-trust reference data and does not change
grants, Task identity or approval mode.

The full outgoing request budget still counts messages, actual tool definitions,
provider framing and output reserve. Removing a duplicate reference copy is not
evidence of token-cache savings or a lower measured cost. Private native reasoning
and continuation data must not enter public context or UI observations.
