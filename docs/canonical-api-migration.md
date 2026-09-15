# Canonical API migration

Work branch: `codex/canonical-ddb-api`, based on compatibility commit `8e7317b`.
DDB source: `7309720806cb455a7124bc2d42174754f637cd54`, release binary 0.1.15.
Stop metadata requires DDB commit `45366462` on `codex/vscode-api-parity`, based on that
commit. The baseline binary fails the new stop-reason regression.

This migration is in progress. The extension now starts the canonical adapter and the sidebar uses DAP.
Several parity items below remain incomplete; this branch is not a finished
release. The compatibility implementation remains available on its own branch.

## Protocol

Use `@ddb-debugger/api-client` through API v2 HTTP/ProtoJSON. The SDK supplies
typed requests, operation polling, pagination, snapshot/replay synchronization,
and separate state/output streams. API v2 and its SDK remain preview-stage.
The vendored SDK and its provenance are in `vendor/`.

One client in the debug-adapter process will own DDB communication. The sidebar
will exchange application data with that process through DAP custom requests
and events. DDB's opaque IDs are mapped to local DAP integers, never decoded or
packed into frame IDs. Resource revisions use BigInt. Replay duplicates and
stale updates must not resurrect deleted resources.

Managed launch uses `ddb serve --managed`, a private temporary bearer-token
file, and the atomic startup report. Handshake must match the child process's
reported server instance. Shutdown of an owned process is bounded; disconnect
from an external service must not terminate it.

Operation admission, terminal operation completion, and target stopped events
are separate transitions. Failed/cancelled operations and partial fanout errors
must become DAP errors. Do not automatically retry a mutation with a new key.

## Feature parity checklist

| Existing behavior | Canonical workflow | Status |
| --- | --- | --- |
| Local YAML launch, cwd/environment, bounded shutdown | Managed startup report, authenticated handshake, admin shutdown | Connection tested with mock and GDB |
| External endpoint | SDK endpoint and bearer token, disconnect without shutdown | Real DAP attach/disconnect leaves the existing server responsive; owner shutdown removes process and private startup directory |
| Session/group/thread discovery | Snapshot and replayed resource upserts/tombstones | Connection, DAP view models and frontend facade tested |
| Thread selection | SelectThread operation | Connection tested |
| Stack, paging, source navigation | ListFrames, ResolveSource, ReadSource; local handles | DAP stack paging, multi-page source reads and inaccessible-path source-reference fallback tested; remote mapping and GUI navigation pending |
| Distributed stack and boundary labels | RunDistributedBacktrace typed frames | Pending |
| Locals and expansion | ListScopes, ListVariables, ExpandVariable | DAP handlers implemented; root/array expansion and compound-watch expansion tested with real GDB |
| Registers | ListRegisters | DAP handler tested with mock and GDB |
| Watch and hover | Evaluate with frame ID and evaluation context | Scalar and compound DAP watches, hover and watch-child assignment tested |
| Variable assignment | Evaluate assignment if supported; backend escape hatch otherwise | Root and array-child DAP assignment tested with real GDB |
| Source/function breakpoints | Create/Update/DeleteBreakpoint operations | Source and function creation, conditions, real hits, replacement and deletion tested with patched DDB |
| Session/group breakpoint selection, inheritance | Explicit canonical session/group/multiple target selectors | Group selection, verified member projection and paired requests tested; streamed verification refresh implemented |
| Conditions, hit counts, enable/disable, logpoints | Typed conditions/counts; adapter evaluates and continues logpoint stops | Conditions, hit conditions and logpoints tested; enable/disable UI audit pending |
| Continue, pause, step in/out/over and all-stop coordination | Execute operations plus execution/thread state events | DAP next/step-in/step-out, session-specific continue/pause, peer all-stop coordination and stopped-frame metadata tested with patched GDB |
| Signals and session kill | ListSignals and v2 raw signal command | DAP list/validation tested on mock/GDB; SIGKILL tested on GDB |
| Jump to line | Temporary canonical breakpoint followed by Execute JUMP | Local GDB destination stop, consumed breakpoint and invalid targets tested; remote source mapping remains unverified |
| Debug Console, autorun, path substitution | Canonical raw-command escape hatch where typed APIs do not cover the command | Implemented with focused-frame CLI/raw console and per-session setup; entrypoint tests cover autorun and substitution |
| Memory reads | ReadMemory | Real GDB bytes, positive/negative offsets, empty reads and limits tested; memory-view UI still unverified |
| Sidebar refresh, grouping, breakpoint/source decorations | Custom DAP requests/events from shared projection | Frontend facade and events wired; GUI/decorations verification pending |
| Focused frame navigation | Frame metadata lookup through DAP, no bit decoding | Frame status wiring complete; GUI verification pending |
| Reconnect, replay gap, output gap, restart | SDK recovery, projection rehydration, explicit loss/restart handling | Real HTTP socket interruption tests cover cursor resume, output gaps, state replay-gap rehydration and changed-instance rejection; managed-child crash termination tested |

