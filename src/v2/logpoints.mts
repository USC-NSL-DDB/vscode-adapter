import type { ExecutionState } from "@ddb-debugger/api-client";
import type { DdbConnection } from "./connection.mjs";

export type LogPart = { text: string } | { expression: string };

/** Parse interpolation without passing literal log text to the debugger. */
export function parseLogMessage(message: string): LogPart[] {
	if (Buffer.byteLength(message, "utf8") > 65536)
		throw new Error("Log message exceeds 64 KiB");
	const parts: LogPart[] = [];
	let text = "";
	let expressions = 0;
	for (let index = 0; index < message.length;) {
		const char = message[index++];
		if ((char === "{" || char === "}") && message[index] === char) {
			text += char;
			index++;
			continue;
		}
		if (char === "}") throw new Error("Unmatched closing brace in log message");
		if (char !== "{") {
			text += char;
			continue;
		}
		if (text) {
			parts.push({ text });
			text = "";
		}
		const start = index;
		let depth = 1;
		let quote = "";
		for (; index < message.length && depth; index++) {
			const current = message[index];
			if (quote) {
				if (current === "\\") index++;
				else if (current === quote) quote = "";
			} else if (current === '"' || current === "'") quote = current;
			else if (current === "{") depth++;
			else if (current === "}") depth--;
		}
		if (depth) throw new Error("Unmatched opening brace in log message");
		const expression = message.slice(start, index - 1).trim();
		if (!expression) throw new Error("Logpoint expression cannot be empty");
		if (++expressions > 128)
			throw new Error("Log message exceeds 128 expressions");
		parts.push({ expression });
	}
	if (text) parts.push({ text });
	return parts;
}

export class DdbLogpoints {
	constructor(private readonly connection: DdbConnection) {}

	/** Returns false when a newer stop or explicit control supersedes this work. */
	async run(
		threadId: string,
		stop: ExecutionState,
		parts: LogPart[],
		current: () => boolean,
		output: (text: string) => void,
	): Promise<boolean> {
		if (!current()) return false;
		const target = { thread: { threadId } };
		let frameId: string | undefined;
		if (parts.some((part) => "expression" in part)) {
			const frames = await this.connection.client.call(
				"DebuggerService.ListFrames",
				{ threadId, page: { pageSize: 1 } },
			);
			frameId = frames.frames?.[0]?.frameId;
			if (!frameId)
				throw new Error("DDB returned no frame for the logpoint expression");
		}
		let message = "";
		for (const part of parts) {
			if (!current()) return false;
			if ("text" in part) message += part.text;
			else {
				const result = await this.connection.complete(
					await this.connection.client.call("DebuggerControlService.Evaluate", {
						target,
						frameId,
						expression: part.expression,
						evaluationContext: "EVALUATION_CONTEXT_WATCH",
					}),
				);
				if (result.evaluation?.value === undefined)
					throw new Error("DDB omitted the logpoint expression value");
				message += result.evaluation.value;
			}
			if (Buffer.byteLength(message, "utf8") > 65536)
				throw new Error("Logpoint output exceeds 64 KiB");
		}
		if (!current()) return false;
		const latest = (
			await this.connection.client.call("DebuggerService.GetExecutionState", {
				target,
			})
		).executionState;
		if (
			!current() ||
			!latest ||
			latest.running ||
			latest.executionStateId !== stop.executionStateId ||
			(latest.revision ?? "0") !== (stop.revision ?? "0")
		)
			return false;
		output(message.endsWith("\n") ? message : `${message}\n`);
		if (!current()) return false;
		await this.connection.complete(
			await this.connection.client.call("DebuggerControlService.Execute", {
				target,
				action: "EXECUTION_ACTION_CONTINUE",
			}),
		);
		return true;
	}
}
