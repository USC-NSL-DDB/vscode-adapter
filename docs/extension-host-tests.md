# Extension-host tests

Run the canonical adapter inside a real VS Code extension host with a dedicated
profile. The test uses GDB and a temporary C program, activates the extension,
refreshes and groups the sidebar, opens the focused source frame, steps through
VS Code, requests scopes, and disconnects. It fails on unhandled promise
rejections during the run.

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

This test is not a complete visual audit. It does not yet exercise breakpoint
selection dialogs, enable/disable actions, remote source editors, or inspect
rendered decorations. Caught refresh failures during disconnect remain visible
in the test log; unhandled rejections are asserted absent.