## Confirmed contract limits

- `ExecuteRawCommand` currently accepts only `RAW_COMMAND_DIALECT_GDB_MI`.
  The schema's CLI enum variants do not mean the runtime supports them.
  Removing MI streams and parsing is possible; preserving arbitrary console
  commands may still require MI syntax inside a v2 request. A completely
  MI-free public command path requires a backend API extension.
- Breakpoint insertion's runtime accepts session, group and multiple targets.
  Broadcast admission succeeds but its operation fails. Use explicit selected
  groups/sessions, preserving the adapter's existing selection semantics.
- DeleteBreakpoint requires an explicit target even though generated fields
  are optional. Broadcast deletion succeeds.
- BreakpointSpec has no log-message field; the adapter retains logpoint plans
  and evaluates them through typed requests at canonical breakpoint stops.
  UpdateBreakpoint supports only enabled and condition masks. Other property
  changes currently replace the logical breakpoint.
- ProtoJSON may omit numeric zero fields, including revisions/cursor sequence.
  Omission is zero, not a malformed revision.

## Checks completed so far

`npm test`: 86 unit tests pass, including opaque handle invalidation, revisions
above JavaScript's integer precision, stale replay/tombstones, atomic snapshot
replacement, required resync, and failed/partial operation rejection.

`DDB_TEST_BINARY=/path/to/ddb npm run test:canonical`: starts two-session mock
and GDB deployments with managed authenticated launch. Checks shared state,
thread selection, frames, scopes, variables, evaluation, explicit group-targeted
breakpoints and their streamed deletion, stepping, and cleanup.

These checks validate the new connection layer, not completed DAP/UI migration.

## DAP implementation checkpoint

`src/v2/session.mts` and `src/v2/inspection.mts` now implement canonical DAP
inspection, basic execution, state/output forwarding, local handle invalidation,
managed launch/external attach, source reads, memory reads and disconnect.
They are now the extension entrypoint. Remaining breakpoint features and the unchecked items above remain required.

The binary test dispatches actual DAP requests through `CanonicalHarness`.
Threads, stackTrace, scopes, register reads, scalar watch evaluation and invalid
thread error responses passed against both mock and GDB before extending the
variable-expansion check. The expanded test initially failed GDB with
`debugger variable-child response is missing its collection`; see the resolution
below.

The scalar-child decoder failure was reproduced on the release DDB binary.
The adapter now obtains missing metadata through the canonical raw-command
method instead of probing scalar ExpandVariable. `RawVariables` creates a
short-lived backend variable object, reads its structured v2 DynamicValue result,
and deletes the object, including on failure. Child expressions are represented
as a root expression and index path, so nested assignment does not depend on
missing evaluateName fields. No MI record parser or legacy route is used.

