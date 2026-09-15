import assert from "node:assert/strict";
import { DdbCommands } from "../../v2/commands.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";

suite("Canonical console commands", () => {
	test("CLI commands preserve quoting and focus without decoding canonical IDs", async () => {
		const calls: {method: string; args: any}[] = [];
		const connection = {
			handshake: { capabilities: { supportedOperations: ["OPERATION_KIND_RAW_COMMAND"] } },
			state: { get: () => ({ backendThreadId: "9" }) },
			client: { call: async (method: string, args: any) => { calls.push({ method, args }); return {}; } },
			complete: async () => ({ rawCommand: { text: "done" } }),
		} as unknown as DdbConnection;
		const command = 'set variable message = "hello world"';
		const result = await new DdbCommands(connection).run(command, { thread: { threadId: "opaque-thread" } }, { frame: { frameId: "opaque-frame", level: 7 }, threadId: "opaque-thread", sessionId: "opaque-session" });
		assert.equal(result, "");
		assert.equal(calls[0].args.frameId, "opaque-frame");
		assert.deepEqual(calls[1].args.target, { thread: { threadId: "opaque-thread" } });
		assert.equal(calls[1].args.command, `-interpreter-exec --thread 9 --frame 7 console ${JSON.stringify(command)}`);
	});

	test("truncated commands fail without retrying the mutation", async () => {
		let mutations = 0;
		const connection = {
			handshake: { capabilities: { supportedOperations: ["OPERATION_KIND_RAW_COMMAND"] } },
			client: { call: async () => { mutations++; return {}; } },
			complete: async () => ({ rawCommand: { truncated: true } }),
		} as unknown as DdbConnection;
		await assert.rejects(new DdbCommands(connection).run("-some-command", { currentThread: {} }), /truncated/);
		assert.equal(mutations, 1);
	});
});
