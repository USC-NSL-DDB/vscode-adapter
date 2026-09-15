# Extension-host tests

Run the canonical adapter inside a real VS Code extension host with a dedicated
profile. The test uses GDB and a temporary C program, activates the extension,
refreshes and groups the sidebar, opens the focused source frame, steps through
VS Code, requests scopes, selects a pre-existing enabled breakpoint group through Quick Pick during
launch, disables
and re-enables that breakpoint, and disconnects. It fails on unhandled promise
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
VSIX to test its packaged runtime. The runner temporarily copies its two test
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
