import type { DebugProtocol } from "vscode-debugprotocol";
import type { Frame, Variable, Target, DistributedFrame, SourceLocation } from "@ddb-debugger/api-client";
import { DdbConnection } from "./connection.mjs";
import { RawVariables, type ExpressionContext } from "./raw_variables.mjs";
import { Handles } from "./handles.mjs";

export interface FrameContext {
	frame: Frame;
	threadId: string;
	sessionId: string;
	boundary?: string;
	boundaryLabel?: string;
}
interface VariableContext {
	frame: FrameContext;
	kind: "scope" | "variable" | "registers" | "expression";
	expression?: ExpressionContext;
	id: string;
	children?: Variable[];
}

/** Translates canonical resource identities into DAP handles and presentation. */
export class DdbInspection {
	readonly threadHandles = new Handles<string>();
	readonly sessionHandles = new Handles<string>();
	readonly groupHandles = new Handles<string>();
	readonly frames = new Handles<FrameContext>();
	private readonly variables = new Handles<VariableContext>();
	private readonly childHints = new Map<string, boolean>();
	private readonly sources = new Handles<string>();

	private readonly raw: RawVariables;
	constructor(readonly connection: DdbConnection, private readonly valuesFormatting = "prettyPrinters") { this.raw = new RawVariables(connection); }

	threadHandle(id: string): number { return this.threadHandles.put(id, id); }
	sessionHandle(id: string): number { return this.sessionHandles.put(id, id); }
	threadTarget(handle: number): Target { return { thread: { threadId: this.threadHandles.get(handle) } }; }
	sessionTarget(handle: number): Target { return { session: { sessionId: this.sessionHandles.get(handle) } }; }

	threads(): DebugProtocol.Thread[] {
		return this.connection.state.all("thread").map(thread => {
			if (!thread.threadId) throw new Error("DDB thread is missing its ID");
			const session = this.connection.state.get("session", thread.sessionId ?? "");
			return { id: this.threadHandle(thread.threadId), name: `${session?.displayName ?? "Session"}: ${thread.name ?? thread.backendThreadId ?? thread.threadId}` };
		});
	}

	/** Invalidates inspection handles on execution; stale requests must fail. */
	invalidate(): void { this.frames.clear(); this.variables.clear(); this.childHints.clear(); }

	async stack(args: DebugProtocol.StackTraceArguments, distributed = false): Promise<DebugProtocol.StackTraceResponse["body"]> {
		const threadId = this.threadHandles.get(args.threadId);
		const thread = this.connection.state.get("thread", threadId);
		if (!thread?.sessionId) throw new Error("Thread is no longer available");
		let frames: DistributedFrame[];
		if (distributed) {
			const result = await this.connection.complete(await this.connection.client.call("DebuggerControlService.RunDistributedBacktrace", { target: { thread: { threadId } }, maxFrames: 4096 }));
			if (!result.distributedBacktrace) throw new Error("DDB omitted the distributed backtrace result");
			if (result.distributedBacktrace.truncated) throw new Error(`Distributed backtrace was truncated: ${result.distributedBacktrace.truncationReason ?? "frame limit"}`);
			frames = result.distributedBacktrace.frames ?? [];
		} else {
			frames = (await this.connection.client.collect("DebuggerService.ListFrames", { threadId })).map(frame => ({ frame, threadId, sessionId: thread.sessionId }));
		}
		const start = args.startFrame ?? 0;
		return {
			totalFrames: frames.length,
			stackFrames: frames.slice(start, args.levels ? start + args.levels : undefined).map(entry => {
				const frame = entry.frame;
				if (!frame?.frameId || !entry.threadId || !entry.sessionId) throw new Error("DDB omitted a stack frame's identity");
				const context: FrameContext = { frame, threadId: entry.threadId, sessionId: entry.sessionId, boundary: entry.boundary, boundaryLabel: entry.boundaryLabel };
				const key = JSON.stringify([frame.frameId, entry.index, entry.boundary, entry.boundaryLabel]);
				return {
					id: this.frames.put(context, key), name: `${entry.boundaryLabel ? `${entry.boundaryLabel} · ` : ""}${frame.functionName ?? "<unknown>"}`,
					source: this.source(frame.location), line: frame.location?.line ?? 0, column: frame.location?.column ?? 0,
					instructionPointerReference: frame.location?.address,
				};
			}),
		};
	}

