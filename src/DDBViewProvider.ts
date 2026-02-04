import * as vscode from "vscode";
import * as path from "path";
import { Breakpoint } from "vscode-debugadapter";
import { logger } from "./logger";
import * as ddb_api from "./common/ddb_api";
import { SessionManager } from "./common/ddb_session_mgr";
import { BreakpointManager } from "./common/ddb_breakpoint_mgr";
import { NotificationService, BreakpointChangedPayload } from "./common/ddb_notification_service";
import { LogicalGroup, DDBBreakpoint, SubBreakpoint } from "./common/ddb_api";
import { showDisclaimerIfNeeded } from "./common/disclaimer_service";
import { OTelService } from "./common/otel";

// ============================================================================
// Sessions Provider - Shows sessions organized by logical groups
// ============================================================================

class SessionsProvider
  implements
  vscode.TreeDataProvider<LogicalGroupItem | SessionItem | SessionItemDetail> {
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
    >
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
    element: LogicalGroupItem | SessionItem | SessionItemDetail
  ): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: LogicalGroupItem | SessionItem | SessionItemDetail
  ): Promise<(LogicalGroupItem | SessionItem | SessionItemDetail)[]> {
    if (!element) {
      // Root level: Show logical groups or empty state
      if (!this.isDebugSessionActive) {
        return [
          new SessionItem(
            "Start DDB to view sessions",
            vscode.TreeItemCollapsibleState.None,
            false
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
            false
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
              value
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
      String(session.sid),
      {
        "Session Alias": String(session.alias),
        "Session ID": String(session.sid),
        "Session Tag": session.tag,
      }
    );
  }

  private formatSessionItemWithLogicalGroup(
    session: ddb_api.Session,
    group?: LogicalGroup
  ): SessionItem {
    if (!group) {
      return new SessionItem(
        `["Ungrouped", sid: ${session.sid}] ${session.alias}`,
        vscode.TreeItemCollapsibleState.Collapsed, // Still expandable for details
        true,
        session.status,
        String(session.sid),
        {
          "Session Alias": String(session.alias),
          "Session ID": String(session.sid),
          "Session Tag": session.tag,
          "Belongs to Group (id)": "N/A",
          "Belongs to Group (alias)": "N/A",
        }
      );
    }
    return new SessionItem(
      `[grp_id: ${group.id}, sid: ${session.sid}] ${session.alias}`,
      vscode.TreeItemCollapsibleState.Collapsed, // Still expandable for details
      true,
      session.status,
      String(session.sid),
      {
        "Session Alias": String(session.alias),
        "Session ID": String(session.sid),
        "Session Tag": session.tag,
        "Belongs to Group (id)": String(group.id),
        "Belongs to Group (alias)": group.alias,
      }
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
        `Failed to fetch sessions for group ${groupId}: ${errorMessage}`
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
    ungroupedSessions: ddb_api.Session[]
  ): LogicalGroupItem[] {
    const items: LogicalGroupItem[] = [];

    // Add all logical groups
    for (const group of groups) {
      const sessionCount = this.sessionManager.getSessionsByGroup(
        group.id
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
          true
        )
      );
    }

    return items;
  }

  private getFlatView(
    groups: LogicalGroup[],
    ungroupedSessions: ddb_api.Session[]
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

class BreakpointsProvider
  implements vscode.TreeDataProvider<BreakpointTreeItem> {
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
      this.treeView.description = this.isGroupedByFile
        ? "Grouped by File"
        : "Flat";
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
    element?: BreakpointTreeItem
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
            `:${bp.location.line}`, // Short form for grouped view
            bp.subbkpts.length > 0
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None
          )
      );
    }

    if (element instanceof BreakpointItem) {
      // Breakpoint level: return sub-breakpoints (groups and sessions)
      return this.getSubBreakpointItems(element.breakpoint.subbkpts);
    }

    if (element instanceof SubBreakpointItem) {
      // Sub-breakpoint level: if it's a group, show sessions within it
      if (element.subbkpt.type === "group") {
        const groupId = element.subbkpt.target_group!;
        return this.getSessionsInGroup(groupId);
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
        `[bkpt ${bp.id}] ${fileName}:${bp.location.line}`,
        bp.subbkpts.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
    });
  }

  private getFileGroupedView(): BreakpointFileItem[] {
    const files = this.breakpointManager.getUniqueFiles();
    return files.map((filePath) => {
      const bps = this.breakpointManager.getBreakpointsByFile(filePath);
      return new BreakpointFileItem(filePath, bps.length);
    });
  }

  private getSubBreakpointItems(subbkpts: SubBreakpoint[]): SubBreakpointItem[] {
    return subbkpts.map((sub) => {
      let displayName: string;
      let targetId: number;

      if (sub.type === "group") {
        targetId = sub.target_group!;
        const group = this.sessionManager.getGroup(targetId);
        displayName = `[Group, grp_id: ${targetId}] ${group?.alias || `Group ${targetId}`}`;
      } else {
        targetId = sub.target_session!;
        const session = this.sessionManager.getSession(targetId);
        displayName = `[Session, sid: ${targetId}] ${session?.alias || `Session ${targetId}`}`;
      }

      return new SubBreakpointItem(sub, displayName);
    });
  }

  private getSessionsInGroup(groupId: number): BreakpointTreeItem[] {
    const group = this.sessionManager.getGroup(groupId);
    if (!group) {
      return [new PlaceholderItem("Currently no active session in this group")];
    }

    const sessions = this.sessionManager.getSessionsByGroup(groupId);
    if (sessions.length === 0) {
      return [new PlaceholderItem("Currently no active session in this group")];
    }
    return sessions.map((session) => new GroupSessionItem(session, group));
  }
}

