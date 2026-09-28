import { registerSessionControls } from "./sessionControls";
import * as vscode from "vscode";
import * as path from "path";
import { Breakpoint } from "vscode-debugadapter";
import { logger } from "./logger";
import * as ddb_api from "./common/ddb_dap_api";
import { SessionManager } from "./common/ddb_session_mgr";
import { BreakpointManager } from "./common/ddb_breakpoint_mgr";
import { NotificationService } from "./common/ddb_notification_service";
import {
	LogicalGroup,
	DDBBreakpoint,
	SubBreakpoint,
} from "./common/ddb_dap_api";
import { showDisclaimerIfNeeded } from "./common/disclaimer_service";
import { OTelService } from "./common/otel";

// ============================================================================
// Sessions Provider - Shows sessions organized by logical groups
// ============================================================================

class SessionsProvider implements vscode.TreeDataProvider<
	LogicalGroupItem | SessionItem | SessionItemDetail
> {
	private _onDidChangeTreeData: vscode.EventEmitter<
		LogicalGroupItem | SessionItem | SessionItemDetail | undefined | null | void
	> = new vscode.EventEmitter<
		LogicalGroupItem | SessionItem | SessionItemDetail | undefined | null | void
	>();
	readonly onDidChangeTreeData: vscode.Event<
		LogicalGroupItem | SessionItem | SessionItemDetail | undefined | null | void
	> = this._onDidChangeTreeData.event;

	private sessionManager: SessionManager;
	public isDebugSessionActive: boolean = false;
	private isGroupedMode: boolean = true; // Default to grouped mode
	private treeView?: vscode.TreeView<
		LogicalGroupItem | SessionItem | SessionItemDetail
	>;

	constructor() {
		this.sessionManager = SessionManager.getInstance();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	clearSessionData(): void {
		this.isDebugSessionActive = false;
		this.sessionManager.clearCache();
		this.refresh();
	}

	// Set TreeView reference to enable description updates
	public setTreeView(
		treeView: vscode.TreeView<
			LogicalGroupItem | SessionItem | SessionItemDetail
		>,
	): void {
		this.treeView = treeView;
	}

	// Update view description to show current mode
	private updateViewDescription(): void {
		if (this.treeView) {
			const description = this.isGroupedMode ? "Grouped" : "Flatten";
			this.treeView.description = description;
		}
	}

	// Toggle between grouped and flat mode
	public toggleGrouping(): void {
		this.isGroupedMode = !this.isGroupedMode;
		this.updateViewDescription();
		this.refresh();
	}

	public getIsGroupedMode(): boolean {
		return this.isGroupedMode;
	}

	// Reset to grouped mode and update description
	public resetToGroupedMode(): void {
		this.isGroupedMode = true;
		this.updateViewDescription();
	}

	// Clear view description
	public clearViewDescription(): void {
		if (this.treeView) {
			this.treeView.description = undefined;
		}
	}

	getTreeItem(
		element: LogicalGroupItem | SessionItem | SessionItemDetail,
	): vscode.TreeItem {
		return element;
	}

	async getChildren(
		element?: LogicalGroupItem | SessionItem | SessionItemDetail,
	): Promise<(LogicalGroupItem | SessionItem | SessionItemDetail)[]> {
		if (!element) {
			// Root level: Show logical groups or empty state
			if (!this.isDebugSessionActive) {
				return [
					new SessionItem(
						"Start DDB to view sessions",
						vscode.TreeItemCollapsibleState.None,
						false,
					),
				];
			}

			// Get all logical groups and sessions
			const groups = this.sessionManager.getAllGroups();
			const ungroupedSessions = this.sessionManager.getUngroupedSessions();

			if (groups.length === 0 && ungroupedSessions.length === 0) {
				return [
					new SessionItem(
						"No sessions found",
						vscode.TreeItemCollapsibleState.None,
						false,
					),
				];
			}

			// Return view based on mode
			if (this.isGroupedMode) {
				// GROUPED MODE: Return LogicalGroupItem array
				return this.getGroupedView(groups, ungroupedSessions);
			} else {
				// FLAT MODE: Return SessionItem array with group info
				return this.getFlatView(groups, ungroupedSessions);
			}
		} else if (element instanceof LogicalGroupItem) {
			// Logical group level: Show sessions in this group (only in grouped mode)
			if (element.isUngrouped) {
				return this.getUngroupedSessionItems();
			} else {
				return this.getSessionsForGroup(element.group.id);
			}
		} else if (element instanceof SessionItem) {
			// Session level: Show session details (works in both modes)
			if (element.sessionDetails) {
				const sessionDetails = element.sessionDetails;
				const sessionDetailsItems: SessionItemDetail[] = [];
				for (const key in sessionDetails) {
					if (Object.prototype.hasOwnProperty.call(sessionDetails, key)) {
						const value = sessionDetails[key];
						const sessionDetailItem = new SessionItemDetail(
							key,
							vscode.TreeItemCollapsibleState.None,
							value,
						);
						sessionDetailsItems.push(sessionDetailItem);
					}
				}
				return sessionDetailsItems;
			}
		}
		return [];
	}

	private formatSessionItem(session: ddb_api.Session): SessionItem {
		return new SessionItem(
			`[sid: ${session.sid}] ${session.alias}`,
			vscode.TreeItemCollapsibleState.Collapsed,
			true,
			session.status,
			session.sid,
			{
				"Session Alias": String(session.alias),
				"Session ID": String(session.sid),
				"Session Tag": session.tag,
			},
		);
	}

	private formatSessionItemWithLogicalGroup(
		session: ddb_api.Session,
		group?: LogicalGroup,
	): SessionItem {
		if (!group) {
			return new SessionItem(
				`["Ungrouped", sid: ${session.sid}] ${session.alias}`,
				vscode.TreeItemCollapsibleState.Collapsed, // Still expandable for details
				true,
				session.status,
				session.sid,
				{
					"Session Alias": String(session.alias),
					"Session ID": String(session.sid),
					"Session Tag": session.tag,
					"Belongs to Group (id)": "N/A",
					"Belongs to Group (alias)": "N/A",
				},
			);
		}
		return new SessionItem(
			`[grp_id: ${group.id}, sid: ${session.sid}] ${session.alias}`,
			vscode.TreeItemCollapsibleState.Collapsed, // Still expandable for details
			true,
			session.status,
			session.sid,
			{
				"Session Alias": String(session.alias),
				"Session ID": String(session.sid),
				"Session Tag": session.tag,
				"Belongs to Group (id)": String(group.id),
				"Belongs to Group (alias)": group.alias,
			},
		);
	}

	private getSessionsForGroup(groupId: number): SessionItem[] {
		try {
			const sessions = this.sessionManager.getSessionsByGroup(groupId);
			return sessions.map((session) => this.formatSessionItem(session));
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`Failed to fetch sessions for group ${groupId}: ${errorMessage}`,
			);
			return [];
		}
	}

	private getUngroupedSessionItems(): SessionItem[] {
		try {
			const sessions = this.sessionManager.getUngroupedSessions();
			return sessions.map((session) => this.formatSessionItem(session));
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`Failed to fetch ungrouped sessions: ${errorMessage}`);
			return [];
		}
	}

	private getGroupedView(
		groups: LogicalGroup[],
		ungroupedSessions: ddb_api.Session[],
	): LogicalGroupItem[] {
		const items: LogicalGroupItem[] = [];

		// Add all logical groups
		for (const group of groups) {
			const sessionCount = this.sessionManager.getSessionsByGroup(
				group.id,
			).length;
			items.push(new LogicalGroupItem(group, sessionCount, false));
		}

		// Add ungrouped sessions if any exist
		if (ungroupedSessions.length > 0) {
			items.push(
				new LogicalGroupItem(
					{
						id: -1,
						hash: "",
						alias: "Ungrouped",
						sids: new Set<number>(),
					} as LogicalGroup,
					ungroupedSessions.length,
					true,
				),
			);
		}

		return items;
	}

	private getFlatView(
		groups: LogicalGroup[],
		ungroupedSessions: ddb_api.Session[],
	): SessionItem[] {
		const items: SessionItem[] = [];

		// Add sessions from each logical group
		for (const group of groups) {
			const sessions = this.sessionManager.getSessionsByGroup(group.id);
			for (const session of sessions) {
				const groupInfo = `[${group.alias}]`;
				items.push(this.formatSessionItemWithLogicalGroup(session, group));
			}
		}

		// Add ungrouped sessions
		for (const session of ungroupedSessions) {
			items.push(this.formatSessionItemWithLogicalGroup(session));
		}

		return items;
	}
}

