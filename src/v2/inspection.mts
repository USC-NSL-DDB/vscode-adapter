import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { DebugProtocol } from "vscode-debugprotocol";
import { DdbApiError } from "@ddb-debugger/api-client";
import type {
	Frame,
	Variable,
	Target,
	DistributedFrame,
	SourceLocation,
} from "@ddb-debugger/api-client";
import { DdbConnection } from "./connection.mjs";
import { Handles } from "./handles.mjs";

export interface FrameContext {
	frame: Frame;
	threadId: string;
	sessionId: string;
	boundary?: string;
	boundaryLabel?: string;
}
interface SourceContext {
	reference?: string;
	location?: SourceLocation;
	sessionId?: string;
	unavailable?: string;
}
interface VariableContext {
	frame: FrameContext;
	kind: "scope" | "variable" | "registers";
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
	private readonly sources = new Handles<SourceContext>();
	private readonly stacks = new Map<
		string,
		Promise<DebugProtocol.StackTraceResponse["body"]>
	>();
	private epoch = 0;
	private readonly threadEpochs = new Map<string, number>();
	private readonly frameChecks = new WeakMap<FrameContext, () => void>();

	constructor(
		readonly connection: DdbConnection,
		private readonly valuesFormatting = "prettyPrinters",
	) {}

	threadHandle(id: string): number {
		return this.threadHandles.put(id, id);
	}
	sessionHandle(id: string): number {
		return this.sessionHandles.put(id, id);
	}
	threadTarget(handle: number): Target {
		return { thread: { threadId: this.threadHandles.get(handle) } };
	}
	sessionTarget(handle: number): Target {
		return { session: { sessionId: this.sessionHandles.get(handle) } };
	}

	private breakpointLocation(threadId: string): SourceLocation | undefined {
		const thread = this.connection.state.get("thread", threadId);
		if (thread?.state !== "THREAD_STATE_STOPPED") return undefined;
		const execution = this.connection.state
			.all("executionState")
			.find((state) => state.target?.thread?.threadId === threadId);
		if (
			execution?.running ||
			execution?.stopReason?.kind !== "STOP_REASON_KIND_BREAKPOINT"
		)
			return undefined;
		if (
			execution.stopReason.threadId &&
			execution.stopReason.threadId !== threadId
		)
			return undefined;
		return execution.location ?? thread.location;
	}

	threads(): DebugProtocol.Thread[] {
		return this.connection.state
			.all("thread")
			.map((thread) => {
				if (!thread.threadId) throw new Error("DDB thread is missing its ID");
				const session = this.connection.state.get(
					"session",
					thread.sessionId ?? "",
				);
				const location = this.breakpointLocation(thread.threadId);
				const name = `${session?.displayName ?? "Session"}: ${
					thread.name ?? thread.backendThreadId ?? thread.threadId
				}`;
				const hit = location
					? ` [breakpoint at ${
							location.path?.split(/[\\/]/).pop() ??
							location.functionName ??
							"?"
						}:${location.line ?? "?"}]`
					: "";
				return {
					id: this.threadHandle(thread.threadId),
					name: name + hit,
					hit: !!location,
				};
			})
			.sort((left, right) => Number(right.hit) - Number(left.hit))
			.map(({ id, name }) => ({ id, name }));
	}

	/** Invalidates inspection handles on execution; stale requests must fail. */
	invalidate(threadId?: string): void {
		// A distributed stack may depend on any caller thread. Frame/variable
		// handles below still expire only for the thread that actually changed.
		this.stacks.clear();
		if (threadId === undefined) {
			this.epoch++;
			this.threadEpochs.clear();
			this.frames.clear();
			this.variables.clear();
		} else {
			this.threadEpochs.set(
				threadId,
				(this.threadEpochs.get(threadId) ?? 0) + 1,
			);
			this.frames.removeWhere((frame) => frame.threadId === threadId);
			this.variables.removeWhere(
				(variable) => variable.frame.threadId === threadId,
			);
		}
	}

	private inspectionCheck(): (threadId: string) => void {
		const epoch = this.epoch;
		const threads = new Map(this.threadEpochs);
		return (threadId) => {
			if (
				epoch !== this.epoch ||
				(threads.get(threadId) ?? 0) !== (this.threadEpochs.get(threadId) ?? 0)
			)
				throw new Error("Inspection expired because target execution changed");
		};
	}

