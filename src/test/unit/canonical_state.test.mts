import assert from "node:assert/strict";
import { Handles } from "../../v2/handles.mjs";
import { DdbState, ResyncRequired } from "../../v2/state.mjs";
import { operationResult, DdbOperationError } from "../../v2/connection.mjs";
import type { StateEvent } from "@ddb-debugger/api-client";

suite("Canonical DDB state", () => {
	test("opaque IDs receive distinct stable handles; invalidation never reuses them", () => {
		const handles = new Handles<string>();
		const first = handles.put("session:opaque/4294967296", "session:opaque/4294967296");
		assert.equal(handles.put("same", "session:opaque/4294967296"), first);
		assert.equal(handles.get(first), "same");
		const second = handles.put("999999999999999999999999999");
		assert.notEqual(first, second);
		handles.clear();
		assert.throws(() => handles.get(first), /expired/);
		assert.ok(handles.put("new") > second);
	});

	test("replayed updates cannot resurrect tombstones even above JS integer precision", () => {
		const state = new DdbState();
		state.hydrate({ serverInstanceId: "instance", stateEventCursor: { serverInstanceId: "instance", sequence: "10" }, sessions: [{ sessionId: "opaque", revision: "9007199254740992" }] });
		const event = (sequence: string, rev: string, deleted = false): StateEvent => ({
			cursor: { serverInstanceId: "instance", sequence }, resourceKind: "RESOURCE_KIND_SESSION", resourceId: "opaque", resourceRevision: rev,
			...(deleted ? { deleted: { resourceKind: "RESOURCE_KIND_SESSION", resourceId: "opaque", resourceRevision: rev } } : { upsert: { session: { sessionId: "opaque", revision: rev } } }),
		});
		assert.equal(state.apply(event("11", "9007199254740993", true)), true);
		assert.equal(state.apply(event("12", "9007199254740992")), false);
		assert.equal(state.get("session", "opaque"), undefined);
		assert.equal(state.apply(event("13", "9007199254740994")), true);
		assert.equal(state.get("session", "opaque")?.revision, "9007199254740994");
		assert.equal(state.apply(event("13", "9007199254740995", true)), false);
	});

	test("rehydration replaces all collections and accepts omitted ProtoJSON zero revisions", () => {
		const state = new DdbState();
		state.hydrate({ serverInstanceId: "old", stateEventCursor: { serverInstanceId: "old" }, sessions: [{ sessionId: "old-session" }] });
		state.hydrate({ serverInstanceId: "new", stateEventCursor: { serverInstanceId: "new" }, pendingCommands: [{ pendingCommandId: "pending" }] });
		assert.equal(state.all("session").length, 0);
		assert.equal(state.all("pendingCommand")[0].pendingCommandId, "pending");
		assert.throws(() => state.apply({ cursor: { serverInstanceId: "old", sequence: "1" } }), ResyncRequired);
		assert.throws(() => state.apply({ requiredResync: {} }), ResyncRequired);
	});

	test("malformed snapshot does not discard the usable projection", () => {
		const state = new DdbState();
		state.hydrate({ serverInstanceId: "server", stateEventCursor: { serverInstanceId: "server" }, sessions: [{ sessionId: "present" }] });
		assert.throws(() => state.hydrate({ serverInstanceId: "server", stateEventCursor: { serverInstanceId: "server" }, sessions: [{}] }), /missing its ID/);
		assert.equal(state.get("session", "present")?.sessionId, "present");
	});

	test("operation failures explain the target cause instead of hiding it behind a generic summary", () => {
		assert.throws(() => operationResult({ operationId: "op", state: "OPERATION_STATE_FAILED",
			error: { message: "debugger command failed" },
			targetOutcomes: [{ target: { session: { sessionId: "worker" } }, error: { message: "debugger command timed out for target" } }],
		}), /debugger command timed out for target/);
	});

	test("failed, cancelled and partially successful operations reject", () => {
		for (const state of ["OPERATION_STATE_FAILED", "OPERATION_STATE_CANCELLED", "OPERATION_STATE_RUNNING"]) {
			assert.throws(() => operationResult({ operationId: "op", state }), DdbOperationError);
		}
		assert.throws(() => operationResult({ operationId: "op", state: "OPERATION_STATE_COMPLETED", targetOutcomes: [{ succeeded: true }, { error: { message: "target failed" } }] }), /target failed/);
		assert.deepEqual(operationResult({ operationId: "op", state: "OPERATION_STATE_COMPLETED", result: { evaluation: { value: "42" } } }), { evaluation: { value: "42" } });
	});
});
