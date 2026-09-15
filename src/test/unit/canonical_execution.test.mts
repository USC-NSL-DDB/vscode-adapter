import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { Thread } from "@ddb-debugger/api-client";
import type { DdbConnection } from "../../v2/connection.mjs";
import { DdbExecution } from "../../v2/execution.mjs";

suite("Canonical execution coordination", () => {
	test("interrupts each running peer once until the stopped state arrives", async () => {
		let threads: Thread[] = [
			{ threadId: "owner", sessionId: "one", state: "THREAD_STATE_STOPPED" },
			{ threadId: "peer-a", sessionId: "two", state: "THREAD_STATE_RUNNING" },
			{ threadId: "peer-b", sessionId: "two", state: "THREAD_STATE_RUNNING" },
			{ threadId: "idle", sessionId: "three", state: "THREAD_STATE_STOPPED" },
		];
		const calls: any[] = [];
		const connection = { state: { all: () => threads }, client: { call: async (_method: string, args: any) => { calls.push(args); return {}; } }, complete: async () => ({}) } as unknown as DdbConnection;
		const execution = new DdbExecution(connection, message => assert.fail(message));
		execution.interruptOthers("one");
		execution.interruptOthers("one");
		await setImmediate();
		execution.interruptOthers("one");
		assert.deepEqual(calls, [{ target: { session: { sessionId: "two" } }, action: "EXECUTION_ACTION_INTERRUPT" }]);
		threads = threads.map(thread => ({ ...thread, state: "THREAD_STATE_STOPPED" }));
		execution.observe();
		assert.equal(execution.pauseKind("two", { kind: "STOP_REASON_KIND_SIGNAL", signalName: "SIGINT" }), "automatic");
		assert.equal(execution.pauseKind("two", { kind: "STOP_REASON_KIND_SIGNAL", signalName: "SIGSEGV" }), undefined);
		execution.resumed("two");
		assert.equal(execution.pauseKind("two", { kind: "STOP_REASON_KIND_SIGNAL", signalName: "SIGINT" }), undefined);
	});

	test("explicit pause is distinct from an external signal and later execution clears it", () => {
		const connection = { state: { all: () => [{ threadId: "thread", sessionId: "session" }] } } as unknown as DdbConnection;
		const execution = new DdbExecution(connection, message => assert.fail(message));
		const signal = { kind: "STOP_REASON_KIND_SIGNAL", signalName: "SIGINT" };
		assert.equal(execution.pauseKind("session", signal), undefined);
		const undo = execution.userControl({ target: { session: { sessionId: "session" } }, action: "EXECUTION_ACTION_INTERRUPT" });
		undo();
		assert.equal(execution.pauseKind("session", signal), undefined);
		execution.userControl({ target: { session: { sessionId: "session" } }, action: "EXECUTION_ACTION_INTERRUPT" });
		assert.equal(execution.pauseKind("session", signal), "explicit");
		execution.userControl({ target: { thread: { threadId: "thread" } }, action: "EXECUTION_ACTION_NEXT" });
		assert.equal(execution.pauseKind("session", signal), undefined);
	});

	test("reports failed interrupt completion without retrying it", async () => {
		let calls = 0;
		const errors: string[] = [];
		const connection = { state: { all: () => [{ sessionId: "peer", state: "THREAD_STATE_RUNNING" }] }, client: { call: async () => { calls++; return {}; } }, complete: async () => { throw new Error("backend rejected interrupt"); } } as unknown as DdbConnection;
		new DdbExecution(connection, message => errors.push(message)).interruptOthers("owner");
		await setImmediate();
		assert.equal(calls, 1);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /backend rejected interrupt/);
	});
});
