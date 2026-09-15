# Canonical API migration

Work branch: `codex/canonical-ddb-api`, based on compatibility commit `8e7317b`.
DDB source: `7309720806cb455a7124bc2d42174754f637cd54`, release binary 0.1.15.

This migration is in progress. The extension still starts the compatibility
adapter until the canonical DAP session and frontend integration are complete.

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
| External endpoint | SDK endpoint and bearer token, disconnect without shutdown | Connection implemented; DAP configuration pending |
| Session/group/thread discovery | Snapshot and replayed resource upserts/tombstones | Connection tested; UI mapping pending |
| Thread selection | SelectThread operation | Connection tested |
| Stack, paging, source navigation | ListFrames, ResolveSource, ReadSource; local handles | DAP stack paging implemented and exercised; remote source reads pending verification |
| Distributed stack and boundary labels | RunDistributedBacktrace typed frames | Pending |
| Locals and expansion | ListScopes, ListVariables, ExpandVariable | DAP handlers implemented; root/array expansion and compound-watch expansion tested with real GDB |
| Registers | ListRegisters | DAP handler tested with mock and GDB |
| Watch and hover | Evaluate with frame ID and evaluation context | Scalar and compound DAP watches, hover and watch-child assignment tested |
| Variable assignment | Evaluate assignment if supported; backend escape hatch otherwise | Root and array-child DAP assignment tested with real GDB |
| Source/function breakpoints | Create/Update/DeleteBreakpoint operations | DAP source creation, condition replacement and deletion tested; function support pending |
| Session/group breakpoint selection, inheritance | Explicit canonical session/group/multiple target selectors | Group selection and paired DAP/custom requests tested in both arrival orders |
| Conditions, hit counts, enable/disable, logpoints | Typed fields where supported; logpoints need explicit implementation | Pending |
| Continue, pause, step in/out/over and all-stop coordination | Execute operations plus execution/thread state events | Next and session-specific DAP continue/pause tested; all-stop coordination and other actions pending |
| Signals and session kill | ListSignals and v2 raw signal command | DAP list/validation tested on mock/GDB; SIGKILL tested on GDB |
| Jump to line | Execute JUMP with source location | Pending |
| Debug Console, autorun, path substitution | Canonical raw-command escape hatch where typed APIs do not cover the command | Pending |
| Memory reads | ReadMemory | Pending |
| Sidebar refresh, grouping, breakpoint/source decorations | Custom DAP requests/events from shared projection | Pending |
| Focused frame navigation | Frame metadata lookup through DAP, no bit decoding | Pending |
| Reconnect, replay gap, output gap, restart | SDK recovery, projection rehydration, explicit loss/restart handling | Projection unit tests; transport fault tests pending |

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
- BreakpointSpec has no log-message field; UpdateBreakpoint supports only
  enabled and condition masks. Do not advertise feature parity until logpoints
  and replacement of other breakpoint properties are verified.
- ProtoJSON may omit numeric zero fields, including revisions/cursor sequence.
  Omission is zero, not a malformed revision.

## Checks completed so far

`npm test`: 56 unit tests pass, including opaque handle invalidation, revisions
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
They are not yet the extension entrypoint. Breakpoints, sidebar custom requests,
all-stop coordination, complete stop metadata, console commands, and the other
unchecked items above remain required.

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
The old frontend has not yet been switched to it. Launch must explicitly enable
pairedBreakpointRequests when using that frontend workflow; standard clients
can use setBreakpoints directly.

Full breakpoint parity remains unproven:

- Function breakpoints and ignore counts are rejected by the current backend's
  typed breakpoint implementation. A schema field alone does not establish
  runtime support.
- Logpoints and hit conditions remain explicitly unimplemented in the canonical
  adapter. They must be implemented and exercised before switching entrypoints.
- The backend reports group-only breakpoints as unverified even when their
  installation operation succeeds. Its projection derives verified from direct
  session sub-breakpoints only. The adapter preserves that flag; correcting the
  status and testing an actual group breakpoint hit remain required.

## Session-control checkpoint

The canonical adapter now exposes session/group lists, frame metadata and thread
selection through DAP custom requests. Session-specific continue/pause preserve
the other session's stopped state. The binary test verifies that behavior,
signal listing, invalid signal rejection, and SIGKILL followed by thread removal
while the other session remains alive. The frontend still needs to consume these
endpoints and replace its bit-packed frame decoding.

The typed SIGNAL implementation quotes the signal name before passing it to the
GDB CLI `signal` command. Real GDB rejects the resulting quoted name. Signal
sending therefore uses one canonical ExecuteRawCommand mutation with a validated
signal token. It does not retry the failed typed mutation or use a legacy route.
This backend encoding defect should be corrected before removing the escape hatch.
