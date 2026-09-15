# DDB debugger for VS Code

Version 0.0.11 supports the local compatibility interfaces of DDB 0.1.15.
See the [migration findings and verification notes](docs/ddb-0.1.15-migration.md).

## Configure

Install DDB and use a working DDB YAML configuration. In `.vscode/launch.json`:

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
      "debugger_args": []
    }
  ]
}
```

Set `ddb.serviceUrl` in VS Code settings to DDB's loopback API address. The
standard value is `http://localhost:5000`; its port must match
`Conf.api_server_port` in the DDB YAML. `DDB_API_URL` overrides the setting.
The extension forwards the same URL to the debug adapter process.

Use the YAML config launch form, not `ddb serve`, because the adapter consumes
MI stdout. API v2-only listeners are not supported in this release.

## Build and test

```bash
npm ci
npm test
DDB_TEST_BINARY=/absolute/path/to/ddb npm run test:integration
npx vsce package
```

Install the resulting `ddb-debugger-0.0.11.vsix` using VS Code's **Extensions:
Install from VSIX** command. The integration tests require a C compiler and GDB.

## Origin

This repository is a manual fork of
[WebFreak001/code-debug](https://github.com/WebFreak001/code-debug).
