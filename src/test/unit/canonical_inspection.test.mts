import assert from "node:assert/strict";
import { DdbInspection } from "../../v2/inspection.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";

function fixture(formatting = "prettyPrinters") {
	const calls: { method: string; args: any }[] = [];
	let pending:
		{ method: string; entered: () => void; wait: Promise<void> } | undefined;
	const connection = {
		state: {
			get: (_kind: string, id: string) => ({
				threadId: id,
				sessionId: `session-${id}`,
			}),
		},
		client: {
			collect: async (method: string, args: any) => {
				calls.push({ method, args });
				if (pending?.method === method) {
					pending.entered();
					await pending.wait;
				}
				if (method.endsWith("ListFrames"))
					return [{ frameId: `frame-${args.threadId}`, functionName: "main" }];
				if (method.endsWith("ListScopes"))
					return [{ scopeId: `scope-${args.frameId}`, name: "Locals" }];
				if (method.endsWith("ListVariables"))
					return [
						{
							variableId: "value",
							name: "value",
							value: "42",
							evaluateName: "value",
							hasChildren: true,
						},
					];
				if (method.endsWith("ExpandVariable"))
					return [
						{
							variableId: "leaf",
							name: "[0]",
							value: "42",
							hasChildren: false,
						},
					];
				return [];
			},
			call: async (method: string, args: any) => {
				calls.push({ method, args });
				if (pending?.method === method) {
					pending.entered();
					await pending.wait;
				}
				if (method.endsWith("SetVariable"))
					return {
						variableAssignment: {
							value: args.value,
							variableId: args.variableId,
						},
					};
				return {
					evaluation: {
						value: "42",
						variableId: "value",
						hasChildren: args.expression !== "scalar",
					},
				};
			},
		},
		complete: async (result: unknown) => result,
	} as unknown as DdbConnection;
	const model = new DdbInspection(connection, formatting);
	return {
		model,
		connection,
		calls,
		pause(method: string) {
			let release!: () => void;
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			pending = {
				method,
				entered,
				wait: new Promise<void>((resolve) => {
					release = resolve;
				}),
			};
			return { started, release };
		},
	};
}

