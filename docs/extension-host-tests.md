# Extension-host tests

Run the canonical adapter inside a real VS Code extension host with a dedicated
profile. The test uses GDB and a temporary C program, activates the extension,
refreshes and groups the sidebar, opens the focused source frame, steps through
VS Code, requests scopes, selects a pre-existing enabled breakpoint group through Quick Pick during
launch, disables
and re-enables that breakpoint, resumes and pauses through sidebar commands,
selects SIGKILL through the signal picker, verifies process exit, and disconnects. It fails on unhandled promise
rejections or refresh-error diagnostics from the extension host.

Requirements: a Linux VS Code executable, a running X display, `cc`, `gdb`, and
a DDB binary containing the canonical migration fixes.

```sh
DISPLAY=:191 \
DDB_VSCODE_EXECUTABLE=/path/to/VSCode-linux-x64/code \
DDB_TEST_BINARY=/path/to/ddb \
npm run test:extension
```

The launcher creates and removes its own user profile and extensions directory
under the system temporary directory. It disables telemetry and updates for the
test host. It does not modify the user's VS Code profile or install extensions.
The test launcher disables Electron sandboxing for this isolated test process.

The first verified run used VS Code 1.104.3 and Xvfb 21.1.12 extracted under
`/tmp/ddb-vscode-ui`. No system packages were installed. The downloaded VS Code
archive SHA-256 was
`4bd1f5219195dc165eda48d2764b7c4be4a1135110034ca228497ae6d34db49c`.

The test clicks the rendered group/session toggle button through the isolated
window's loopback DevTools endpoint. It verifies group selection survives view
switching, creates a session-targeted breakpoint, and checks rendered editor
labels, the execution annotation, and focused-frame status. Disconnect clears
the execution annotation. The helper uses the Node test runner's built-in fetch
and WebSocket support; this setup is validated with Node 24.

A second session uses an inline DAP fixture to serve source content through a
source reference. It tests the registered focused-frame command with a
reference-only source and with a remote path plus reference. Both must open a
VS Code debug editor with the supplied content and selected line. This tests
frontend navigation and the editor content provider; it does not test a remote
DDB deployment.

## Test an extracted VSIX

Set DDB_TEST_EXTENSION_DIRECTORY to the `extension` directory extracted from a
VSIX to test its packaged runtime. The runner temporarily copies its four test
files under that directory so VS Code attributes fixture API calls to the DDB
extension. It removes those files afterward. The directory must be writable.
The test asserts that VS Code loaded the requested extension path.

```sh
DISPLAY=:191 \
DDB_VSCODE_EXECUTABLE=/path/to/VSCode-linux-x64/code \
DDB_TEST_BINARY=/path/to/ddb \
DDB_TEST_EXTENSION_DIRECTORY=/tmp/extracted-vsix/extension \
npm run test:extension
```

For packaged stdio tests, set DDB_TEST_ADAPTER to the extracted
`extension/out/src/gdb.js` and run the compiled canonical_stdio integration test.

The modal Kill Session confirmation is covered by callback tests because VS Code
refuses modal dialogs in extension-test mode. Those tests verify confirmation,
cancellation, owning-session capture, awaited control failures, and signal-picker
cancellation during loading. The real extension-host test covers delivery of the
same SIGKILL signal to GDB.

Packaged stdio tests also check environment override/removal and the three
variable display modes. The mock backend emits a scheduled stop after Continue;
the integration scenario observes that event instead of polling for a lasting
running state. Real GDB verifies running-to-paused behavior.

## Instrumented gRPC greeter test

Set `DDB_GREETER_WORKSPACE` to a helloworld workspace containing
`build/greeter_server` and `build/greeter_client` built with DDB instrumentation.
This selects the greeter scenario instead of the C fixture. The current test
expects the client RPC at `greeter_client.cc:70` and the server handler at
`greeter_server.cc:59`. It uses `mosquitto` on port 28883 and gRPC on port 50059.
Stop other local DDB discovery/broker sessions before this test. The test saves
and restores `/tmp/ddb/service_discovery/config`; DDB's managed broker cleanup
currently affects other Mosquitto processes on the host.

```sh
DISPLAY=:191 \
DDB_VSCODE_EXECUTABLE=/path/to/VSCode-linux-x64/code \
DDB_TEST_BINARY=/path/to/ddb \
DDB_TEST_EXTENSION_DIRECTORY=/tmp/extracted-vsix/extension \
DDB_GREETER_WORKSPACE=/mnt/home/ybyan/codebase/grpc/examples/cpp/helloworld \
npm run test:extension
```

The test launches the actual binaries with `--ddb`, installs group breakpoints,
and checks automatic editor selection at both client and server hits. It checks
actual-hit thread labels, distributed caller frames, scopes and variables, then
clicks a caller frame and the breakpoint panel's inline source action. Disconnect
must terminate both attached processes. It also checks initial stack retrieval
finishes within one second without waiting for missing system-library sources.

The normal scenario covers the group Quick Pick. The greeter scenario supplies
its selected group through the same paired breakpoint request so it can test RPC
and stop behavior independently. Both scenarios use an isolated VS Code profile.
Simultaneous independent breakpoint hits are covered by deterministic adapter
unit tests; the greeter scenario hits the client and server in sequence.

## Concurrent breakpoint hit panel

The standard extension-host run also exercises the real canonical adapter with
an in-memory backend state fixture. Two sessions hit one breakpoint while a third
thread hits another breakpoint. The test checks parent, group and session markers,
clicks a session's **Go to Paused Frame** button, chooses another session through
the parent row's picker, and verifies VS Code's active stack frame changes.
Resuming one thread must preserve other hits; resuming all threads must remove
all hit actions and markers. Accumulated hit counts remain nonzero throughout.

Set `DDB_HIT_UI_ONLY=1` to run just this fixture with the usual extension-host
environment. It does not start a DDB server or use service discovery. Real GDB
integration separately checks that only the actual breakpoint owner appears in
the hit projection and that focusing it leaves every process stopped.
