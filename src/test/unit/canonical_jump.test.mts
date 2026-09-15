import assert from "node:assert/strict";
import type { ExecuteRequest } from "@ddb-debugger/api-client";
import type { DdbInspection } from "../../v2/inspection.mjs";
import { DdbJump } from "../../v2/jump.mjs";
import { Handles } from "../../v2/handles.mjs";

function fixture(verified = true) {
	const calls: { method: string; args: any }[] = [];
	const threadHandles = new Handles<string>();
	const threadId = threadHandles.put("opaque-thread");
	const model = {
		threadHandles,
		connection: {
			state: { get: () => ({ sessionId: "opaque-session", state: "THREAD_STATE_STOPPED" }) },
			handshake: { capabilities: { executionActions: ["EXECUTION_ACTION_JUMP"] } },
			client: { call: async (method: string, args: any) => { calls.push({ method, args }); return { breakpoint: { breakpointId: "temporary", verified } }; } },
			complete: async (result: unknown) => result,
		},
	} as unknown as DdbInspection;
	const jump = new DdbJump(model);
	const [target] = jump.list({ source: { path: "/source with spaces/main.c" }, line: 12 });
	return { jump, calls, args: { threadId, targetId: target.id } };
}

suite("Canonical jump", () => {
	test("installs a temporary session breakpoint and jumps the selected thread", async () => {
		const { jump, calls, args } = fixture();
		let execution: ExecuteRequest | undefined;
		await jump.run(args, async request => { execution = request; });
		assert.deepEqual(calls, [{ method: "DebuggerControlService.CreateBreakpoint", args: {
			target: { session: { sessionId: "opaque-session" } },
			breakpoint: { source: { source: "/source with spaces/main.c", line: 12 }, temporary: true, enabled: true },
		} }]);
		assert.deepEqual(execution, { target: { thread: { threadId: "opaque-thread" } }, action: "EXECUTION_ACTION_JUMP", jumpLocation: { path: "/source with spaces/main.c", line: 12 } });
	});

	test("cleans up a temporary breakpoint if execution fails", async () => {
		const { jump, calls, args } = fixture();
		await assert.rejects(jump.run(args, async () => { throw new Error("jump rejected"); }), /jump rejected/);
		assert.deepEqual(calls[1], { method: "DebuggerControlService.DeleteBreakpoint", args: { target: { session: { sessionId: "opaque-session" } }, breakpointId: "temporary" } });
	});

	test("never resumes for an unresolved destination and cleans up its breakpoint", async () => {
		const { jump, calls, args } = fixture(false);
		await assert.rejects(jump.run(args, async () => { assert.fail("must not execute"); }), /could not resolve/);
		assert.equal(calls[1].method, "DebuggerControlService.DeleteBreakpoint");
	});

	test("rejects invalid destinations and handles before creating breakpoints", async () => {
		const { jump, calls, args } = fixture();
		assert.throws(() => jump.list({ source: {}, line: 12 }), /source path/);
		assert.throws(() => jump.list({ source: { path: "/main.c" }, line: 0 }), /positive source line/);
		await assert.rejects(jump.run({ ...args, targetId: -1 }, async () => {}), /Unknown or expired/);
		await assert.rejects(jump.run({ ...args, threadId: -1 }, async () => {}), /Unknown or expired/);
		assert.deepEqual(calls, []);
	});
});