The binary test now passes both mock and GDB. It also checks array expansion,
root assignment, a compound watch expression, local/watch child assignment and
hovering the assigned element. Unit tests cover cleanup after failed creation,
quoting, target/frame forwarding, and rejection of expired canonical frames
before raw mutation admission.

Additional confirmed variable gaps: Evaluate currently always returns no
variableId, and expanded children have no evaluateName. The v2 variable-object bridge covers compound watch expansion and nested
assignment for these cases. Framework pretty printers and nonzero stack levels
still require broader integration coverage.

## Breakpoint DAP checkpoint

Source breakpoint reconciliation now uses CreateBreakpoint/DeleteBreakpoint,
retains unchanged breakpoint IDs, serializes mutations, and preserves explicit
session/group selection. The canonical DAP session supports the frontend's
paired setBreakpoints/setSessionBreakpoints requests. Integration tests check
both arrival orders, backend condition/target resources, and error completion
for both paired requests. Unmatched requests are bounded and rejected at
session disconnect.

The sidebar's group query now has a DAP endpoint that allocates local handles.
The frontend now uses this endpoint. Launch must explicitly enable
pairedBreakpointRequests when using that frontend workflow; standard clients
can use setBreakpoints directly.

Full breakpoint parity remains unproven:

- DDB commit `7390297a` implements typed function locations. Function creation,
  real hits, conditions, replacement and deletion are covered. DDB commit
  `33fc7007` adds ignore counts; source and function hit conditions are implemented.
- Logpoints use typed frame inspection/evaluation and targeted continuation.
  Real-GDB output and failure behavior are covered; the final GUI audit remains.
- DDB commit `ba512f18` corrects group-only breakpoint verification and projects
  installed session members. Paired DAP, sidebar and real group-hit checks cover
  the fix. The adapter forwards streamed verification changes with stable IDs.

## Session-control checkpoint

The canonical adapter now exposes session/group lists, frame metadata and thread
selection through DAP custom requests. Session-specific continue/pause preserve
the other session's stopped state. The binary test verifies that behavior,
signal listing, invalid signal rejection, and SIGKILL followed by thread removal
while the other session remains alive. The frontend consumes these endpoints and uses frame metadata instead of
bit-packed frame decoding.

The typed SIGNAL implementation quotes the signal name before passing it to the
GDB CLI `signal` command. Real GDB rejects the resulting quoted name. Signal
sending therefore uses one canonical ExecuteRawCommand mutation with a validated
signal token. It does not retry the failed typed mutation or use a legacy route.
This backend encoding defect should be corrected before removing the escape hatch.

## Frontend and entrypoint checkpoint

The extension entrypoint now runs CanonicalDebugSession. Sidebar caches fetch
sessions, groups, source-group membership and breakpoint snapshots through custom
DAP requests. The notification service consumes `ddb.stateChanged` events and
coalesces refreshes; it opens no HTTP or WebSocket connection. Frame status reads
explicit DAP metadata instead of decoding bits from frame IDs. The frontend opts
into paired breakpoint requests during configuration resolution.

A new stdio integration test launches the actual compiled entrypoint and checks
initialize/launch/configurationDone, thread discovery, distributed stack capture,
sidebar group/readiness requests, and disconnect. This complements direct DAP
handler tests. No VS Code GUI run has been completed. Legacy transport tests keep
using the compatibility implementation explicitly; its launcher and notification
service are retained temporarily for comparison and will need cleanup.

## Console and startup configuration

Debug Console REPL requests run backend CLI commands or explicit raw debugger
commands through ExecuteRawCommand. CLI commands carry the focused frame and
thread, with the frame validated before admission. Output arrives on the SDK
output stream; the command response does not echo an extra `done` marker.
Truncated results fail explicitly without repeating the mutation.

