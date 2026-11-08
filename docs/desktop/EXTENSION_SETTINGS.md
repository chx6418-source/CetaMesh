# Extension public settings

The existing Extension Settings service owns desired configuration. Extension
Runtime owns effective host configuration and generation. Saving public fields
on an enabled executable Extension waits for a controlled restart and a receipt
from that host. Only this Extension restarts; equal public configuration keeps
the same host and generation. A successful save can still report
`needs-reconciliation`, `pending`, or `unsupported`; those states are not an
application receipt.

Process and trusted VM hosts support the `public-settings-v1` profile. Each
handler receives an immutable `context.settings` containing declared public
fields and their defaults. Host code validates the installed package, schema,
public values, configuration revision and generation before acknowledging it.
Runtime publishes executable capabilities only after this acknowledgement.
Transport health or an old successful invocation cannot acknowledge settings.

`secretRef` values remain in the existing Core private-settings file. UI returns
only `{configured:boolean}`. This profile does not send raw secrets, private
store paths, environment entries, or a credential resolver to plugins.
`secretConsumption: unsupported` is independent of public settings application;
it does not imply authenticated connectivity. A future credential-consuming
adapter requires its own precise authority and disclosure review.

The public JSON envelope remains `schemaVersion:1` with `values`. Optional
`binding` and opaque edit `revision` bind an explicit save to the reviewed
package and schema. Existing readers continue to read `values`; they do not
implement configuration delivery. Reading legacy unbound settings does not
rewrite them. They remain visible for Owner review, but require an explicit save
before this profile consumes them. Partial saves carry forward only values
already bound to the exact installed package. Package update or rollback does
not silently adopt another version's values. Private key/value file format is
unchanged. Writes use the JSON Storage Primitive; failed writes retain the prior
cache, and a failed public write rolls back completed private changes.

Owner settings views return a CAS revision. A stale edit or changed installed
package is rejected before writes. Desired configuration revision and effective
revision are separate from that edit revision. Secret-only changes do not
restart a public-configured host. Configuration receipts are volatile runtime
facts; Core restart must obtain a fresh receipt from a new host.

Disable, uninstall and version change revoke capabilities and invalidate old
generations. Late receipts cannot restore them. A changed desired revision
invalidates an older application. Unconfirmed process exit retains the existing
stop fence and prevents replacement. Retry by saving current settings again or
explicitly restarting; neither operation replays earlier capability calls.
In-flight effects remain subject to the existing unknown-effect rules.

HTTP/event data adapters report `unsupported` for settings consumption.
Memory Packs, Skill content and packages without settings report
`not-applicable`. A content package never gains execution from settings.

See the [wire compatibility decision](../protocol/ADR-EXTENSION-PUBLIC-SETTINGS.md)
and [Plugin API](../plugin-development/06-plugin-api.md). Registered
`test-extension-runtime` exercises real temporary Workers, configuration
results, CAS, storage failures, concurrency, exit proof and conformance vectors;
`test-plugins-page-ui` checks truthful UI rendering. These are source and
isolated-process checks, not installed/native release acceptance.
