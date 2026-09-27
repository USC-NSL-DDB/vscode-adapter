import assert from "node:assert/strict";
import { DdbApiError } from "@ddb-debugger/api-client";
import { DdbInspection } from "../../v2/inspection.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";

suite("Frame inspection error presentation", () => {
	for (const [command, args] of [
		["source", { sourceReference: 0, source: { path: "/missing/library.c" } }],
		["evaluate", { expression: "local_from_another_frame", context: "watch" }],
		["evaluate", { expression: "local_from_another_frame", context: "hover" }],
		["scopes", { frameId: 123 }],
		["variables", { variablesReference: 123 }],
	] as const) {
		test(`${command} ${"context" in args ? args.context : ""} failures stay in their view without a popup`, async () => {
			const dap = new CanonicalHarness();
			const inspection = new DdbInspection({ client: { call: async () => { throw new Error("debugger rejected command for target"); } } } as unknown as DdbConnection);
			Object.assign(dap, { inspection });
			const response = await dap.request(command, args);
			assert.equal(response.success, false, "a failure must not be reported as successful empty data");
			assert.ok(response.message);
			assert.equal(response.body.error.showUser, false, "automatic inspection failures must not produce popup errors");
		});
	}
	test("unavailable remote source reports its path and recovery guidance", async () => {
		const inspection = new DdbInspection({ state: { get: () => ({ sessionId: "session" }) }, client: {
			collect: async () => [{ frameId: "frame", location: { path: "/build/missing/library.c", line: 42 } }],
			call: async () => { throw new DdbApiError(404, { code: "DDB_ERROR_CODE_NOT_FOUND", message: "source was not found" }); },
		} } as unknown as DdbConnection);
		const dap = new CanonicalHarness();
		Object.assign(dap, { inspection });
		const frame = (await inspection.stack({ threadId: inspection.threadHandle("thread") })).stackFrames[0];
		const response = await dap.request("source", { sourceReference: frame.source!.sourceReference, source: frame.source });
		assert.equal(response.success, false);
		assert.match(response.message ?? "", /\/build\/missing\/library.c/);
		assert.match(response.message ?? "", /pathSubstitutions/);
		assert.equal(response.body.error.showUser, false);
	});
	test("an explicit console command failure remains visible", async () => {
		const dap = new CanonicalHarness();
		Object.assign(dap, { commands: { run: async () => { throw new Error("invalid console command"); } } });
		const response = await dap.request("evaluate", { expression: "bad-command", context: "repl" });
		assert.equal(response.success, false);
		assert.equal(response.body.error.showUser, true);
	});
});
