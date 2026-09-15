import type { DebugProtocol } from "vscode-debugprotocol";
import type { Breakpoint, Target } from "@ddb-debugger/api-client";
import type { DdbInspection } from "./inspection.mjs";
import { Handles } from "./handles.mjs";

import type { SubBkpt } from "../backend/backend.js";
export type BreakpointTarget = SubBkpt;
export interface SourceBreakpoint extends DebugProtocol.SourceBreakpoint { subbkpts?: BreakpointTarget[] }
type Request = SourceBreakpoint | DebugProtocol.FunctionBreakpoint;
interface Entry { request: Request; fingerprint: string; resource: Breakpoint }

/** Reconciles source and function breakpoint sets through canonical operations. */
export class DdbBreakpoints {
	// The undefined key is the DAP function-breakpoint set.
	private readonly bySource = new Map<string | undefined, Entry[]>();
	private readonly handles = new Handles<string>();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly model: DdbInspection) {}

	set(source: string, requests: SourceBreakpoint[], modified = false): Promise<DebugProtocol.Breakpoint[]> {
		const task = this.queue.then(() => this.reconcile(source, requests, modified));
		this.queue = task.catch(() => undefined);
		return task;
	}

	setFunctions(requests: DebugProtocol.FunctionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
		const task = this.queue.then(() => this.reconcile(undefined, requests, false));
		this.queue = task.catch(() => undefined);
		return task;
	}

	handle(id: string): number { return this.handles.put(id, id); }

	all(): DebugProtocol.Breakpoint[] {
		return [...this.bySource].flatMap(([source, entries]) => entries.map(entry => this.present(source, entry)));
	}

	/** Update DAP verification when installed group members change. */
	refresh(): DebugProtocol.Breakpoint[] {
		const changed: DebugProtocol.Breakpoint[] = [];
		for (const [source, entries] of this.bySource) {
			for (const entry of entries) {
				const current = this.model.connection.state.get("breakpoint", entry.resource.breakpointId!);
				if (!current || BigInt(current.revision ?? "0") <= BigInt(entry.resource.revision ?? "0")) continue;
				const before = this.present(source, entry);
				entry.resource = current;
				const after = this.present(source, entry);
				if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(after);
			}
		}
		return changed;
	}

	private target(request: Request): Target | undefined {
		const state = this.model.connection.state;
		const subbkpts = "subbkpts" in request ? request.subbkpts : undefined;
		const targets: Target[] = subbkpts === undefined
			? [
				...state.all("group").map(group => ({ group: { groupId: group.groupId } })),
				...state.all("session").filter(session => !session.groupId).map(session => ({ session: { sessionId: session.sessionId } })),
			]
			: subbkpts.map(selection => {
				if (selection.type === "group") return { group: { groupId: this.model.groupHandles.get(selection.target) } };
				if (selection.type === "session") return this.model.sessionTarget(selection.target);
				throw new Error("Invalid breakpoint target type");
			});
		const unique = [...new Map(targets.map(target => [JSON.stringify(target), target])).entries()]
			.sort(([left], [right]) => left.localeCompare(right)).map(([, target]) => target);
		return unique.length ? { multiple: { targets: unique } } : undefined;
	}

	private async reconcile(source: string | undefined, requests: Request[], modified: boolean): Promise<DebugProtocol.Breakpoint[]> {
		if (source !== undefined && !source) throw new Error("Breakpoint source path is required");
		const connection = this.model.connection;
		const previous = this.bySource.get(source) ?? [];
		const requested = requests.map(request => {
			const location = source === undefined
				? { function: { functionName: (request as DebugProtocol.FunctionBreakpoint).name } }
				: { source: { source, line: (request as SourceBreakpoint).line, column: (request as SourceBreakpoint).column } };
			if (location.function && !location.function.functionName?.trim()) throw new Error("Breakpoint function name is required");
			if (location.source && (!Number.isInteger(location.source.line) || location.source.line < 1)) throw new Error("Breakpoint line must be a positive integer");
			const logMessage = "logMessage" in request ? request.logMessage : undefined;
			const target = this.target(request);
			const fingerprint = JSON.stringify([location, request.condition ?? "", request.hitCondition ?? "", logMessage ?? "", target]);
			return { request, target, fingerprint, location, logMessage };
		});
		const entries = [...previous];
		this.bySource.set(source, entries);
		for (const entry of previous) {
			if (modified || !requested.some(item => item.fingerprint === entry.fingerprint)) {
				await connection.complete(await connection.client.call("DebuggerControlService.DeleteBreakpoint", { breakpointId: entry.resource.breakpointId, target: { broadcast: {} } }));
				entries.splice(entries.indexOf(entry), 1);
			}
		}
		const response: DebugProtocol.Breakpoint[] = [];
		for (const item of requested) {
			const existing = entries.find(entry => entry.fingerprint === item.fingerprint);
			if (existing) { response.push(this.present(source, existing)); continue; }
			try {
				if (!item.target) throw new Error("No sessions or groups selected for this breakpoint");
				if (item.logMessage) throw new Error("Canonical logpoint handling is not yet implemented");
				if (item.request.hitCondition) throw new Error("Canonical hit-condition handling is not yet implemented");
				const result = await connection.complete(await connection.client.call("DebuggerControlService.CreateBreakpoint", {
					target: item.target, breakpoint: { ...item.location, enabled: true, condition: item.request.condition || undefined },
				}));
				if (!result.breakpoint?.breakpointId) throw new Error("DDB omitted the breakpoint identity");
				const entry: Entry = { request: item.request, fingerprint: item.fingerprint, resource: result.breakpoint };
				entries.push(entry);
				response.push(this.present(source, entry));
			} catch (error) {
				response.push({ verified: false, source: source === undefined ? undefined : { path: source }, line: (item.request as SourceBreakpoint).line, message: error instanceof Error ? error.message : String(error) });
			}
		}
		return response;
	}

	private present(source: string | undefined, entry: Entry): DebugProtocol.Breakpoint {
		return {
			id: this.handle(entry.resource.breakpointId!),
			verified: entry.resource.verified ?? false, line: (entry.request as SourceBreakpoint).line,
			source: source === undefined ? undefined : { path: source }, message: entry.resource.message,
			...{ subbkpts: ("subbkpts" in entry.request ? entry.request.subbkpts : undefined) ?? [] },
		};
	}
}