Managed/external launch applies pretty-printer enablement, path substitutions
and autorun to each ready session once. The stdio suite includes real GDB and
checks an autorun print setting and source-path mappings containing spaces via
subsequent console queries. Direct DAP tests also check focused CLI assignment
and raw expression commands. Disabled values formatting avoids expandable value
handles; broader formatting and C++ pretty-printer coverage remains required.

Managed startup forwards `debugger_args` as separate process arguments. Overrides
of managed endpoint, authentication and startup-report arguments fail explicitly.
Unit tests cover argument boundaries and override rejection; the stdio test
launches DDB with an additional console-level argument.

Telemetry forwarding, entry-stop configuration,
late-session setup ordering, source-path navigation, and remote configuration
semantics remain part of the completion audit. The implemented startup behavior
must not be treated as proof that those options already have parity.

## Execution-state checkpoint and backend prerequisite

The baseline binary's execution-state projection always sets `stop_reason` to
`None`. Both a SDK integration assertion and DDB's HTTP integration assertion
failed after stepping: the expected `STOP_REASON_KIND_STEP` was absent.
The DDB branch `codex/vscode-api-parity` retains stop details in runtime thread
state and converts internal identities to opaque API IDs during projection.
It commits the stopped thread set and its reason together, and clears reasons
on resume. Tests cover step and breakpoint reasons, signal names, principal
thread identity in all-thread stops, missing stopped-thread lists, and cleanup.

The adapter explicitly requests the EXECUTION snapshot section. DDB's default
snapshot excludes it. Stop events follow per-thread execution-state revisions,
so separately arriving thread resources cannot emit the previous stop reason.
A newer stopped snapshot also emits a stop when a fast step or replay gap hid
the intervening running state. Replayed revisions do not emit duplicate stops.
DAP stop events include breakpoint handles and signal names.

Validation uses the backend built from the patch branch. All four canonical
integration tests pass with mock and real GDB, including actual stdio startup,
a real breakpoint hit with its canonical ID, and a SIGINT stop with its signal
name. The adapter unit suite has 63 passing tests. DDB's core suite has 312
passing tests and one ignored test; all six API v1/v2 integration tests pass,
including the stop-reason regression.
The original release binary remains available for baseline comparisons.

This checkpoint does not establish full execution or breakpoint parity.
Explicit-pause versus external-signal presentation, entry-stop classification,
all-stop coordination still needs work. No current VSIX has been
packaged or GUI-tested.

## Group breakpoint projection and refresh

DDB commit `ba512f18` on `codex/vscode-api-parity` adds installed session IDs to
internal group-breakpoint snapshots and exposes each member as a canonical
SubBreakpoint. Member IDs remain stable when another member joins or leaves,
and each member carries its inheritedFromGroupId. The legacy snapshot encoding
retains its existing shape. Empty groups awaiting installation remain pending.
The runtime's existing removal of a logical breakpoint after deletion of its
last installed member is preserved.

The regression first failed against the prior backend with an absent verified
flag. With this patch, paired DAP requests and sidebar snapshots report verified
group breakpoints, and the real-GDB test hits a group-selected breakpoint and
checks its canonical breakpoint/thread identities. The backend test checks
pending-to-installed transitions, stable surviving member IDs, revision changes,
and removal. DDB has 313 passing core tests, one ignored core test, and six passing
API v1/v2 integration tests.

The adapter refreshes cached breakpoint resources from newer streamed revisions.
Verification changes emit DAP breakpoint-changed events; hit-count-only updates
do not. The existing DAP handle survives verification changes, and unchanged
setBreakpoints requests do not reinstall the breakpoint. The adapter unit suite
has 64 passing tests. Transport recovery of externally deleted breakpoints and
full dynamic-session GUI behavior remain part of the wider completion audit.

## Function breakpoints and SDK empty lists

DDB commit `7390297a` on `codex/vscode-api-parity` implements typed function
locations through breakpoint storage, command generation, group inheritance and
canonical projection. The API advertises the function breakpoint capability.
The adapter advertises and handles setFunctionBreakpoints, preserves unchanged
IDs, reconciles condition changes and deletions, and keeps the function set
independent of each source breakpoint set. Function names appear in sidebar DTOs.