	private checkFrame(frame: FrameContext): () => void {
		const check = this.frameChecks.get(frame) ?? (() => {});
		check();
		return check;
	}

	/** Reuse one stack per stop so overlapping DAP loads cannot race a tree refresh. */
	async stack(
		args: DebugProtocol.StackTraceArguments,
		distributed = false,
	): Promise<DebugProtocol.StackTraceResponse["body"]> {
		const threadId = this.threadHandles.get(args.threadId);
		const check = this.inspectionCheck();
		const key = JSON.stringify([threadId, distributed]);
		let pending = this.stacks.get(key);
		if (!pending) {
			pending = this.loadStack(threadId, distributed);
			this.stacks.set(key, pending);
			void pending.catch(() => {
				if (this.stacks.get(key) === pending) this.stacks.delete(key);
			});
		}
		const stack = await pending;
		check(threadId);
		for (const frame of stack.stackFrames)
			this.checkFrame(this.frames.get(frame.id));
		// Traversal can stop a caller and clear the cache while loading. The
		// completed stack is reusable once all its frame lifetimes are checked.
		if (!this.stacks.has(key)) this.stacks.set(key, Promise.resolve(stack));
		const start = args.startFrame ?? 0;
		return {
			...stack,
			stackFrames: stack.stackFrames.slice(
				start,
				args.levels ? start + args.levels : undefined,
			),
		};
	}

	private async loadStack(
		threadId: string,
		distributed: boolean,
	): Promise<DebugProtocol.StackTraceResponse["body"]> {
		const originCheck = this.inspectionCheck();
		const thread = this.connection.state.get("thread", threadId);
		if (!thread?.sessionId) throw new Error("Thread is no longer available");
		let frames: DistributedFrame[];
		if (distributed) {
			const result = await this.connection.complete(
				await this.connection.client.call(
					"DebuggerControlService.RunDistributedBacktrace",
					{ target: { thread: { threadId } }, maxFrames: 4096 },
				),
			);
			if (!result.distributedBacktrace)
				throw new Error("DDB omitted the distributed backtrace result");
			if (result.distributedBacktrace.truncated)
				throw new Error(
					`Distributed backtrace was truncated: ${
						result.distributedBacktrace.truncationReason ?? "frame limit"
					}`,
				);
			frames = result.distributedBacktrace.frames ?? [];
		} else {
			frames = (
				await this.connection.client.collect("DebuggerService.ListFrames", {
					threadId,
				})
			).map((frame) => ({ frame, threadId, sessionId: thread.sessionId }));
		}
		originCheck(threadId);
		// Distributed traversal can interrupt a running caller. Its returned
		// frames belong to that new stop, rather than the pre-traversal epoch.
		const check = distributed ? this.inspectionCheck() : originCheck;
		const sourceRequests = new Map<
			string,
			Promise<DebugProtocol.Source | undefined>
		>();
		const result = {
			totalFrames: frames.length,
			stackFrames: await Promise.all(
				frames.map(async (entry) => {
					const boundaryOnly =
						!entry.frame &&
						!!entry.boundary &&
						entry.boundary !== "DISTRIBUTED_BOUNDARY_KIND_UNSPECIFIED";
					const frame: Frame = entry.frame ?? { synthetic: true };
					if (
						(!frame.frameId && !boundaryOnly) ||
						!entry.threadId ||
						!entry.sessionId
					)
						throw new Error("DDB omitted a stack frame's identity");
					check(entry.threadId);
					const context: FrameContext = {
						frame,
						threadId: entry.threadId,
						sessionId: entry.sessionId,
						boundary: entry.boundary,
						boundaryLabel: entry.boundaryLabel,
					};
					this.frameChecks.set(context, () => check(context.threadId));
					const key = JSON.stringify([
						frame.frameId,
						entry.sessionId,
						entry.threadId,
						entry.index,
						entry.boundary,
						entry.boundaryLabel,
					]);
					const sourceKey = JSON.stringify([
						entry.sessionId,
						frame.location?.path,
						frame.location?.sourceReference,
					]);
					let source = sourceRequests.get(sourceKey);
					if (!source) {
						source = this.stackSource(frame.location, entry.sessionId);
						sourceRequests.set(sourceKey, source);
					}

					let resolvedSource = await source;
					if (!resolvedSource && !boundaryOnly) {
						const name =
							frame.functionName ?? frame.location?.address ?? "Unknown frame";
						const details = [name, frame.module, frame.location?.address]
							.filter(Boolean)
							.join(" · ");
						const unavailable = `No source information is available for ${details}. The binary may lack debug symbols. Build it with debug information to inspect its source.`;
						resolvedSource = {
							name,
							sourceReference: this.sources.put(
								{ unavailable },
								`unavailable:${key}`,
							),
						};
					}
					const hit = this.breakpointLocation(entry.threadId);
					const atBreakpoint =
						hit?.path &&
						hit.path === frame.location?.path &&
						hit.line === frame.location?.line &&
						(frame.level ?? 0) === 0;
					const caller = boundaryOnly
						? this.connection.state.get("session", entry.sessionId)?.displayName
						: undefined;
					check(entry.threadId);
					return {
						id: this.frames.put(context, key),
						name: boundaryOnly
							? `${entry.boundaryLabel ?? "distributed call boundary"}${
									caller ? ` · Caller: ${caller}` : ""
								}`
							: `${atBreakpoint ? "[breakpoint] " : ""}${
									entry.boundaryLabel ? `${entry.boundaryLabel} · ` : ""
								}${frame.functionName ?? "<unknown>"}`,
						presentationHint: boundaryOnly ? ("label" as const) : undefined,
						source: resolvedSource,
						line: frame.location?.line ?? 0,
						column: frame.location?.column ?? 0,
						instructionPointerReference: frame.location?.address,
					};
				}),
			),
		};
		check(threadId);
		for (const entry of frames) if (entry.threadId) check(entry.threadId);
		return result;
	}

