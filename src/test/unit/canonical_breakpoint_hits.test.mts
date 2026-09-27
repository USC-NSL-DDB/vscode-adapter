import assert from "node:assert/strict";
import type { Snapshot } from "@ddb-debugger/api-client";
import type { DdbConnection } from "../../v2/connection.mjs";
import { DdbState } from "../../v2/state.mjs";
import { DdbInspection } from "../../v2/inspection.mjs";
import { DdbBreakpoints } from "../../v2/breakpoints.mjs";
import { DdbSidebar } from "../../v2/sidebar.mjs";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";

function fixture() {
	const snapshot: Snapshot = {
		serverInstanceId: "server", stateEventCursor: { serverInstanceId: "server" },
		breakpoints: [
			{ breakpointId: "shared", target: { group: { groupId: "group" } }, hitCount: "42", subBreakpoints: [{ subBreakpointId: "child-two", sessionId: "two" }] },
			{ breakpointId: "different", target: { session: { sessionId: "two" } } },
		],
		threads: ["one", "peer", "two", "third"].map(id => ({ threadId: id, sessionId: id === "peer" ? "one" : id === "third" ? "two" : id, state: "THREAD_STATE_STOPPED" })),
		executionStates: ["one", "peer", "two", "third"].map(id => ({ executionStateId: id, revision: "1", target: { thread: { threadId: id } }, stopReason: {
			kind: "STOP_REASON_KIND_BREAKPOINT", breakpointId: id === "third" ? "different" : id === "two" ? "child-two" : "shared", threadId: id === "peer" ? "one" : id,
		} })),
	};
	const state = new DdbState();
	state.hydrate(snapshot);
	const connection = { state, client: { call: () => assert.fail("hit navigation must not execute debugger commands") } } as unknown as DdbConnection;
	const model = new DdbInspection(connection);
	const breakpoints = new DdbBreakpoints(model);
	const sidebar = new DdbSidebar(model, breakpoints);
	return { state, snapshot, connection, model, breakpoints, sidebar };
}

suite("Current breakpoint hits", () => {
	test("projects concurrent session hits, maps child identities, and excludes all-stop peers", () => {
		const { sidebar, model } = fixture();
		const [shared, different] = sidebar.breakpointSnapshot();
		assert.equal(shared.times, "42");
		assert.deepEqual(shared.hits.map(hit => hit.threadId), [model.threadHandle("one"), model.threadHandle("two")]);
		assert.equal(different.hits.length, 1);
		assert.equal(different.hits[0].threadId, model.threadHandle("third"));
	});

	test("retains multiple hitting threads within one session", () => {
		const { snapshot, state, sidebar } = fixture();
		snapshot.executionStates![3].stopReason!.breakpointId = "shared";
		state.hydrate(snapshot);
		const hits = sidebar.breakpointSnapshot()[0].hits;
		assert.equal(hits.length, 3);
		assert.equal(new Set(hits.map(hit => hit.sessionId)).size, 2);
		assert.equal(new Set(hits.map(hit => hit.threadId)).size, 3);
	});

	test("clears only resumed or changed stops without using accumulated hit counts", () => {
		const { state, snapshot, sidebar } = fixture();
		snapshot.threads![0].state = "THREAD_STATE_RUNNING";
		state.hydrate(snapshot);
		assert.equal(sidebar.breakpointSnapshot()[0].hits.length, 1);
		snapshot.executionStates![2].stopReason = { kind: "STOP_REASON_KIND_PAUSE", threadId: "two" };
		state.hydrate(snapshot);
		assert.equal(sidebar.breakpointSnapshot()[0].hits.length, 0);
		assert.equal(sidebar.breakpointSnapshot()[1].hits.length, 1);
		snapshot.threads = [];
		state.hydrate(snapshot);
		assert.equal(sidebar.currentHits().length, 0);
	});

	test("explicit focus selects the requested stopped thread and rejects a resumed or newer hit", async () => {
		const { connection, state, snapshot, model, sidebar, breakpoints } = fixture();
		const dap = new CanonicalHarness();
		Object.assign(dap, { connection, inspection: model, sidebar, breakpoints, execution: { pauseKind: () => undefined }, focusedStop: "one" });
		const hit = sidebar.breakpointSnapshot()[0].hits[1];
		assert.equal((await dap.request("ddb.focusBreakpointHit", hit)).success, true);
		const stop = dap.events.at(-1)!;
		assert.equal(stop.event, "stopped");
		assert.equal(stop.body.threadId, hit.threadId);
		assert.equal(stop.body.preserveFocusHint, false);
		snapshot.threads![2].state = "THREAD_STATE_RUNNING";
		state.hydrate(snapshot);
		assert.equal((await dap.request("ddb.focusBreakpointHit", hit)).success, false);
		snapshot.threads![2].state = "THREAD_STATE_STOPPED";
		snapshot.executionStates![2].revision = "2";
		state.hydrate(snapshot);
		assert.equal((await dap.request("ddb.focusBreakpointHit", hit)).success, false);
		assert.equal(dap.events.length, 1, "stale clicks must not change focus");
	});
});