The original function request failed with `function breakpoints are not currently
supported`. The canonical integration test now creates typed function breakpoints
against mock and GDB. With real GDB it installs a conditional function breakpoint,
continues to a hit, checks the function frame and DAP breakpoint ID, replaces its
condition and deletes it. The command round-trip test preserves a C++-style name
with colons and spaces. Two LLDB bridge option tests pass using mocked LLDB objects;
real LLDB execution remains unverified because no executable is installed here.

Deletion exposed an SDK defect: collect rejected omitted empty ProtoJSON arrays.
DDB SDK commit `25e4a354` fixes that behavior while still rejecting malformed
present fields. Its seven TypeScript tests pass. The adapter vendors the rebuilt
SDK using a revision-qualified tarball name and a pinned integrity digest.

Current checks pass: 65 adapter unit tests; four canonical integration tests;
314 DDB core tests with one ignored; six API v1/v2 integration tests; seven SDK
tests; and two LLDB bridge option tests. The subsequent checkpoint below adds
hit conditions; other incomplete items remain in the parity checklist.

## Hit conditions and consumed breakpoint cleanup

DDB commit `33fc7007` retains ignore counts in logical breakpoint properties,
returns them through the canonical API, and carries them into group inheritance.
The GDB insertion command uses `-i`. The LLDB bridge sets and verifies the count,
removing the breakpoint if that configuration fails. The mock backend accounts
for ignored breakpoint encounters. The adapter advertises hit-condition support
and sends typed ignoreCount/temporary fields for source and function breakpoints.

The accepted forms preserve the legacy adapter's semantics:

| Form | Behavior |
| --- | --- |
| `>N` | Skip the first N hits, then stop on subsequent hits. |
| `N`, positive | Skip N hits, then stop once on each installed debugger member. |
| `0` or empty | Ordinary breakpoint. |

Counts use decimal strings and BigInt validation. Unsupported expressions and
values outside unsigned 64-bit range produce an error; backend limits can also
reject an admitted configuration. No JavaScript number conversion changes a count.

The real-GDB regression checks the number of skipped function calls, a subsequent
persistent hit, one-shot member removal, and preservation of the other installed
group member. Unit coverage also checks source breakpoint requests and exact
large counts. When a logical breakpoint is deleted, the adapter removes its
cached entry and emits a DAP removed event, allowing the same request to create
a new live breakpoint. Deletion racing an adapter reconciliation cannot remove
an unrelated cached entry.

Validation: 66 adapter unit tests, four canonical integration tests, 315 backend
core tests with one ignored, six API v1/v2 tests, and four LLDB bridge option tests
pass. Real LLDB execution and full GUI behavior remain unverified. All-stop coordination and the other incomplete checklist items remain required.

## Logpoints

The adapter now advertises logpoints and retains parsed log messages alongside
canonical breakpoint IDs. Expressions in braces are evaluated in frame zero of
the hitting thread through ListFrames and Evaluate. Literal text never becomes a
debugger command. Double braces escape literal braces; quoted and nested braces
inside expressions are preserved. Messages and output are bounded at 64 KiB,
with at most 128 expressions per message.

A logpoint emits one DAP console message and continues only its hitting thread.
It suppresses the corresponding visible breakpoint stop. Before continuation,
the adapter checks both its current stop generation and a fresh canonical
execution-state revision. Explicit DAP execution commands, signals and console
commands cancel pending automatic continuation. Evaluation errors produce a
stderr message and a visible stopped event. Automatic continuation is not
retried on failure. Recent deleted logpoint plans are retained in a bounded
history so a one-shot deletion does not discard an already pending log message.

