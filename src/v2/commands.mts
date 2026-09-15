import type { Target } from "@ddb-debugger/api-client";
import type { DdbConnection } from "./connection.mjs";
import type { FrameContext } from "./inspection.mjs";

/** Backend-specific console operations still travel through authenticated API v2. */
export class DdbCommands {
	constructor(private readonly connection: DdbConnection) {}

	async run(command: string, target: Target, frame?: FrameContext): Promise<string> {
		if (!command.trim()) return "";
		if (!this.connection.handshake.capabilities.supportedOperations?.includes("OPERATION_KIND_RAW_COMMAND")) throw new Error("DDB does not support backend console commands");
		let request = command;
		if (!command.startsWith("-")) {
			let options = "";
			if (frame) {
				await this.connection.client.call("DebuggerService.ListScopes", { frameId: frame.frame.frameId });
				const thread = this.connection.state.get("thread", frame.threadId)?.backendThreadId;
				if (!thread || !/^\d+$/.test(thread)) throw new Error("DDB omitted the backend thread identifier");
				options = ` --thread ${thread} --frame ${frame.frame.level ?? 0}`;
			}
			request = `-interpreter-exec${options} console ${JSON.stringify(command)}`;
		}
		const result = await this.connection.complete(await this.connection.client.call("DebuggerControlService.ExecuteRawCommand", {
			target, dialect: "RAW_COMMAND_DIALECT_GDB_MI", command: request,
		}));
		if (!result.rawCommand) throw new Error("DDB omitted the console command result");
		if (result.rawCommand.truncated) throw new Error("DDB truncated the console command result");
		const value = result.rawCommand.value?.objectValue?.fields?.value?.stringValue;
		return value ?? (result.rawCommand.text === "done" ? "" : result.rawCommand.text ?? "");
	}
}
