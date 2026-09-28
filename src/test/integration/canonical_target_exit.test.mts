import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";

suite("Independent target exit", function () {
	this.timeout(30000);
	setup(function () {
		if (!process.env.DDB_TEST_BINARY) this.skip();
	});
	test("a client exiting leaves the paused server inspectable and expires only client frames", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ddb-target-exit-"));
		const dap = new CanonicalHarness();
		const request = async (
			command: string,
			args: object = {},
		): Promise<any> => {
			const result = await dap.request(command, args);
			assert.equal(result.success, true, `${command}: ${result.message}`);
			return result.body;
		};
		try {
			const source = join(directory, "main.c"),
				binary = join(directory, "main"),
				config = join(directory, "ddb.yaml");
			await writeFile(
				source,
				"int main(void) { int value = 7; return value == 7 ? 0 : 1; }\n",
			);
			execFileSync("cc", ["-g", "-O0", source, "-o", binary]);
			await writeFile(
				config,
				`Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${directory}/base\n  log_dir: ${directory}/logs\n  Debugger:\n    backend: gdb\nStaticSessions:\n` +
					["server", "client"]
						.map(
							(name, index) =>
								`  - tag: ${name}\n    alias: ${name}\n    hash: ${name}\n    pid: ${
									9701 + index
								}\n    start_mode: binary\n    binary_path: ${binary}\n    stop_at_entry: true\n`,
						)
						.join(""),
			);
			await request("launch", {
				ddbpath: process.env.DDB_TEST_BINARY,
				configFilePath: config,
				cwd: directory,
				distributedStack: false,
			});
			await request("configurationDone");
			const until = async (predicate: () => boolean | Promise<boolean>) => {
				const deadline = Date.now() + 10000;
				while (!(await predicate())) {
					assert.ok(Date.now() < deadline);
					await delay(20);
				}
			};
			await until(
				() =>
					dap.events.filter((event) => event.event === "stopped").length >= 2,
			);
			const threads = (await request("threads")).threads;
			const server = threads.find((thread: any) =>
				thread.name.startsWith("server ("),
			);
			const client = threads.find((thread: any) =>
				thread.name.startsWith("client ("),
			);
			assert.ok(server && client, JSON.stringify(threads));
			const serverFrame = (await request("stackTrace", { threadId: server.id }))
				.stackFrames[0];
			const clientFrame = (await request("stackTrace", { threadId: client.id }))
				.stackFrames[0];
			const clientSession = (await request("ddb.getSessions")).sessions.find(
				(session: any) => session.alias.startsWith("client ("),
			);
			assert.ok(clientSession);
			await request("continue", {
				threadId: client.id,
				sessionId: clientSession.sid,
			});
			await until(
				async () =>
					!(await request("threads")).threads.some(
						(thread: any) => thread.id === client.id,
					),
			);
			assert.ok(!dap.events.some((event) => event.event === "terminated"));
			const scopes = (await request("scopes", { frameId: serverFrame.id }))
				.scopes;
			const locals = scopes.find((scope: any) => scope.name !== "Registers");
			assert.ok(locals);
			assert.ok(
				(
					await request("variables", {
						variablesReference: locals.variablesReference,
					})
				).variables.some((variable: any) => variable.name === "value"),
			);
			const expired = await dap.request("scopes", { frameId: clientFrame.id });
			assert.equal(expired.success, false);
			assert.match(expired.message ?? "", /expired/);
			assert.ok(
				dap.events.some(
					(event) =>
						event.event === "thread" &&
						event.body?.reason === "exited" &&
						event.body.threadId === client.id,
				),
			);
		} finally {
			await dap.request("disconnect");
			await rm(directory, { recursive: true, force: true });
		}
	});
});
