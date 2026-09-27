# Canonical adapter parity audit

The canonical adapter replaces the compatibility implementation at commit
`8e7317b`. The runtime entrypoint loads `src/v2/session.mts`. It uses the
vendored TypeScript SDK over authenticated API v2 HTTP, with separate state and
output streams. The sidebar uses DAP requests and events through that connection.

Use a backend checkout containing `ea2fe491` or its descendants, including the
local-variable inspection fix for GDB presentation frame filters.
The unpatched 0.1.15 binary does not provide all required behavior.

## Enabled compatibility features

This audit uses the compatibility entrypoint, command registrations, launch
implementation and package manifest to define the existing feature set.

| Feature | Implementation and verification |
| --- | --- |
| YAML launch, working directory, arguments and environment | Managed startup and authenticated endpoint discovery. Packaged stdio tests exercise launch options, environment override and removal, autorun, path substitutions and diagnostics. |
| Stop at entry | Typed temporary function breakpoint, installed once at configuration completion. GDB tests verify a named entrypoint and its actual stop. |
| Session, group and thread discovery | Canonical snapshot/event projection with opaque-ID mapping. Binary, frontend and real VS Code tests cover discovery and sidebar refresh/grouping. |
| Local and distributed stacks | Typed frame APIs, pagination and frame ownership. GDB checks local frames; the mock topology checks pagination and ownership. The instrumented gRPC greeter test opens a distributed caller frame in VS Code and inspects its variables. |
| Source navigation | Local paths and canonical source references. GDB tests exercise substituted paths and executable paths with spaces. VS Code tests open local, reference-only and remote-path sources, plus the breakpoint-panel source action. Missing library sources resolve lazily when opened. |
| Locals, watches, hover, registers and assignment | Typed variable metadata, retained evaluation handles and identity-based assignment. Real GDB checks scalar, array and C++ container expansion, caller-frame ownership, registers and assignments. Unit tests reject stale handles and late replies. |
| Variable display modes | Packaged GDB tests expand arrays in prettyPrinters and parseText modes, and verify disabled mode exposes no expansion handle. |
| Source and function breakpoints | Typed creation/deletion, conditions, hit counts, verification and inherited members. GDB tests exercise real hits; VS Code tests cover group/session selection, view switching, disable/re-enable and unrelated breakpoint preservation. |
| Logpoints | Canonical stop handling evaluates expressions and resumes the correct session. Tests cover successful output, failed evaluation and newer user control. |
| Continue, pause and stepping | Typed Execute operations. GDB tests verify step in/out/over, session-specific control, all-stop coordination and pause focus. Deterministic unit tests cover delayed stop publication after newer control. |
| Signals and kill | ListSignals and typed Execute SIGNAL. VS Code sends SIGKILL and verifies process exit. Callback tests cover confirmation, cancellation, owning-session capture and rejected requests. |
| Jump to line | Temporary breakpoint and typed Execute JUMP. GDB tests verify destination stops, substituted paths, consumed breakpoints and invalid targets. |
| Console and startup commands | Native console requests preserve command text and canonical frame/session context; typed configuration enables pretty-printers and source mappings. Packaged GDB tests verify autorun and console output. |
| Decorations and focused-frame status | Real VS Code tests inspect rendered group/session breakpoint labels, execution labels and status-bar metadata, then verify cleanup. |
| Output and reconnection | Real loopback HTTP tests interrupt streams, verify cursor resume and loss warnings, rehydrate state after replay gaps and reject a changed server instance. |
| Shutdown and failures | Managed process exit, bounded owned-process cleanup, credential cleanup and external-server preservation are exercised by lifecycle tests. Refresh tests reject late results and stop callbacks during disconnect. |
| Telemetry settings | Frontend settings are forwarded to the backend without overriding explicit arguments. Unit tests verify enabled/disabled behavior and correlation settings; test runs disable export. |

## Scope decisions

The compatibility DDB entrypoint explicitly advertised `supportsStepBack: false`.
It did not implement executable/SSH attach. Its YAML loader ignored inherited
`target`, `arguments` and `terminal` settings, and its memory-view command was
commented out. These inherited declarations are not enabled features lost by the
migration. The new adapter additionally supports attaching to an existing API
endpoint and typed memory reads, both tested.

