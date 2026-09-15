import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DdbConnection } from "../../v2/connection.mjs";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
async function until(predicate: () => boolean, detail: string) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${detail}`);
		await delay(20);
	}
}

async function launchFixture(dir: string) {
	const config = join(dir, "ddb.yaml");
	await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(dir, "base"))}\n  log_dir: ${JSON.stringify(join(dir, "logs"))}\n  Debugger:\n    backend: mock\nStaticSessions:\n  - tag: test\n    hash: group\n    pid: 4401\n    mock:\n      source_file: main.c\n      source_line: 4\n      function: main\n`);
	const pidFile = join(dir, "pid");
	const wrapper = join(dir, "ddb-wrapper");
	const argsFile = join(dir, "args");
	const tokensFile = join(dir, "tokens.json");
	await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nprintf '%s\n' "$@" > ${quote(argsFile)}\nprevious=\nfor argument in "$@"; do\n  if [ "$previous" = "--api-auth-token-file" ]; then cp "$argument" ${quote(tokensFile)}; fi\n  previous="$argument"\ndone\nexec ${quote(process.env.DDB_TEST_BINARY!)} "$@"\n`, { mode: 0o700 });
	const connection = await DdbConnection.launch({ binary: wrapper, configFilePath: config, cwd: dir });
	return { connection, pidFile, argsFile, tokensFile };
}

suite("Canonical connection lifecycle", function () {
	this.timeout(20000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	test("unexpected managed process exit terminates the DAP session", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ddb-lifecycle-"));
		let connection: DdbConnection | undefined;
		try {
			const fixture = await launchFixture(dir);
			connection = fixture.connection;
			const { pidFile } = fixture;
			const dap = new CanonicalHarness();
			await dap.begin(connection);
			const pid = Number(await readFile(pidFile, "utf8"));
			assert.ok(Number.isSafeInteger(pid) && pid > 1);
			process.kill(pid, "SIGKILL");
			await until(() => dap.events.some(event => event.event === "terminated"), "DAP termination after managed DDB dies");
			assert.ok(dap.events.some(event => event.event === "output" && /DDB.*SIGKILL/.test(event.body.output)));
			assert.equal(connection.client.closed, true);
			assert.equal((await dap.request("disconnect")).success, true);
			assert.equal(dap.events.filter(event => event.event === "terminated").length, 1);
		} finally { await connection?.close(); await rm(dir, { recursive: true, force: true }); }
	});
	test("external DAP disconnect preserves the server; managed close removes its process and credentials", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ddb-ownership-"));
		let owner: DdbConnection | undefined;
		const dap = new CanonicalHarness();
		try {
			const fixture = await launchFixture(dir);
			owner = fixture.connection;
			const args = (await readFile(fixture.argsFile, "utf8")).trim().split("\n");
			const reportFile = args[args.indexOf("--startup-report") + 1];
			const tokenFile = args[args.indexOf("--api-auth-token-file") + 1];
			const report = JSON.parse(await readFile(reportFile, "utf8"));
			const tokens = JSON.parse(await readFile(fixture.tokensFile, "utf8"));
			const attached = await dap.request("attach", { apiEndpoint: report.endpoint, apiToken: tokens.tokens[0].token });
			assert.equal(attached.success, true, attached.message);
			assert.equal((await dap.request("configurationDone")).success, true);
			assert.ok((await dap.request("threads")).body.threads.length > 0);
			assert.equal((await dap.request("disconnect")).success, true);
			assert.equal(owner.client.closed, false);
			assert.equal((await owner.client.handshake()).serverInfo.serverInstanceId, report.server_instance_id);
			const close = owner.close();
			assert.equal(owner.close(), close, "managed close is idempotent");
			await close;
			assert.throws(() => process.kill(report.pid, 0), { code: "ESRCH" });
			await assert.rejects(access(dirname(tokenFile)), { code: "ENOENT" });
		} finally { await dap.request("disconnect"); await owner?.close(); await rm(dir, { recursive: true, force: true }); }
	});

});
