import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	DdbClient, DdbProtocolError, type DdbClientConfig, type Handshake,
	type Operation, type OperationAdmissionResponse, type OperationResult,
	type StateSyncItem,
} from "@ddb-debugger/api-client";
import { DdbState, ResyncRequired } from "./state.mjs";

export interface ManagedOptions {
	binary: string;
	configFilePath: string;
	cwd: string;
	env?: Record<string, string | null>;
	startupTimeoutMs?: number;
	debuggerArgs?: string[];
	onOutput?: (category: "stdout" | "stderr", text: string) => void;
}

/** Managed transport options belong to the adapter; all other flags reach DDB. */
export function managedArguments(options: ManagedOptions, tokenFile: string, reportFile: string): string[] {
	const extra = options.debuggerArgs ?? [];
	if (!Array.isArray(extra) || extra.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("debugger_args must be an array of argument strings");
	const reserved = new Set(["--api-bind", "--api-port", "--api-auth-token-file", "--startup-report", "--managed"]);
	for (const argument of extra) {
		if (reserved.has(argument.split("=", 1)[0])) throw new Error(`${argument.split("=", 1)[0]} is managed by the adapter; use apiEndpoint for an existing server`);
	}
	return ["serve", resolve(options.cwd, options.configFilePath), ...extra, "--managed", "--api-auth-token-file", tokenFile, "--startup-report", reportFile];
}

interface StartupReport {
	protocol_version?: number;
	status?: string;
	pid?: number;
	endpoint?: string;
	server_instance_id?: string;
	api_versions?: string[];
	phase?: string;
	code?: string;
	message?: string;
}

/** Failed operations are terminal too. Their result must not become a DAP success. */
export class DdbOperationError extends Error {
	constructor(readonly operation: Operation) {
		const failures = operation.targetOutcomes?.filter(outcome => outcome.succeeded !== true);
		const details = failures?.map(outcome => outcome.error?.message).filter(Boolean).join("; ");
		super(operation.error?.message ?? (details || `DDB operation ${operation.operationId} ended as ${operation.state}`));
	}
}

export function operationResult(operation: Operation): OperationResult {
	if (operation.state !== "OPERATION_STATE_COMPLETED" || operation.error || operation.targetOutcomes?.some(outcome => outcome.succeeded !== true)) {
		throw new DdbOperationError(operation);
	}
	return operation.result ?? {};
}

/** One authenticated SDK client owns all debugger requests, state and output. */
export class DdbConnection {
	readonly state = new DdbState();
	private stopping?: Promise<void>;
	private constructor(
		readonly client: DdbClient,
		readonly handshake: Handshake,
		private readonly owned?: { child: ChildProcess; directory: string },
	) {}

	static async connect(config: DdbClientConfig): Promise<DdbConnection> {
		const client = new DdbClient(config);
		try { return new DdbConnection(client, await client.handshake()); }
		catch (error) { client.close(); throw error; }
	}

	static async launch(options: ManagedOptions): Promise<DdbConnection> {
		const directory = await mkdtemp(join(tmpdir(), "ddb-vscode-"));
		const tokenFile = join(directory, "token.json");
		const reportFile = join(directory, "startup.json");
		const bearerToken = randomBytes(32).toString("hex");
		let child: ChildProcess | undefined;
		let client: DdbClient | undefined;
		try {
			await writeFile(tokenFile, JSON.stringify({ tokens: [{ token: bearerToken, scope: "admin" }] }), { mode: 0o600 });
			const env = { ...process.env };
			for (const [key, value] of Object.entries(options.env ?? {})) {
				if (value === null) delete env[key]; else env[key] = value;
			}
			child = spawn(options.binary, managedArguments(options, tokenFile, reportFile), { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
			let launchError: Error | undefined;
			child.on("error", error => { launchError = error; });
			child.stdout?.on("data", chunk => options.onOutput?.("stdout", chunk.toString()));
			child.stderr?.on("data", chunk => options.onOutput?.("stderr", chunk.toString()));
			const deadline = Date.now() + (options.startupTimeoutMs ?? 30000);
			let report: StartupReport | undefined;
			while (!report) {
				if (launchError) throw launchError;
				try {
					if ((await stat(reportFile)).size > 16384) throw new Error("DDB startup report exceeds 16 KiB");
					report = JSON.parse(await readFile(reportFile, "utf8")) as StartupReport;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (report) break;
				if (child.exitCode !== null || child.signalCode !== null) throw new Error(`DDB exited before startup completed (${child.exitCode ?? child.signalCode})`);
				if (Date.now() >= deadline) throw new Error("Timed out waiting for DDB startup report");
				await delay(25);
			}
			if (report.protocol_version !== 1) throw new Error("Unsupported DDB startup report version");
			if (report.status !== "ready") throw new Error(`DDB startup failed during ${report.phase ?? "startup"}: ${report.message ?? report.code ?? "unknown error"}`);
			if (report.pid !== child.pid || !report.endpoint || !report.server_instance_id || !report.api_versions?.includes("v2")) {
				throw new Error("DDB startup report is missing or mismatches process identity");
			}
			const endpoint = new URL(report.endpoint);
			if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname) || !endpoint.port || endpoint.port === "0") {
				throw new Error("Managed DDB did not report a loopback endpoint with an allocated port");
			}
			client = new DdbClient({ endpoint: report.endpoint, bearerToken });
			const handshake = await client.handshake();
			if (handshake.serverInfo.serverInstanceId !== report.server_instance_id) throw new Error("DDB handshake does not match startup report identity");
			return new DdbConnection(client, handshake, { child, directory });
		} catch (error) {
			client?.close();
			if (child) await stopProcess(child);
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	async complete(admission: OperationAdmissionResponse): Promise<OperationResult> {
		let operation = admission.operation;
		if (!operation?.operationId) throw new DdbProtocolError("DDB omitted the admitted operation ID");
		if (!["OPERATION_STATE_COMPLETED", "OPERATION_STATE_FAILED", "OPERATION_STATE_CANCELLED"].includes(operation.state ?? "")) {
			operation = await this.client.waitOperation(operation.operationId);
		}
		return operationResult(operation);
	}

	/** The SDK handles replay gaps; requiredResync events also require rehydration. */
	async *states(): AsyncGenerator<StateSyncItem> {
		while (!this.client.closed) {
			try {
				for await (const item of this.client.stateSync({ sections: [
					"SNAPSHOT_SECTION_TOPOLOGY", "SNAPSHOT_SECTION_SELECTION", "SNAPSHOT_SECTION_EXECUTION",
					"SNAPSHOT_SECTION_BREAKPOINTS", "SNAPSHOT_SECTION_PENDING_OPERATIONS",
					"SNAPSHOT_SECTION_EXTENSIONS", "SNAPSHOT_SECTION_CAPABILITIES",
				] })) {
					if (item.type === "snapshot") {
						if (item.snapshot.serverInstanceId !== this.handshake.serverInfo.serverInstanceId) {
							throw new DdbProtocolError("DDB restarted; begin a new debug session to replace expired resource handles");
						}
						this.state.hydrate(item.snapshot);
					} else if (!this.state.apply(item.event)) continue;
					yield item;
				}
				return;
			} catch (error) {
				if (!(error instanceof ResyncRequired)) throw error;
			}
		}
	}

	close(): Promise<void> {
		return this.stopping ??= this.dispose();
	}

	private async dispose(): Promise<void> {
		try {
			if (this.owned && this.owned.child.exitCode === null && this.owned.child.signalCode === null) {
				try {
					// Shutdown may close the API before its final operation can be polled.
					await this.client.call("DdbAdminService.Shutdown", { target: { broadcast: {} }, gracePeriod: "2s" }, { timeoutMs: 2500 });
				} catch { /* The process fallback below also handles a dead API. */ }
				await waitForExit(this.owned.child, 2500);
			}
		} finally {
			this.client.close();
			if (this.owned) {
				await stopProcess(this.owned.child);
				await rm(this.owned.directory, { recursive: true, force: true });
			}
		}
	}
}

async function waitForExit(child: ChildProcess, timeout: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
	await new Promise<void>(resolve => {
		const done = () => { clearTimeout(timer); child.off("exit", done); resolve(); };
		const timer = setTimeout(done, timeout);
		child.once("exit", done);
	});
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
	child.kill("SIGTERM");
	await waitForExit(child, 1500);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await waitForExit(child, 1500);
	}
}