	async scopes(frameId: number): Promise<DebugProtocol.ScopesResponse["body"]> {
		const frame = this.frames.get(frameId);
		const scopes = await this.connection.client.collect("DebuggerService.ListScopes", { frameId: frame.frame.frameId });
		return { scopes: [
			...scopes.map(scope => {
				if (!scope.scopeId) throw new Error("DDB omitted scope ID");
				return { name: scope.name ?? "Locals", expensive: scope.expensive ?? false, variablesReference: this.variables.put({ frame, kind: "scope", id: scope.scopeId }, scope.scopeId) };
			}),
			{ name: "Registers", expensive: false, variablesReference: this.variables.put({ frame, kind: "registers", id: frame.frame.frameId! }, `registers:${frame.frame.frameId}`) },
		] };
	}

	async listVariables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.VariablesResponse["body"]> {
		const context = this.variables.get(args.variablesReference);
		const client = this.connection.client;
		if (context.kind === "expression") {
			const expression = context.expression!;
			const start = args.start ?? 0;
			const children = await this.raw.expand(expression, start, args.count || 1000);
			context.children = children.map((child, index) => ({ name: child.name, value: child.value, variableId: String(start + index) }));
			return { variables: children.map((child, index) => ({ name: child.name, value: child.value, type: child.type,
				variablesReference: child.children > 0 ? this.variables.put({ frame: context.frame, kind: "expression", id: "", expression: { ...expression, path: [...expression.path, start + index] } }) : 0 })) };
		}
		if (context.kind === "registers") {
			const registers = await client.collect("DebuggerService.ListRegisters", { frameId: context.id, format: "REGISTER_FORMAT_HEXADECIMAL" });
			return { variables: registers.map(register => ({ name: register.name ?? "?", value: register.unavailable ? "<unavailable>" : register.formattedValue ?? register.value ?? "", variablesReference: 0 })) };
		}
		const variables = context.kind === "scope"
			? await client.collect("DebuggerService.ListVariables", { scopeId: context.id })
			: await client.collect("DebuggerService.ExpandVariable", { variableId: context.id });
		// Canonical local-variable queries omit child counts on GDB. Ask only for
		// object metadata; scalar ExpandVariable currently rejects empty children.
		for (let offset = 0; offset < variables.length; offset += 4) {
			await Promise.all(variables.slice(offset, offset + 4).map(async variable => {
				if (this.valuesFormatting === "disabled" || variable.childCount !== undefined || variable.hasChildren || !variable.variableId || !variable.evaluateName) return;
				let hasChildren = this.childHints.get(variable.variableId);
				if (hasChildren === undefined) {
					const metadata = await this.raw.inspect({ frame: context.frame, expression: variable.evaluateName, path: [] });
					hasChildren = metadata.children > 0;
					this.childHints.set(variable.variableId, hasChildren);
				}
				variable.hasChildren = hasChildren;
			}));
		}
		context.children = variables;
		const start = args.start ?? 0;
		return { variables: variables.slice(start, args.count ? start + args.count : undefined).map(variable => this.variable(variable, context.frame)) };
	}

	private variable(variable: Variable, frame: FrameContext): DebugProtocol.Variable {
		return {
			name: variable.name ?? "?", value: variable.value ?? "", type: variable.typeName, evaluateName: variable.evaluateName,
			variablesReference: this.valuesFormatting !== "disabled" && variable.hasChildren && variable.variableId ? this.variables.put(variable.evaluateName
				? { frame, kind: "expression", id: variable.variableId, expression: { frame, expression: variable.evaluateName, path: [] } }
				: { frame, kind: "variable", id: variable.variableId }, variable.variableId) : 0,
			memoryReference: variable.address,
		};
	}

