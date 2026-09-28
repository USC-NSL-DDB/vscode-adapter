import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import type { Thread } from "@ddb-debugger/api-client";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";
import { DdbInspection } from "../../v2/inspection.mjs";
import { DdbExecution } from "../../v2/execution.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";

suite("Canonical stop ordering", () => {
	for (const resume of [false, true])
		test(`delayed stop ${
			resume
				? "respects a newer resume"
				: "still coordinates peers without newer control"
		}`, async () => {
			const threads: Thread[] = [
				{
					threadId: "owner",
					sessionId: "owner-session",
					state: "THREAD_STATE_STOPPED",
				},
				{
					threadId: "peer",
					sessionId: "peer-session",
					state: resume ? "THREAD_STATE_STOPPED" : "THREAD_STATE_RUNNING",
				},
			];
			const calls: any[] = [];
			const connection = {
				handshake: {
					capabilities: { executionActions: ["EXECUTION_ACTION_CONTINUE"] },
				},
				state: {
					get: (_kind: string, id: string) =>
						threads.find((thread) => thread.threadId === id),
					all: (kind: string) => (kind === "thread" ? threads : []),
				},
				client: {
					call: async (_method: string, args: any) => {
						calls.push(args);
						if (args.action === "EXECUTION_ACTION_CONTINUE")
							threads[1].state = "THREAD_STATE_RUNNING";
						if (args.action === "EXECUTION_ACTION_INTERRUPT")
							threads[1].state = "THREAD_STATE_STOPPED";
						return {};
					},
				},
				complete: async () => ({}),
			} as unknown as DdbConnection;
			let release!: () => void;
			const ready = new Promise<void>((resolve) => {
				release = resolve;
			});
			const dap = new CanonicalHarness();
			const inspection = new DdbInspection(connection);
			const peerSession = inspection.sessionHandle("peer-session");
			Object.assign(dap, {
				connection,
				inspection,
				execution: new DdbExecution(connection, (message) =>
					assert.fail(message),
				),
				breakpoints: { ready: () => ready },
				stopRevisions: new Map([["owner", "stop:1"]]),
			});
			// Deliver a real stop while breakpoint synchronization holds its publication.
			(dap as any).stopped("owner", {
				executionStateId: "stop",
				revision: "1",
				stopReason: { kind: "STOP_REASON_KIND_STEP" },
			});
			if (resume)
				assert.equal(
					(await dap.request("continue", { sessionId: peerSession })).success,
					true,
				);
			release();
			await setImmediate();
			assert.equal(
				calls.filter((call) => call.action === "EXECUTION_ACTION_INTERRUPT")
					.length,
				resume ? 0 : 1,
			);
			const stops = dap.events.filter((event) => event.event === "stopped");
			assert.equal(stops.length, 1, "the owner stop must remain visible");
			assert.equal(stops[0].body.preserveFocusHint, resume);
		});
	test("publishes the coordinated stop after the peer state catches up with its operation", async () => {
		const threads: Thread[] = [
			{ threadId: "owner", sessionId: "one", state: "THREAD_STATE_STOPPED" },
			{ threadId: "peer", sessionId: "two", state: "THREAD_STATE_RUNNING" },
		];
		const connection = {
			state: {
				get: (_kind: string, id: string) =>
					threads.find((thread) => thread.threadId === id),
				all: (kind: string) => (kind === "thread" ? threads : []),
			},
			client: { call: async () => ({}) },
			complete: async () => ({}),
		} as unknown as DdbConnection;
		const dap = new CanonicalHarness();
		Object.assign(dap, {
			connection,
			inspection: new DdbInspection(connection),
			execution: new DdbExecution(connection, assert.fail),
			breakpoints: { ready: async () => {} },
			stopRevisions: new Map([["owner", "stop:1"]]),
		});
		(dap as any).stopped("owner", {
			executionStateId: "stop",
			revision: "1",
			stopReason: { kind: "STOP_REASON_KIND_STEP" },
		});
		await delay(20);
		assert.equal(
			dap.events.some((event) => event.event === "stopped"),
			false,
			"an operation reply is not the thread-state update",
		);
		threads[1].state = "THREAD_STATE_STOPPED";
		await delay(20);
		const stop = dap.events.find((event) => event.event === "stopped");
		assert.ok(stop?.body.allThreadsStopped);
	});
});
