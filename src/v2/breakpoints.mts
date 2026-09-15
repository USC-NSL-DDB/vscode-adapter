import type { DebugProtocol } from "vscode-debugprotocol";
import type { Breakpoint, Target } from "@ddb-debugger/api-client";
import type { DdbInspection } from "./inspection.mjs";
import { Handles } from "./handles.mjs";

import type { SubBkpt } from "../backend/backend.js";
export type BreakpointTarget = SubBkpt;
export interface SourceBreakpoint extends DebugProtocol.SourceBreakpoint { subbkpts?: BreakpointTarget[] }
interface Entry { request: SourceBreakpoint; fingerprint: string; resource: Breakpoint }

/** Reconciles each source's complete requested breakpoint set with DDB. */
export class DdbBreakpoints {
	private readonly bySource = new Map<string, Entry[]>();
	private readonly handles = new Handles<string>();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly model: DdbInspection) {}

	set(source: string, requests: SourceBreakpoint[], modified = false): Promise<DebugProtocol.Breakpoint[]> {
		const task = this.queue.then(() => this.reconcile(source, requests, modified));
		this.queue = task.catch(() => undefined);
		return task;
	}

	all(): DebugProtocol.Breakpoint[] {
		return [...this.bySource].flatMap(([source, entries]) => entries.map(entry => this.present(source, entry)));
	}

	private target(request: SourceBreakpoint): Target | undefined {
		const state = this.model.connection.state;
		const targets: Target[] = request.subbkpts === undefined
			? [
				...state.all("group").map(group => ({ group: { groupId: group.groupId } })),
				...state.all("session").filter(session => !session.groupId).map(session => ({ session: { sessionId: session.sessionId } })),
			]
			: request.subbkpts.map(selection => {
				if (selection.type === "group") return { group: { groupId: this.model.groupHandles.get(selection.target) } };
				if (selection.type === "session") return this.model.sessionTarget(selection.target);
				throw new Error("Invalid breakpoint target type");
			});
		const unique = [...new Map(targets.map(target => [JSON.stringify(target), target])).entries()]
			.sort(([left], [right]) => left.localeCompare(right)).map(([, target]) => target);
		return unique.length ? { multiple: { targets: unique } } : undefined;
	}

	private async reconcile(source: string, requests: SourceBreakpoint[], modified: boolean): Promise<DebugProtocol.Breakpoint[]> {
		if (!source) throw new Error("Breakpoint source path is required");
		const connection = this.model.connection;
		const previous = this.bySource.get(source) ?? [];
		const requested = requests.map(request => {
			if (!Number.isInteger(request.line) || request.line < 1) throw new Error("Breakpoint line must be a positive integer");
			const target = this.target(request);
			const fingerprint = JSON.stringify([request.line, request.column, request.condition ?? "", request.hitCondition ?? "", request.logMessage ?? "", target]);
			return { request, target, fingerprint };
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
				if (item.request.logMessage) throw new Error("Canonical logpoint handling is not yet implemented");
				if (item.request.hitCondition) throw new Error("Canonical hit-condition handling is not yet implemented");
				const result = await connection.complete(await connection.client.call("DebuggerControlService.CreateBreakpoint", {
					target: item.target, breakpoint: { source: { source, line: item.request.line, column: item.request.column }, enabled: true, condition: item.request.condition || undefined },
				}));
				if (!result.breakpoint?.breakpointId) throw new Error("DDB omitted the breakpoint identity");
				const entry: Entry = { request: item.request, fingerprint: item.fingerprint, resource: result.breakpoint };
				entries.push(entry);
				response.push(this.present(source, entry));
			} catch (error) {
				response.push({ verified: false, source: { path: source }, line: item.request.line, message: error instanceof Error ? error.message : String(error) });
			}
		}
		return response;
	}

	private present(source: string, entry: Entry): DebugProtocol.Breakpoint {
		return {
			id: this.handles.put(entry.resource.breakpointId!, entry.resource.breakpointId!),
			verified: entry.resource.verified ?? false, line: entry.request.line,
			source: { path: source }, message: entry.resource.message,
			...{ subbkpts: entry.request.subbkpts ?? [] },
		};
	}
}
