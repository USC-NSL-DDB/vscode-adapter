import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

suite("Canonical adapter entrypoint", function () {
	this.timeout(40000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	for (const backend of ["mock", "gdb"] as const) test(`${backend}: stdio launch, sidebar, distributed stack and disconnect`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "ddb-stdio-test-"));
		const config = join(directory, "ddb.yaml");
		const executable = join(directory, "main");
		if (backend === "gdb") {
			await writeFile(join(directory, "main.c"), "int main(void) { int value = 1; return value; }\n");
			execFileSync("cc", ["-g", "-O0", join(directory, "main.c"), "-o", executable]);
		}
		await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(directory, "base"))}\n  log_dir: ${JSON.stringify(join(directory, "logs"))}\n  Debugger:\n    backend: ${backend}\nStaticSessions:\n  - tag: stdio\n    alias: stdio\n    hash: stdio-group\n    pid: 4501\n${backend === "gdb" ? `    start_mode: binary\n    binary_path: ${JSON.stringify(executable)}\n    stop_at_entry: true\n` : ""}`);
		const child = spawn(process.execPath, [fileURLToPath(new URL("../../gdb.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], detached: true });
		let sequence = 0;
		let buffer = Buffer.alloc(0);
		let stderr = "";
		let protocolError: Error | undefined;
		const pending = new Map<number, (value: any) => void>();
		const events: string[] = [];
		const output: string[] = [];
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		child.stdout.on("data", chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const match = /^Content-Length: (\d+)\r\n\r\n$/.exec(buffer.subarray(0, end + 4).toString());
				if (!match) { protocolError = new Error("Adapter wrote non-DAP data to stdout"); return; }
				const size = Number(match[1]);
				if (buffer.length < end + 4 + size) return;
				const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
				buffer = buffer.subarray(end + 4 + size);
				if (message.type === "response") { pending.get(message.request_seq)?.(message); pending.delete(message.request_seq); }
				else if (message.type === "event") { events.push(message.event); if (message.event === "output") output.push(message.body.output); }
			}
		});
		const request = (command: string, args = {}): Promise<any> => new Promise((resolve, reject) => {
			const seq = ++sequence;
			const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`${command} timed out: ${protocolError ?? stderr}`)); }, 15000);
			pending.set(seq, response => { clearTimeout(timer); resolve(response); });
			const body = JSON.stringify({ seq, type: "request", command, arguments: args });
			child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		});
		try {
			assert.equal((await request("initialize", { adapterID: "ddb", pathFormat: "path", linesStartAt1: true, columnsStartAt1: true })).success, true);
			const launched = await request("launch", { ddbpath: process.env.DDB_TEST_BINARY, configFilePath: config, cwd: directory, debugger_args: ["--console-level", "warn"], autorun: backend === "gdb" ? ["set print elements 33"] : [], pathSubstitutions: backend === "gdb" ? { "/old build path": "/new source path" } : {} });
			assert.equal(launched.success, true, launched.message);
			assert.ok(events.includes("initialized"));
			assert.equal((await request("configurationDone")).success, true);
			let threads = await request("threads");
			for (let attempt = 0; threads.body.threads.length === 0 && attempt < 100; attempt++) { await delay(20); threads = await request("threads"); }
			assert.equal(threads.body.threads.length, 1);
			for (let attempt = 0; !events.includes("stopped") && attempt < 100; attempt++) await delay(20);
			assert.ok(events.includes("stopped"), `Missing stop event; events=${events.join(",")}; output=${output.join("")}`);
			const stack = await request("stackTrace", { threadId: threads.body.threads[0].id });
			assert.equal(stack.success, true, stack.message);
			assert.ok(stack.body.stackFrames.length > 0);
			const groups = await request("ddb.getGroups");
			assert.equal(groups.success, true, groups.message);
			assert.equal(groups.body.groups.length, 1);
			assert.equal((await request("ddb.status")).body.status, "up");
			if (backend === "gdb") {
				const shown = await request("evaluate", { expression: "show print elements", context: "repl", frameId: stack.body.stackFrames[0].id });
				assert.equal(shown.success, true, shown.message);
				for (let attempt = 0; !output.some(line => /33/.test(line)) && attempt < 100; attempt++) await delay(20);
				assert.ok(output.some(line => /33/.test(line)), output.join(""));
				const substitutions = await request("evaluate", { expression: "show substitute-path", context: "repl", frameId: stack.body.stackFrames[0].id });
				assert.equal(substitutions.success, true, substitutions.message);
				for (let attempt = 0; !output.some(line => line.includes("/old build path")) && attempt < 100; attempt++) await delay(20);
				assert.ok(output.some(line => line.includes("/old build path") && line.includes("/new source path")), output.join(""));
			}
			const disconnected = await request("disconnect");
			assert.equal(disconnected.success, true, disconnected.message);
			assert.equal(protocolError, undefined);
		} finally {
			if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } }
			await rm(directory, { recursive: true, force: true });
		}
	});
});
