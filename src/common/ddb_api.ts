import axios from "axios";

const apiBaseUrl = process.env.DDB_API_URL || "http://localhost:5000";

// Conditionally import vscode - only available in extension host
let vscode: any;
try {
  vscode = require("vscode");
} catch (e) {
  // vscode module not available (running in debug adapter process)
  vscode = null;
}

enum Endpoint {
  GetSessions = "/sessions",
  ResolveSrcToGroupIds = "/src_to_grp_ids",
  ResolveSrcToGroups = "/src_to_grps",
  GetGroups = "/groups",
  GetGroup = "/group",
  PendingCommands = "/pcommands",
  FinishedCommands = "/fcommands",
  Status = "/status",
}

function get_url(endpoint: Endpoint): string {
  return `${apiBaseUrl}${endpoint}`;
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

export async function getSessions(): Promise<Session[]> {
  const response = await axios.get<Session[]>(get_url(Endpoint.GetSessions));
  return response.data;
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  const response = await axios.get<ServiceStatus>(get_url(Endpoint.Status));
  return response.data;
}

export async function waitForServiceReady(
  maxAttempts?: number,
  intervalMs?: number
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
      const status = await getServiceStatus();
      if (status.status === "up") {
        console.log("DDB service is ready!");
        return;
      }
    } catch (error) {
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
  return response.data;
}

export async function getGroup(query: GetGroupQuery): Promise<LogicalGroup> {
  const response = await axios.get<LogicalGroup>(get_url(Endpoint.GetGroup), { params: query });
  return {
    ...response.data,
    sids: new Set(response.data.sids),
  }
}

/**
 * GET /src_to_grp_ids?src=...
 * Resolves a source string to a list of Group IDs
 */
export async function resolveSrcToGroupIds(src: string): Promise<Set<number>> {
  const response = await axios.get<GroupIdsResponse>(get_url(Endpoint.ResolveSrcToGroupIds), {
    params: { src } satisfies SourceResolver
  });
  return new Set(response.data.grp_ids);
}

/**
 * GET /src_to_grps?src=...
 * Resolves a source string to full GroupMeta objects
 */
export async function resolveSrcToGroups(src: string): Promise<LogicalGroup[]> {
  const response = await axios.get<GroupsResponse>(get_url(Endpoint.ResolveSrcToGroups), {
    params: { src } satisfies SourceResolver
  });
  return response.data.grps;
}