// ============================================================================
// Breakpoints Provider - Shows breakpoints with their associated sessions/groups
// ============================================================================

// Union type for all breakpoint tree items
type BreakpointTreeItem =
	| BreakpointFileItem
	| BreakpointItem
	| SubBreakpointItem
	| GroupSessionItem
	| PlaceholderItem;

class BreakpointsProvider implements vscode.TreeDataProvider<BreakpointTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<
		BreakpointTreeItem | undefined | null | void
	> = new vscode.EventEmitter<BreakpointTreeItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<
		BreakpointTreeItem | undefined | null | void
	> = this._onDidChangeTreeData.event;

	private breakpointManager: BreakpointManager;
	private sessionManager: SessionManager;
	public isDebugSessionActive: boolean = false;
	private isGroupedByFile: boolean = false; // Default: flat hierarchical view
	private treeView?: vscode.TreeView<BreakpointTreeItem>;

	constructor() {
		this.breakpointManager = BreakpointManager.getInstance();
		this.sessionManager = SessionManager.getInstance();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	clearSessionData(): void {
		this.isDebugSessionActive = false;
		this.refresh();
	}

	// Set TreeView reference to enable description updates
	public setTreeView(treeView: vscode.TreeView<BreakpointTreeItem>): void {
		this.treeView = treeView;
	}

	// Toggle between flat and grouped-by-file views
	public toggleGroupByFile(): void {
		this.isGroupedByFile = !this.isGroupedByFile;
		this.updateViewDescription();
		this.refresh();
	}

	// Update view description to show current mode
	private updateViewDescription(): void {
		if (this.treeView) {
			this.treeView.description = undefined;
			void vscode.commands.executeCommand(
				"setContext",
				"ddb.breakpointsGroupedByFile",
				this.isGroupedByFile,
			);
		}
	}

	// Reset to default view and update description
	public resetToDefaultView(): void {
		this.isGroupedByFile = false;
		this.updateViewDescription();
	}

	// Clear view description
	public clearViewDescription(): void {
		if (this.treeView) {
			this.treeView.description = undefined;
		}
	}

	getTreeItem(element: BreakpointTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(
		element?: BreakpointTreeItem,
	): Promise<BreakpointTreeItem[]> {
		if (!element) {
			// Root level
			if (!this.isDebugSessionActive) {
				return [new PlaceholderItem("Start DDB to view breakpoints")];
			}

			const breakpoints = this.breakpointManager.getAllBreakpoints();
			if (breakpoints.length === 0) {
				return [new PlaceholderItem("No breakpoints found")];
			}

			if (this.isGroupedByFile) {
				// Grouped by file view: return file items
				return this.getFileGroupedView();
			} else {
				// Flat hierarchical view: return breakpoint items directly
				return this.getFlatView(breakpoints);
			}
		}

		if (element instanceof BreakpointFileItem) {
			// File level: return breakpoints in this file
			const bps = this.breakpointManager.getBreakpointsByFile(element.filePath);
			return bps.map(
				(bp) =>
					new BreakpointItem(
						bp,
						`Line ${bp.location.line}`, // Filename is already shown by the parent.
						bp.subbkpts.length > 0 || !!bp.hits?.length
							? vscode.TreeItemCollapsibleState.Collapsed
							: vscode.TreeItemCollapsibleState.None,
					),
			);
		}

		if (element instanceof BreakpointItem) {
			// Breakpoint level: return sub-breakpoints (groups and sessions)
			return this.getSubBreakpointItems(element.breakpoint);
		}

		if (element instanceof SubBreakpointItem) {
			// Sub-breakpoint level: if it's a group, show sessions within it
			if (element.subbkpt.type === "group") {
				const groupId = element.subbkpt.target_group!;
				return this.getSessionsInGroup(groupId, element.breakpoint);
			}
			// Sessions are not expandable
			return [];
		}

		return [];
	}

	private getFlatView(breakpoints: DDBBreakpoint[]): BreakpointItem[] {
		return breakpoints.map((bp) => {
			const fileName = path.basename(bp.location.src);
			return new BreakpointItem(
				bp,
				bp.location.line > 0
					? `${fileName}:${bp.location.line}`
					: bp.location.src,
				bp.subbkpts.length > 0 || !!bp.hits?.length
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None,
			);
		});
	}

	private getFileGroupedView(): BreakpointFileItem[] {
		const files = this.breakpointManager.getUniqueFiles();
		return files.map((filePath) => {
			const bps = this.breakpointManager.getBreakpointsByFile(filePath);
			return new BreakpointFileItem(
				filePath,
				bps.length,
				bps.flatMap((bp) => bp.hits ?? []),
			);
		});
	}

	private getSubBreakpointItems(
		breakpoint: DDBBreakpoint,
	): SubBreakpointItem[] {
		const covered = new Set<number>();
		const items = breakpoint.subbkpts.map((sub) => {
			let displayName: string;
			let targetId: number;

			if (sub.type === "group") {
				targetId = sub.target_group!;
				const group = this.sessionManager.getGroup(targetId);
				displayName = group?.alias || `Group ${targetId}`;
			} else {
				targetId = sub.target_session!;
				const session = this.sessionManager.getSession(targetId);
				displayName = session?.alias || `Session ${targetId}`;
			}

			const sessions =
				sub.type === "group"
					? this.sessionManager
							.getSessionsByGroup(targetId)
							.map((session) => session.sid)
					: [targetId];
			for (const id of sessions) covered.add(id);
			return new SubBreakpointItem(
				sub,
				displayName,
				breakpoint,
				(breakpoint.hits ?? []).filter((hit) =>
					sessions.includes(hit.sessionId),
				),
			);
		});
		// Broadcast/thread targets may not have an explicit sidebar assignment.
		for (const hit of breakpoint.hits ?? []) {
			if (covered.has(hit.sessionId)) continue;
			covered.add(hit.sessionId);
			const session = this.sessionManager.getSession(hit.sessionId);
			items.push(
				new SubBreakpointItem(
					{
						type: "session",
						id: -hit.sessionId,
						target_session: hit.sessionId,
					},
					session?.alias ?? `Session ${hit.sessionId}`,
					breakpoint,
					breakpoint.hits!.filter((item) => item.sessionId === hit.sessionId),
				),
			);
		}
		return items;
	}

	private getSessionsInGroup(
		groupId: number,
		breakpoint: DDBBreakpoint,
	): BreakpointTreeItem[] {
		const group = this.sessionManager.getGroup(groupId);
		if (!group) {
			return [new PlaceholderItem("Currently no active session in this group")];
		}

		const sessions = this.sessionManager.getSessionsByGroup(groupId);
		if (sessions.length === 0) {
			return [new PlaceholderItem("Currently no active session in this group")];
		}
		return sessions.map(
			(session) => new GroupSessionItem(session, group, breakpoint),
		);
	}
}

// ============================================================================
// Tree Item Classes
// ============================================================================

class LogicalGroupItem extends vscode.TreeItem {
	constructor(
		public readonly group: LogicalGroup,
		public readonly sessionCount: number,
		public readonly isUngrouped: boolean = false,
	) {
		super(
			isUngrouped
				? `Ungrouped (${sessionCount})`
				: `[grp_id: ${group.id}] ${group.alias} (${sessionCount} sessions)`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		this.contextValue = "logicalGroup";
		this.tooltip = isUngrouped
			? `Sessions not belonging to any logical group`
			: `Logical Group Detail:\nGroup ID: ${group.id}\nGroup Alias: ${group.alias}\nGroup Hash: ${group.hash}\nNumber of Sessions: ${sessionCount}`;
	}
}

export type SessionControlItem = Pick<SessionItem, "sessionId">;

class SessionItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly showStatus: boolean,
		public readonly status?: string,
		public readonly sessionId?: number,
		public readonly sessionDetails?: any,
	) {
		super(label, collapsibleState);
		this.sessionDetails = sessionDetails;

		if (showStatus) {
			this.description = this.status;
			this.sessionId = sessionId;
			// Add a context value to enable right-click menu actions
			this.contextValue = "sessionItem";
		}
	}
}