	async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DebugProtocol.EvaluateResponse["body"]> {
		const frame = args.frameId === undefined ? undefined : this.frames.get(args.frameId);
		if (frame && args.context !== "repl" && this.valuesFormatting !== "disabled") {
			const expression: ExpressionContext = { frame, expression: args.expression, path: [] };
			const value = await this.raw.inspect(expression);
			return { result: value.value, type: value.type, variablesReference: value.children > 0 ? this.variables.put({ frame, kind: "expression", id: "", expression }) : 0 };
		}
		const result = await this.connection.complete(await this.connection.client.call("DebuggerControlService.Evaluate", {
			target: frame ? { thread: { threadId: frame.threadId } } : { currentThread: {} },
			frameId: frame?.frame.frameId, expression: args.expression,
			evaluationContext: args.context === "hover" ? "EVALUATION_CONTEXT_HOVER" : args.context === "repl" ? "EVALUATION_CONTEXT_REPL" : "EVALUATION_CONTEXT_WATCH",
		}));
		const value = result.evaluation;
		if (!value) throw new Error("DDB omitted evaluation result");
		return { result: value.value ?? "", type: value.typeName, memoryReference: value.address,
			variablesReference: this.valuesFormatting !== "disabled" && value.variableId && frame ? this.variables.put({ frame, kind: "variable", id: value.variableId }, value.variableId) : 0 };
	}

	async setVariable(args: DebugProtocol.SetVariableArguments): Promise<DebugProtocol.SetVariableResponse["body"]> {
		const context = this.variables.get(args.variablesReference);
		if (!context.children && context.kind !== "registers") await this.listVariables({ variablesReference: args.variablesReference });
		const child = context.children?.find(variable => variable.name === args.name);
		if (context.kind === "expression") {
			if (!child?.variableId) throw new Error(`Unknown child ${args.name}`);
			const value = await this.raw.assign({ ...context.expression!, path: [...context.expression!.path, Number(child.variableId)] }, args.value);
			this.childHints.clear();
			return { value, variablesReference: 0 };
		}
		const expression = context.kind === "registers" ? `$${args.name.replace(/^\$/, "")}` : child?.evaluateName;
		if (!expression) throw new Error(`DDB did not provide an assignable expression for ${args.name}`);
		const result = await this.connection.complete(await this.connection.client.call("DebuggerControlService.Evaluate", {
			target: { thread: { threadId: context.frame.threadId } }, frameId: context.frame.frame.frameId,
			expression: `(${expression}) = (${args.value})`, evaluationContext: "EVALUATION_CONTEXT_REPL",
		}));
		if (!result.evaluation) throw new Error("DDB omitted assignment result");
		context.children = undefined;
		this.childHints.clear();
		return { value: result.evaluation.value ?? args.value, type: result.evaluation.typeName, variablesReference: 0 };
	}

	source(location?: SourceLocation): DebugProtocol.Source | undefined {
		if (!location?.path && !location?.sourceReference) return undefined;
		return { path: location.path, name: location.path?.split(/[\\/]/).pop(), sourceReference: location.sourceReference ? this.sources.put(location.sourceReference, location.sourceReference) : 0 };
	}

	async readSource(reference: number): Promise<DebugProtocol.SourceResponse["body"]> {
		const sourceReference = this.sources.get(reference);
		let line = 1;
		let content = "";
		let contentHash: string | undefined;
		for (;;) {
			const { source } = await this.connection.client.call("DebuggerService.ReadSource", { sourceReference, startLine: line, maxLines: 1000 });
			if (!source) throw new Error("DDB omitted source content");
			if (source.startLine !== line) throw new Error("DDB returned the wrong source page");
			if (line === 1) contentHash = source.source?.contentHash;
			else if (contentHash !== source.source?.contentHash) throw new Error("Source changed while reading; request it again");
			content += (line > 1 && source.lineCount ? "\n" : "") + (source.content ?? "");
			if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error("Source exceeds the 16 MiB display limit");
			if (!source.hasMore) return { content, mimeType: source.source?.mediaType };
			if (!source.lineCount) throw new Error("DDB source pagination did not advance");
			line += source.lineCount;
		}
	}
}