// ============================================================================
// Tree Item Classes
// ============================================================================

class LogicalGroupItem extends vscode.TreeItem {
  constructor(
    public readonly group: LogicalGroup,
    public readonly sessionCount: number,
    public readonly isUngrouped: boolean = false
  ) {
    super(
      isUngrouped
        ? `Ungrouped (${sessionCount})`
        : `[grp_id: ${group.id}] ${group.alias} (${sessionCount} sessions)`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = "logicalGroup";
    this.tooltip = isUngrouped
      ? `Sessions not belonging to any logical group`
      : `Logical Group Detail:\nGroup ID: ${group.id}\nGroup Alias: ${group.alias}\nGroup Hash: ${group.hash}\nNumber of Sessions: ${sessionCount}`;
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly showStatus: boolean,
    public readonly status?: string,
    public readonly sessionId?: string,
    public readonly sessionDetails?: any
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
    public readonly description: string
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
    public readonly breakpointCount: number
  ) {
    super(
      `${path.basename(filePath)} (${breakpointCount} breakpoint${breakpointCount !== 1 ? "s" : ""})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = "breakpointFileItem";
    this.tooltip = filePath;
    this.iconPath = new vscode.ThemeIcon("file");
  }
}

// Represents a single breakpoint
class BreakpointItem extends vscode.TreeItem {
  constructor(
    public readonly breakpoint: DDBBreakpoint,
    displayLabel: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(displayLabel, collapsibleState);
    this.contextValue = "breakpointItem";
    this.description = breakpoint.enabled ? "" : "(disabled)";
    this.tooltip = new vscode.MarkdownString(
      `**Breakpoint ${breakpoint.id}**\n\n` +
      `- File: ${breakpoint.location.src}\n` +
      `- Line: ${breakpoint.location.line}\n` +
      `- Enabled: ${breakpoint.enabled}\n` +
      `- Hit count: ${breakpoint.times}\n` +
      `- Sub-breakpoints: ${breakpoint.subbkpts.length}`
    );
    this.iconPath = new vscode.ThemeIcon(
      breakpoint.enabled ? "debug-breakpoint" : "debug-breakpoint-disabled"
    );
  }
}

// Represents a sub-breakpoint (session or group assignment)
// Groups are expandable to show sessions within them
class SubBreakpointItem extends vscode.TreeItem {
  constructor(
    public readonly subbkpt: SubBreakpoint,
    displayName: string
  ) {
    // Groups are expandable to show sessions within them
    const collapsibleState =
      subbkpt.type === "group"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    super(displayName, collapsibleState);
    this.contextValue =
      subbkpt.type === "group" ? "groupSubBkpt" : "sessionSubBkpt";
    this.iconPath = new vscode.ThemeIcon(
      subbkpt.type === "group" ? "folder" : "debug"
    );
    const targetId =
      subbkpt.type === "group" ? subbkpt.target_group : subbkpt.target_session;
    this.tooltip = `${subbkpt.type === "group" ? "Group" : "Session"} ID: ${targetId}`;
  }
}

// Represents a session within a group (when expanding group sub-breakpoints)
class GroupSessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: ddb_api.Session,
    public readonly group: LogicalGroup
  ) {
    super(
      `↳ [sid: ${session.sid}] ${session.alias || "unnamed"}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = "groupSessionItem";
    // this.iconPath = new vscode.ThemeIcon("debug");
    this.description = session.status;
    this.tooltip = new vscode.MarkdownString(
      `**Session ${session.sid}**\n\n` +
        `- Alias: ${session.alias || "none"}\n` +
        `- Status: ${session.status}\n` +
        `- Tag: ${session.tag}\n` +
        `- Group: ${group.alias || `Group ${group.id}`}`
    );
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
    }
  );

  // Set TreeView reference for breakpoints provider
  breakpointsProvider.setTreeView(breakpointsTreeView);

  context.subscriptions.push(sessionsTreeView);
  context.subscriptions.push(breakpointsTreeView);

  // Get SessionManager instance (but don't start auto-refresh yet)
  const sessionManager = SessionManager.getInstance();

  // Get BreakpointManager instance
  const breakpointManager = BreakpointManager.getInstance();

  // Get NotificationService instance for WebSocket notifications
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

  // Subscribe to SessionListChanged notifications from backend
  const sessionNotificationUnsubscribe = notificationService.onNotification(
    "SessionListChanged",
    async () => {
      if (sessionsProvider.isDebugSessionActive) {
        logger.debug(
          "[DDBViewProvider] SessionListChanged notification received, updating data"
        );
        await sessionManager.updateAll(); // Fetch fresh data
        // View auto-refreshes via SessionManager.onDataUpdated listener
      }
    }
  );
  context.subscriptions.push({ dispose: sessionNotificationUnsubscribe });
  
  // Subscribe to BreakpointChanged notifications from backend
  const bkptNotificationUnsubscribe = notificationService.onNotification(
    "BreakpointChanged",
    async (data: BreakpointChangedPayload) => {
      if (sessionsProvider.isDebugSessionActive) {
        logger.debug(
          `[DDBViewProvider] BreakpointChanged notification received, type: ${data.type}`
        );

        if (data.type === "TargetChanged") {
          // Session was added to or removed from a group - group membership changed
          // The breakpoint targets haven't changed, just the underlying group composition
          logger.debug(
            `[DDBViewProvider] TargetChanged: refreshing session data`
          );
          await sessionManager.updateAll();
          breakpointManager.notifyDataChange(); // Notify breakpoint view to refresh as well
        }

        if (data.type === "Removed") {
          const breakpointId = data.data as number;
          logger.debug(
            `[DDBViewProvider] Breakpoint ${breakpointId} removed from backend`
          );

          // Get the breakpoint info before it's removed from cache (for cleanup)
          const removedBp = breakpointManager.getBreakpoint(breakpointId);

          // Refresh the cache
          await breakpointManager.immediateUpdateAll();

          // If we had the breakpoint info, clean up VSCode breakpoint and decorations
          if (removedBp) {
            const bpId = `${path.normalize(removedBp.location.src)}:${removedBp.location.line}`;
            // Remove from selections map via command
            await vscode.commands.executeCommand(
              "ddb.internal.removeBreakpointSelection",
              bpId
            );
          }
          // Update editor decorations
          await vscode.commands.executeCommand("ddb.internal.updateDecorations");
        }

        if (data.type === "Added") {
          const newBreakpoint = data.data as DDBBreakpoint;
          logger.debug(
            `[DDBViewProvider] Breakpoint ${newBreakpoint.id} added on backend`
          );

          // Refresh cache to include the new breakpoint
          await breakpointManager.immediateUpdateAll();

          // Sync selections map with all breakpoints
          const allBreakpoints = breakpointManager.getAllBreakpoints();
          await vscode.commands.executeCommand(
            "ddb.internal.syncBreakpointSelections",
            allBreakpoints
          );

          // Update editor decorations
          await vscode.commands.executeCommand("ddb.internal.updateDecorations");
        }

        if (data.type === "Updated") {
          const updatedBreakpoint = data.data as DDBBreakpoint;
          logger.debug(
            `[DDBViewProvider] Breakpoint ${updatedBreakpoint.id} updated`
          );

          // Refresh all breakpoints
          await breakpointManager.immediateUpdateAll();

          // Sync selections map with all breakpoints
          const allBreakpoints = breakpointManager.getAllBreakpoints();
          await vscode.commands.executeCommand(
            "ddb.internal.syncBreakpointSelections",
            allBreakpoints
          );

          // Update editor decorations
          await vscode.commands.executeCommand("ddb.internal.updateDecorations");
        }
      }
    }
  );
  context.subscriptions.push({ dispose: bkptNotificationUnsubscribe });

  // Subscribe to WebSocket connection state changes
  const wsStateUnsubscribe = notificationService.onConnectionStateChange(
    (connected) => {
      if (sessionsProvider.isDebugSessionActive) {
        if (connected) {
          logger.debug(
            "[DDBViewProvider] WebSocket connected, disabling polling"
          );
          sessionManager.setWebSocketActive(true);
          sessionManager.stopAutoRefresh(); // Stop polling
          breakpointManager.setWebSocketActive(true);
          breakpointManager.stopAutoRefresh(); // Stop polling
        } else {
          logger.debug(
            "[DDBViewProvider] WebSocket disconnected, enabling polling fallback"
          );
          sessionManager.setWebSocketActive(false);
          sessionManager.startAutoRefresh(); // Resume polling as fallback
          breakpointManager.setWebSocketActive(false);
          breakpointManager.startAutoRefresh(); // Resume polling as fallback
        }
      }
    }
  );

  context.subscriptions.push({ dispose: wsStateUnsubscribe });

  // Debug session START listener
  const debugStartListener = vscode.debug.onDidStartDebugSession(
    async (debugSession) => {
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

        // Start WebSocket notification service
        notificationService.start();

        // Wait a moment for WebSocket to connect, then decide on polling
        setTimeout(() => {
          if (notificationService.isConnected()) {
            logger.debug(
              "[DDBViewProvider] WebSocket connected, disabling polling"
            );
            sessionManager.setWebSocketActive(true);
            breakpointManager.setWebSocketActive(true);
            // Don't start polling - WebSocket will handle updates
          } else {
            logger.debug(
              "[DDBViewProvider] WebSocket not connected, using polling"
            );
            sessionManager.setWebSocketActive(false);
            sessionManager.startAutoRefresh(); // Start polling as fallback
            breakpointManager.setWebSocketActive(false);
            breakpointManager.startAutoRefresh(); // Start polling as fallback
          }
        }, 5000); // Wait 5 second for WebSocket connection

        // Trigger immediate update - fetch both sessions AND groups
        // Tree will auto-refresh via onDataUpdated event when data is ready
        await sessionManager.updateAll();

        // Fetch initial breakpoint data (auto-refresh controlled by WebSocket state above)
        await breakpointManager.updateAll();
      } catch (error) {
        logger.error(
          `[DDBViewProvider] DDB service not ready: ${error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
    }
  );

  // Debug session STOP listener
  const debugStopListener = vscode.debug.onDidTerminateDebugSession(
    (debugSession) => {
      OTelService.log_info(`[activity] debug_session_stopped`);

      // Stop WebSocket notification service
      notificationService.stop();
      sessionManager.setWebSocketActive(false);

      // Stop SessionManager auto-refresh
      sessionManager.stopAutoRefresh();

      // Stop BreakpointManager auto-refresh and clear cache
      breakpointManager.stopAutoRefresh();
      breakpointManager.clearCache();

      // Clear tree data in both providers
      sessionsProvider.clearSessionData();
      breakpointsProvider.clearSessionData();

      // Clear view descriptions when debug session ends
      sessionsProvider.clearViewDescription();
      breakpointsProvider.clearViewDescription();
    }
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
    }
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
          "Cannot refresh: No active debug session. Did you start DDB already?"
        );
        return;
      }

      // Fetch fresh sessions AND groups (updates cache and returns fresh data)
      await sessionManager.fetchAll();
      // Tree will auto-refresh via event listener
    }
  );

  context.subscriptions.push(sessionsRefreshCommand);

  // Toggle grouping command for sessions view
  const toggleGroupingCommand = vscode.commands.registerCommand(
    "ddbSessionsExplorer.toggleGrouping",
    () => {
      if (!sessionsProvider.isDebugSessionActive) {
        vscode.window.showInformationMessage(
          "Cannot toggle: No active debug session. Did you start DDB already?"
        );
        return;
      }

      // Toggle the mode
      sessionsProvider.toggleGrouping();
    }
  );

  context.subscriptions.push(toggleGroupingCommand);

  // Show logical group details command
  const showLogicalGroupDetailsCommand = vscode.commands.registerCommand(
    "ddbSessionsExplorer.showLogicalGroupDetails",
    (item: LogicalGroupItem) => {
      if (item.isUngrouped) {
        vscode.window.showInformationMessage(
          "Sessions not belonging to any logical group"
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
    }
  );

  context.subscriptions.push(showLogicalGroupDetailsCommand);

  // Manual refresh command for breakpoints view
  const breakpointsRefreshCommand = vscode.commands.registerCommand(
    "ddbBreakpointsExplorer.refresh",
    async () => {
      if (!breakpointsProvider.isDebugSessionActive) {
        vscode.window.showInformationMessage(
          "Cannot refresh: No active debug session. Did you start DDB already?"
        );
        return;
      }

      // Fetch fresh breakpoints (updates cache and returns fresh data)
      await breakpointManager.fetchAllBreakpoints();
      // Tree will auto-refresh via event listener
    }
  );

  context.subscriptions.push(breakpointsRefreshCommand);

  // Toggle grouping command for breakpoints view
  const toggleBreakpointGroupingCommand = vscode.commands.registerCommand(
    "ddbBreakpointsExplorer.toggleGroupByFile",
    () => {
      if (!breakpointsProvider.isDebugSessionActive) {
        vscode.window.showInformationMessage(
          "Cannot toggle: No active debug session. Did you start DDB already?"
        );
        return;
      }

      // Toggle the mode
      breakpointsProvider.toggleGroupByFile();
    }
  );

  context.subscriptions.push(toggleBreakpointGroupingCommand);

  // Pause session command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ddbSessionsExplorer.pauseSession",
      (item: SessionItem) => {
        const sessionId = item.sessionId;
        vscode.window.showInformationMessage(
          `Trying to pause session: ${sessionId}`
        );
        const debugSession = vscode.debug.activeDebugSession;
        if (debugSession) {
          debugSession.customRequest("pause", { sessionId: sessionId });
        }
      }
    )
  );

  // Continue session command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ddbSessionsExplorer.continueSession",
      (item: SessionItem) => {
        const sessionId = item.sessionId;
        vscode.window.showInformationMessage(
          `Trying to continue session: ${sessionId}`
        );
        const debugSession = vscode.debug.activeDebugSession;
        if (debugSession) {
          debugSession.customRequest("continue", { sessionId: sessionId });
        }
      }
    )
  );

  // Kill session command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ddbSessionsExplorer.killSession",
      async (item: SessionItem) => {
        const sessionId = item.sessionId;

        // Show confirmation dialog
        const result = await vscode.window.showWarningMessage(
          `Are you sure you want to kill session ${sessionId}? This will terminate the process.`,
          { modal: true },
          "Yes",
          "No"
        );

        if (result !== "Yes") {
          return; // User cancelled
        }

        const debugSession = vscode.debug.activeDebugSession;
        if (debugSession) {
          debugSession.customRequest("send-signal", {
            sessionId: sessionId,
            signal: "SIGINT",
          });
        }
      }
    )
  );

  // Send signal command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ddbSessionsExplorer.sendSignal",
      async (item: SessionItem) => {
        const sessionId = item.sessionId;
        const debugSession = vscode.debug.activeDebugSession;
        if (!debugSession) {
          vscode.window.showErrorMessage("No active debug session");
          return;
        }

        // Create QuickPick with loading state
        interface SignalQuickPickItem extends vscode.QuickPickItem {
          signalName: string;
        }
        const quickPick = vscode.window.createQuickPick<SignalQuickPickItem>();
        quickPick.title = `Send Signal to Session ${sessionId}`;
        quickPick.placeholder = "Loading available signals...";
        quickPick.busy = true;
        quickPick.enabled = false;
        quickPick.ignoreFocusOut = true;
        quickPick.matchOnDescription = true;
        quickPick.show();

        try {
          // Fetch signal list from debugger
          const response = await debugSession.customRequest("list-signals", {
            sessionId,
          });
          const signals = response.signals;

          // Populate QuickPick
          quickPick.items = signals.map((sig: any) => ({
            label: sig.name,
            description: `stop:${sig.stop} print:${sig.print} pass:${sig.pass}`,
            detail: sig.desc,
            signalName: sig.name,
          }));

          quickPick.busy = false;
          quickPick.enabled = true;
          quickPick.placeholder = "Select a signal to send";
        } catch (error) {
          quickPick.dispose();
          vscode.window.showErrorMessage(`Failed to fetch signals: ${error}`);
          return;
        }

        // Handle selection
        quickPick.onDidAccept(() => {
          const selected = quickPick.selectedItems[0];
          if (selected) {
            debugSession.customRequest("send-signal", {
              sessionId,
              signal: selected.signalName,
            });
          }
          quickPick.dispose();
        });

        quickPick.onDidHide(() => quickPick.dispose());
      }
    )
  );
}

export function deactivate() {
  // Stop SessionManager auto-refresh when extension deactivates
  SessionManager.getInstance().stopAutoRefresh();
  // Stop BreakpointManager auto-refresh when extension deactivates
  BreakpointManager.getInstance().stopAutoRefresh();
}
