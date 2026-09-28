import axios from "axios";

// Conditionally import vscode - only available in extension host
let vscode: any;
try {
	vscode = require("vscode");
} catch (e) {
	// vscode module not available (running in debug adapter process)
	vscode = null;
}

/**
 * Get the DDB service base URL from configuration or environment variable.
 * The adapter receives the extension's resolved URL at launch. Otherwise use
 * DDB_API_URL, vscode configuration, then the local default.
 */
let serviceUrl: string | undefined;

export function configureServiceUrl(url: string): void {
	serviceUrl = url.replace(/\/+$/, "");
}

export function getServiceUrl(): string {
	if (serviceUrl) return serviceUrl;
	// Priority 1: Environment variable (backward compatibility)
	if (process.env.DDB_API_URL) {
		return process.env.DDB_API_URL.replace(/\/+$/, "");
	}

	// Priority 2: VS Code configuration
	if (vscode) {
		const config = vscode.workspace.getConfiguration("ddb");
		return config
			.get("serviceUrl", "http://localhost:5000")
			.replace(/\/+$/, "");
	}

	// Priority 3: Default
	return "http://localhost:5000";
}

/**
 * Get the WebSocket URL for notifications.
 * Converts http:// to ws:// and https:// to wss://, then adds the notifications endpoint.
 */
export function getWebSocketUrl(): string {
	const baseUrl = getServiceUrl();
	// Convert http://localhost:5000 → ws://localhost:5000
	// Convert https://localhost:5000 → wss://localhost:5000
	const wsUrl = baseUrl.replace(/^http/, "ws");
	return `${wsUrl}/notifications/subscribe`;
}

enum Endpoint {
	GetSessions = "/sessions",
	ResolveSrcToGroupIds = "/src_to_grp_ids",
	ResolveSrcToGroups = "/src_to_grps",
	GetGroups = "/groups",
	GetGroup = "/group",
	GetBreakpoints = "/bkpts",
	PendingCommands = "/pcommands",
	FinishedCommands = "/fcommands",
	Status = "/status",
}

function get_url(endpoint: Endpoint): string {
	return `${getServiceUrl()}${endpoint}`;
}

export interface Session {
	sid: number;
	tag: string;
	alias: string;
	status: string;
	group?: {
		valid: boolean;
		id: number;
		hash: number;
	};
}

export interface ServiceStatus {
	status: "up" | "down";
}

export interface GetGroupQuery {
	grp_id?: number;
	grp_hash?: string;
}

export interface GroupIdsResponse {
	grp_ids: Set<number>;
}

export interface GroupsResponse {
	grps: LogicalGroup[];
}

export interface SourceResolver {
	src: string;
}

export interface LogicalGroup {
	id: number;
	hash: string;
	alias: string;
	sids: Set<number>;
}

// Breakpoint-related interfaces
export interface BreakpointLocation {
	src: string;
	line: number;
}

export interface SubBreakpoint {
	type: "session" | "group";
	id: number; // Sub-breakpoint's own ID
	target_session?: number; // Present when type === "session"
	target_group?: number; // Present when type === "group"
}

export interface DDBBreakpoint {
	id: number;
	location: BreakpointLocation;
	enabled: boolean;
	times: number;
	subbkpts: SubBreakpoint[];
}

export interface GetBreakpointsResponse {
	bkpts: DDBBreakpoint[];
}

export async function getSessions(): Promise<Session[]> {
	const response = await axios.get<Session[]>(get_url(Endpoint.GetSessions));
	return response.data;
}

export async function getServiceStatus(
	signal?: AbortSignal,
): Promise<ServiceStatus> {
	const response = await axios.get<ServiceStatus>(get_url(Endpoint.Status), {
		timeout: 5000,
		signal,
	});
	return response.data;
}

