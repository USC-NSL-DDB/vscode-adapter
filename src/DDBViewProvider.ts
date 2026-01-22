import * as vscode from "vscode";
import { Breakpoint } from "vscode-debugadapter";
import { logger } from "./logger";
import * as ddb_api from "./common/ddb_api";
import { SessionManager } from "./common/ddb_session_mgr";
import { NotificationService } from "./common/ddb_notification_service";
import { LogicalGroup } from "./common/ddb_api";

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
// Breakpoints Provider - Shows breakpoints with their associated sessions
// ============================================================================

class BreakpointsProvider implements vscode.TreeDataProvider<BreakPointItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    BreakPointItem | undefined | null | void
  > = new vscode.EventEmitter<BreakPointItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    BreakPointItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  public isDebugSessionActive: boolean = false;

  constructor(private breakpointSessionsMap: Map<string, string[]>) { }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  clearSessionData(): void {
    this.isDebugSessionActive = false;
    this.refresh();
  }

  getTreeItem(element: BreakPointItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BreakPointItem): Promise<BreakPointItem[]> {
    if (!element) {
      // Root level: Show breakpoints or empty state
      if (!this.isDebugSessionActive) {
        return [
          new BreakPointItem(
            "Start DDB to view breakpoints",
            [],
            vscode.TreeItemCollapsibleState.None
          ),
        ];
      }

      return this.getBreakpointSessions();
    }
    return [];
  }

  private getBreakpointSessions(): BreakPointItem[] {
    const breakpointSessions: BreakPointItem[] = [];
    this.breakpointSessionsMap.forEach((sessions, breakpointId) => {
      breakpointSessions.push(
        new BreakPointItem(
          breakpointId,
          sessions,
          vscode.TreeItemCollapsibleState.None
        )
      );
    });
    return breakpointSessions;
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

class BreakPointItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly sessions: string[],
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(name, collapsibleState);

    this.label = name;

    // Display session IDs directly in the description
    this.description = sessions.join(", ");

    // Create a detailed tooltip with session information
    this.tooltip = new vscode.MarkdownString(
      `**${name}**\n\nSessions:\n${sessions.map((s) => `- ${s}`).join("\n")}`
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

export function activate(
  context: vscode.ExtensionContext,
  breakpointSessionsMap: Map<string, string[]>
) {
  // Create providers
  const sessionsProvider = new SessionsProvider();
  const breakpointsProvider = new BreakpointsProvider(breakpointSessionsMap);

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

  context.subscriptions.push(sessionsTreeView);
  context.subscriptions.push(breakpointsTreeView);

  // Get SessionManager instance (but don't start auto-refresh yet)
  const sessionManager = SessionManager.getInstance();

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

  // Subscribe to SessionListChanged notifications from backend
  const notificationUnsubscribe = notificationService.onNotification(
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

  context.subscriptions.push({ dispose: notificationUnsubscribe });

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
        } else {
          logger.debug(
            "[DDBViewProvider] WebSocket disconnected, enabling polling fallback"
          );
          sessionManager.setWebSocketActive(false);
          sessionManager.startAutoRefresh(); // Resume polling as fallback
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

      // Reset to grouped mode and show description
      sessionsProvider.resetToGroupedMode();

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
            // Don't start polling - WebSocket will handle updates
          } else {
            logger.debug(
              "[DDBViewProvider] WebSocket not connected, using polling"
            );
            sessionManager.setWebSocketActive(false);
            sessionManager.startAutoRefresh(); // Start polling as fallback
          }
        }, 5000); // Wait 5 second for WebSocket connection

        // Trigger immediate update - fetch both sessions AND groups
        // Tree will auto-refresh via onDataUpdated event when data is ready
        await sessionManager.updateAll();
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
      // Stop WebSocket notification service
      notificationService.stop();
      sessionManager.setWebSocketActive(false);

      // Stop SessionManager auto-refresh
      sessionManager.stopAutoRefresh();

      // Clear tree data in both providers
      sessionsProvider.clearSessionData();
      breakpointsProvider.clearSessionData();

      // Clear view description when debug session ends
      sessionsProvider.clearViewDescription();
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

      // Refresh breakpoints view
      breakpointsProvider.refresh();
    }
  );

  context.subscriptions.push(breakpointsRefreshCommand);

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
}

export function deactivate() {
  // Stop SessionManager auto-refresh when extension deactivates
  SessionManager.getInstance().stopAutoRefresh();
}
