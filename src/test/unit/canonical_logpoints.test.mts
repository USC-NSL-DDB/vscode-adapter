import assert from "node:assert/strict";
import type { ExecutionState } from "@ddb-debugger/api-client";
import type { DdbConnection } from "../../v2/connection.mjs";
import { DdbLogpoints, parseLogMessage } from "../../v2/logpoints.mjs";

const stop: ExecutionState = {
	executionStateId: "opaque-execution",
	revision: "4",
	target: { thread: { threadId: "opaque-thread" } },
};
function fixture(
	options: {
		fail?: boolean;
		evaluated?: () => void;
		latest?: ExecutionState;
	} = {},
) {
	const calls: { method: string; args: any }[] = [];
	const connection = {
		client: {
			call: async (method: string, args: any) => {
				calls.push({ method, args });
				if (method.endsWith("ListFrames"))
					return { frames: [{ frameId: "opaque-frame" }] };
				if (method.endsWith("GetExecutionState"))
					return { executionState: options.latest ?? stop };
				return { method };
			},
		},
		complete: async ({ method }: any) => {
			if (method.endsWith("Evaluate")) {
				options.evaluated?.();
				if (options.fail) throw new Error("expression failed");
				return { evaluation: { value: "17" } };
			}
			return {};
		},
	} as unknown as DdbConnection;
	return { calls, runner: new DdbLogpoints(connection) };
}

suite("Canonical logpoints", () => {
	test("parses literals, escaped braces, quoted braces and nested expressions", () => {
		assert.deepEqual(
			parseLogMessage('literal={{ok}} value={counter + 1} {"}"}'),
			[
				{ text: "literal={ok} value=" },
				{ expression: "counter + 1" },
				{ text: " " },
				{ expression: '"}"' },
			],
		);
		assert.deepEqual(parseLogMessage("{Thing{1, 2}.value}"), [
			{ expression: "Thing{1, 2}.value" },
		]);
		assert.deepEqual(parseLogMessage(""), []);
		for (const invalid of [
			"{",
			"}",
			"{}",
			"{   }",
			"{counter",
			"x".repeat(65537),
		])
			assert.throws(() => parseLogMessage(invalid));
	});

	test("evaluates in the hitting frame and continues only its thread", async () => {
		const { calls, runner } = fixture();
		const output: string[] = [];
		assert.equal(
			await runner.run(
				"opaque-thread",
				stop,
				parseLogMessage("value={counter}"),
				() => true,
				(text) => output.push(text),
			),
			true,
		);
		assert.deepEqual(output, ["value=17\n"]);
		const evaluation = calls.find((call) => call.method.endsWith("Evaluate"))!;
		assert.equal(evaluation.args.frameId, "opaque-frame");
		assert.equal(evaluation.args.expression, "counter");
		assert.deepEqual(evaluation.args.target, {
			thread: { threadId: "opaque-thread" },
		});
		assert.deepEqual(calls.at(-1)?.args, {
			target: { thread: { threadId: "opaque-thread" } },
			action: "EXECUTION_ACTION_CONTINUE",
		});
	});

	test("failed expressions never resume the target or emit a partial message", async () => {
		const { calls, runner } = fixture({ fail: true });
		const output: string[] = [];
		await assert.rejects(
			runner.run(
				"opaque-thread",
				stop,
				parseLogMessage("prefix {bad}"),
				() => true,
				(text) => output.push(text),
			),
			/expression failed/,
		);
		assert.deepEqual(output, []);
		assert.ok(!calls.some((call) => call.method.endsWith("Execute")));
	});

	test("explicit control during evaluation cancels automatic continuation", async () => {
		let current = true;
		const { calls, runner } = fixture({
			evaluated: () => {
				current = false;
			},
		});
		assert.equal(
			await runner.run(
				"opaque-thread",
				stop,
				parseLogMessage("{counter}"),
				() => current,
				() => assert.fail("cancelled logpoint emitted output"),
			),
			false,
		);
		assert.ok(!calls.some((call) => call.method.endsWith("Execute")));
	});

	test("a newer backend stop cancels continuation even before its stream update arrives", async () => {
		const { calls, runner } = fixture({ latest: { ...stop, revision: "5" } });
		assert.equal(
			await runner.run(
				"opaque-thread",
				stop,
				parseLogMessage("literal"),
				() => true,
				() => assert.fail("stale logpoint emitted output"),
			),
			false,
		);
		assert.ok(!calls.some((call) => call.method.endsWith("Execute")));
	});
});
