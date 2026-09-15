import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";

suite("Canonical source path substitution", function () {
	this.timeout(30000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	for (const spacedDirectory of [false, true]) test(`maps source paths with ${spacedDirectory ? "a spaced" : "a plain"} executable directory`, async () => {
		const directory = await mkdtemp(join(tmpdir(), spacedDirectory ? "ddb mapped source " : "ddb-mapped-source-"));
		const dap = new CanonicalHarness();
		const request = async (command: string, args: object = {}): Promise<any> => {
			const response = await dap.request(command, args);
			assert.equal(response.success, true, `${command}: ${response.message}`);
			return response.body;
		};
		const stopped = async (offset: number) => {
			const deadline = Date.now() + 10000;
			while (!dap.events.slice(offset).some(event => event.event === "stopped")) { assert.ok(Date.now() < deadline, "mapped program must stop"); await delay(20); }
		};
		try {
			const source = join(directory, "main file.c");
			const binary = join(directory, "program");
			const buildRoot = "/remote build/source";
			await writeFile(source, "int main(void) {\n int value = 1;\n value += 2;\n value += 3;\n value += 4;\n return value;\n}\n");
			execFileSync("cc", ["-g", "-O0", `-fdebug-prefix-map=${directory}=${buildRoot}`, source, "-o", binary]);
			const config = join(directory, "ddb.yaml");
			await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(directory, "base"))}\n  log_dir: ${JSON.stringify(join(directory, "logs"))}\n  Debugger:\n    backend: gdb\nStaticSessions:\n  - tag: mapped\n    alias: mapped\n    hash: mapped\n    pid: 4501\n    start_mode: binary\n    binary_path: ${JSON.stringify(binary)}\n    stop_at_entry: true\n`);
			await request("launch", { ddbpath: process.env.DDB_TEST_BINARY, configFilePath: config, cwd: directory, distributedStack: false, showDevDebugOutput: true, pathSubstitutions: { [buildRoot]: directory } });
			await request("configurationDone");
			await stopped(0);
			const threadId = (await request("threads")).threads[0].id;
			const initial = await request("stackTrace", { threadId });
			assert.equal(initial.stackFrames[0].source.path, source);
			const breakpoints = await request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: 4 }] });
			assert.equal(breakpoints.breakpoints[0].verified, true);
			let offset = dap.events.length;
			await request("continue", { threadId });
			await stopped(offset);
			const hit = (await request("stackTrace", { threadId })).stackFrames[0];
			assert.equal(hit.source.path, source);
			assert.equal(hit.line, 4);
			const targets = await request("gotoTargets", { source: { path: source }, line: 5 });
			offset = dap.events.length;
			await request("goto", { threadId, targetId: targets.targets[0].id });
			await stopped(offset);
			const destination = (await request("stackTrace", { threadId })).stackFrames[0];
			assert.equal(destination.source.path, source);
			assert.equal(destination.line, 5);
		} catch (error) {
			console.error(dap.events.filter(event => event.event === "output").map(event => event.body.output).join(""));
			throw error;
		} finally {
			await dap.request("disconnect");
			await rm(directory, { recursive: true, force: true });
		}
	});
});