class SessionItemDetail extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly description: string,
	) {
		super(label, collapsibleState);
		this.description = description;
	}
}

// Placeholder item for empty states
class PlaceholderItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.contextValue = "placeholder";
	}
}

// Represents a file grouping in grouped-by-file view
class BreakpointFileItem extends vscode.TreeItem {
	constructor(
		public readonly filePath: string,
		public readonly breakpointCount: number,
		public readonly hits: ddb_api.BreakpointHit[],
	) {
		super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = "breakpointFileItem";
		this.description = `${breakpointCount} breakpoint${
			breakpointCount === 1 ? "" : "s"
		}`;
		this.tooltip = new vscode.MarkdownString().appendText(
			`${filePath}\n${this.description}`,
		);
		this.iconPath = new vscode.ThemeIcon("file");
		showBreakpointHits(this, hits);
	}
}

function showBreakpointHits(
	item: vscode.TreeItem,
	hits: ddb_api.BreakpointHit[],
	arrow = false,
): void {
	if (!hits.length) return;
	const sessions = new Set(hits.map((hit) => hit.sessionId)).size;
	item.description = arrow
		? hits.length === 1
			? "Hit"
			: `Hit · ${hits.length} threads`
		: `Hit · ${sessions} session${sessions === 1 ? "" : "s"}`;
	item.contextValue += "Hit";
	if (arrow)
		item.iconPath = new vscode.ThemeIcon(
			"debug-stackframe",
			new vscode.ThemeColor("debugIcon.breakpointCurrentStackframeForeground"),
		);
	if (item.tooltip instanceof vscode.MarkdownString)
		item.tooltip.appendMarkdown(
			`\n\n**Currently paused here:** ${hits
				.map((hit) => `session ${hit.sessionId}, thread ${hit.threadName}`)
				.join("; ")}`,
		);
}

