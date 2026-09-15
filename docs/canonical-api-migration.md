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
| Stack, paging, source navigation | ListFrames, ResolveSource, ReadSource; local handles | ListFrames tested; DAP handlers pending |
| Distributed stack and boundary labels | RunDistributedBacktrace typed frames | Pending |
| Locals and expansion | ListScopes, ListVariables, ExpandVariable | Lists tested; expansion and DAP handlers pending |
| Registers | ListRegisters | Pending |
| Watch and hover | Evaluate with frame ID and evaluation context | Evaluation tested; DAP handlers pending |
| Variable assignment | Evaluate assignment if supported; backend escape hatch otherwise | Pending |
| Source/function breakpoints | Create/Update/DeleteBreakpoint operations | Source insertion/deletion tested; function and DAP handlers pending |
| Session/group breakpoint selection, inheritance | Explicit canonical session/group/multiple target selectors | Multiple-group creation tested; frontend pairing pending |
| Conditions, hit counts, enable/disable, logpoints | Typed fields where supported; logpoints need explicit implementation | Pending |
| Continue, pause, step in/out/over and all-stop coordination | Execute operations plus execution/thread state events | Next tested; remaining actions and DAP handlers pending |
| Signals and session kill | ListSignals and Execute SIGNAL | Pending |
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

`npm test`: 54 unit tests pass, including opaque handle invalidation, revisions
above JavaScript's integer precision, stale replay/tombstones, atomic snapshot
replacement, required resync, and failed/partial operation rejection.

`DDB_TEST_BINARY=/path/to/ddb npm run test:canonical`: starts two-session mock
and GDB deployments with managed authenticated launch. Checks shared state,
thread selection, frames, scopes, variables, evaluation, explicit group-targeted
breakpoints and their streamed deletion, stepping, and cleanup.

These checks validate the new connection layer, not completed DAP/UI migration.
