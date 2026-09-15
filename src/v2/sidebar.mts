import { DdbApiError, type Target } from "@ddb-debugger/api-client";
import type { DdbInspection } from "./inspection.mjs";
import type { DdbBreakpoints } from "./breakpoints.mjs";
import { Handles } from "./handles.mjs";

/** Sidebar DTOs use adapter-local handles; no canonical IDs cross as numbers. */
export class DdbSidebar {
	private readonly subHandles = new Handles<string>();
	constructor(private readonly model: DdbInspection, private readonly breakpoints: DdbBreakpoints) {}

	groups() {
		return this.model.connection.state.all("group").map(group => ({
			id: this.model.groupHandles.put(group.groupId!, group.groupId!), alias: group.displayName ?? "Group",
			hash: group.groupId!, sids: (group.sessionIds ?? []).map(id => this.model.sessionHandle(id)),
		}));
	}

	breakpointSnapshot() {
		return this.model.connection.state.all("breakpoint").map(breakpoint => {
			const targets: { type: "group" | "session"; id: number; target_group?: number; target_session?: number }[] = [];
			const seen = new Set<string>();
			const visit = (target: Target) => {
				if (target.multiple) { for (const child of target.multiple.targets ?? []) visit(child); }
				if (target.group?.groupId) {
					const id = target.group.groupId;
					if (seen.has(id)) return;
					seen.add(id);
					const key = JSON.stringify([breakpoint.breakpointId, "group", id]);
					targets.push({ type: "group", id: this.subHandles.put(key, key), target_group: this.model.groupHandles.put(id, id) });
				}
				if (target.session?.sessionId) {
					const id = target.session.sessionId;
					if (seen.has(id)) return;
					seen.add(id);
					const key = JSON.stringify([breakpoint.breakpointId, "session", id]);
					targets.push({ type: "session", id: this.subHandles.put(key, key), target_session: this.model.sessionHandle(id) });
				}
			};
			if (breakpoint.target) visit(breakpoint.target);
			return {
				id: this.breakpoints.handle(breakpoint.breakpointId!),
				location: { src: breakpoint.spec?.source?.source ?? "", line: breakpoint.spec?.source?.line ?? 0 },
				enabled: breakpoint.spec?.enabled ?? true, times: breakpoint.hitCount ?? "0", subbkpts: targets,
				verified: breakpoint.verified ?? false, pending: breakpoint.pending ?? false, message: breakpoint.message,
			};
		});
	}

	async sourceGroups(source: string) {
		if (!source) throw new Error("Source path is required");
		const groups = this.groups();
		const matches: typeof groups = [];
		for (let offset = 0; offset < groups.length; offset += 4) {
			const results = await Promise.all(groups.slice(offset, offset + 4).map(async group => {
				try {
					await this.model.connection.client.call("DebuggerService.ResolveSource", {
						target: { group: { groupId: this.model.groupHandles.get(group.id) } }, location: { path: source },
					});
					return group;
				} catch (error) {
					if (error instanceof DdbApiError && error.detail.code === "DDB_ERROR_CODE_NOT_FOUND") return undefined;
					throw error;
				}
			}));
			for (const group of results) if (group) matches.push(group);
		}
		return matches;
	}
}
