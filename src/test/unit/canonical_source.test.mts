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
	test("stack frames resolve inaccessible paths and expose readable source references", async () => {
		const calls: any[] = [];
		const path = "/ddb-remote-source-fixture/main.c";
		const connection = {
			state: { get: () => ({ sessionId: "session" }) },
			client: {
				collect: async () => [0, 1].map(level => ({ frameId: `frame-${level}`, functionName: "main", location: { path, line: 2 } })),
				call: async (method: string, args: any) => {
					calls.push({ method, args });
					if (method === "DebuggerService.ResolveSource") return { source: { sourceReference: "remote-source", path } };
					assert.equal(method, "DebuggerService.ReadSource");
					return { source: { startLine: 1, lineCount: 2, content: "first\nsecond", hasMore: false } };
				},
			},
		} as unknown as DdbConnection;
		const model = new DdbInspection(connection);
		const stack = await model.stack({ threadId: model.threadHandle("thread") });
		const source = stack!.stackFrames[0].source!;
		assert.ok(source.sourceReference! > 0, "remote stack source must be retrievable");
		assert.equal(source.path, path);
		assert.equal(stack!.stackFrames[1].source!.sourceReference, source.sourceReference);
		assert.deepEqual(calls, [], "stack rendering must not wait for source retrieval");
		assert.equal((await model.readSource(source.sourceReference!))!.content, "first\nsecond");
	});

	test("keeps local navigation and retains frames when remote source is unavailable", async () => {
		for (const local of [true, false]) {
			const path = local ? `${process.cwd()}/package.json` : "/ddb-unavailable-source-fixture/main.c";
			let calls = 0;
			const connection = { state: { get: () => ({ sessionId: "session" }) }, client: {
				collect: async () => [{ frameId: "frame", functionName: "main", location: { path, line: 2 } }],
				call: async () => { calls++; throw new Error("source unavailable"); },
			} } as unknown as DdbConnection;
			const model = new DdbInspection(connection);
			const stack = await model.stack({ threadId: model.threadHandle("thread") });
			assert.equal(stack!.stackFrames.length, 1);
			assert.equal(stack!.stackFrames[0].source!.path, path);
			assert.equal(stack!.stackFrames[0].source!.sourceReference! > 0, !local);
			assert.equal(calls, 0);
		}
	});

});
