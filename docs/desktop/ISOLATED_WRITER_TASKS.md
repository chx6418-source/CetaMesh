# Isolated writer Task contract

The existing Task owner supports an explicit `isolated-write` child contract.
It does not change the default read-only child contract or grant capabilities.
Creating a writer requires a different Workspace and a synchronous, trusted
Core resolver for its completed worktree provisioning receipt and physical
directory identities. A caller supplies the operation reference, never the
proof. Missing or asynchronous resolvers refuse admission.

The parent must be queued or paused. Two current children and six lifetime
children remain the family limits. Each writer has its own non-overlapping
physical root; another Workspace ID cannot reuse the same root. The parent
cannot start or resume until children are terminal. Current parent objective,
provisioning proof and root identities are checked again before child execution.
Initially, only the controlled Managed provider can execute isolated writers.
External native provider support requires independently verified scope controls.

`readScope`, `writeScope`, `outputKind: changes` and `expectedEvidence` are bounded
contract fields. They are not authorization. Production assembly must enforce
exact grants and file scope through the existing Capability Broker before
enabling its trusted resolver. A stored child or a created worktree does not
prove a tool ran, that executions overlapped, or that a result was verified.
Result integration is a separate reviewed operation; child completion never
merges files into the parent automatically.

## Storage compatibility and rollback

Task stores containing only existing tasks continue to use schema version 1.
The first isolated writer causes the existing Task store to write version 2
with the explicit `isolated-writer-v1` feature. Before that write, it retains
an exact, hash-named version 1 document in the same private Task directory.
Failure to create or validate that backup refuses the upgrade. The current
reader accepts both versions; invalid feature or family bindings are refused.

The former reader does not support version 2. Its actual frozen implementation
is exercised as a test fixture and must refuse without changing original bytes.
Do not downgrade a populated StateDir to that reader, and never overwrite new
tasks or execution receipts with the pre-upgrade backup. A code rollback must
retain the version 2 reader with writer admission disabled, or use a separate
StateDir while preserving the complete original store for current-code recovery.
The backup is historical evidence, not permission for an automatic data rollback.

The Task-domain regression proves contract validation, persistence, restart,
physical aliases, refused execution and old-reader behavior. Formal Core
provisioning, scoped tools, simultaneous execution and independently checked
results require their own integration evidence.