Real-GDB tests verify interpolation, literal braces, targeted continuation to an
ordinary breakpoint, isolation of the other session, and stopping on expression
failure. Unit tests cover parsing, frame/target routing, cancellation, newer
backend stops, failed evaluation and retention after deletion. All 71 adapter
unit tests and four canonical integration tests pass. Multi-client control races,
full recovery behavior and the remaining checklist items still need the final
completion audit; these checks do not establish full migration completion.

## All-stop coordination checkpoint

Visible principal stops now interrupt each running peer session once through
canonical Execute operations. Completion does not imply that a stopped-state
update has arrived, so the coordinator keeps duplicate suppression until that
update. Automatic pauses preserve focus; explicit pauses are distinguished
from external SIGINT. Failed pause requests restore their prior classification
and report the failure. Successful logpoints do not pause peers.

Stopped events include the frame metadata consumed by source decorations, and
principal breakpoint stops include the existing breakpointInfo payload.
The real GDB regression first failed because a peer kept running after a
breakpoint. It now checks the peer stops, focus remains on the breakpoint,
source metadata is present, and a logpoint leaves its peer running until a
subsequent ordinary breakpoint.

Validation: 74 unit tests and all four canonical binary/entrypoint integration
tests pass with the patched debug DDB binary. Real VS Code decoration rendering
and LLDB execution remain unverified.

## Jump and stepping checkpoint

The canonical DAP entrypoint now advertises gotoTargets and implements goto.
Targets use bounded local handles and validated source locations. A jump creates
a temporary breakpoint in the selected thread's session, then executes typed
JUMP against that thread. An unresolved destination never resumes execution.
A rejected jump removes its temporary breakpoint and reports cleanup failures.

The real GDB test failed before this change because gotoTargets returned no
destination. It now verifies the destination line in both the stopped event and
fresh stack, consumption of the temporary breakpoint, and invalid target/line
errors. The same test exercises actual DAP step-in into tick, step-out back to
main, and next, checking each new step stop and stack function.

Validation: 78 unit tests and four canonical integration tests pass against the
patched DDB debug binary. Remote paths/source references and real LLDB jump
behavior are still outside the verified coverage.

## Connection ownership and managed exit checkpoint

A real managed-process crash exposed an indefinite wait: the SDK kept retrying
streams after its child DDB process had exited. The connection now observes
owned-child exit, closes the SDK to abort streams and requests, and reports
the process status through state synchronization. The DAP session terminates
once, including when the client sends disconnect after the crash.

The lifecycle tests kill only their own fixture process, then verify the error
output, termination event and closed SDK. A separate real DAP attach test
disconnects from an externally owned endpoint and confirms that the original
server remains responsive with the same instance ID. Closing the owner is
idempotent and removes both its process and private startup directory.

These tests do not establish recovery from external-server restarts, replay
gaps or output gaps; those remain separate checklist items.

Validation for the ownership checkpoint: 78 unit tests and all six canonical
integration tests pass with the patched DDB debug binary.

## Snapshot recovery checkpoint

A replacement snapshot now invalidates frame and variable handles and sends a
DAP invalidated event when the client supports it. Breakpoint reconciliation
runs through the mutation queue and lists current canonical breakpoints after
earlier mutations finish. Missing entries emit removed events and are forgotten
so an unchanged setBreakpoints request can recreate them.

An injected-snapshot DAP regression first failed because a lost deletion left
a stale breakpoint in the adapter. It now verifies removal, recreation with a
new local ID, invalidation of an old frame handle, and the client refresh event.
A separate test verifies reconciliation waits for in-flight creation, avoiding
false removal based on a snapshot older than the operation result.

This covers adapter behavior after receiving a replacement snapshot. It does
not yet exercise SDK replay-gap recovery over a broken network connection.

Validation for this checkpoint: 80 unit tests and six canonical integration
tests pass with the patched DDB debug binary.

## HTTP recovery verification

