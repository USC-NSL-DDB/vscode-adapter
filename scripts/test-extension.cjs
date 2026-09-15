const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

for (const key of ['DDB_VSCODE_EXECUTABLE', 'DDB_TEST_BINARY', 'DISPLAY']) {
  if (!process.env[key]) throw new Error(`Set ${key} before running the extension-host tests`);
}
const directory = mkdtempSync(join(tmpdir(), 'ddb-vscode-host-'));
try {
  const profile = join(directory, 'user-data');
  mkdirSync(join(profile, 'User'), { recursive: true });
  writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
    'ddb.otel.enabled': false,
  }));
  const result = spawnSync(process.env.DDB_VSCODE_EXECUTABLE, [
    '--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome',
    '--skip-release-notes', '--disable-extensions', `--user-data-dir=${profile}`,
    `--extensions-dir=${join(directory, 'extensions')}`,
    `--extensionDevelopmentPath=${resolve(__dirname, '..')}`,
    `--extensionTestsPath=${resolve(__dirname, '../out/src/test/extension/canonical_ui.js')}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OTEL_SDK_DISABLED: 'true' }, timeout: 90000, detached: true });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.pid) { try { process.kill(-result.pid, 'SIGTERM'); } catch {} }
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (/^Failed to update (?:all data|breakpoints|sessions|groups)|rejected promise not handled/m.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
    console.error('Extension-host refresh or unhandled-rejection diagnostics detected');
    process.exitCode = 1;
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
