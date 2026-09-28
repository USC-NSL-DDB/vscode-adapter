import type { Target } from "@ddb-debugger/api-client";
import type { DdbConnection } from "./connection.mjs";
import type { FrameContext } from "./inspection.mjs";

/** Backend-specific console operations still travel through authenticated API v2. */
export class DdbCommands {
	constructor(private readonly connection: DdbConnection) {}

	async run(
		command: string,
		target: Target,
		frame?: FrameContext,
	): Promise<string> {
		if (!command.trim()) return "";
		if (
			!this.connection.handshake.capabilities.supportedOperations?.includes(
				"OPERATION_KIND_RAW_COMMAND",
			)
		)
			throw new Error("DDB does not support backend console commands");
		const result = await this.connection.complete(
			await this.connection.client.call(
				"DebuggerControlService.ExecuteRawCommand",
				{
					target,
					dialect: "RAW_COMMAND_DIALECT_BACKEND_NATIVE",
					command,
					frameId: frame?.frame.frameId,
				},
			),
		);
		if (!result.rawCommand)
			throw new Error("DDB omitted the console command result");
		if (result.rawCommand.truncated)
			throw new Error("DDB truncated the console command result");
		const value =
			result.rawCommand.value?.objectValue?.fields?.value?.stringValue;
		return (
			value ??
			(result.rawCommand.text === "done" ? "" : (result.rawCommand.text ?? ""))
		);
	}
}
