import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";

suite("Canonical C++ inspection", function () {
	this.timeout(30000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	test("pretty printers, nested/paged expansion and caller-frame evaluation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ddb-cpp-"));
		const dap = new CanonicalHarness();
		const request = async (command: string, args: object = {}): Promise<any> => {
			const response = await dap.request(command, args);
			assert.equal(response.success, true, `${command}: ${response.message}`);
			return response.body;
		};
		const until = async (predicate: () => boolean) => {
			const deadline = Date.now() + 10000;
			while (!predicate()) { assert.ok(Date.now() < deadline, "expected debugger stop"); await delay(20); }
		};
		try {
			const source = join(directory, "main.cpp");
			const binary = join(directory, "main");
			await writeFile(source, '#include <vector>\n#include <string>\n__attribute__((noinline)) int inner(int marker) { return marker + 1; }\nint main() {\n int marker = 17;\n std::vector<int> values{3, 5, 8};\n std::string label = "caller text";\n std::vector<std::vector<int>> matrix{{1, 2}, {7, 9}, {}};\n int result = inner(99);\n return result + marker + values[0] + label.size();\n}\n');
			execFileSync("c++", ["-g", "-O0", source, "-o", binary]);
			const config = join(directory, "ddb.yaml");
			await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(directory, "base"))}\n  log_dir: ${JSON.stringify(join(directory, "logs"))}\n  Debugger:\n    backend: gdb\nStaticSessions:\n  - tag: cpp\n    alias: cpp\n    hash: cpp\n    pid: 4501\n    start_mode: binary\n    binary_path: ${JSON.stringify(binary)}\n    stop_at_entry: true\n`);
			await request("launch", { ddbpath: process.env.DDB_TEST_BINARY, configFilePath: config, cwd: directory, distributedStack: false });
			await request("configurationDone");
			await until(() => dap.events.some(event => event.event === "stopped"));
			const threadId = (await request("threads")).threads[0].id;
			await request("setFunctionBreakpoints", { breakpoints: [{ name: "inner" }] });
			const offset = dap.events.length;
			await request("continue", { threadId });
			await until(() => dap.events.slice(offset).some(event => event.event === "stopped"));
			const frames = (await request("stackTrace", { threadId })).stackFrames;
			assert.match(frames[0].name, /inner/);
			const caller = frames.find((frame: any) => frame.name === "main");
			assert.ok(caller, "caller frame must be present");
			assert.equal((await request("evaluate", { frameId: frames[0].id, expression: "marker", context: "watch" })).result, "99");
			assert.equal((await request("evaluate", { frameId: caller.id, expression: "marker", context: "watch" })).result, "17");
			const label = await request("evaluate", { frameId: caller.id, expression: "label", context: "watch" });
			assert.match(label.result, /caller text/);
			assert.equal(label.variablesReference, 0, "pretty-printed strings are leaves");
			const vector = await request("evaluate", { frameId: caller.id, expression: "values", context: "watch" });
			assert.ok(vector.variablesReference > 0);
			const page = (await request("variables", { variablesReference: vector.variablesReference, start: 1, count: 2 })).variables;
			assert.deepEqual(page.map((value: any) => value.value), ["5", "8"]);
			await request("setVariable", { variablesReference: vector.variablesReference, name: page[0].name, value: "13" });
			const changed = (await request("variables", { variablesReference: vector.variablesReference, start: 0, count: 3 })).variables;
			assert.deepEqual(changed.map((value: any) => value.value), ["3", "13", "8"]);
			const scopes = (await request("scopes", { frameId: caller.id })).scopes;
			const locals: any[] = [];
			for (const scope of scopes.filter((scope: any) => scope.name !== "Registers")) {
				locals.push(...(await request("variables", { variablesReference: scope.variablesReference })).variables);
			}
			const localVector = locals.find(value => value.name === "values");
			assert.ok(localVector?.variablesReference > 0, "scope vector must be expandable");
			assert.deepEqual((await request("variables", { variablesReference: localVector.variablesReference })).variables.map((value: any) => value.value), ["3", "13", "8"]);
			const matrix = await request("evaluate", { frameId: caller.id, expression: "matrix", context: "watch" });
			const rows = (await request("variables", { variablesReference: matrix.variablesReference })).variables;
			assert.equal(rows.length, 3);
			assert.deepEqual((await request("variables", { variablesReference: rows[2].variablesReference })).variables, [], "empty dynamic containers must expand cleanly");
			assert.ok(rows[1].variablesReference > 0, "nested vector must be expandable");
			const cells = (await request("variables", { variablesReference: rows[1].variablesReference })).variables;
			assert.deepEqual(cells.map((value: any) => value.value), ["7", "9"]);
			await request("setVariable", { variablesReference: rows[1].variablesReference, name: cells[0].name, value: "11" });
			assert.deepEqual((await request("variables", { variablesReference: rows[1].variablesReference })).variables.map((value: any) => value.value), ["11", "9"]);
		} finally {
			await dap.request("disconnect");
			await rm(directory, { recursive: true, force: true });
		}
	});
});
