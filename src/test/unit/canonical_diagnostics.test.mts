import assert from "node:assert/strict";
import { diagnosticFetch } from "../../v2/diagnostics.mjs";

suite("Canonical request diagnostics", () => {
	test("preserves authenticated requests and streaming responses without logging payloads", async () => {
		const logs: string[] = [];
		const response = new Response("stream content");
		const input = "http://localhost/v2/DebuggerService/ListFrames?token=private-query";
		const init = { method: "POST", headers: { Authorization: "Bearer private-token" }, body: "private-expression" };
		const fetch = diagnosticFetch(text => logs.push(text), async (actual, options) => {
			assert.equal(actual, input); assert.equal(options, init); return response;
		});
		assert.equal(await fetch(input, init), response);
		assert.equal(response.bodyUsed, false);
		assert.deepEqual(logs, ["[DDB API] 1 POST /v2/DebuggerService/ListFrames\n", "[DDB API] 1 POST /v2/DebuggerService/ListFrames -> 200\n"]);
	});
	test("preserves transport errors without printing their potentially sensitive messages", async () => {
		const logs: string[] = [];
		const error = new Error("private-token");
		const fetch = diagnosticFetch(text => logs.push(text), async () => { throw error; });
		await assert.rejects(fetch(new Request("http://localhost/v2/test", { method: "POST" })), thrown => thrown === error);
		assert.equal(logs.at(-1), "[DDB API] 1 POST /v2/test -> transport failed\n");
		assert.ok(!logs.join("").includes("private-token"));
	});
});
