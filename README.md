# DDB debugger for VS Code

This development branch migrates the extension to DDB's canonical API v2 and
TypeScript SDK. The adapter owns the backend connection; the sidebar communicates
with it through VS Code's Debug Adapter Protocol.

See the [feature audit and test evidence](docs/canonical-parity-audit.md)
for the supported compatibility features and validation limits.
The compatibility adapter remains on `codex/migrate-current-ddb`.

## Required DDB build

Use DDB's `codex/vscode-api-parity` branch at commit `b773bcf8` or a descendant
containing those fixes. The unpatched 0.1.15 binary lacks required stop metadata,
function-breakpoint and hit-count behavior. The patched branch also fixes
GDB executable paths containing spaces, typed signal delivery, variable assignment,
expandable evaluations, native frame-scoped console commands and debugger settings. API v2 and its SDK are preview APIs.

Build from a separate DDB worktree. For example:

```sh
cargo build --manifest-path /path/to/ddb-worktree/ddb/Cargo.toml \
  --package ddb --bin ddb --target-dir /tmp/ddb-canonical-build
```

Use `/tmp/ddb-canonical-build/debug/ddb` as `ddbpath` below. The adapter repository
vendors the matching SDK install archive; `npm ci` installs it.

Debug Console and `autorun` accept native debugger CLI commands, such as
`print counter` or `set print elements 100`. Replace old MI commands such as
`-data-evaluate-expression` with their CLI equivalents. Watch and hover expressions
use typed evaluation directly.

## Managed launch

Use a working DDB YAML configuration. In `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "ddb",
      "request": "launch",
      "name": "DDB",
      "ddbpath": "/absolute/path/to/ddb",
      "configFilePath": "${workspaceFolder}/ddb.yaml",
      "cwd": "${workspaceFolder}",
      "distributedStack": true,
      "debugger_args": []
    }
  ]
}
```

The adapter starts `ddb serve --managed`, creates private authentication and
startup-report files, and connects to the reported loopback endpoint. Disconnect
shuts down that owned process and removes its temporary files. The patched backend
also shuts down if the adapter exits unexpectedly. GDB retains the configured
`Conf.on_exit` policy, including when its connection to DDB closes. Configure debugged
programs and their startup behavior in DDB YAML.

`stopAtEntry: true` additionally installs a temporary `main` breakpoint;
a function-name string selects a different entry function. This setting does not
automatically continue an initially stopped process.

`debugger_args` accepts additional DDB flags. Bind, authentication, managed-mode,
and startup-report flags belong to the adapter and cannot be overridden there.
`printCalls: true` shows API methods and HTTP status without headers or payloads.
`showDevDebugOutput: true` also shows managed-process stdout.

## Breakpoints and call stacks

The call stack labels actual breakpoint threads with their file and line and
lists them before paused peers. The top frame at the breakpoint has a
`[breakpoint]` prefix. One hit receives automatic editor focus; concurrent hits
remain labelled without repeatedly switching editors.

Hover over a source breakpoint in **DDB Breakpoints** and click **Go to Breakpoint
Source** to open its line. Distributed call boundaries include the caller's
session name, and caller frames support source navigation and variable inspection.

Unavailable library source is fetched only when opening that frame. It no longer
holds up the call stack. A file that DDB cannot retrieve still requires installing
its source or configuring a source mapping.

## Attach to an existing API v2 server

```json
{
  "type": "ddb",
  "request": "attach",
  "name": "Existing DDB",
  "apiEndpoint": "http://127.0.0.1:5000"
}
```

Supply authentication through `DDB_API_TOKEN` in VS Code's environment, or the
optional `apiToken` launch property. Disconnect closes the client and leaves an
external server running.

The old `ddb.serviceUrl`, `serviceUrl`, and `DDB_API_URL` settings do not select
the canonical connection. Managed launch discovers its endpoint; attach uses
`apiEndpoint`. The adapter no longer consumes DDB's MI stdout transport.

## Build and test

```sh
npm ci
npm test
DDB_TEST_BINARY=/absolute/path/to/patched/ddb npm run test:canonical
npx vsce package
```

The canonical integration suite requires C and C++ compilers and GDB. It tests
managed startup, external ownership, inspection, execution, C++ pretty printers,
and a two-session distributed mock topology. See
[extension-host tests](docs/extension-host-tests.md) for real VS Code validation.

Install the resulting VSIX using VS Code's **Extensions: Install from VSIX**
command. The package version remains 0.0.11 during development; a package built
from this branch has different requirements from the compatibility package.

## Origin

This repository is a manual fork of
[WebFreak001/code-debug](https://github.com/WebFreak001/code-debug).
