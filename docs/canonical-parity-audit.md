# Canonical adapter parity audit

The migration branch is `codex/canonical-ddb-api`, descended from compatibility
commit `8e7317b`. The runtime entrypoint loads `src/v2/session.mts`. It uses the
vendored TypeScript SDK over authenticated API v2 HTTP, with separate state and
output streams. The sidebar uses DAP requests and events through that connection.

Use backend branch `codex/vscode-api-parity` at `00adc459` or a descendant. Its
worktree is `/tmp/ddb-canonical-api-fixes`; the DDB main worktree was not modified.
The unpatched 0.1.15 binary does not provide all required behavior.

## Enabled compatibility features

This audit uses the compatibility entrypoint, command registrations, launch
implementation and package manifest to define the existing feature set.

| Feature | Implementation and verification |
| --- | --- |
| YAML launch, working directory, arguments and environment | Managed startup and authenticated endpoint discovery. Packaged stdio tests exercise launch options, environment override and removal, autorun, path substitutions and diagnostics. |
| Stop at entry | Typed temporary function breakpoint, installed once at configuration completion. GDB tests verify a named entrypoint and its actual stop. |
| Session, group and thread discovery | Canonical snapshot/event projection with opaque-ID mapping. Binary, frontend and real VS Code tests cover discovery and sidebar refresh/grouping. |
| Local and distributed stacks | Typed frame APIs, pagination and frame ownership. GDB checks local frames; a real two-session DDB mock topology checks distributed parent frames, boundary rows, pagination and thread selection. |
| Source navigation | Local paths and canonical source references. GDB tests exercise substituted paths and executable paths with spaces. VS Code tests open local, reference-only and remote-path sources. |
| Locals, watches, hover, registers and assignment | Typed inspection with structured raw-command results for missing variable metadata. Real GDB checks scalar, array and C++ container expansion, caller-frame ownership, registers and assignments. Unit tests reject stale handles and late replies. |
| Variable display modes | Packaged GDB tests expand arrays in prettyPrinters and parseText modes, and verify disabled mode exposes no expansion handle. |
| Source and function breakpoints | Typed creation/deletion, conditions, hit counts, verification and inherited members. GDB tests exercise real hits; VS Code tests cover group/session selection, view switching, disable/re-enable and unrelated breakpoint preservation. |
| Logpoints | Canonical stop handling evaluates expressions and resumes the correct session. Tests cover successful output, failed evaluation and newer user control. |
| Continue, pause and stepping | Typed Execute operations. GDB tests verify step in/out/over, session-specific control, all-stop coordination and pause focus. Deterministic unit tests cover delayed stop publication after newer control. |
| Signals and kill | ListSignals and typed Execute SIGNAL. VS Code sends SIGKILL and verifies process exit. Callback tests cover confirmation, cancellation, owning-session capture and rejected requests. |
| Jump to line | Temporary breakpoint and typed Execute JUMP. GDB tests verify destination stops, substituted paths, consumed breakpoints and invalid targets. |
| Console and startup commands | Canonical raw-command operations preserve quoting and frame/session context. Packaged GDB tests verify autorun and console output. |
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
commands and variable metadata still use GDB MI command syntax inside structured
v2 raw-command requests where the backend lacks an equivalent typed operation.

## Reproducibility and limits

Run `npm test`, then `DDB_TEST_BINARY=/path/to/ddb npm run test:canonical`.
[Extension-host instructions](extension-host-tests.md) cover testing an extracted
VSIX in a dedicated VS Code profile. No marketplace publication or merge is part
of this migration.

Two integration-test timing assumptions were corrected. The GDB fixture now
waits for both inferiors to reach main before attaching the all-stop adapter.
The mock backend always stops 25 ms after Continue, so its test checks the
continued event instead of expecting a persistent running state. A pause of that
already stopped mock is idempotent; actual running-to-paused behavior is checked
with GDB.

The SDK/API remains preview-stage and this adapter is pinned to the tested SDK
archive and backend fixes. Distributed adapter behavior is tested through DDB's
mock topology, not a deployed application framework. The original DDB adapter's
GDB path is validated with real GDB; this audit does not claim real LLDB coverage.
The repository's pre-existing broad lint failures are not a passing validation
gate. TypeScript compilation, focused tests and runtime checks are the evidence.

Earlier investigation and regression details are retained in
[the migration log](canonical-api-migration.md).

## Validation results

- Adapter unit tests: 114 passed.
- Backend core tests: 317 passed, one ignored.
- Canonical binary integration suite: 12 passed, including all variable modes.
- Corrected mock execution scenario: five additional consecutive passes.
- Extracted VSIX: four stdio scenarios and the real VS Code/GDB scenario passed
  before the documentation and setting-description update. The final artifact
  is rechecked after packaging; its receipt is recorded separately.