// Represents a single breakpoint
class BreakpointItem extends vscode.TreeItem {
	get hits(): ddb_api.BreakpointHit[] {
		return this.breakpoint.hits ?? [];
	}
	constructor(
		public readonly breakpoint: DDBBreakpoint,
		displayLabel: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
	) {
		super(displayLabel, collapsibleState);
		this.id = `breakpoint:${breakpoint.id}`;
		this.contextValue =
			breakpoint.location.src && breakpoint.location.line > 0
				? "sourceBreakpointItem"
				: "breakpointItem";
		this.description = breakpoint.enabled ? "" : "(disabled)";
		this.tooltip = new vscode.MarkdownString(
			`**Breakpoint ${breakpoint.id}**\n\n` +
				`- File: ${breakpoint.location.src}\n` +
				`- Line: ${breakpoint.location.line}\n` +
				`- Enabled: ${breakpoint.enabled}\n` +
				`- Hit count: ${breakpoint.times}\n` +
				`- Sub-breakpoints: ${breakpoint.subbkpts.length}`,
		);
		this.iconPath = new vscode.ThemeIcon(
			breakpoint.enabled ? "debug-breakpoint" : "debug-breakpoint-disabled",
			new vscode.ThemeColor(
				breakpoint.enabled
					? "debugIcon.breakpointForeground"
					: "debugIcon.breakpointDisabledForeground",
			),
		);
		showBreakpointHits(this, this.hits);
	}
}

