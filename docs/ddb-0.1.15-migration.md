# Migration to DDB 0.1.15

Adapter version: 0.0.11. Branch: `codex/migrate-current-ddb`.

Examined against DDB source commit
`7309720806cb455a7124bc2d42174754f637cd54` and the local release binary reporting
`ddb 0.1.15`. Adapter baseline: `14994a591dfa00423b04c27206ba3b2d9d1b8a3c`.

## Findings and changes

| Boundary | Finding | Adapter change |
| --- | --- | --- |
| Startup threads | A real GDB session emits `thread-created` before DDB registers its command endpoint. Immediate `thread-info --thread 1` returns `Session 1 does not exist`; a later request succeeds. | Announce the thread immediately. Retry only that registration error, at 100 ms intervals for at most 50 attempts. Cancel when the thread exits or the session quits. Preserve a basic thread label if metadata fails. |
| Enumeration | CLI commands without a target now use the selected thread when available. | Use `thread-info --all` to enumerate the distributed session. |
| Stepping and signals | DDB's execution service returns silent MI presentations for next, step, finish and send-signal. Waiting for a tokenized MI completion hangs. | Use waited `/api/v1/commands` receipts for these commands, including their older `record-time-and-*` aliases. Keep asynchronous MI running/stopped events. |
| Thread selection | DDB's thread-select implementation builds an internal command without the external MI token. | Use `/api/v1/threads/select`; raw thread-select commands use waited HTTP receipts too. |
| Error handling | MI failures were suppressed by default, losing the backend diagnostic and sometimes dereferencing absent response data. Pause/signal requests acknowledged before completion. | Reject failures with their diagnostic; return DAP errors for failed control requests. Explicit suppression remains available. |
| Breakpoints | Parsed MI dictionaries are key/value arrays, but sub-breakpoints were read as plain objects. | Decode IDs, target IDs and types with `MINode.valueOf`. |
| Breakpoint changes | Target-only changes were ignored; failures could leave the original setBreakpoints request pending. | Compare target selections, propagate errors to both requests, and match source paths exactly. Preserve colons in source paths. |
| Expressions and variables | Expressions with spaces lacked MI quoting. Some callers already quoted expressions; registers and assignment could use the selected session instead of the displayed frame. | Quote once at the transport boundary, escape variable-object expressions, and target register reads and local/variable-object assignment explicitly. |
| Process launch | The configured environment and working directory were ignored; a periodic stdin timer survived termination. | Honor cwd/env, resolve the config path against cwd, run autorun commands, remove the timer, reject outstanding requests on exit, and bound shutdown. |
| Service URL | The extension host read VS Code settings, but the separate adapter process fell back to localhost:5000. | Forward the resolved URL through the debug configuration and normalize trailing slashes. |
| HTTP collections | JSON arrays were typed as Sets without consistent conversion. | Normalize group membership on every group-returning route. |
| Notifications | The WebSocket welcome message has no notification payload. Reconnection could miss state changes. | Accept welcome messages separately, validate event envelopes, and refresh sessions/breakpoints after reconnect. |

The original startup reproduction produced:

```text
=thread-created,id="1",session-id="1",...
71^error,msg="Session 1 does not exist"
...
72^done,threads=[{id="1",...}],current-thread-id="1"
```

A mock backend alone did not reproduce that registration race. The regression
suite therefore includes a real GDB process and deterministic replay of the
initial error through the adapter's actual thread-created handler.

## Protocol choice

This release retains DDB's supported numeric-ID compatibility contracts:

- MI stdin/stdout for commands with replies and asynchronous debugger events.
- Local unversioned HTTP routes for sessions, groups, sources and breakpoints.
- Waited API v1 HTTP receipts for commands whose MI replies are absent or lose
  their token.
- Version 1 WebSocket notifications at `/notifications/subscribe`.

DDB's API migration policy keeps these compatibility routes supported. Current
DDB exposes them only on a loopback listener. Run the extension host alongside
DDB, such as in a VS Code Remote SSH environment, or forward that loopback port.
The configured `ddb.serviceUrl` must reach the same DDB process that the adapter
launches. Set DDB's `Conf.api_server_port` to match it.

An API v2-only remote listener is not supported by this adapter release. V2 has
opaque IDs, operation admission, separate replayable state/output streams and
different schemas. It requires a separate transport migration, not URL changes.
There is no silent downgrade or mutation retry. An HTTP command timeout is an
error; it does not prove that the command was cancelled.

## Verification

```bash
npm ci
npm test
DDB_TEST_BINARY=/absolute/path/to/ddb npm run test:integration
npm run vscode:prepublish
npx vsce package
```

The integration suite starts disposable two-session deployments with the mock
backend and real GDB. Real GDB tests require `cc` and a working GDB installation.
They exercise:

- Immediate thread creation, all-session enumeration and thread selection.
- HTTP session/group/source lookup, breakpoint snapshots and WebSocket changes.
- Local stack capture, locals, expression evaluation and register reads.
- DAP threads, stackTrace, scopes, variables, watch evaluation and step errors.
- Breakpoint creation, conditions, enable/disable and deletion.
- Next/step, mock finish, continue, interrupt, signal listing, real session kill
  and repeated shutdown.

Unit tests cover startup/exit races, permanent query errors, missing completion
paths, failed breakpoint request completion, distributed frame metadata,
notification welcome messages, URL normalization and child-process lifecycle.

The old unit suite had two failing nested-value expansion tests. Their test
callback discarded parsed arrays by reading `.name`; it now preserves those
arrays so the existing expected nested values are checked. Tests run compiled
JavaScript, avoiding ts-node/Mocha loading issues with cross-file DAP type
augmentations and Node's built-in TypeScript loader.

Repository-wide ESLint was already failing on the baseline, with 7,483 findings
before generated output existed. It remains a separate cleanup task. The build,
unit tests and binary integration tests are the migration's executable checks.

## Limits of verification

The tests exercise adapter methods and DAP handlers without launching the VS Code
GUI. They do not validate a deployed distributed application, remote-parent
context restoration, every framework plugin, LLDB, or Windows. Distributed
frame IDs and boundary metadata have regression coverage; a real distributed
backtrace across services still needs the application's deployment.

Existing frame-handle bit packing still limits sessions to 255, threads to
65,535 and frame levels to 127. This migration preserves that adapter model.