export async function waitForServiceReady(
	maxAttempts?: number,
	intervalMs?: number,
	signal?: AbortSignal,
): Promise<void> {
	// Read from VSCode settings or use defaults
	let attempts = maxAttempts ?? 30;
	let interval = intervalMs ?? 1000;

	if (vscode) {
		const config = vscode.workspace.getConfiguration("ddb");
		attempts = maxAttempts ?? config.get("pollMaxAttempts", 30);
		interval = intervalMs ?? config.get("pollIntervalMs", 1000);
	}

	let currentAttempt = 0;

	while (currentAttempt < attempts) {
		try {
			if (signal?.aborted) throw new Error("DDB startup cancelled");
			const status = await getServiceStatus(signal);
			if (status.status === "up") {
				console.error("DDB service is ready!");
				return;
			}
		} catch (error) {
			if (signal?.aborted) throw new Error("DDB startup cancelled");
			// Service not ready, continue polling
		}

		currentAttempt++;
		if (currentAttempt >= attempts) {
			throw new Error(`DDB service not ready after ${attempts} attempts`);
		}

		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

export async function getGroups(): Promise<LogicalGroup[]> {
	const response = await axios.get<LogicalGroup[]>(get_url(Endpoint.GetGroups));
	return response.data.map((group) => ({
		...group,
		sids: new Set(group.sids),
	}));
}

export async function getGroup(query: GetGroupQuery): Promise<LogicalGroup> {
	const response = await axios.get<LogicalGroup>(get_url(Endpoint.GetGroup), {
		params: query,
	});
	return {
		...response.data,
		sids: new Set(response.data.sids),
	};
}

/**
 * GET /src_to_grp_ids?src=...
 * Resolves a source string to a list of Group IDs
 */
export async function resolveSrcToGroupIds(src: string): Promise<Set<number>> {
	const response = await axios.get<GroupIdsResponse>(
		get_url(Endpoint.ResolveSrcToGroupIds),
		{
			params: { src } satisfies SourceResolver,
		},
	);
	return new Set(response.data.grp_ids);
}

/**
 * GET /src_to_grps?src=...
 * Resolves a source string to full GroupMeta objects
 */
export async function resolveSrcToGroups(src: string): Promise<LogicalGroup[]> {
	const response = await axios.get<GroupsResponse>(
		get_url(Endpoint.ResolveSrcToGroups),
		{
			params: { src } satisfies SourceResolver,
		},
	);
	return response.data.grps.map((group) => ({
		...group,
		sids: new Set(group.sids),
	}));
}

/**
 * GET /bkpts
 * Retrieves all breakpoints from the DDB backend
 */
export async function getBreakpoints(): Promise<DDBBreakpoint[]> {
	const response = await axios.get<GetBreakpointsResponse>(
		get_url(Endpoint.GetBreakpoints),
	);
	return response.data.bkpts;
}
export interface CommandResult {
	status: string;
	payload?: Record<string, unknown>;
}

async function completedCommand(
	endpoint: string,
	body: unknown,
): Promise<CommandResult> {
	try {
		const response = await axios.post<{
			data?: { state: string; result?: { responses: CommandResult[] } };
			error?: { message: string };
		}>(`${getServiceUrl()}${endpoint}`, body, { timeout: 30000 });
		if (response.data.error) throw new Error(response.data.error.message);
		const data = response.data.data;
		const results = data?.result?.responses;
		if (data?.state !== "completed" || !results?.length)
			throw new Error("DDB returned an incomplete command receipt");
		const failure = results.find((result) => result.status === "error");
		if (failure)
			throw new Error(String(failure.payload?.msg || "DDB command failed"));
		return results[0];
	} catch (error) {
		if (axios.isAxiosError(error) && error.response?.data?.error?.message) {
			throw new Error(error.response.data.error.message);
		}
		throw error;
	}
}

/** HTTP selection avoids tokenless MI thread-select replies in DDB 0.1.15. */
export async function selectThread(threadId: number): Promise<boolean> {
	const result = await completedCommand("/api/v1/threads/select", {
		thread_id: threadId,
	});
	if (result.status !== "done")
		throw new Error(`Thread selection failed: ${result.status}`);
	return true;
}

/** Commands with silent MI presentation still return explicit HTTP receipts. */
export function executeCommand(command: string): Promise<CommandResult> {
	return completedCommand("/api/v1/commands", { command, wait: true });
}
