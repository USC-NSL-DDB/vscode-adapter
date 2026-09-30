import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";

suite("Watch expressions across processes", function () {
	this.timeout(30000);
	for (const backend of ["gdb", "lldb"]) {
		test(`${backend}: a local unavailable in another process stays an inline evaluation failure`, async function () {
			if (!process.env.DDB_TEST_BINARY) this.skip();
			const directory = await mkdtemp(join(tmpdir(), "ddb-watch-"));
			const dap = new CanonicalHarness();
			const request = async (command: string, args: object = {}) => {
				const response = await dap.request(command, args);
				assert.equal(response.success, true, `${command}: ${response.message}`);
				return response.body;
			};
			try {
				for (const name of ["server", "caller"]) {
					const source = join(directory, `${name}.cpp`);
					await writeFile(
						source,
						`int main(int ${name}_local, char **) { return ${name}_local; }\n`,
					);
					execFileSync("c++", [
						"-g",
						"-O0",
						source,
						"-o",
						join(directory, name),
					]);
				}
				const config = join(directory, "ddb.yaml");
				await writeFile(
					config,
					`Framework: unspecified
Conf:
  auto_shutdown: false
  on_exit: kill
  base_dir: ${directory}/base
  log_dir: ${directory}/logs
  Debugger:
    backend: ${backend}
StaticSessions:
${["server", "caller"]
	.map(
		(name, index) => `  - tag: ${name}
    alias: ${name}
    hash: ${name}
    pid: ${4501 + index}
    start_mode: binary
    binary_path: ${directory}/${name}
    stop_at_entry: true`,
	)
	.join("\n")}
`,
				);
				await request("launch", {
					ddbpath: process.env.DDB_TEST_BINARY,
					configFilePath: config,
					cwd: directory,
					distributedStack: false,
					// Keep native startup independent of external symbol-server latency.
					env: { DEBUGINFOD_URLS: "" },
				});
				await request("configurationDone");
				const deadline = Date.now() + 10000;
				let frames: any[] = [];
				while (
					frames.filter((frame) =>
						["server.cpp", "caller.cpp"].some(
							(name) => frame.source?.path === join(directory, name),
						),
					).length < 2
				) {
					assert.ok(
						Date.now() < deadline,
						`both processes must expose their stopped source frame: ${JSON.stringify(frames.map((frame) => ({ name: frame.name, source: frame.source })))}`,
					);
					frames = [];
					for (const thread of (await request("threads")).threads) {
						const stack = await dap.request("stackTrace", {
							threadId: thread.id,
						});
						if (stack.success) frames.push(...stack.body.stackFrames);
					}
					await delay(20);
				}
				const server = frames.find(
					(frame) => frame.source?.path === join(directory, "server.cpp"),
				);
				const caller = frames.find(
					(frame) => frame.source?.path === join(directory, "caller.cpp"),
				);
				assert.ok(server && caller, "both source frames must be available");
				const watch = { expression: "server_local", context: "watch" };
				assert.equal(
					(await request("evaluate", { ...watch, frameId: server.id })).result,
					"1",
				);
				for (const context of ["watch", "hover"]) {
					const unavailable = await dap.request("evaluate", {
						...watch,
						context,
						frameId: caller.id,
					});
					assert.equal(unavailable.success, false);
					assert.equal(
						unavailable.message,
						"Cannot evaluate this expression in the selected frame",
					);
					assert.equal(unavailable.body.error.showUser, false);
				}
				assert.equal(
					(await request("evaluate", { ...watch, frameId: server.id })).result,
					"1",
					"returning to the owning frame restores the watch",
				);
				assert.equal(
					(
						await request("evaluate", {
							expression: "caller_local",
							context: "watch",
							frameId: caller.id,
						})
					).result,
					"1",
				);
			} finally {
				await dap.request("disconnect", {}).catch(() => {});
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
});