// Represents a sub-breakpoint (session or group assignment)
// Groups are expandable to show sessions within them
class SubBreakpointItem extends vscode.TreeItem {
	constructor(
		public readonly subbkpt: SubBreakpoint,
		displayName: string,
		public readonly breakpoint: DDBBreakpoint,
		public readonly hits: ddb_api.BreakpointHit[],
	) {
		// Groups are expandable to show sessions within them
		const collapsibleState =
			subbkpt.type === "group"
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None;
		super(displayName, collapsibleState);
		this.id = `breakpoint:${breakpoint.id}:${subbkpt.type}:${
			subbkpt.type === "group" ? subbkpt.target_group : subbkpt.target_session
		}`;
		this.contextValue =
			subbkpt.type === "group" ? "groupSubBkpt" : "sessionSubBkpt";
		this.iconPath = new vscode.ThemeIcon(
			subbkpt.type === "group" ? "organization" : "debug",
		);
		this.description = subbkpt.type === "group" ? "Group" : "Session";
		const targetId =
			subbkpt.type === "group" ? subbkpt.target_group : subbkpt.target_session;
		this.tooltip = new vscode.MarkdownString().appendText(
			`${displayName}\n${this.description} ID: ${targetId}` +
				(subbkpt.id > 0 ? `\nSub-breakpoint ID: ${subbkpt.id}` : ""),
		);
		showBreakpointHits(this, hits, subbkpt.type === "session");
	}
}

// Represents a session within a group (when expanding group sub-breakpoints)
class GroupSessionItem extends vscode.TreeItem {
	readonly hits: ddb_api.BreakpointHit[];
	constructor(
		public readonly session: ddb_api.Session,
		public readonly group: LogicalGroup,
		breakpoint: DDBBreakpoint,
	) {
		super(
			session.alias || `Session ${session.sid}`,
			vscode.TreeItemCollapsibleState.None,
		);
		this.id = `breakpoint:${breakpoint.id}:group:${group.id}:session:${session.sid}`;
		this.hits = (breakpoint.hits ?? []).filter(
			(hit) => hit.sessionId === session.sid,
		);
		this.contextValue = "groupSessionItem";
		this.iconPath = new vscode.ThemeIcon("debug");
		this.description = session.status;
		this.tooltip = new vscode.MarkdownString(
			`**Session ${session.sid}**\n\n` +
				`- Alias: ${session.alias || "none"}\n` +
				`- Status: ${session.status}\n` +
				`- Tag: ${session.tag}\n` +
				`- Group: ${group.alias || `Group ${group.id}`}`,
		);
		showBreakpointHits(this, this.hits, true);
	}
}

// Commented out for future use - not implemented in backend yet
// class CommandItem extends vscode.TreeItem {
//   constructor(
//     public readonly label: string,
//     public readonly collapsibleState: vscode.TreeItemCollapsibleState,
//     public readonly type: "pending" | "finished",
//     public readonly commandData?: any
//   ) {
//     super(label, collapsibleState);
//     this.tooltip = this.label;
//     if (commandData) {
//       this.description = `${commandData.target_sessions.length}/${commandData.finished_sessions.length}`;
//       this.tooltip = `Token: ${commandData.token}\nCommand: ${
//         commandData.command
//       }\nTarget Sessions: ${commandData.target_sessions.join(
//         ", "
//       )}\nFinished Sessions: ${commandData.finished_sessions.join(", ")}`;
//     }
//   }
// }

// ============================================================================
// Activation and Registration
// ============================================================================