suite("Canonical inspection lifetimes", () => {
	for (const method of ["ListFrames", "ListScopes", "ListVariables"])
		test(`rejects ${method} completing after invalidation`, async () => {
			const { model, pause } = fixture();
			const threadId = model.threadHandle("one");
			const frame = (await model.stack({ threadId })).stackFrames[0];
			const scope = (await model.scopes(frame.id)).scopes[0];
			if (method === "ListFrames") model.invalidate();
			const gate = pause(`DebuggerService.${method}`);
			const result =
				method === "ListFrames"
					? model.stack({ threadId })
					: method === "ListScopes"
						? model.scopes(frame.id)
						: model.listVariables({
								variablesReference: scope.variablesReference,
							});
			await gate.started;
			model.invalidate();
			gate.release();
			await assert.rejects(result, /expired|changed/i);
		});

	test("overlapping stack reads and pagination share the current stop, then reload after execution", async () => {
		const { model, calls, pause } = fixture();
		const threadId = model.threadHandle("one");
		const gate = pause("DebuggerService.ListFrames");
		const first = model.stack({ threadId, levels: 1 });
		await gate.started;
		const second = model.stack({ threadId });
		gate.release();
		assert.deepEqual(await first, await second);
		assert.deepEqual(
			(await model.stack({ threadId, startFrame: 1 })).stackFrames,
			[],
		);
		assert.equal(
			calls.filter((call) => call.method.endsWith("ListFrames")).length,
			1,
		);
		const oldId = (await first).stackFrames[0].id;
		model.invalidate("one");
		const fresh = await model.stack({ threadId });
		assert.notEqual(fresh.stackFrames[0].id, oldId);
		assert.equal(
			calls.filter((call) => call.method.endsWith("ListFrames")).length,
			2,
		);
	});

	test("a failed stack load is retried", async () => {
		const { model, connection } = fixture();
		let attempts = 0;
		connection.client.collect = async () => {
			if (++attempts === 1) throw new Error("temporary stack failure");
			return [{ frameId: "frame" }] as any;
		};
		const threadId = model.threadHandle("one");
		await assert.rejects(model.stack({ threadId }), /temporary stack failure/);
		assert.equal((await model.stack({ threadId })).stackFrames.length, 1);
		assert.equal(attempts, 2);
	});

	test("one thread resuming preserves handles for another stopped thread", async () => {
		const { model } = fixture();
		const first = (await model.stack({ threadId: model.threadHandle("one") }))
			.stackFrames[0];
		const second = (await model.stack({ threadId: model.threadHandle("two") }))
			.stackFrames[0];
		const scope = (await model.scopes(second.id)).scopes[0];
		model.invalidate("one");
		await assert.rejects(model.scopes(first.id), /expired/);
		assert.ok((await model.scopes(second.id)).scopes.length > 0);
		assert.equal(
			(
				await model.listVariables({
					variablesReference: scope.variablesReference,
				})
			).variables[0].value,
			"42",
		);
	});
	for (const operation of ["evaluate", "setVariable"])
		test(`rejects ${operation} results from an expired frame`, async () => {
			const { model, pause } = fixture("disabled");
			const frame = (await model.stack({ threadId: model.threadHandle("one") }))
				.stackFrames[0];
			const scope = (await model.scopes(frame.id)).scopes[0];
			const gate = pause(
				`DebuggerControlService.${
					operation === "evaluate" ? "Evaluate" : "SetVariable"
				}`,
			);
			const result =
				operation === "evaluate"
					? model.evaluate({
							frameId: frame.id,
							expression: "value",
							context: "watch",
						})
					: model.setVariable({
							variablesReference: scope.variablesReference,
							name: "value",
							value: "42",
						});
			await gate.started;
			model.invalidate("one");
			gate.release();
			await assert.rejects(result, /expired|changed/i);
		});

	test("typed values expand and assign children without expression names", async () => {
		const { model, calls } = fixture();
		const frame = (await model.stack({ threadId: model.threadHandle("one") }))
			.stackFrames[0];
		const scope = (await model.scopes(frame.id)).scopes[0];
		const root = (
			await model.listVariables({
				variablesReference: scope.variablesReference,
			})
		).variables[0];
		const child = (
			await model.listVariables({ variablesReference: root.variablesReference })
		).variables[0];
		assert.equal(child.evaluateName, undefined);
		assert.equal(
			(
				await model.setVariable({
					variablesReference: root.variablesReference,
					name: child.name,
					value: "43",
				})
			).value,
			"43",
		);
		assert.deepEqual(
			calls.find((call) => call.method.endsWith("SetVariable"))?.args,
			{
				target: { thread: { threadId: "one" } },
				variableId: "leaf",
				value: "43",
			},
		);
		assert.ok(
			(
				await model.evaluate({
					frameId: frame.id,
					expression: "value",
					context: "watch",
				})
			).variablesReference > 0,
		);
		assert.equal(
			(
				await model.evaluate({
					frameId: frame.id,
					expression: "scalar",
					context: "hover",
				})
			).variablesReference,
			0,
		);
		assert.equal(
			calls.some((call) => call.method.endsWith("ExecuteRawCommand")),
			false,
		);
	});

	test("another thread resuming does not discard an in-flight inspection", async () => {
		const { model, pause } = fixture();
		const gate = pause("DebuggerService.ListFrames");
		const result = model.stack({ threadId: model.threadHandle("two") });
		await gate.started;
		model.invalidate("one");
		gate.release();
		const frame = (await result).stackFrames[0];
		assert.ok((await model.scopes(frame.id)).scopes.length > 0);
	});
});
