import dap from "vscode-debugadapter";
import type { DebugProtocol } from "vscode-debugprotocol";
import type { ExecuteRequest, Thread as DdbThread, StateSyncItem, OutputEvent as DdbOutput } from "@ddb-debugger/api-client";
import { DdbConnection } from "./connection.mjs";
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
}

/** Canonical DAP implementation. Activated once the remaining parity handlers land. */
export class CanonicalDebugSession extends DebugSession {
	private connection?: DdbConnection;
	private inspection?: DdbInspection;
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
			supportsEvaluateForHovers: true,
			supportsSetVariable: true,
			supportsReadMemoryRequest: true,
		};
		this.sendResponse(response);
	}

	protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: CanonicalLaunchArguments): Promise<void> {
		await this.reply(response, async () => {
			this.distributed = args.distributedStack ?? false;
			if (!args.apiEndpoint && !args.configFilePath) throw new Error("Set configFilePath for managed DDB, or apiEndpoint for an existing server");
			const connection = args.apiEndpoint
				? await DdbConnection.connect({ endpoint: args.apiEndpoint, bearerToken: args.apiToken ?? process.env.DDB_API_TOKEN })
				: await DdbConnection.launch({ binary: args.ddbpath ?? "ddb", configFilePath: args.configFilePath!, cwd: args.cwd ?? process.cwd(), env: args.env,
					onOutput: (category, text) => { if (category === "stderr" || args.showDevDebugOutput) this.sendEvent(new OutputEvent(text, category)); },
				});
			try { await this.useConnection(connection); }
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
		this.inspection = new DdbInspection(connection);
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
		await this.reply(response, () => this.model.evaluate(args));
	}
	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		await this.reply(response, () => this.model.setVariable(args));
	}
	protected override async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): Promise<void> {
		await this.reply(response, () => this.model.readSource(args.sourceReference));
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
	protected override async continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): Promise<void> {
		await this.execute(response, () => ({ target: { broadcast: {} }, action: "EXECUTION_ACTION_CONTINUE" }), { allThreadsContinued: true });
	}
	protected override async pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): Promise<void> {
		await this.execute(response, () => ({ target: { broadcast: {} }, action: "EXECUTION_ACTION_INTERRUPT" }));
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