	async scopes(frameId: number): Promise<DebugProtocol.ScopesResponse["body"]> {
		const frame = this.frames.get(frameId);
		const check = this.checkFrame(frame);
		if (!frame.frame.frameId) return { scopes: [] };
		const scopes = await this.connection.client.collect(
			"DebuggerService.ListScopes",
			{ frameId: frame.frame.frameId },
		);
		check();
		return {
			scopes: [
				...scopes.map((scope) => {
					if (!scope.scopeId) throw new Error("DDB omitted scope ID");
					return {
						name: scope.name ?? "Locals",
						expensive: scope.expensive ?? false,
						presentationHint:
							scope.kind === "SCOPE_KIND_LOCALS" ||
							scope.kind === "SCOPE_KIND_ARGUMENTS"
								? "locals"
								: undefined,
						namedVariables:
							scope.variableCount !== undefined &&
							Number.isSafeInteger(Number(scope.variableCount))
								? Number(scope.variableCount)
								: undefined,
						variablesReference: this.variables.put(
							{ frame, kind: "scope", id: scope.scopeId },
							scope.scopeId,
						),
					};
				}),
				{
					name: "Registers",
					expensive: true,
					presentationHint: "registers",
					variablesReference: this.variables.put(
						{ frame, kind: "registers", id: frame.frame.frameId! },
						`registers:${frame.frame.frameId}`,
					),
				},
			],
		};
	}

