import { randomUUID } from "node:crypto";
import type { DynamicValue } from "@ddb-debugger/api-client";
import type { FrameContext } from "./inspection.mjs";
import type { DdbConnection } from "./connection.mjs";

export interface ExpressionContext {
	frame: FrameContext;
	expression: string;
	path: number[];
}
export interface VariableShape {
	name: string;
	value: string;
	type?: string;
	children: number;
}
type Fields = Record<string, DynamicValue>;
function string(fields: Fields, key: string): string | undefined { return fields[key]?.stringValue; }
function count(fields: Fields): number {
	const value = Number(string(fields, "numchild") ?? "0");
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("DDB returned an invalid variable child count");
	return value;
}
function childCount(fields: Fields): number {
	// Dynamic pretty printers can defer their count until children are requested.
	const deferred = string(fields, "dynamic") === "1" && string(fields, "displayhint") !== "string";
	return Math.max(count(fields), string(fields, "has_more") === "1" || deferred ? 1 : 0);
}
function shape(fields: Fields): VariableShape {
	return { name: string(fields, "exp") ?? string(fields, "name") ?? "?", value: string(fields, "value") ?? "", type: string(fields, "type"), children: childCount(fields) };
}

/** Bounded v2 escape hatch for metadata absent from canonical variable resources.
 * Variable objects live only for one operation. Canonical IDs are never decoded.
 */
export class RawVariables {
	constructor(private readonly connection: DdbConnection) {}

	private async command(frame: FrameContext, command: string): Promise<Fields> {
		if (!this.connection.handshake.capabilities.supportedOperations?.includes("OPERATION_KIND_RAW_COMMAND")) throw new Error("DDB does not support the variable-object command API");
		let result;
		try { result = await this.connection.complete(await this.connection.client.call("DebuggerControlService.ExecuteRawCommand", {
			target: { thread: { threadId: frame.threadId } }, dialect: "RAW_COMMAND_DIALECT_GDB_MI", command,
		})); } catch (error) { throw new Error(`${command.split(" ")[0]} failed: ${String(error)}`); }
		if (result.rawCommand?.truncated) throw new Error("DDB truncated the variable-object result");
		return result.rawCommand?.value?.objectValue?.fields ?? {};
	}

	private async withObject<T>(context: ExpressionContext, work: (name: string, fields: Fields) => Promise<T>): Promise<T> {
		// Validate the canonical frame before touching a backend variable object.
		await this.connection.client.call("DebuggerService.ListScopes", { frameId: context.frame.frame.frameId });
		const root = `ddb_vscode_${randomUUID().replace(/-/g, "")}`;
		let attempted = false;
		let failed = false;
		try {
			const backendThread = this.connection.state.get("thread", context.frame.threadId)?.backendThreadId;
			if (!backendThread || !/^\d+$/.test(backendThread)) throw new Error("DDB omitted the GDB thread identifier");
			attempted = true;
			let fields = await this.command(context.frame, `-var-create --thread ${backendThread} --frame ${context.frame.frame.level ?? 0} ${root} * ${JSON.stringify(context.expression)}`);
			let name = string(fields, "name");
			if (!name) throw new Error("DDB omitted the variable-object name");
			if (context.path.length > 64) throw new Error("Variable expansion exceeds 64 levels");
			for (const index of context.path) {
				const children = await this.children(context.frame, name, index, 1);
				fields = children[0];
				if (!fields) throw new Error("Variable child no longer exists");
				name = string(fields, "name");
				if (!name) throw new Error("DDB omitted the child variable-object name");
			}
			return await work(name, fields);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			if (attempted && !this.connection.client.closed) {
				try { await this.command(context.frame, `-var-delete ${JSON.stringify(root)}`); }
				catch (error) { if (!failed) throw error; }
			}
		}
	}

	private async children(frame: FrameContext, name: string, start: number, length: number): Promise<Fields[]> {
		const result = await this.command(frame, `-var-list-children --all-values ${JSON.stringify(name)} ${start} ${start + length}`);
		const values = result.children?.listValue?.values;
		if (!values) {
			if (string(result, "numchild") === "0") return [];
			throw new Error("DDB omitted variable children");
		}
		return values.map(value => {
			const fields = value.objectValue?.fields;
			const child = fields?.child?.objectValue?.fields ?? fields;
			if (!child) throw new Error("DDB returned a malformed variable child");
			return child;
		});
	}

	inspect(context: ExpressionContext): Promise<VariableShape> {
		return this.withObject(context, async (_name, fields) => shape(fields));
	}

	expand(context: ExpressionContext, start = 0, length = 1000): Promise<VariableShape[]> {
		if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 || length > 10000) throw new Error("Invalid variable child range");
		return this.withObject(context, async (name, fields) => {
			if (childCount(fields) === 0) return [];
			return (await this.children(context.frame, name, start, length)).map(shape);
		});
	}

	assign(context: ExpressionContext, value: string): Promise<string> {
		return this.withObject(context, async name => {
			const fields = await this.command(context.frame, `-var-assign ${JSON.stringify(name)} ${JSON.stringify(value)}`);
			const result = string(fields, "value");
			if (result === undefined) throw new Error("DDB omitted variable assignment result");
			return result;
		});
	}
}
