import dap from "vscode-debugadapter";
import type { DebugProtocol } from "vscode-debugprotocol";
import type { ExecuteRequest, Thread as DdbThread, StateSyncItem, OutputEvent as DdbOutput } from "@ddb-debugger/api-client";
import { DdbConnection } from "./connection.mjs";
import { DdbCommands } from "./commands.mjs";
import { DdbSidebar } from "./sidebar.mjs";
import { DdbBreakpoints } from "./breakpoints.mjs";
import { DdbInspection } from "./inspection.mjs";

const { DebugSession, InitializedEvent, TerminatedEvent, OutputEvent, StoppedEvent, ContinuedEvent, ThreadEvent, Event } = dap;

export interface CanonicalLaunchArguments extends DebugProtocol.LaunchRequestArguments {
	ddbpath?: string;
	configFilePath?: string;
	cwd?: string;
	env?: Record<string, string | null>;
	apiEndpoint?: string;
	apiToken?: string;
	distributedStack?: boolean;
	showDevDebugOutput?: boolean;
	pairedBreakpointRequests?: boolean;
	autorun?: string[];
	debugger_args?: string[];
	valuesFormatting?: "disabled" | "parseText" | "prettyPrinters";
	pathSubstitutions?: Record<string, string>;
}

/** DAP session backed by the canonical DDB SDK. */
export class CanonicalDebugSession extends DebugSession {
	private connection?: DdbConnection;
	private inspection?: DdbInspection;
	private breakpoints?: DdbBreakpoints;
	private sidebar?: DdbSidebar;
	private commands?: DdbCommands;
	private startupOptions?: CanonicalLaunchArguments;
	private readonly sessionSetup = new Map<string, Promise<void>>();
	protected pairedBreakpoints = false;
	private readonly breakpointRequests = new Map<number, {
		promise: Promise<DebugProtocol.Breakpoint[]>;
		resolve: (value: DebugProtocol.Breakpoint[]) => void;
		reject: (error: unknown) => void;
	}>();
	private readonly knownThreads = new Map<string, DdbThread>();
	private stateTask?: Promise<void>;
	private outputTask?: Promise<void>;
	private closing = false;
	private configured = false;
	private distributed = false;
	private pendingStops: DdbThread[] = [];

	protected override initializeRequest(response: DebugProtocol.InitializeResponse): void {
		response.body = {
			supportsConfigurationDoneRequest: true,
			supportsConditionalBreakpoints: true,
			supportsEvaluateForHovers: true,
			supportsSetVariable: true,
			supportsReadMemoryRequest: true,
		};
		this.sendResponse(response);
	}

	protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: CanonicalLaunchArguments): Promise<void> {
		await this.reply(response, async () => {
			this.startupOptions = args;
			this.distributed = args.distributedStack ?? true;
			this.pairedBreakpoints = args.pairedBreakpointRequests ?? false;
			if (!args.apiEndpoint && !args.configFilePath) throw new Error("Set configFilePath for managed DDB, or apiEndpoint for an existing server");
			const connection = args.apiEndpoint
				? await DdbConnection.connect({ endpoint: args.apiEndpoint, bearerToken: args.apiToken ?? process.env.DDB_API_TOKEN })
				: await DdbConnection.launch({ binary: args.ddbpath ?? "ddb", configFilePath: args.configFilePath!, cwd: args.cwd ?? process.cwd(), env: args.env, debuggerArgs: args.debugger_args,
					onOutput: (category, text) => { if (category === "stderr" || args.showDevDebugOutput) this.sendEvent(new OutputEvent(text, category)); },
				});
			try {
				await this.useConnection(connection);
				await Promise.all(this.sessionSetup.values());
			}
			catch (error) { await connection.close(); throw error; }
			this.sendEvent(new InitializedEvent());
		});
	}

	protected override async attachRequest(response: DebugProtocol.AttachResponse, args: CanonicalLaunchArguments): Promise<void> {
		if (!args.apiEndpoint) { this.sendErrorResponse(response, 1, "Set apiEndpoint to attach to an existing DDB server"); return; }
		await this.launchRequest(response, args);
	}

	/** Also used by the binary integration harness to exercise real DAP handlers. */
	protected async useConnection(connection: DdbConnection): Promise<void> {
		if (this.connection) throw new Error("A DDB connection is already active");
		this.connection = connection;
		this.inspection = new DdbInspection(connection, this.startupOptions?.valuesFormatting);
		this.breakpoints = new DdbBreakpoints(this.inspection);
		this.sidebar = new DdbSidebar(this.inspection, this.breakpoints);
		this.commands = new DdbCommands(connection);
		let readyResolve!: () => void;
		let readyReject!: (error: unknown) => void;
		const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
		this.stateTask = (async () => {
			try {
				for await (const item of connection.states()) {
					this.stateChanged(item);
					if (item.type === "snapshot") readyResolve();
				}
			} catch (error) {
				readyReject(error);
				if (!this.closing) {
					this.closing = true;
					this.sendEvent(new OutputEvent(`DDB state synchronization failed: ${String(error)}\n`, "stderr"));
					await connection.close();
					this.sendEvent(new TerminatedEvent());
				}
			}
		})();
		await ready;
		this.outputTask = (async () => {
			try { for await (const output of connection.client.subscribeOutput()) this.output(output); }
			catch (error) { if (!this.closing) this.sendEvent(new OutputEvent(`DDB output stream failed: ${String(error)}\n`, "stderr")); }
		})();
	}

	private stateChanged(_item: StateSyncItem): void {
		const inspection = this.model;
		if (this.startupOptions) {
			for (const session of this.connection!.state.all("session")) {
				if (!session.sessionId || this.sessionSetup.has(session.sessionId) || !["SESSION_STATUS_READY", "SESSION_STATUS_STOPPED", "SESSION_STATUS_RUNNING"].includes(session.status ?? "")) continue;
				const id = session.sessionId;
				const setup = this.configureBackend(id, session.backend?.kind === "BACKEND_KIND_GDB");
				this.sessionSetup.set(id, setup);
				void setup.catch(error => this.sendEvent(new OutputEvent(`DDB session setup failed: ${String(error)}\n`, "stderr")));
			}
		}
		const threads = this.connection!.state.all("thread");
		const live = new Set(threads.map(thread => thread.threadId));
		for (const [id] of this.knownThreads) {
			if (!live.has(id)) {
				this.sendEvent(new ThreadEvent("exited", inspection.threadHandle(id)));
				this.knownThreads.delete(id);
				inspection.invalidate();
			}
		}
		for (const thread of threads) {
			if (!thread.threadId) continue;
			const previous = this.knownThreads.get(thread.threadId);
			if (!previous) this.sendEvent(new ThreadEvent("started", inspection.threadHandle(thread.threadId)));
			this.knownThreads.set(thread.threadId, thread);
			if (previous?.state === thread.state) continue;
			if (thread.state === "THREAD_STATE_RUNNING") {
				inspection.invalidate();
				this.sendEvent(new ContinuedEvent(inspection.threadHandle(thread.threadId), false));
			} else if (thread.state === "THREAD_STATE_STOPPED") {
				if (this.configured) this.stopped(thread); else this.pendingStops.push(thread);
			}
		}
		this.sendEvent(new Event("ddb.stateChanged"));
	}

	private async configureBackend(sessionId: string, gdb: boolean): Promise<void> {
		const target = { session: { sessionId } };
		const options = this.startupOptions!;
		if (gdb && (options.valuesFormatting ?? "prettyPrinters") === "prettyPrinters") await this.commands!.run("-enable-pretty-printing", target);
		for (const [from, to] of Object.entries(options.pathSubstitutions ?? {})) {
			await this.commands!.run(`set substitute-path ${JSON.stringify(from)} ${JSON.stringify(to)}`, target);
		}
		for (const command of options.autorun ?? []) await this.commands!.run(command, target);
	}

	private stopped(thread: DdbThread): void {
		const states = this.connection!.state.all("executionState");
		const reason = states.find(state => state.stopReason?.threadId === thread.threadId)?.stopReason;
		const kind = reason?.kind ?? "";
		const dapReason = kind.includes("BREAKPOINT") ? "breakpoint" : kind.includes("STEP") ? "step" : kind.includes("SIGNAL") ? "exception" : "pause";
		const event = new StoppedEvent(dapReason, this.model.threadHandle(thread.threadId!), reason?.description);
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped = this.connection!.state.all("thread").every(item => item.state !== "THREAD_STATE_RUNNING");
		this.sendEvent(event);
	}

	private output(output: DdbOutput): void {
		if (output.gap) this.sendEvent(new OutputEvent(`DDB output was lost: ${output.gap.reason ?? "output replay gap"}\n`, "stderr"));
		const category = output.stream === "OUTPUT_STREAM_KIND_INFERIOR_STDERR" ? "stderr"
			: ["OUTPUT_STREAM_KIND_TARGET", "OUTPUT_STREAM_KIND_INFERIOR_STDOUT"].includes(output.stream ?? "") ? "stdout" : "console";
		const text = output.text ?? (output.data ? Buffer.from(output.data, "base64").toString("utf8") : "");
		if (text) this.sendEvent(new OutputEvent(text, category));
	}

	private get model(): DdbInspection {
		if (!this.inspection || this.closing) throw new Error("DDB debug session is not connected");
		return this.inspection;
	}

	protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
		this.configured = true;
		this.sendResponse(response);
		for (const thread of this.pendingStops) {
			if (this.connection?.state.get("thread", thread.threadId!)?.state === "THREAD_STATE_STOPPED") this.stopped(thread);
		}
		this.pendingStops = [];
	}

	protected override async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
		await this.reply(response, async () => ({ threads: this.model.threads() }));
	}
	protected override async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		await this.reply(response, () => this.model.stack(args, this.distributed));
	}
	protected override async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
		await this.reply(response, () => this.model.scopes(args.frameId));
	}
	protected override async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		await this.reply(response, () => this.model.listVariables(args));
	}
	protected override async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		await this.reply(response, async () => {
			if (args.context !== "repl") return this.model.evaluate(args);
			const frame = args.frameId === undefined ? undefined : this.model.frames.get(args.frameId);
			const target = frame ? { thread: { threadId: frame.threadId } } : { currentThread: {} };
			return { result: await this.commands!.run(args.expression, target, frame), variablesReference: 0 };
		});
	}
	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		await this.reply(response, () => this.model.setVariable(args));
	}
	protected override async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): Promise<void> {
		await this.reply(response, () => this.model.readSource(args.sourceReference));
	}

	private breakpointPair(seq: number) {
		let pair = this.breakpointRequests.get(seq);
		if (!pair) {
			if (this.breakpointRequests.size >= 1024) throw new Error("Too many unmatched breakpoint requests");
			let resolve!: (value: DebugProtocol.Breakpoint[]) => void;
			let reject!: (error: unknown) => void;
			const promise = new Promise<DebugProtocol.Breakpoint[]>((done, fail) => { resolve = done; reject = fail; });
			void promise.catch(() => undefined);
			pair = { promise, resolve, reject };
			this.breakpointRequests.set(seq, pair);
		}
		return pair;
	}

	protected override async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		await this.reply(response, async () => {
			if (!this.breakpoints) throw new Error("DDB is not connected");
			if (!this.pairedBreakpoints) return { breakpoints: await this.breakpoints.set(args.source.path ?? "", args.breakpoints ?? [], args.sourceModified) };
			try { return { breakpoints: await this.breakpointPair(response.request_seq).promise }; }
			finally { this.breakpointRequests.delete(response.request_seq); }
		});
	}

	protected override async customRequest(command: string, response: DebugProtocol.Response, args: any): Promise<void> {
		if (command === "ddb.getSessions") {
			await this.reply(response, async () => ({ sessions: this.model.connection.state.all("session").map(session => ({
				sid: this.model.sessionHandle(session.sessionId!), tag: session.displayName ?? "Session", alias: session.displayName ?? "Session",
				status: (session.status ?? "SESSION_STATUS_UNSPECIFIED").replace("SESSION_STATUS_", "").toLowerCase(),
				group: session.groupId ? { valid: true, id: this.model.groupHandles.put(session.groupId, session.groupId), hash: session.groupId } : undefined,
			})) }));
			return;
		}
		if (command === "ddb.frameMetadata") {
			await this.reply(response, async () => {
				const context = this.model.frames.get(args.frameId);
				return { session_id: this.model.sessionHandle(context.sessionId), thread_id: this.model.threadHandle(context.threadId),
					level: context.frame.level ?? 0, file: context.frame.location?.path, line: context.frame.location?.line,
					afterBoundary: !!context.boundary && context.boundary !== "DISTRIBUTED_BOUNDARY_KIND_UNSPECIFIED", boundaryLabel: context.boundaryLabel };
			});
			return;
		}
		if (command === "ddb.selectThread") {
			await this.reply(response, async () => {
				const target = this.model.threadTarget(args.threadId);
				await this.model.connection.complete(await this.model.connection.client.call("DebuggerControlService.SelectThread", { target }));
			});
			return;
		}
		if (command === "list-signals") {
			await this.reply(response, async () => ({ signals: (await this.model.connection.client.collect("DebuggerService.ListSignals", {
				target: this.model.sessionTarget(args.sessionId),
			})).map(signal => ({ ...signal, desc: signal.description })) }));
			return;
		}
		if (command === "send-signal") {
			await this.reply(response, async () => {
				if (typeof args.signal !== "string" || !/^(?:SIG[A-Z0-9]+|[0-9]+)$/.test(args.signal)) throw new Error("A valid signal name or number is required");
				const connection = this.model.connection;
				if (!connection.handshake.capabilities.supportedOperations?.includes("OPERATION_KIND_RAW_COMMAND")) throw new Error("DDB does not support signal commands");
				// The current typed SIGNAL path quotes its argument before the CLI
				// signal command, which GDB rejects. Use one v2 mutation, never retry.
				await connection.complete(await connection.client.call("DebuggerControlService.ExecuteRawCommand", {
					target: this.model.sessionTarget(args.sessionId), dialect: "RAW_COMMAND_DIALECT_GDB_MI", command: `-send-signal ${args.signal}`,
				}));
			});
			return;
		}

		if (["ddb.getGroups", "ddb.getBreakpoints", "ddb.resolveSourceGroups", "ddb.status"].includes(command)) {
			await this.reply(response, async () => {
				void this.model;
				if (!this.sidebar) throw new Error("DDB sidebar is not ready");
				switch (command) {
					case "ddb.getGroups": return { groups: this.sidebar.groups() };
					case "ddb.getBreakpoints": return { bkpts: this.sidebar.breakpointSnapshot() };
					case "ddb.resolveSourceGroups": return { grps: await this.sidebar.sourceGroups(args.src) };
					default: return { status: this.connection!.state.cursor ? "up" : "starting" };
				}
			});
			return;
		}

		if (command !== "setSessionBreakpoints") { super.customRequest(command, response, args); return; }
		await this.reply(response, async () => {
			if (!Number.isInteger(args.seq)) throw new Error("Original breakpoint request sequence is required");
			const pair = this.breakpointPair(args.seq);
			try {
				if (!this.breakpoints) throw new Error("DDB is not connected");
				const request = args.arguments as DebugProtocol.SetBreakpointsArguments;
				const result = await this.breakpoints.set(request.source.path ?? "", request.breakpoints ?? [], request.sourceModified);
				pair.resolve(result);
				return { breakpoints: this.breakpoints.all() };
			} catch (error) { pair.reject(error); throw error; }
		});
	}

	protected override async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this.execute(response, () => ({ target: this.model.threadTarget(args.threadId), action: "EXECUTION_ACTION_NEXT" }));
	}
	protected override async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		await this.execute(response, () => ({ target: this.model.threadTarget(args.threadId), action: "EXECUTION_ACTION_STEP_IN" }));
	}
	protected override async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
		await this.execute(response, () => ({ target: this.model.threadTarget(args.threadId), action: "EXECUTION_ACTION_STEP_OUT" }));
	}
	protected override async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments & { sessionId?: number; session_id?: number }): Promise<void> {
		await this.execute(response, () => ({ target: args.sessionId !== undefined || args.session_id !== undefined ? this.model.sessionTarget((args.sessionId ?? args.session_id)!) : { broadcast: {} }, action: "EXECUTION_ACTION_CONTINUE" }), { allThreadsContinued: args.sessionId === undefined && args.session_id === undefined });
	}
	protected override async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments & { sessionId?: number; session_id?: number }): Promise<void> {
		await this.execute(response, () => ({ target: args.sessionId !== undefined || args.session_id !== undefined ? this.model.sessionTarget((args.sessionId ?? args.session_id)!) : { broadcast: {} }, action: "EXECUTION_ACTION_INTERRUPT" }));
	}
	private async execute(response: DebugProtocol.Response, makeRequest: () => ExecuteRequest, body?: object): Promise<void> {
		await this.reply(response, async () => {
			const connection = this.model.connection;
			const request = makeRequest();
			if (!connection.handshake.capabilities.executionActions?.includes(request.action!)) throw new Error(`DDB does not support ${request.action}`);
			await connection.complete(await connection.client.call("DebuggerControlService.Execute", request));
			return body;
		});
	}

	protected override async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
		await this.reply(response, async () => {
			const address = `0x${(BigInt(args.memoryReference) + BigInt(args.offset ?? 0)).toString(16)}`;
			const { memory } = await this.model.connection.client.call("DebuggerService.ReadMemory", { target: { currentThread: {} }, address, byteCount: String(args.count) });
			if (!memory) throw new Error("DDB omitted memory result");
			return { address: memory.address ?? address, data: memory.data, unreadableBytes: Number(memory.unreadableBytes ?? "0") };
		});
	}

	protected override async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
		await this.reply(response, async () => {
			this.closing = true;
			for (const pair of this.breakpointRequests.values()) pair.reject(new Error("DDB disconnected"));
			this.breakpointRequests.clear();
			await this.connection?.close();
			await Promise.all([this.stateTask, this.outputTask]);
			this.sendEvent(new TerminatedEvent());
		});
	}

	protected async reply(response: DebugProtocol.Response, work: () => Promise<object | undefined | void>): Promise<void> {
		try {
			const body = await work();
			if (body !== undefined) response.body = body;
			this.sendResponse(response);
		} catch (error) { this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error)); }
	}
}