	async listVariables(
		args: DebugProtocol.VariablesArguments,
	): Promise<DebugProtocol.VariablesResponse["body"]> {
		const context = this.variables.get(args.variablesReference);
		const check = this.checkFrame(context.frame);
		const client = this.connection.client;
		if (context.kind === "registers") {
			const registers = await client.collect("DebuggerService.ListRegisters", {
				frameId: context.id,
				format: "REGISTER_FORMAT_HEXADECIMAL",
			});
			check();
			return {
				variables: registers.map((register) => ({
					name: register.name ?? "?",
					value: register.unavailable
						? "<unavailable>"
						: (register.formattedValue ?? register.value ?? ""),
					variablesReference: 0,
				})),
			};
		}
		const start = args.start ?? 0;
		const count = args.count ?? 0;
		const end = count ? start + count : undefined;
		// Match the SDK collector's bound, including the prefix needed to reach
		// an offset through continuation tokens.
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(count) ||
			start < 0 ||
			count < 0 ||
			start > 10000 ||
			(end !== undefined && end > 10000)
		) {
			throw new Error(
				"Invalid variable range: at most 10000 entries can be requested",
			);
		}
		const variables: Variable[] = [];
		if (end === undefined) {
			variables.push(
				...(context.kind === "scope"
					? await client.collect("DebuggerService.ListVariables", {
							scopeId: context.id,
						})
					: await client.collect("DebuggerService.ExpandVariable", {
							variableId: context.id,
						})),
			);
		} else {
			// Canonical pages use continuation tokens. Read only as far as DAP
			// requests, instead of eagerly collecting the rest of a large scope.
			let pageToken: string | undefined;
			const seen = new Set<string>();
			while (variables.length < end) {
				const page = {
					pageSize: Math.min(200, end - variables.length),
					pageToken,
				};
				const result =
					context.kind === "scope"
						? await client.call("DebuggerService.ListVariables", {
								scopeId: context.id,
								page,
							})
						: await client.call("DebuggerService.ExpandVariable", {
								variableId: context.id,
								page,
							});
				check();
				if ((result.variables?.length ?? 0) > page.pageSize)
					throw new Error("DDB exceeded the requested variable page size");
				if (!result.variables?.length && result.page?.nextPageToken)
					throw new Error(
						"DDB returned an empty variable page with a continuation token",
					);
				variables.push(...(result.variables ?? []));
				pageToken = result.page?.nextPageToken;
				if (!pageToken) break;
				if (seen.has(pageToken))
					throw new Error("DDB repeated a variable page token");
				seen.add(pageToken);
			}
		}
		check();
		// Earlier pages may remain visible and editable after an out-of-order
		// refresh. Keep their identities until this scope is invalidated.
		context.children =
			end === undefined
				? variables
				: [
						...new Map(
							[...(context.children ?? []), ...variables].map((variable) => [
								variable.variableId ?? variable.name,
								variable,
							]),
						).values(),
					];
		return {
			variables: variables
				.slice(start, end)
				.map((variable) => this.variable(variable, context.frame)),
		};
	}

	private variable(
		variable: Variable,
		frame: FrameContext,
	): DebugProtocol.Variable {
		return {
			name: variable.name ?? "?",
			value: variable.value ?? "",
			type: variable.typeName,
			evaluateName: variable.evaluateName,
			variablesReference:
				this.valuesFormatting !== "disabled" &&
				variable.hasChildren &&
				variable.variableId
					? this.variables.put(
							{ frame, kind: "variable", id: variable.variableId },
							variable.variableId,
						)
					: 0,
			memoryReference: variable.address,
		};
	}

	async evaluate(
		args: DebugProtocol.EvaluateArguments,
	): Promise<DebugProtocol.EvaluateResponse["body"]> {
		const frame =
			args.frameId === undefined ? undefined : this.frames.get(args.frameId);
		if (frame && !frame.frame.frameId)
			throw new Error(
				"Select an executable stack frame to evaluate an expression",
			);
		const check = frame ? this.checkFrame(frame) : () => {};
		const result = await this.connection.complete(
			await this.connection.client.call("DebuggerControlService.Evaluate", {
				target: frame
					? { thread: { threadId: frame.threadId } }
					: { currentThread: {} },
				frameId: frame?.frame.frameId,
				expression: args.expression,
				evaluationContext:
					args.context === "hover"
						? "EVALUATION_CONTEXT_HOVER"
						: args.context === "repl"
							? "EVALUATION_CONTEXT_REPL"
							: "EVALUATION_CONTEXT_WATCH",
			}),
		);
		check();
		const value = result.evaluation;
		if (!value) throw new Error("DDB omitted evaluation result");
		return {
			result: value.value ?? "",
			type: value.typeName,
			memoryReference: value.address,
			variablesReference:
				this.valuesFormatting !== "disabled" &&
				value.hasChildren &&
				value.variableId &&
				frame
					? this.variables.put(
							{ frame, kind: "variable", id: value.variableId },
							value.variableId,
						)
					: 0,
		};
	}

	async setVariable(
		args: DebugProtocol.SetVariableArguments,
	): Promise<DebugProtocol.SetVariableResponse["body"]> {
		const context = this.variables.get(args.variablesReference);
		const check = this.checkFrame(context.frame);
		if (!context.children && context.kind !== "registers")
			await this.listVariables({ variablesReference: args.variablesReference });
		check();
		const target = { thread: { threadId: context.frame.threadId } };
		if (context.kind === "registers") {
			const expression = `$${args.name.replace(/^\$/, "")}`;
			const result = await this.connection.complete(
				await this.connection.client.call("DebuggerControlService.Evaluate", {
					target,
					frameId: context.frame.frame.frameId,
					expression: `(${expression}) = (${args.value})`,
					evaluationContext: "EVALUATION_CONTEXT_REPL",
				}),
			);
			check();
			if (!result.evaluation)
				throw new Error("DDB omitted register assignment result");
			return {
				value: result.evaluation.value ?? args.value,
				type: result.evaluation.typeName,
				variablesReference: 0,
			};
		}
		const child = context.children?.find(
			(variable) => variable.name === args.name,
		);
		if (!child?.variableId)
			throw new Error(
				`DDB did not provide a variable identity for ${args.name}`,
			);
		const result = await this.connection.complete(
			await this.connection.client.call("DebuggerControlService.SetVariable", {
				target,
				variableId: child.variableId,
				value: args.value,
			}),
		);
		check();
		if (!result.variableAssignment)
			throw new Error("DDB omitted assignment result");
		context.children = undefined;
		return {
			value: result.variableAssignment.value ?? args.value,
			type: child.typeName,
			variablesReference: this.variable(child, context.frame)
				.variablesReference,
		};
	}

	private async stackSource(
		location: SourceLocation | undefined,
		sessionId: string,
	): Promise<DebugProtocol.Source | undefined> {
		const local = this.source(location);
		if (!location?.path || location.sourceReference) return local;
		if (isAbsolute(location.path)) {
			try {
				await access(location.path, constants.R_OK);
				return local;
			} catch {
				/* Ask DDB for source content unavailable on the adapter host. */
			}
		}
		// VS Code fetches this only when opening the frame. Source discovery can
		// involve SSH and must not delay delivery of the rest of the call stack.
		return {
			...local,
			sourceReference: this.sources.put(
				{ location, sessionId },
				JSON.stringify([sessionId, location.path]),
			),
		};
	}

	source(location?: SourceLocation): DebugProtocol.Source | undefined {
		if (!location?.path && !location?.sourceReference) return undefined;
		return {
			path: location.path,
			name: location.path?.split(/[\\/]/).pop(),
			sourceReference: location.sourceReference
				? this.sources.put(
						{ reference: location.sourceReference },
						location.sourceReference,
					)
				: 0,
		};
	}

	async readSource(
		reference: number,
		source?: DebugProtocol.Source,
	): Promise<DebugProtocol.SourceResponse["body"]> {
		// VS Code can fall back to a source request after a local file disappears.
		// Zero means a filesystem path, never an adapter handle.
		if (!reference)
			throw new Error(
				`Source file ${
					source?.path ?? source?.name ?? "<unknown>"
				} is not available`,
			);
		const context = this.sources.get(reference);
		if (context.unavailable) throw new Error(context.unavailable);
		try {
			return await this.readSourceContent(context);
		} catch (error) {
			if (
				error instanceof DdbApiError &&
				error.detail.code === "DDB_ERROR_CODE_NOT_FOUND"
			) {
				const path =
					context.location?.path ?? source?.path ?? source?.name ?? "<unknown>";
				throw new Error(
					`Source file ${path} is not available. Install the matching source files or configure pathSubstitutions to map the build path to your local checkout.`,
				);
			}
			throw error;
		}
	}

	private async readSourceContent(
		context: SourceContext,
	): Promise<DebugProtocol.SourceResponse["body"]> {
		if (!context.reference) {
			const resolved = await this.connection.client.call(
				"DebuggerService.ResolveSource",
				{
					target: { session: { sessionId: context.sessionId } },
					location: context.location,
				},
			);
			if (!resolved.source?.sourceReference)
				throw new Error(
					`Source file ${
						context.location?.path ?? "<unknown>"
					} is not available`,
				);
			context.reference = resolved.source.sourceReference;
		}
		const sourceReference = context.reference;
		let line = 1;
		let content = "";
		let contentHash: string | undefined;
		for (;;) {
			const { source } = await this.connection.client.call(
				"DebuggerService.ReadSource",
				{ sourceReference, startLine: line, maxLines: 1000 },
			);
			if (!source) throw new Error("DDB omitted source content");
			if (source.startLine !== line)
				throw new Error("DDB returned the wrong source page");
			if (line === 1) contentHash = source.source?.contentHash;
			else if (contentHash !== source.source?.contentHash)
				throw new Error("Source changed while reading; request it again");
			content +=
				(line > 1 && source.lineCount ? "\n" : "") + (source.content ?? "");
			if (Buffer.byteLength(content) > 16 * 1024 * 1024)
				throw new Error("Source exceeds the 16 MiB display limit");
			if (!source.hasMore)
				return { content, mimeType: source.source?.mediaType };
			if (!source.lineCount)
				throw new Error("DDB source pagination did not advance");
			line += source.lineCount;
		}
	}
}
