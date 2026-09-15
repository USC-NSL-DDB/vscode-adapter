import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";

suite("Canonical distributed stack", function () {
	this.timeout(30000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	test("cross-session backtrace preserves boundary rows and frame ownership", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ddb-distributed-"));
		const dap = new CanonicalHarness();
		const request = async (command: string, args: object = {}): Promise<any> => {
			const result = await dap.request(command, args);
			assert.equal(result.success, true, `${command}: ${result.message}`);
			return result.body;
		};
		try {
			const source = join(directory, "source.c");
			await writeFile(source, "// distributed source\n".repeat(20));
			const config = join(directory, "ddb.yaml");
			const sessions = [1, 2].map(index => `  - tag: "127.0.0.1:-${1800 + index}"\n    alias: ${index === 1 ? "child" : "parent"}\n    hash: group-${index}\n    pid: ${1800 + index}\n    mock:\n      source_file: ${JSON.stringify(source)}\n      stack_frames:\n        - function: ${index === 1 ? "child_leaf" : "parent_handler"}\n          file: ${JSON.stringify(source)}\n          line: 9\n        - function: ${index === 1 ? "child_dispatch" : "parent_root"}\n          file: ${JSON.stringify(source)}\n          line: 10\n${index === 1 ? "      dbt_parent:\n        ip: 127.0.0.1\n        pid: 1802\n        tid: 1\n        caller_ctx:\n          pc: 5246976\n          sp: 2147426304\n          fp: 2147430400\n" : ""}`).join("");
			await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(directory, "base"))}\n  log_dir: ${JSON.stringify(join(directory, "logs"))}\n  Debugger:\n    backend: mock\nStaticSessions:\n${sessions}`);
			await request("launch", { ddbpath: process.env.DDB_TEST_BINARY, configFilePath: config, cwd: directory, distributedStack: true });
			await request("configurationDone");
			const deadline = Date.now() + 10000;
			while (dap.events.filter(event => event.event === "stopped").length < 2) { assert.ok(Date.now() < deadline); await delay(20); }
			const threads = (await request("threads")).threads;
			const child = threads.find((thread: any) => thread.name.includes("child") || thread.name.includes("1801"));
			assert.ok(child, JSON.stringify(threads));
			const stack = await request("stackTrace", { threadId: child.id });
			assert.ok(stack.stackFrames.some((frame: any) => frame.name.includes("child_leaf")));
			const parent = stack.stackFrames.find((frame: any) => frame.name.includes("parent_handler"));
			assert.ok(parent, "distributed stack must reach the parent session");
			const boundary = stack.stackFrames.find((frame: any) => frame.name.includes("distributed call boundary"));
			assert.ok(boundary, "distributed boundary must be visible");
			assert.equal(boundary.presentationHint, "label");
			assert.deepEqual((await request("scopes", { frameId: boundary.id })).scopes, []);
			for (const context of ["watch", "repl"]) {
				const result = await dap.request("evaluate", { frameId: boundary.id, expression: "1", context });
				assert.equal(result.success, false);
				assert.match(result.message ?? "", /executable stack frame/);
			}
			const metadata = await request("ddb.frameMetadata", { frameId: parent.id });
			assert.notEqual(metadata.thread_id, child.id);
			await request("ddb.selectThread", { threadId: metadata.thread_id });
			const scopes = (await request("scopes", { frameId: parent.id })).scopes;
			assert.ok(scopes.length > 0);
			for (const scope of scopes) await request("variables", { variablesReference: scope.variablesReference });
			const page = await request("stackTrace", { threadId: child.id, startFrame: 1, levels: 2 });
			assert.equal(page.totalFrames, stack.totalFrames);
			assert.deepEqual(page.stackFrames.map((frame: any) => frame.name), stack.stackFrames.slice(1, 3).map((frame: any) => frame.name));
		} finally {
			await dap.request("disconnect");
			await rm(directory, { recursive: true, force: true });
		}
	});
});
