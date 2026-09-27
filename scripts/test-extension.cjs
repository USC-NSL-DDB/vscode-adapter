const { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

for (const key of ['DDB_VSCODE_EXECUTABLE', 'DDB_TEST_BINARY', 'DISPLAY']) {
  if (!process.env[key]) throw new Error(`Set ${key} before running the extension-host tests`);
}
const directory = mkdtempSync(join(tmpdir(), 'ddb-vscode-host-'));
const extensionDirectory = resolve(process.env.DDB_TEST_EXTENSION_DIRECTORY ?? resolve(__dirname, '..'));
let fixtureDirectory;
const suite = process.env.DDB_GREETER_WORKSPACE ? 'greeter_ui.js' : 'canonical_ui.js';
let testsPath = resolve(__dirname, '../out/src/test/extension', suite);
try {
  if (process.env.DDB_TEST_EXTENSION_DIRECTORY) {
    // VS Code attributes API permissions to the extension containing each file.
    fixtureDirectory = mkdtempSync(join(extensionDirectory, '.ddb-tests-'));
    for (const name of ['canonical_ui.js', 'source_navigation.js', 'session_controls.js', 'greeter_ui.js', 'breakpoint_hits.js']) {
      copyFileSync(resolve(__dirname, '../out/src/test/extension', name), join(fixtureDirectory, name));
    }
    testsPath = join(fixtureDirectory, suite);
  }
  const profile = join(directory, 'user-data');
  mkdirSync(join(profile, 'User'), { recursive: true });
  writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
    'ddb.otel.enabled': false,
  }));
  const result = spawnSync(process.env.DDB_VSCODE_EXECUTABLE, [
    '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-workspace-trust', '--skip-welcome',
    '--skip-release-notes', '--disable-extensions', `--user-data-dir=${profile}`,
    `--extensions-dir=${join(directory, 'extensions')}`,
    `--extensionDevelopmentPath=${extensionDirectory}`,
    `--extensionTestsPath=${testsPath}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OTEL_SDK_DISABLED: 'true', DDB_TEST_PROFILE: profile, DDB_TEST_CDP_SCRIPT: resolve(__dirname, 'test-vscode-cdp.cjs'), DDB_TEST_NODE: process.execPath }, timeout: process.env.DDB_GREETER_WORKSPACE ? 150000 : 90000, detached: true });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.pid) { try { process.kill(-result.pid, 'SIGTERM'); } catch {} }
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (/^Failed to update (?:all data|breakpoints|sessions|groups)|rejected promise not handled/m.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
    console.error('Extension-host refresh or unhandled-rejection diagnostics detected');
    process.exitCode = 1;
  }
} finally {
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
