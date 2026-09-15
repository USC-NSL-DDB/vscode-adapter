import assert from "node:assert/strict";
import type { Breakpoint } from "@ddb-debugger/api-client";
import { SubBkptType } from "../../backend/backend.js";
import { DdbBreakpoints } from "../../v2/breakpoints.mjs";
import type { DdbInspection } from "../../v2/inspection.mjs";

suite("Canonical breakpoint updates", () => {
	test("refreshes group verification without changing DAP identity or reinserting", async () => {
		let resource: Breakpoint = { breakpointId: "opaque-breakpoint", revision: "9007199254740992", verified: false, pending: true, message: "waiting for an eligible group session" };
		let mutations = 0;
		const model = {
			groupHandles: { get: () => "opaque-group" },
			connection: {
				state: { get: () => resource },
				client: { call: async () => { mutations++; return {}; } },
				complete: async () => ({ breakpoint: resource }),
			},
		} as unknown as DdbInspection;
		const breakpoints = new DdbBreakpoints(model);
		const requested = [{ source: { path: "main.c", name: "main.c" }, line: 6, subbkpts: [{ type: SubBkptType.Group, target: 1 }] }];
		const [pending] = await breakpoints.set("main.c", requested);
		resource = { ...resource, revision: "9007199254740993", verified: true, pending: false, message: undefined };
		const [installed] = breakpoints.refresh();
		assert.equal(installed.id, pending.id);
		assert.equal(installed.verified, true);
		assert.equal(installed.message, undefined);
		assert.deepEqual(breakpoints.refresh(), []);
		assert.deepEqual(await breakpoints.set("main.c", requested), [installed]);
		assert.equal(mutations, 1);
		resource = { ...resource, revision: "9007199254740994", hitCount: "1" };
		assert.deepEqual(breakpoints.refresh(), [], "hit counts alone do not change DAP breakpoint presentation");
		resource = { ...resource, revision: "9007199254740995", verified: false, pending: true };
		assert.equal(breakpoints.refresh()[0].verified, false);
	});
	test("source and function sets reconcile independently and retain unchanged IDs", async () => {
		const resources = new Map<string, Breakpoint>();
		let nextId = 0;
		const model = {
			connection: {
				state: { get: (_kind: string, id: string) => resources.get(id), all: (kind: string) => kind === "group" ? [{ groupId: "opaque-group" }] : [] },
				client: { call: async (method: string, args: any) => ({ method, args }) },
				complete: async ({ method, args }: any) => {
					if (method.endsWith("DeleteBreakpoint")) { resources.delete(args.breakpointId); return {}; }
					const resource = { breakpointId: `opaque-${++nextId}`, verified: true, spec: args.breakpoint };
					resources.set(resource.breakpointId, resource);
					return { breakpoint: resource };
				},
			},
		} as unknown as DdbInspection;
		const breakpoints = new DdbBreakpoints(model);
		const [source] = await breakpoints.set("main.c", [{ source: { path: "main.c", name: "main.c" }, line: 6 }]);
		const functions = [{ name: "worker::tick(int)", condition: "value > 0" }, { name: "other" }];
		const inserted = await breakpoints.setFunctions(functions);
		assert.equal(resources.size, 3);
		assert.deepEqual(await breakpoints.setFunctions(functions), inserted);
		assert.equal(nextId, 3);
		assert.equal(resources.get("opaque-2")?.spec?.function?.functionName, "worker::tick(int)");
		assert.equal(resources.get("opaque-2")?.spec?.condition, "value > 0");
		const [retained] = await breakpoints.setFunctions([functions[1]]);
		assert.equal(retained.id, inserted[1].id);
		assert.ok(breakpoints.all().some(item => item.id === source.id));
		await breakpoints.set("main.c", []);
		assert.deepEqual(breakpoints.all(), [retained]);
		assert.deepEqual(await breakpoints.setFunctions([]), []);
		assert.equal(resources.size, 0);
	});

});
