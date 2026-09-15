import assert from "node:assert/strict";
import type { DdbConnection } from "../../v2/connection.mjs";
import { DdbInspection } from "../../v2/inspection.mjs";

suite("Canonical source content", () => {
	test("preserves line boundaries between canonical source pages", async () => {
		const requests: any[] = [];
		const connection = { client: { call: async (method: string, args: any) => {
			assert.equal(method, "DebuggerService.ReadSource"); requests.push(args);
			return { source: { source: { contentHash: "same", mediaType: "text/plain" }, startLine: args.startLine, lineCount: args.startLine === 1 ? 2 : 1, content: args.startLine === 1 ? "first\nsecond" : "third", hasMore: args.startLine === 1 } };
		} } } as unknown as DdbConnection;
		const model = new DdbInspection(connection);
		const reference = model.source({ sourceReference: "opaque-source" })!.sourceReference!;
		assert.deepEqual(await model.readSource(reference), { content: "first\nsecond\nthird", mimeType: "text/plain" });
		assert.deepEqual(requests.map(request => request.startLine), [1, 3]);
		assert.ok(requests.every(request => request.sourceReference === "opaque-source"));
	});

	test("rejects source changes during pagination instead of mixing file versions", async () => {
		const connection = { client: { call: async (_method: string, args: any) => ({ source: { source: { contentHash: args.startLine === 1 ? "before" : "after" }, startLine: args.startLine, lineCount: 1, content: "line", hasMore: args.startLine === 1 } }) } } as unknown as DdbConnection;
		const model = new DdbInspection(connection);
		await assert.rejects(model.readSource(model.source({ sourceReference: "source" })!.sourceReference!), /changed while reading/);
	});
});
