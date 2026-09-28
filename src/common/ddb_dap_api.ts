import * as vscode from "vscode";
export type {
	LogicalGroup,
	GetGroupQuery,
	ServiceStatus,
	SubBreakpoint,
} from "./ddb_api";
import type {
	Session as LegacySession,
	LogicalGroup,
	GetGroupQuery,
	ServiceStatus,
	DDBBreakpoint as LegacyBreakpoint,
} from "./ddb_api";
export type Session = Omit<LegacySession, "group"> & {
	group?: { valid: boolean; id: number; hash: string };
};
export interface BreakpointHit {
	breakpointId: number;
	sessionId: number;
	threadId: number;
	threadName: string;
	stopRevision: string;
}
export type DDBBreakpoint = Omit<LegacyBreakpoint, "times"> & {
	times: string | number;
	hits?: BreakpointHit[];
};

function session(): vscode.DebugSession {
	const active = vscode.debug.activeDebugSession;
	if (!active || active.type !== "ddb")
		throw new Error("No active DDB debug session");
	return active;
}
export async function getSessions(): Promise<Session[]> {
	return (await session().customRequest("ddb.getSessions")).sessions;
}
export async function getGroups(): Promise<LogicalGroup[]> {
	return (await session().customRequest("ddb.getGroups")).groups.map(
		(group: LogicalGroup) => ({ ...group, sids: new Set(group.sids) }),
	);
}
export async function getGroup(query: GetGroupQuery): Promise<LogicalGroup> {
	const group = (await getGroups()).find((item) =>
		query.grp_id !== undefined
			? item.id === query.grp_id
			: item.hash === query.grp_hash,
	);
	if (!group) throw new Error("DDB group no longer exists");
	return group;
}
export async function resolveSrcToGroups(src: string): Promise<LogicalGroup[]> {
	return (
		await session().customRequest("ddb.resolveSourceGroups", { src })
	).grps.map((group: LogicalGroup) => ({
		...group,
		sids: new Set(group.sids),
	}));
}
export async function resolveSrcToGroupIds(src: string): Promise<Set<number>> {
	return new Set((await resolveSrcToGroups(src)).map((group) => group.id));
}
export async function getBreakpoints(): Promise<DDBBreakpoint[]> {
	return (await session().customRequest("ddb.getBreakpoints")).bkpts;
}
export async function getServiceStatus(): Promise<ServiceStatus> {
	return session().customRequest("ddb.status");
}
export async function waitForServiceReady(): Promise<void> {
	const active = session();
	const deadline = Date.now() + 30000;
	let lastError: unknown;
	while (
		vscode.debug.activeDebugSession?.id === active.id &&
		Date.now() < deadline
	) {
		try {
			if ((await active.customRequest("ddb.status")).status === "up") return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`DDB did not become ready: ${String(
			lastError ?? "session ended or timed out",
		)}`,
	);
}
