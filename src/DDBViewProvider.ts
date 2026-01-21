import * as vscode from "vscode";
import { Breakpoint } from "vscode-debugadapter";
import { logger } from "./logger";
import * as ddb_api from "./common/ddb_api";
import { SessionManager } from "./common/ddb_session_mgr";

class SessionsCommandsProvider
  implements
    vscode.TreeDataProvider<
      SessionItem | SessionItemDetail | CommandItem | BreakPointItem
    >
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    SessionItem | CommandItem | undefined | null | void
  > = new vscode.EventEmitter<
    SessionItem | CommandItem | undefined | null | void
  >();
  readonly onDidChangeTreeData: vscode.Event<
    SessionItem | CommandItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private sessionManager: SessionManager;
  public isDebugSessionActive: boolean = false;

  constructor(private breakpointSessionsMap: Map<string, string[]>) {
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

  getTreeItem(
    element: SessionItem | CommandItem | BreakPointItem
  ): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: SessionItem | CommandItem | BreakPointItem | SessionItemDetail
  ): Promise<
    (SessionItem | SessionItemDetail | CommandItem | BreakPointItem)[]
  > {
    if (!element) {
      // Root level: Show empty state message if no debug session active
      if (!this.isDebugSessionActive) {
        return [
          new SessionItem(
            "Start DDB to view sessions",
            vscode.TreeItemCollapsibleState.None,
            false
          ),
        ];
      }

      // Root level: Sessions, Pending Commands, Finished Commands
      return [
        new SessionItem(
          "Sessions",
          vscode.TreeItemCollapsibleState.Collapsed,
          false
        ),
        new CommandItem(
          "Pending Commands",
          vscode.TreeItemCollapsibleState.Collapsed,
          "pending"
        ),
        new CommandItem(
          "Finished Commands",
          vscode.TreeItemCollapsibleState.Collapsed,
          "finished"
        ),
        new BreakPointItem(
          "Breakpoint",
          [],
          vscode.TreeItemCollapsibleState.Collapsed
        ),
      ];
    } else if (element instanceof SessionItem) {
      if (element.label === "Sessions") {
        // Fetch and return sessions
        return this.getSessions();
      }

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
    } else if (
      element instanceof CommandItem &&
      element.label === "Pending Commands"
    ) {
      // Fetch and return pending commands
      return []; // this.getCommands("pending"); // TODO: Backend not ready
    } else if (
      element instanceof CommandItem &&
      element.label === "Finished Commands"
    ) {
      // Fetch and return finished commands
      return []; // this.getCommands("finished"); // TODO: Backend not ready
    } else if (
      element instanceof BreakPointItem &&
      element.label === "Breakpoint"
    ) {
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
  private getSessions(): SessionItem[] {
    try {
      // Return empty if no debug session
      if (!this.isDebugSessionActive) {
        return [];
      }

      // Use SessionManager cache instead of direct API call
      const sessions = this.sessionManager.getAllSessions();

      // Return sessions with collapsible state to make them expandable
      return sessions.map((session) => {
        const sessionItem = new SessionItem(
          `[${session.alias}] ${session.tag}`,
          vscode.TreeItemCollapsibleState.Collapsed,
          true,
          session.status,
          String(session.sid),
          {
            alias: String(session.alias),
            sid: String(session.sid),
            tag: session.tag,
          }
        );
        return sessionItem;
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage("Failed to fetch sessions from cache");
      logger.error(`Failed to fetch sessions from cache: ${errorMessage}`);
      return [];
    }
  }

  private async getCommands(
    type: "pending" | "finished"
  ): Promise<CommandItem[]> {
    // this is not properly implemented in backend yet.
    return [];
  }
}

class SessionItem extends vscode.TreeItem {
  private createButton(title: string, icon: string, command: string): string {
    const args = encodeURIComponent(JSON.stringify([this.sessionId]));
    return `<a href="command:${command}?${args}" title="${title}"><span style="color: var(--vscode-textLink-foreground);">$(${icon})</span></a>`;
  }

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

    // Add icons for expandable items
    // if (collapsibleState === vscode.TreeItemCollapsibleState.Collapsed ||
    // 	collapsibleState === vscode.TreeItemCollapsibleState.Expanded) {
    // 	this.iconPath = new vscode.ThemeIcon('debug-session');
    // }

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

class CommandItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: "pending" | "finished",
    public readonly commandData?: any
  ) {
    super(label, collapsibleState);
    this.tooltip = this.label;
    if (commandData) {
      this.description = `${commandData.target_sessions.length}/${commandData.finished_sessions.length}`;
      this.tooltip = `Token: ${commandData.token}\nCommand: ${
        commandData.command
      }\nTarget Sessions: ${commandData.target_sessions.join(
        ", "
      )}\nFinished Sessions: ${commandData.finished_sessions.join(", ")}`;
    }
    // this.iconPath = new vscode.ThemeIcon(type === 'pending' ? 'loading~spin' : 'pass');
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

export function activate(
  context: vscode.ExtensionContext,
  breakpointSessionsMap: Map<string, string[]>
) {
  const sessionsCommandsProvider = new SessionsCommandsProvider(
    breakpointSessionsMap
  );

  const treeView = vscode.window.createTreeView("sessionsCommandsExplorer", {
    treeDataProvider: sessionsCommandsProvider,
  });

  context.subscriptions.push(treeView);

  // Get SessionManager instance (but don't start auto-refresh yet)
  const sessionManager = SessionManager.getInstance();

  // Subscribe to SessionManager updates for automatic tree refresh
  const sessionManagerUnsubscribe = sessionManager.onDataUpdated(() => {
    // Only refresh if tree is visible and debug session is active
    if (treeView.visible && sessionsCommandsProvider.isDebugSessionActive) {
      sessionsCommandsProvider.refresh();
    }
  });

  context.subscriptions.push({ dispose: sessionManagerUnsubscribe });

  // Debug session START listener
  const debugStartListener = vscode.debug.onDidStartDebugSession(
    async (debugSession) => {
      // Mark debug session as active
      sessionsCommandsProvider.isDebugSessionActive = true;

      // Start SessionManager auto-refresh
      sessionManager.startAutoRefresh();

      // Trigger immediate update
      await sessionManager.updateSessions();

      // Refresh tree to show data
      sessionsCommandsProvider.refresh();
    }
  );

  // Debug session STOP listener
  const debugStopListener = vscode.debug.onDidTerminateDebugSession(
    (debugSession) => {
      // Stop SessionManager auto-refresh
      sessionManager.stopAutoRefresh();

      // Clear tree data
      sessionsCommandsProvider.clearSessionData();
    }
  );

  context.subscriptions.push(debugStartListener);
  context.subscriptions.push(debugStopListener);

  // Visibility listener
  const visibilityListener = treeView.onDidChangeVisibility((e) => {
    if (e.visible && sessionsCommandsProvider.isDebugSessionActive) {
      // Refresh tree when becoming visible during active debug session
      sessionsCommandsProvider.refresh();
    }
  });

  context.subscriptions.push(visibilityListener);

  // Initial refresh
  sessionsCommandsProvider.refresh();

  // Manual refresh command - only works during active debug session
  const refreshCommand = vscode.commands.registerCommand(
    "sessionsCommandsExplorer.refresh",
    async () => {
      if (!sessionsCommandsProvider.isDebugSessionActive) {
        vscode.window.showInformationMessage(
          "Cannot refresh: No active debug session"
        );
        return;
      }

      // Fetch fresh sessions using new API (updates cache and returns fresh data)
      await sessionManager.fetchAllSessions();
      // Tree will auto-refresh via event listener
    }
  );

  context.subscriptions.push(refreshCommand);

  // Pause session command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sessionsCommandsExplorer.pauseSession",
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
      "sessionsCommandsExplorer.continueSession",
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
