import assert from "node:assert/strict";
import { DdbInspection } from "../../v2/inspection.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";
import { DdbState } from "../../v2/state.mjs";
import { setImmediate } from "node:timers/promises";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";

suite("Manual greeter regressions", () => {
	test("stack presentation defers remote source retrieval until the frame is opened", async () => {
		const calls: string[] = [];
		const connection = {
			state: { get: () => ({ sessionId: "session" }) },
			client: {
				collect: async () => [{ frameId: "frame", location: { path: "/missing-greeter/source.c", line: 44 } }],
				call: async (method: string) => { calls.push(method); throw new Error("Source unavailable"); },
			},
		} as unknown as DdbConnection;
		const model = new DdbInspection(connection);
		const stack = await model.stack({ threadId: model.threadHandle("thread") });
		assert.deepEqual(calls, [], "a slow remote source lookup must not hold up the call stack");
		assert.ok(stack!.stackFrames[0].source!.sourceReference! > 0);
		await assert.rejects(model.readSource(stack!.stackFrames[0].source!.sourceReference!), /Source unavailable/);
	});

	test("VS Code source fallback with reference zero reports an unavailable file, not an expired handle", async () => {
		const dap = new CanonicalHarness();
		Object.assign(dap, { inspection: new DdbInspection({} as DdbConnection) });
		const result = await dap.request("source", { sourceReference: 0, source: { path: "./nptl/pthread_kill.c" } });
		assert.equal(result.success, false);
		assert.match(result.message ?? "", /source.*(unavailable|not available)/i);
		assert.doesNotMatch(result.message ?? "", /expired.*handle/i);
	});
	test("distributed traversal may stop its caller without expiring the new caller frames", async () => {
		let model: DdbInspection;
		const connection = {
			state: { get: (_kind: string, id: string) => ({ sessionId: id + "-session" }) },
			client: {
				call: async () => {
					model.invalidate("caller"); // The backend interrupts the caller to unwind it.
					return { distributedBacktrace: { frames: [
						{ frame: { frameId: "server-frame" }, threadId: "server", sessionId: "server-session" },
						{ frame: { frameId: "caller-frame" }, threadId: "caller", sessionId: "caller-session" },
					] } };
				},
				collect: async () => [{ scopeId: "scope", name: "Locals" }],
			},
			complete: async (value: unknown) => value,
		} as unknown as DdbConnection;
		model = new DdbInspection(connection);
		const stack = await model.stack({ threadId: model.threadHandle("server") }, true);
		assert.equal(stack!.stackFrames.length, 2);
		assert.ok((await model.scopes(stack!.stackFrames[1].id))!.scopes.length);
	});

	test("all-stop peers are paused and only one concurrent breakpoint takes focus", async () => {
		const state = new DdbState();
		const snapshot = {
			serverInstanceId: "server", stateEventCursor: { serverInstanceId: "server" },
			threads: ["peer", "owner", "other"].map(id => ({ threadId: id, sessionId: id === "other" ? "other-session" : "session", state: "THREAD_STATE_STOPPED" as const, location: { path: "/project/handler.cc", line: 59 } })),
			executionStates: ["peer", "owner", "other"].map(id => ({ executionStateId: id, target: { thread: { threadId: id } }, revision: "1", stopReason: { kind: "STOP_REASON_KIND_BREAKPOINT" as const, threadId: id === "peer" ? "owner" : id, breakpointId: "breakpoint" } })),
		};
		const connection = {
			state,
			async *states() { state.hydrate(snapshot); yield { type: "snapshot", snapshot }; },
			client: { async *subscribeOutput() {} },
		} as unknown as DdbConnection;
		const dap = new CanonicalHarness();
		await dap.begin(connection);
		await setImmediate();
		const stops = dap.events.filter(event => event.event === "stopped");
		assert.deepEqual(stops.map(event => event.body.reason), ["breakpoint", "breakpoint"]);
		assert.equal(stops.length, 2, "all-stop peers must not interrupt VS Code frame selection with redundant stop events");
		assert.equal(stops.filter(event => !event.body.preserveFocusHint).length, 1);
		const threads = (await dap.request("threads")).body.threads;
		assert.match(threads[0].name, /breakpoint at handler.cc:59/);
		assert.match(threads[1].name, /breakpoint at handler.cc:59/);
		assert.doesNotMatch(threads[2].name, /breakpoint/);
	});

});
