import type { DebugProtocol } from "vscode-debugprotocol";
import type {
	Breakpoint,
	BreakpointSpec,
	Target,
} from "@ddb-debugger/api-client";
import type { DdbInspection } from "./inspection.mjs";
import { parseLogMessage, type LogPart } from "./logpoints.mjs";
import { Handles } from "./handles.mjs";

import type { SubBkpt } from "../backend/backend.js";
export type BreakpointTarget = SubBkpt;
export interface SourceBreakpoint extends DebugProtocol.SourceBreakpoint {
	subbkpts?: BreakpointTarget[];
}
type Request = SourceBreakpoint | DebugProtocol.FunctionBreakpoint;
interface Entry {
	request: Request;
	fingerprint: string;
	resource: Breakpoint;
	log?: LogPart[];
}

/** Legacy forms: N skips N hits then stops once; >N keeps stopping afterward. */
export function hitCondition(
	condition?: string,
): Pick<BreakpointSpec, "ignoreCount" | "temporary"> {
	if (!condition?.trim()) return {};
	const match = /^(>)?(\d+)$/.exec(condition.trim());
	if (!match)
		throw new Error(
			"Hit condition must be N or >N, where N is a nonnegative integer",
		);
	const count = BigInt(match[2]);
	if (count > 18446744073709551615n)
		throw new Error("Hit count exceeds the supported unsigned 64-bit range");
	if (!match[1] && count === 0n) return {};
	return { ignoreCount: count.toString(), temporary: !match[1] };
}

/** Reconciles source and function breakpoint sets through canonical operations. */
export class DdbBreakpoints {
	// The undefined key is the DAP function-breakpoint set.
	private readonly bySource = new Map<string | undefined, Entry[]>();
	private readonly handles = new Handles<string>();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly retiredLogs = new Map<string, LogPart[]>();
	private readonly pendingDeletes = new Set<string>();
	constructor(private readonly model: DdbInspection) {}

	set(
		source: string,
		requests: SourceBreakpoint[],
		modified = false,
	): Promise<DebugProtocol.Breakpoint[]> {
		const task = this.queue.then(() =>
			this.reconcile(source, requests, modified),
		);
		this.queue = task.catch(() => undefined);
		return task;
	}

	setFunctions(
		requests: DebugProtocol.FunctionBreakpoint[],
	): Promise<DebugProtocol.Breakpoint[]> {
		const task = this.queue.then(() =>
			this.reconcile(undefined, requests, false),
		);
		this.queue = task.catch(() => undefined);
		return task;
	}

	async ready(): Promise<void> {
		await this.queue;
	}

	logMessage(id: string): LogPart[] | undefined {
		for (const entries of this.bySource.values()) {
			const entry = entries.find((item) => item.resource.breakpointId === id);
			if (entry) return entry.log;
		}
		return this.retiredLogs.get(id);
	}

	private retire(entry: Entry): void {
		if (!entry.log) return;
		this.retiredLogs.set(entry.resource.breakpointId!, entry.log);
		while (this.retiredLogs.size > 1024)
			this.retiredLogs.delete(this.retiredLogs.keys().next().value!);
	}

	handle(id: string): number {
		return this.handles.put(id, id);
	}

	all(): DebugProtocol.Breakpoint[] {
		return [...this.bySource].flatMap(([source, entries]) =>
			entries.map((entry) => this.present(source, entry)),
		);
	}

	forget(resourceId: string): DebugProtocol.Breakpoint[] {
		// setBreakpoints already describes this removal to VS Code. Emitting a
		// second removal event would delete its disabled breakpoint entry.
		if (this.pendingDeletes.has(resourceId)) return [];
		const removed: DebugProtocol.Breakpoint[] = [];
		for (const [source, entries] of this.bySource) {
			for (let index = entries.length - 1; index >= 0; index--) {
				if (entries[index].resource.breakpointId !== resourceId) continue;
				this.retire(entries[index]);
				removed.push(this.present(source, entries[index]));
				entries.splice(index, 1);
			}
		}
		return removed;
	}

	/** List after earlier mutations complete; a snapshot can predate their results. */
	resynchronize(): Promise<DebugProtocol.Breakpoint[]> {
		const task = this.queue.then(async () => {
			const ids = [...this.bySource.values()].flatMap((entries) =>
				entries.map((entry) => entry.resource.breakpointId!),
			);
			if (!ids.length) return [];
			const current = await this.model.connection.client.collect(
				"DebuggerService.ListBreakpoints",
				{},
			);
			const live = new Set(
				current.map((breakpoint) => breakpoint.breakpointId),
			);
			return ids.filter((id) => !live.has(id)).flatMap((id) => this.forget(id));
		});
		this.queue = task.catch(() => undefined);
		return task;
	}

