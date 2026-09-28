import type { DebugProtocol } from "vscode-debugprotocol";
import type { ExecuteRequest } from "@ddb-debugger/api-client";
import type { DdbInspection } from "./inspection.mjs";
import { Handles } from "./handles.mjs";

/** A jump must stop at its destination, just as the legacy temporary breakpoint did. */
export class DdbJump {
	private readonly targets = new Handles<{ path: string; line: number }>();
	private count = 0;
	constructor(private readonly model: DdbInspection) {}

	list(args: DebugProtocol.GotoTargetsArguments): DebugProtocol.GotoTarget[] {
		const path = args.source.path;
		if (!path || path.includes("\0"))
			throw new Error("Jump requires a source path");
		if (
			!Number.isSafeInteger(args.line) ||
			args.line < 1 ||
			args.line > 0x7fffffff
		)
			throw new Error("Jump requires a positive source line");
		if (++this.count > 1024) {
			this.targets.clear();
			this.count = 1;
		}
		const id = this.targets.put({ path, line: args.line });
		return [
			{
				id,
				label: `${args.source.name ?? path}:${args.line}`,
				line: args.line,
				column: args.column,
			},
		];
	}

	async run(
		args: DebugProtocol.GotoArguments,
		execute: (request: ExecuteRequest) => Promise<void>,
	): Promise<void> {
		const location = this.targets.get(args.targetId);
		const threadId = this.model.threadHandles.get(args.threadId);
		const connection = this.model.connection;
		const thread = connection.state.get("thread", threadId);
		if (!thread?.sessionId || thread.state !== "THREAD_STATE_STOPPED")
			throw new Error("Jump requires a stopped thread");
		if (
			!connection.handshake.capabilities.executionActions?.includes(
				"EXECUTION_ACTION_JUMP",
			)
		)
			throw new Error("DDB does not support jump");
		const target = { session: { sessionId: thread.sessionId } };
		const result = await connection.complete(
			await connection.client.call("DebuggerControlService.CreateBreakpoint", {
				target,
				breakpoint: {
					source: { source: location.path, line: location.line },
					temporary: true,
					enabled: true,
				},
			}),
		);
		const breakpointId = result.breakpoint?.breakpointId;
		if (!breakpointId)
			throw new Error("DDB omitted the jump breakpoint identity");
		try {
			if (!result.breakpoint?.verified)
				throw new Error("DDB could not resolve the jump destination");
			await execute({
				target: { thread: { threadId } },
				action: "EXECUTION_ACTION_JUMP",
				jumpLocation: location,
			});
		} catch (error) {
			try {
				await connection.complete(
					await connection.client.call(
						"DebuggerControlService.DeleteBreakpoint",
						{ target, breakpointId },
					),
				);
			} catch (cleanup) {
				throw new Error(
					`${String(
						error,
					)}; could not remove jump breakpoint ${breakpointId}: ${String(
						cleanup,
					)}`,
				);
			}
			throw error;
		}
	}
}
