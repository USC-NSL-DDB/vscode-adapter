import assert from "node:assert/strict";
import { RawVariables, type ExpressionContext } from "../../v2/raw_variables.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";

suite("Canonical variable-object bridge", () => {
	const context: ExpressionContext = { expression: 'some_value["quoted key"]', path: [], frame: { frame: { frameId: "opaque-frame", level: 17 }, threadId: "opaque-thread", sessionId: "opaque-session" } };

	test("failed variable creation still cleans up its requested object and preserves the error", async () => {
		const commands: string[] = [];
		const connection = {
			handshake: { capabilities: { supportedOperations: ["OPERATION_KIND_RAW_COMMAND"] } },
			state: { get: () => ({ backendThreadId: "31" }) },
			client: { closed: false, call: async (method: string, args: {command?: string; target?: object; frameId?: string}) => {
				if (method === "DebuggerService.ListScopes") { assert.equal(args.frameId, "opaque-frame"); return {}; }
				assert.deepEqual(args.target, { thread: { threadId: "opaque-thread" } });
				commands.push(args.command!);
				throw new Error(args.command!.startsWith("-var-create") ? "creation failed" : "cleanup failed");
			} },
		} as unknown as DdbConnection;
		await assert.rejects(new RawVariables(connection).inspect(context), /creation failed/);
		assert.equal(commands.length, 2);
		assert.ok(commands[0].includes("--thread 31 --frame 17"));
		assert.ok(commands[0].endsWith(JSON.stringify(context.expression)));
		const root = commands[0].split(" ")[5];
		assert.equal(commands[1], `-var-delete ${JSON.stringify(root)}`);
	});

	test("expired canonical frame fails before any raw command is admitted", async () => {
		const calls: string[] = [];
		const connection = { client: { call: async (method: string) => { calls.push(method); throw new Error("expired frame"); } } } as unknown as DdbConnection;
		await assert.rejects(new RawVariables(connection).inspect(context), /expired frame/);
		assert.deepEqual(calls, ["DebuggerService.ListScopes"]);
	});
});