export function activate(context: vscode.ExtensionContext) {
	// Create providers
	const sessionsProvider = new SessionsProvider();
	const breakpointsProvider = new BreakpointsProvider();

	// Create tree views
	const sessionsTreeView = vscode.window.createTreeView("ddbSessionsExplorer", {
		treeDataProvider: sessionsProvider,
	});

	// Set TreeView reference to enable description updates
	sessionsProvider.setTreeView(sessionsTreeView);

	const breakpointsTreeView = vscode.window.createTreeView(
		"ddbBreakpointsExplorer",
		{
			treeDataProvider: breakpointsProvider,
		},
	);

	// Set TreeView reference for breakpoints provider
	breakpointsProvider.setTreeView(breakpointsTreeView);

	context.subscriptions.push(sessionsTreeView);
	context.subscriptions.push(breakpointsTreeView);

	// Get SessionManager instance (but don't start auto-refresh yet)
	const sessionManager = SessionManager.getInstance();

	// Get BreakpointManager instance
	const breakpointManager = BreakpointManager.getInstance();

	// Get NotificationService instance for EventStream notifications
	const notificationService = NotificationService.getInstance();

	// Subscribe to SessionManager updates for automatic tree refresh
	const sessionManagerUnsubscribe = sessionManager.onDataUpdated(() => {
		// Only refresh if tree is visible and debug session is active
		if (sessionsTreeView.visible && sessionsProvider.isDebugSessionActive) {
			sessionsProvider.refresh();
		}
	});

	context.subscriptions.push({ dispose: sessionManagerUnsubscribe });

	// Subscribe to BreakpointManager updates for automatic tree refresh
	const breakpointManagerUnsubscribe = breakpointManager.onDataUpdated(() => {
		// Only refresh if tree is visible and debug session is active
		if (
			breakpointsTreeView.visible &&
			breakpointsProvider.isDebugSessionActive
		) {
			breakpointsProvider.refresh();
		}
	});
	context.subscriptions.push({ dispose: breakpointManagerUnsubscribe });

	let activeSessionId: string | undefined;

	const snapshotUnsubscribe = notificationService.onNotification(
		"SnapshotChanged",
		async () => {
			if (!sessionsProvider.isDebugSessionActive) return;
			const snapshotSessionId = activeSessionId;
			try {
				const previous = breakpointManager.getAllBreakpoints();
				await Promise.all([
					sessionManager.updateAll(),
					breakpointManager.immediateUpdateAll(),
				]);
				if (
					!sessionsProvider.isDebugSessionActive ||
					activeSessionId !== snapshotSessionId
				)
					return;
				const current = breakpointManager.getAllBreakpoints();
				const paths = new Set(
					current.map(
						(bp) => `${path.normalize(bp.location.src)}:${bp.location.line}`,
					),
				);
				for (const removed of previous) {
					const key = `${path.normalize(removed.location.src)}:${
						removed.location.line
					}`;
					if (!paths.has(key))
						await vscode.commands.executeCommand(
							"ddb.internal.removeBreakpointSelection",
							key,
						);
				}
				await vscode.commands.executeCommand(
					"ddb.internal.syncBreakpointSelections",
					current,
				);
				await vscode.commands.executeCommand("ddb.internal.updateDecorations");
			} catch (error) {
				logger.error(`DDB view refresh failed: ${String(error)}`);
			}
		},
	);
	context.subscriptions.push({ dispose: snapshotUnsubscribe });

	// Subscribe to EventStream connection state changes
	const wsStateUnsubscribe = notificationService.onConnectionStateChange(
		(connected) => {
			if (sessionsProvider.isDebugSessionActive) {
				if (connected) {
					logger.debug(
						"[DDBViewProvider] EventStream connected, disabling polling",
					);
					sessionManager.setEventStreamActive(true);
					sessionManager.stopAutoRefresh(); // Stop polling
					breakpointManager.setEventStreamActive(true);
					breakpointManager.stopAutoRefresh(); // Stop polling
					Promise.all([
						sessionManager.updateAll(),
						breakpointManager.updateAll(),
					]).catch((error) =>
						logger.error("Failed to refresh DDB state after reconnect:", error),
					);
				} else {
					logger.debug(
						"[DDBViewProvider] EventStream disconnected, enabling polling fallback",
					);
					sessionManager.setEventStreamActive(false);
					sessionManager.startAutoRefresh(); // Resume polling as fallback
					breakpointManager.setEventStreamActive(false);
					breakpointManager.startAutoRefresh(); // Resume polling as fallback
				}
			}
		},
	);

	context.subscriptions.push({ dispose: wsStateUnsubscribe });

	// Debug session START listener
	const debugStartListener = vscode.debug.onDidStartDebugSession(
		async (debugSession) => {
			if (debugSession.type !== "ddb") return;
			activeSessionId = debugSession.id;
			// Mark debug sessions as active in both providers
			sessionsProvider.isDebugSessionActive = true;
			breakpointsProvider.isDebugSessionActive = true;

			// Show disclaimer notification if not suppressed (non-blocking)
			showDisclaimerIfNeeded();

			// Reset to grouped mode and show description
			sessionsProvider.resetToGroupedMode();

			// Reset breakpoints view to default
			breakpointsProvider.resetToDefaultView();

			try {
				// Ensure all DDB services are ready.
				await ddb_api.waitForServiceReady();
				if (activeSessionId !== debugSession.id) return;

				// Start EventStream notification service
				notificationService.start();

				const eventUpdates = notificationService.isConnected();
				sessionManager.setEventStreamActive(eventUpdates);
				breakpointManager.setEventStreamActive(eventUpdates);
				if (!eventUpdates) {
					sessionManager.startAutoRefresh();
					breakpointManager.startAutoRefresh();
				}

				// Trigger immediate update - fetch both sessions AND groups
				// Tree will auto-refresh via onDataUpdated event when data is ready
				await sessionManager.updateAll();
				if (activeSessionId !== debugSession.id) return;

				// Fetch initial breakpoint data (auto-refresh controlled by EventStream state above)
				await breakpointManager.updateAll();
			} catch (error) {
				logger.error(
					`[DDBViewProvider] DDB service not ready: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return;
			}
		},
	);

	// Stop producers before the adapter disconnects, rather than after termination.
	const stopViews = (debugSession: vscode.DebugSession) => {
		if (activeSessionId !== debugSession.id) return;
		activeSessionId = undefined;
		sessionsProvider.isDebugSessionActive = false;
		breakpointsProvider.isDebugSessionActive = false;
		notificationService.stop();
		sessionManager.setEventStreamActive(false);
		breakpointManager.setEventStreamActive(false);
		sessionManager.stopAutoRefresh();
		breakpointManager.stopAutoRefresh();
		breakpointManager.clearCache();
		sessionsProvider.clearSessionData();
		breakpointsProvider.clearSessionData();
		sessionsProvider.clearViewDescription();
		breakpointsProvider.clearViewDescription();
	};
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterTrackerFactory("ddb", {
			createDebugAdapterTracker: (debugSession) => ({
				onWillReceiveMessage: (message) => {
					if (
						message.command === "disconnect" ||
						message.command === "terminate"
					)
						stopViews(debugSession);
				},
				onWillStopSession: () => stopViews(debugSession),
			}),
		}),
	);
	const debugStopListener = vscode.debug.onDidTerminateDebugSession(
		(debugSession) => {
			if (debugSession.type !== "ddb") return;
			OTelService.log_info(`[activity] debug_session_stopped`);
			stopViews(debugSession);
		},
	);

	context.subscriptions.push(debugStartListener);
	context.subscriptions.push(debugStopListener);

	// Visibility listener for sessions view
	const sessionsVisibilityListener = sessionsTreeView.onDidChangeVisibility(
		(e) => {
			if (e.visible && sessionsProvider.isDebugSessionActive) {
				// Refresh tree when becoming visible during active debug session
				sessionsProvider.refresh();
			}
		},
	);

	context.subscriptions.push(sessionsVisibilityListener);

	const breakpointsVisibilityListener =
		breakpointsTreeView.onDidChangeVisibility((e) => {
			if (e.visible && breakpointsProvider.isDebugSessionActive) {
				// Refresh tree when becoming visible during active debug session
				breakpointsProvider.refresh();
			}
		});

	context.subscriptions.push(breakpointsVisibilityListener);

	// Initial refresh
	sessionsProvider.refresh();
	breakpointsProvider.refresh();

	// Manual refresh command for sessions view
	const sessionsRefreshCommand = vscode.commands.registerCommand(
		"ddbSessionsExplorer.refresh",
		async () => {
			if (!sessionsProvider.isDebugSessionActive) {
				vscode.window.showInformationMessage(
					"Cannot refresh: No active debug session. Did you start DDB already?",
				);
				return;
			}

			// Fetch fresh sessions AND groups (updates cache and returns fresh data)
			await sessionManager.fetchAll();
			// Tree will auto-refresh via event listener
		},
	);

	context.subscriptions.push(sessionsRefreshCommand);

	// Toggle grouping command for sessions view
	const toggleGroupingCommand = vscode.commands.registerCommand(
		"ddbSessionsExplorer.toggleGrouping",
		() => {
			if (!sessionsProvider.isDebugSessionActive) {
				vscode.window.showInformationMessage(
					"Cannot toggle: No active debug session. Did you start DDB already?",
				);
				return;
			}

			// Toggle the mode
			sessionsProvider.toggleGrouping();
		},
	);

	context.subscriptions.push(toggleGroupingCommand);

	// Show logical group details command
	const showLogicalGroupDetailsCommand = vscode.commands.registerCommand(
		"ddbSessionsExplorer.showLogicalGroupDetails",
		(item: LogicalGroupItem) => {
			if (item.isUngrouped) {
				vscode.window.showInformationMessage(
					"Sessions not belonging to any logical group",
				);
			} else {
				const message = [
					`Logical Group Details:`,
					``,
					`Group Alias: ${item.group.alias}`,
					`Group ID: ${item.group.id}`,
					`Group Hash: ${item.group.hash}`,
					`Number of Sessions: ${item.sessionCount}`,
				].join("\n");

				vscode.window.showInformationMessage(message, { modal: true });
			}
		},
	);

	context.subscriptions.push(showLogicalGroupDetailsCommand);

	// Manual refresh command for breakpoints view
	const breakpointsRefreshCommand = vscode.commands.registerCommand(
		"ddbBreakpointsExplorer.refresh",
		async () => {
			if (!breakpointsProvider.isDebugSessionActive) {
				vscode.window.showInformationMessage(
					"Cannot refresh: No active debug session. Did you start DDB already?",
				);
				return;
			}

			// Fetch fresh breakpoints (updates cache and returns fresh data)
			await breakpointManager.fetchAllBreakpoints();
			// Tree will auto-refresh via event listener
		},
	);

	context.subscriptions.push(breakpointsRefreshCommand);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"ddbBreakpointsExplorer.focusHit",
			async (item: { hits?: ddb_api.BreakpointHit[] }) => {
				const session = vscode.debug.activeDebugSession;
				if (session?.type !== "ddb" || !item?.hits?.length) return;
				const hits = item.hits;
				const hit =
					hits.length === 1
						? hits[0]
						: (
								await vscode.window.showQuickPick(
									hits.map((hit) => ({
										label:
											sessionManager.getSession(hit.sessionId)?.alias ??
											`Session ${hit.sessionId}`,
										description: `Session ${hit.sessionId} · Thread ${hit.threadName}`,
										hit,
									})),
									{
										title: "Go to Paused Frame",
										placeHolder:
											"Choose a thread currently hitting this breakpoint",
									},
								)
							)?.hit;
				if (!hit) return;
				try {
					// Open the view before the stop event arrives so VS Code can reveal and
					// select its frame row, including when the Call Stack was collapsed.
					await vscode.commands.executeCommand(
						"workbench.debug.action.focusCallStackView",
					);
					await session.customRequest("ddb.focusBreakpointHit", hit);
				} catch (error) {
					void vscode.window.showWarningMessage(
						`Could not focus breakpoint hit: ${String(error)}`,
					);
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"ddbBreakpointsExplorer.openSource",
			async (item: BreakpointItem) => {
				const location = item?.breakpoint?.location;
				if (
					!location?.src ||
					!Number.isInteger(location.line) ||
					location.line < 1
				)
					return;
				const line = location.line - 1;
				const session = vscode.debug.activeDebugSession;
				const base =
					session?.configuration.cwd ?? session?.workspaceFolder?.uri.fsPath;
				const file = base ? path.resolve(base, location.src) : location.src;
				await vscode.commands.executeCommand(
					"vscode.open",
					vscode.Uri.file(file),
					{
						selection: new vscode.Range(line, 0, line, 0),
					},
				);
			},
		),
	);

	// Toggle grouping command for breakpoints view
	const toggleBreakpointGroupingCommand = vscode.commands.registerCommand(
		"ddbBreakpointsExplorer.toggleGroupByFile",
		() => {
			if (!breakpointsProvider.isDebugSessionActive) {
				vscode.window.showInformationMessage(
					"Cannot toggle: No active debug session. Did you start DDB already?",
				);
				return;
			}

			// Toggle the mode
			breakpointsProvider.toggleGroupByFile();
		},
	);

	context.subscriptions.push(toggleBreakpointGroupingCommand);
	context.subscriptions.push(
		vscode.commands.registerCommand("ddbBreakpointsExplorer.showFlat", () => {
			if (!breakpointsProvider.isDebugSessionActive) return;
			breakpointsProvider.resetToDefaultView();
			breakpointsProvider.refresh();
		}),
	);

	registerSessionControls(vscode, context);
}

export function deactivate() {
	// Stop SessionManager auto-refresh when extension deactivates
	SessionManager.getInstance().stopAutoRefresh();
	// Stop BreakpointManager auto-refresh when extension deactivates
	BreakpointManager.getInstance().stopAutoRefresh();
}
