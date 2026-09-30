# gRPC with LLDB

These profiles use the DDB `dev` branch and the adapter `main` branch. Use LLDB 20 or later for the instrumented greeter binaries used here.
LLDB 18 cannot read their `DW_FORM_data16` debug information.

## Setup

On Ubuntu 24.04:

```sh
sudo apt-get install lldb-20 python3-lldb-20
lldb-20 --version
```

DDB starts `lldb` on each target host. If installing the versioned package leaves
that command absent, create a launcher without replacing an existing one:

```sh
sudo ln -s /usr/bin/lldb-20 /usr/local/bin/lldb
lldb --version
```

Check the same command through SSH for discovered processes. The package manager
may replace an earlier LLDB installation because the Python packages conflict.

1. Copy `ddb-lldb.yaml` to the greeter workspace's `.ddb/dbg_grpc_lldb.yaml`.
2. Add the configuration from `launch-lldb.json` to `.vscode/launch.json`.
3. Set `ddbpath` to your built DDB executable and start that VS Code profile.
4. From the workspace's `build` directory, run `./greeter_server --ddb` and
   `./greeter_client --ddb` in separate terminals.
5. Set group breakpoints at the client RPC and server handler. Resume each
   process from the DDB Sessions panel, or continue all processes.

The profile enables the existing frame-filter presets and LLDB's native value
formatters. It does not need GDB's `-enable-pretty-printing` command. Clearing
`DEBUGINFOD_URLS` keeps local symbol lookup from waiting for an external server.
For SSH targets, configure that environment on the target host if needed.

PET/faketime is disabled. RPC deadlines continue to advance while a process is
paused, so a sufficiently long pause can still cause an application RPC timeout.

## Automated validation

See [extension-host tests](../../docs/extension-host-tests.md). Select LLDB with
`DDB_TEST_BACKEND=lldb`, and set `DDB_GREETER_WORKSPACE` for the actual instrumented
client/server test. Its broker uses port 28883 and its server uses port 50059.
