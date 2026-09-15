import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DdbConnection } from "../../v2/connection.mjs";

async function until(predicate: () => boolean, detail: string) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${detail}`);
		await delay(20);
	}
}

suite("Canonical DDB binary", function () {
	this.timeout(30000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	for (const backend of ["mock", "gdb"] as const) {
		test(`${backend}: authenticated managed startup, snapshots, typed inspection and operations`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "ddb-v2-test-"));
			let connection: DdbConnection | undefined;
			let pump: Promise<void> | undefined;
			let streamError: unknown;
			const output: string[] = [];
			try {
				const source = join(dir, "main.c");
				const executable = join(dir, "main");
				await writeFile(source, '#include <unistd.h>\nint main(void) {\n int counter = 42;\n while (counter) {\n  sleep(1);\n  counter--;\n }\n return 0;\n}\n');
				if (backend === "gdb") execFileSync("cc", ["-g", "-O0", source, "-o", executable]);
				const config = join(dir, "ddb.yaml");
				const sessions = [1, 2].map(id => `  - tag: session-${id}\n    alias: session-${id}\n    hash: group-${id}\n    pid: ${4400 + id}\n` + (backend === "mock"
					? `    mock:\n      source_file: ${JSON.stringify(source)}\n      source_line: 4\n      function: main\n`
					: `    start_mode: binary\n    binary_path: ${JSON.stringify(executable)}\n    stop_at_entry: true\n`)).join("");
				await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(dir, "base"))}\n  log_dir: ${JSON.stringify(join(dir, "logs"))}\n  Debugger:\n    backend: ${backend}\nStaticSessions:\n${sessions}`);
				connection = await DdbConnection.launch({ binary: process.env.DDB_TEST_BINARY!, configFilePath: config, cwd: dir, onOutput: (_category, text) => output.push(text) });
				const c = connection;
				assert.equal(c.handshake.capabilities.apiVersion, "v2");
				pump = (async () => { for await (const _item of c.states()) { /* Apply all changes in the connection. */ } })().catch(error => { if (!c.client.closed) streamError = error; });
				await until(() => c.state.all("thread").filter(thread => thread.state === "THREAD_STATE_STOPPED").length === 2 || streamError !== undefined, "both stopped threads from canonical state");
				if (streamError) throw streamError;
				assert.equal(c.state.all("session").length, 2);
				assert.equal(c.state.all("group").length, 2);
				const thread = c.state.all("thread")[0];
				const target = { thread: { threadId: thread.threadId } };
				await c.complete(await c.client.call("DebuggerControlService.SelectThread", { target }));
				const frames = await c.client.collect("DebuggerService.ListFrames", { threadId: thread.threadId });
				assert.ok(frames.length > 0);
				assert.equal(frames[0].location?.path, source);
				const scopes = await c.client.collect("DebuggerService.ListScopes", { frameId: frames[0].frameId });
				assert.ok(scopes.length > 0);
				await c.client.collect("DebuggerService.ListVariables", { scopeId: scopes[0].scopeId });
				const evaluation = await c.complete(await c.client.call("DebuggerControlService.Evaluate", { target, frameId: frames[0].frameId, expression: "1 + 2", evaluationContext: "EVALUATION_CONTEXT_WATCH" }));
				assert.ok(evaluation.evaluation?.value !== undefined);
				if (backend === "gdb") assert.equal(evaluation.evaluation.value, "3");
				const breakpoint = await c.complete(await c.client.call("DebuggerControlService.CreateBreakpoint", { target: { multiple: { targets: c.state.all("group").map(group => ({ group: { groupId: group.groupId } })) } }, breakpoint: { source: { source, line: 5 }, enabled: true } }));
				assert.ok(breakpoint.breakpoint?.breakpointId);
				await until(() => c.state.all("breakpoint").length === 1 || streamError !== undefined, "breakpoint stream upsert");
				if (streamError) throw streamError;
				await c.complete(await c.client.call("DebuggerControlService.DeleteBreakpoint", { target: { broadcast: {} }, breakpointId: breakpoint.breakpoint.breakpointId }));
				await until(() => c.state.all("breakpoint").length === 0 || streamError !== undefined, "breakpoint stream deletion");
				if (streamError) throw streamError;
				const beforeStep = BigInt(c.state.get("thread", thread.threadId!)?.revision ?? "0");
				await c.complete(await c.client.call("DebuggerControlService.Execute", { target, action: "EXECUTION_ACTION_NEXT" }));
				await until(() => (c.state.get("thread", thread.threadId!)?.state === "THREAD_STATE_STOPPED" && BigInt(c.state.get("thread", thread.threadId!)?.revision ?? "0") > beforeStep) || streamError !== undefined, "step stop");
				if (streamError) throw streamError;
			} catch (error) {
				console.error(output.join(""));
				if (error && typeof error === "object" && "operation" in error) console.error(JSON.stringify(error.operation, null, 2));
				throw error;
			} finally {
				await connection?.close();
				await pump;
				await rm(dir, { recursive: true, force: true });
			}
		});
	}
});
