# Settings feature compatibility

The existing Settings store remains the sole writer of `settings/settings.json`.
Its envelope stays at schema version 1. Current readers supply absent optional
model connection, model preference and Skill library fields from their defaults.
The writer omits these fields while inactive. In particular, an explicit empty
connection list is meaningful (all connections disabled) and is persisted.

Before the first write that enables these fields, the store preserves the prior
configuration as `settings/settings.pre-features-v1.json`. It uses the existing
atomic JSON primitive and an exclusive final copy. A preexisting snapshot is
never replaced. An incomplete or unavailable snapshot refuses the first feature
write and retains both the active bytes and in-memory revision. Ordinary writes
to already advanced configurations remain usable when no historical snapshot
exists; the store does not reconstruct missing history.

For a new state directory, the snapshot contains the default configuration in
effect before the feature was enabled. For an existing directory it contains the
previous saved values and revision, with inactive optional defaults omitted.
It is a configuration rollback point, not a backup of subsequent Task, Memory,
Workspace, credential-store or execution history changes.

`store.compatibility()` reports the active feature names, whether an upgraded
reader is needed, and the snapshot path, availability, revision and SHA-256.
This is a read-only observation. It does not reset or restore active settings.

An older strict reader cannot understand enabled new fields. Its safe refusal
must retain the advanced active file. Downgrade validation uses a separate state
copy: load the preserved configuration with the actual historical reader, save a
normal setting there, and reload it with the current reader. Do not replace a live
Core's settings or imply that old binaries can use the new features. Restoring a
prior configuration requires a separately controlled, stopped-Core procedure and
retention of the advanced active configuration.

The registered compatibility suite checks inactive writes, immutable snapshots,
first-write defaults, all-disabled model semantics, restart, snapshot failures
and an isolated rollback copy. Historical-reader validation is separate from
installed product, installer and release acceptance.
