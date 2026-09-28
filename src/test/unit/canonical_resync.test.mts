import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Breakpoint, Snapshot } from "@ddb-debugger/api-client";
import type { DdbConnection } from "../../v2/connection.mjs";
import { DdbState } from "../../v2/state.mjs";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";

suite("Canonical snapshot recovery", () => {
	test("removes a breakpoint deleted during a replay gap and recreates it on the next request", async () => {
		const state = new DdbState();
		let resume!: () => void;
		const recovery = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let close!: () => void;
		const closed = new Promise<void>((resolve) => {
			close = resolve;
		});
		const resources = new Map<string, Breakpoint>();
		let next = 0;
		const snapshot = (): Snapshot => ({
			serverInstanceId: "server",
			stateEventCursor: { serverInstanceId: "server", sequence: "1" },
			groups: [{ groupId: "group" }],
			sessions: [{ sessionId: "session" }],
			threads: [
				{
					threadId: "thread",
					sessionId: "session",
					state: "THREAD_STATE_STOPPED",
				},
			],
			breakpoints: [...resources.values()],
		});
		const connection = {
			state,
			client: {
				subscribeOutput: async function* () {},
				collect: async (method: string) => {
					if (method === "DebuggerService.ListFrames")
						return [
							{
								frameId: "frame",
								functionName: "main",
								location: { path: "main.c", line: 6 },
							},
						];
					assert.equal(method, "DebuggerService.ListBreakpoints");
					return [...resources.values()];
				},
				call: async (method: string, args: any) => {
					assert.equal(method, "DebuggerControlService.CreateBreakpoint");
					const breakpoint = {
						breakpointId: `breakpoint-${++next}`,
						verified: true,
						revision: "1",
						spec: args.breakpoint,
					};
					resources.set(breakpoint.breakpointId, breakpoint);
					return { breakpoint };
				},
			},
			complete: async (result: unknown) => result,
			states: async function* () {
				let current = snapshot();
				state.hydrate(current);
				yield { type: "snapshot", snapshot: current };
				await recovery;
				current = snapshot();
				state.hydrate(current);
				yield { type: "snapshot", snapshot: current };
				await closed;
			},
			close: async () => {
				close();
			},
		} as unknown as DdbConnection;
		const dap = new CanonicalHarness();
		try {
			assert.equal(
				(
					await dap.request("initialize", {
						adapterID: "ddb",
						pathFormat: "path",
						supportsInvalidatedEvent: true,
					})
				).success,
				true,
			);
			await dap.begin(connection);
			const thread = (await dap.request("threads")).body.threads[0].id;
			const frameId = (await dap.request("stackTrace", { threadId: thread }))
				.body.stackFrames[0].id;
			assert.equal(
				(await dap.request("ddb.frameMetadata", { frameId })).success,
				true,
			);
			const args = { source: { path: "main.c" }, breakpoints: [{ line: 6 }] };
			const original = await dap.request("setBreakpoints", args);
			assert.equal(original.success, true, original.message);
			const id = original.body.breakpoints[0].id;
			resources.clear(); // The tombstone was lost while the stream was disconnected.
			resume();
			const deadline = Date.now() + 1000;
			while (
				!dap.events.some(
					(event) =>
						event.event === "breakpoint" &&
						event.body.reason === "removed" &&
						event.body.breakpoint.id === id,
				)
			) {
				assert.ok(
					Date.now() < deadline,
					"resync must remove the missing DAP breakpoint",
				);
				await delay(10);
			}
			assert.ok(
				dap.events.some(
					(event) =>
						event.event === "invalidated" &&
						event.body.areas.includes("stacks"),
				),
			);
			assert.equal(
				(await dap.request("ddb.frameMetadata", { frameId })).success,
				false,
				"snapshot must invalidate old frame handles",
			);
			const replaced = await dap.request("setBreakpoints", args);
			assert.equal(replaced.success, true, replaced.message);
			assert.notEqual(replaced.body.breakpoints[0].id, id);
			assert.equal(next, 2);
		} finally {
			resume();
			await dap.request("disconnect");
		}
	});
});