	/** Update DAP verification when installed group members change. */
	refresh(): DebugProtocol.Breakpoint[] {
		const changed: DebugProtocol.Breakpoint[] = [];
		for (const [source, entries] of this.bySource) {
			for (const entry of entries) {
				const current = this.model.connection.state.get(
					"breakpoint",
					entry.resource.breakpointId!,
				);
				if (
					!current ||
					BigInt(current.revision ?? "0") <=
						BigInt(entry.resource.revision ?? "0")
				)
					continue;
				const before = this.present(source, entry);
				entry.resource = current;
				const after = this.present(source, entry);
				if (JSON.stringify(before) !== JSON.stringify(after))
					changed.push(after);
			}
		}
		return changed;
	}

	private target(request: Request): Target | undefined {
		const state = this.model.connection.state;
		const subbkpts = "subbkpts" in request ? request.subbkpts : undefined;
		const targets: Target[] =
			subbkpts === undefined
				? [
						...state
							.all("group")
							.map((group) => ({ group: { groupId: group.groupId } })),
						...state
							.all("session")
							.filter((session) => !session.groupId)
							.map((session) => ({
								session: { sessionId: session.sessionId },
							})),
					]
				: subbkpts.map((selection) => {
						if (selection.type === "group")
							return {
								group: {
									groupId: this.model.groupHandles.get(selection.target),
								},
							};
						if (selection.type === "session")
							return this.model.sessionTarget(selection.target);
						throw new Error("Invalid breakpoint target type");
					});
		const unique = [
			...new Map(
				targets.map((target) => [JSON.stringify(target), target]),
			).entries(),
		]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, target]) => target);
		return unique.length ? { multiple: { targets: unique } } : undefined;
	}

	private async reconcile(
		source: string | undefined,
		requests: Request[],
		modified: boolean,
	): Promise<DebugProtocol.Breakpoint[]> {
		if (source !== undefined && !source)
			throw new Error("Breakpoint source path is required");
		const connection = this.model.connection;
		const previous = this.bySource.get(source) ?? [];
		const requested = requests.map((request) => {
			const location =
				source === undefined
					? {
							function: {
								functionName: (request as DebugProtocol.FunctionBreakpoint)
									.name,
							},
						}
					: {
							source: {
								source,
								line: (request as SourceBreakpoint).line,
								column: (request as SourceBreakpoint).column,
							},
						};
			if (location.function && !location.function.functionName?.trim())
				throw new Error("Breakpoint function name is required");
			if (
				location.source &&
				(!Number.isInteger(location.source.line) || location.source.line < 1)
			)
				throw new Error("Breakpoint line must be a positive integer");
			const hit = hitCondition(request.hitCondition);
			const logMessage =
				"logMessage" in request ? request.logMessage : undefined;
			const log =
				logMessage === undefined ? undefined : parseLogMessage(logMessage);
			const target = this.target(request);
			const fingerprint = JSON.stringify([
				location,
				request.condition ?? "",
				request.hitCondition ?? "",
				logMessage ?? "",
				target,
			]);
			return { request, target, fingerprint, location, logMessage, hit, log };
		});
		const entries = [...previous];
		this.bySource.set(source, entries);
		for (const entry of previous) {
			if (
				modified ||
				!requested.some((item) => item.fingerprint === entry.fingerprint)
			) {
				this.retire(entry);
				const id = entry.resource.breakpointId!;
				this.pendingDeletes.add(id);
				try {
					await connection.complete(
						await connection.client.call(
							"DebuggerControlService.DeleteBreakpoint",
							{ breakpointId: id, target: { broadcast: {} } },
						),
					);
					const index = entries.indexOf(entry);
					if (index >= 0) entries.splice(index, 1);
				} finally {
					this.pendingDeletes.delete(id);
				}
			}
		}
		const response: DebugProtocol.Breakpoint[] = [];
		for (const item of requested) {
			const existing = entries.find(
				(entry) => entry.fingerprint === item.fingerprint,
			);
			if (existing) {
				response.push(this.present(source, existing));
				continue;
			}
			try {
				if (!item.target)
					throw new Error("No sessions or groups selected for this breakpoint");
				const result = await connection.complete(
					await connection.client.call(
						"DebuggerControlService.CreateBreakpoint",
						{
							target: item.target,
							breakpoint: {
								...item.location,
								...item.hit,
								enabled: true,
								condition: item.request.condition || undefined,
							},
						},
					),
				);
				if (!result.breakpoint?.breakpointId)
					throw new Error("DDB omitted the breakpoint identity");
				const entry: Entry = {
					request: item.request,
					fingerprint: item.fingerprint,
					resource: result.breakpoint,
					log: item.log,
				};
				entries.push(entry);
				response.push(this.present(source, entry));
			} catch (error) {
				response.push({
					verified: false,
					source: source === undefined ? undefined : { path: source },
					line: (item.request as SourceBreakpoint).line,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return response;
	}

	private present(
		source: string | undefined,
		entry: Entry,
	): DebugProtocol.Breakpoint {
		return {
			id: this.handle(entry.resource.breakpointId!),
			verified: entry.resource.verified ?? false,
			line: (entry.request as SourceBreakpoint).line,
			source: source === undefined ? undefined : { path: source },
			message: entry.resource.message,
			...{
				subbkpts:
					("subbkpts" in entry.request ? entry.request.subbkpts : undefined) ??
					[],
			},
		};
	}
}
