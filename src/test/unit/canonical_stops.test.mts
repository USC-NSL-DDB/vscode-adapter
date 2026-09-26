import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { ExecutionState, Snapshot, StateSyncItem } from "@ddb-debugger/api-client";
import { DdbState } from "../../v2/state.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";

suite("Canonical DAP stop events", () => {
	test("waits for execution details and detects stops across coalesced running updates", async () => {
		const state = new DdbState();
		const queue: (Snapshot | null)[] = [];
		let wake: (() => void) | undefined;
		const publish = async (snapshot: Snapshot | null) => { queue.push(snapshot); wake?.(); await setImmediate(); };
		const connection = {
			state,
			async *states(): AsyncGenerator<StateSyncItem> {
				while (true) {
					if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
					const snapshot = queue.shift();
					if (!snapshot) return;
					state.hydrate(snapshot);
					yield { type: "snapshot", snapshot };
				}
			},
			client: { async *subscribeOutput() {} },
			close: async () => { await publish(null); },
		} as unknown as DdbConnection;
		let execution: ExecutionState = { executionStateId: "opaque-execution", target: { thread: { threadId: "opaque-thread" } }, revision: "1", stopReason: { kind: "STOP_REASON_KIND_ENTRY" } };
		const snapshot = (running = false): Snapshot => ({
			serverInstanceId: "server", stateEventCursor: { serverInstanceId: "server" },
			threads: [{ threadId: "opaque-thread", sessionId: "opaque-session", state: running ? "THREAD_STATE_RUNNING" : "THREAD_STATE_STOPPED" }],
			executionStates: [execution],
		});
		queue.push(snapshot());
		const dap = new CanonicalHarness();
		try {
			await dap.begin(connection);
			await setImmediate();
			const stops = () => dap.events.filter(event => event.event === "stopped");
			assert.deepEqual(stops().map(event => event.body.reason), ["entry"]);
			await publish(snapshot(true));
			await publish(snapshot()); // Thread stop arrives before the execution resource.
			assert.equal(stops().length, 1, "must not emit a stop with the previous reason");
			execution = { ...execution, revision: "2", stopReason: { kind: "STOP_REASON_KIND_STEP" } };
			await publish(snapshot());
			assert.deepEqual(stops().map(event => event.body.reason), ["entry", "step"]);
			// A snapshot after replay loss may contain a newer stop without a running update.
			execution = { ...execution, revision: "3", stopReason: { kind: "STOP_REASON_KIND_SIGNAL", signalName: "SIGUSR1" } };
			await publish(snapshot());
			assert.equal(stops()[2].body.reason, "exception");
			assert.equal(stops()[2].body.text, "SIGUSR1");
			await publish(snapshot());
			assert.equal(stops().length, 3, "snapshot replay must not duplicate stops");
			execution = { ...execution, revision: "4", stopReason: { kind: "STOP_REASON_KIND_BREAKPOINT", breakpointId: "opaque-breakpoint" } };
			await publish(snapshot());
			assert.equal(stops()[3].body.reason, "breakpoint");
			assert.ok(stops()[3].body.hitBreakpointIds[0] > 0);
		} finally { await connection.close(); }
	});
});