Legacy implementation files remain for compatibility regression tests. The active
entrypoint does not instantiate their MI transport or parser. Arbitrary console
and autorun commands use native debugger CLI text. Variable
inspection, assignment and setup use typed SDK methods. The adapter does not
construct MI commands or manage backend variable objects.

## Reproducibility and limits

Run `npm test`, then `DDB_TEST_BINARY=/path/to/ddb npm run test:canonical`.
[Extension-host instructions](extension-host-tests.md) cover testing an extracted
VSIX in a dedicated VS Code profile. Marketplace publication is separate from local integration.

Two integration-test timing assumptions were corrected. The GDB fixture now
waits for both inferiors to reach main before attaching the all-stop adapter.
The mock backend always stops 25 ms after Continue, so its test checks the
continued event instead of expecting a persistent running state. A pause of that
already stopped mock is idempotent; actual running-to-paused behavior is checked
with GDB.

The SDK/API remains preview-stage and this adapter is pinned to the tested SDK
archive and backend fixes. Distributed adapter behavior is tested through DDB's
mock topology and the instrumented gRPC greeter client/server. The GDB path is
validated with real GDB; this audit does not claim real LLDB coverage.
The repository's pre-existing broad lint failures are not a passing validation
gate. TypeScript compilation, focused tests and runtime checks are the evidence.

Earlier investigation and regression details are retained in
[the migration log](canonical-api-migration.md).

## Historical migration validation

- Adapter unit tests: 122 passed.
- Backend core tests: 322 passed, one ignored; HTTP and gRPC checks passed.
- Canonical binary integration suite: 12 passed, including all variable modes,
  C++ nested containers, typed child assignment and caller-frame native console.
- Backend real GDB tests cover one-time evaluation, stop-scoped cleanup,
  lazy pretty-printers, typed settings, authorization and idempotent assignment.
- Rust, TypeScript and Python SDK checks and generated-contract checks passed.

Packaged stdio and extension-host checks use the procedures above. Their logs and
artifact digest are recorded with the packaged build, since source test results
alone do not establish that a VSIX contains the expected runtime.

## Follow-up to greeter manual testing

- Missing source references no longer become handle zero. Stack rendering does
  not perform remote source resolution. Initial greeter stack requests measured
  25–73 ms after the change, compared with 4.1–4.9 seconds before it.
- A process-wide GDB stop produces one DAP stop for its actual owner. Automatically
  interrupted peers do not cancel VS Code's frame selection. Stop publication
  waits for their state updates after the interrupt operation completes.
- Breakpoint owners sort first and carry file/line labels; one simultaneous hit
  receives editor focus. A unit regression checks two actual hits and a paused peer.
- Distributed traversal can interrupt a running caller. Returned caller frames
  now use that new stop's inspection lifetime while the origin's stale-request
  check remains active. Boundary labels include the caller session.
- The breakpoint panel provides an inline source-navigation action.
- Backend GDB exit-policy tests cover kill and detach with running and stopped
  inferiors. Managed startup tests cover unexpected launcher exit. Direct tests
  against the greeter pair cover DDB SIGTERM and SIGKILL cleanup.

The greeter VS Code scenario checks the initial stack, client/server highlights,
caller-frame clicks, scopes and variables, source navigation and cleanup.
See the package validation receipt for the exact artifact and test logs.

## Current breakpoint hits

The adapter derives panel hit markers from current stopped-thread ownership and
canonical breakpoint IDs. It supports simultaneous hits across sessions and
multiple hitting threads within a session. Session and group rows show only hits
for their breakpoint; automatic pauses and historical counts do not create hits.
File groups also aggregate current hits when the panel groups by file.

**Go to Paused Frame** selects the actual stopped thread in VS Code, including
its stack and variables. A picker disambiguates multiple hits. Requests carry the
stop revision and are rejected if the target resumed or reached a different stop.
No backend or SDK change is needed.

A real VS Code fixture verifies concurrent indicators, navigation and clearing
on resume through the canonical adapter. It also caught and now guards against
later stop events cancelling the first hit's automatic frame selection. Later
concurrent stop events update only their own thread. Real GDB integration verifies
hit ownership and that navigation preserves stopped execution.