Two loopback HTTP tests exercise the production SDK, connection and DAP session
against a scripted canonical server. The tests destroy live state/output
sockets after initial delivery. They verify output reconnects with its last
cursor, reports a gap once, and delivers later output without duplicating the
first message. A state replay-gap response causes a fresh snapshot, removes
old resources, and resumes from the new snapshot cursor.

The second scenario returns a different server instance in the recovery
snapshot. The adapter reports the restart, closes its client and terminates
the session without applying the replacement server's resources. These are
real HTTP transport tests with scripted server responses, not a live DDB
journal-retention stress test. They required no production-code change.

Validation: 82 tests pass in npm test, including both HTTP recovery scenarios.
The six real-binary integration tests last passed at the preceding checkpoint;
production code has not changed since that run.

## Source pagination checkpoint

ReadSource returns pages joined internally by newlines, without a trailing
page separator. The adapter previously concatenated those pages directly,
merging lines at each boundary. It now inserts the missing separator, checks
that the returned start line matches the request, and rejects a content-hash
change between pages rather than displaying a mixture of file versions.

Both regressions failed before the fix. The real GDB integration fixture now
contains more than 1,000 lines; canonical ResolveSource and the adapter's
ReadSource loop reproduce all its lines across the page boundary.

Validation: 84 unit tests and six canonical integration tests pass. This proves
retrieval using a resolved source reference. Stack frames still need to expose
references for paths unavailable to VS Code; remote path mapping and GUI
source navigation remain incomplete. No backend source changes were needed.

## Stack source references checkpoint

Stack frames now check whether their reported absolute path is readable on the
adapter host. Inaccessible or relative paths are resolved through canonical
ResolveSource with the frame's owning session. The resulting opaque reference
becomes a local DAP source handle, which the existing source request can read.
Repeated references to a file within one stack request share the lookup.
Local readable paths keep local navigation. Missing source content does not
remove the stack frame or fail the stack request.

The new regression failed before the change because inaccessible paths had
sourceReference zero. Tests now verify reference resolution and reading, lookup
deduplication, local-file behavior and missing-source fallback. Validation:
86 unit tests and six canonical integration tests pass. The fallback tests
use a controlled service; actual VS Code navigation between different hosts
and remote path mappings remain unverified.

## Manifest and package checkpoint

The initial configuration and snippets now launch type ddb with a YAML file
or attach to apiEndpoint. External attach requires apiEndpoint and advertises
apiToken and distributedStack. Descriptions for managed process arguments,
environment overrides and startup output now match the canonical launcher.
Legacy configuration properties remain subject to the full migration audit;
replacing obsolete GDB snippets does not establish support for those settings.

A development VSIX was built at /tmp/ddb-canonical-migration.vsix. Its extracted
copy contains the canonical entrypoint, ESM adapter modules, frontend and
installed TypeScript SDK. The SDK installation archive is excluded from the
package. Both mock and GDB stdio tests passed against the extracted adapter,
including sidebar queries, distributed stack, autorun/substitution and shutdown.
The test runner accepts DDB_TEST_ADAPTER to repeat these checks on a packaged
entrypoint. This development artifact is not a completed migration release,
and a real VS Code extension-host/UI run is still required.

## Memory-read checkpoint

DAP zero-length reads now return an empty result without sending a request that
DDB rejects. The adapter validates counts, offsets and numeric addresses,
rejects offsets producing negative addresses, and checks the server's advertised
maxMemoryReadBytes before making a read.

The real GDB regression first failed on the zero-length request. It now verifies
the bytes of an assigned two-integer array, positive and negative offsets, empty
reads, invalid counts and the advertised read limit. Validation: 86 unit tests
and six canonical integration tests pass. The request still uses DDB's selected
thread, as required by the current numeric memory-reference convention.

Neither code nor xvfb-run is on PATH in the current environment. The memory-view
UI and broader extension-host checks remain unverified and need test setup.
The previously built development VSIX predates this memory change.
