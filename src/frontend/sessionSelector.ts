import * as vscode from "vscode";
import * as ddb_api from "../common/ddb_api";
import { SessionManager } from "../common/ddb_session_mgr";

// ============================================================================
// Session Selector TreeView Provider
// Provides a tree view with checkboxes for selecting groups/sessions
// When a group is checked, its child sessions are locked (cannot be toggled)
// ============================================================================

export interface SessionSelection {
  groupIds: number[];
  sessionIds: number[];
}

// Tree item types
export type SessionSelectorItem = GroupItem | SelectorSessionItem;

export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly group: ddb_api.LogicalGroup,
    public readonly sessionCount: number,
    public readonly isUngrouped: boolean = false
  ) {
    super(
      isUngrouped ? "Ungrouped" : group.alias,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = "selectorGroupItem";
    this.description = `(${sessionCount} sessions)`;
    this.iconPath = new vscode.ThemeIcon(isUngrouped ? "folder-opened" : "folder");
  }
}

export class SelectorSessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: ddb_api.Session,
    public readonly parentGroupId: number // -1 for ungrouped
  ) {
    super(
      session.alias || `Session ${session.sid}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = "selectorSessionItem";
    this.description = `sid=${session.sid}`;
    this.iconPath = new vscode.ThemeIcon("debug");
  }
}

export class SessionSelectorProvider
  implements vscode.TreeDataProvider<SessionSelectorItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SessionSelectorItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessionManager = SessionManager.getInstance();
  private lockedGroups = new Set<number>(); // Groups that are checked (children locked)
  private checkedGroups = new Set<number>();
  private checkedSessions = new Set<number>();

  // Selection promise for async workflow
  private selectionResolve?: (value: SessionSelection | undefined) => void;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  // Called when user clicks "Apply Selection" command
  confirmSelection(): void {
    if (this.selectionResolve) {
      this.selectionResolve(this.getSelection());
      this.selectionResolve = undefined;
    }
  }

  // Called when user cancels
  cancelSelection(): void {
    if (this.selectionResolve) {
      this.selectionResolve(undefined);
      this.selectionResolve = undefined;
    }
  }

  // Start selection mode and return a promise
  async promptForSelection(): Promise<SessionSelection | undefined> {
    // Reset state
    this.lockedGroups.clear();
    this.checkedGroups.clear();
    this.checkedSessions.clear();
    this.refresh();

    return new Promise((resolve) => {
      this.selectionResolve = resolve;
    });
  }

  getSelection(): SessionSelection {
    const groupIds: number[] = [];
    const sessionIds: number[] = [];

    for (const gid of this.checkedGroups) {
      if (gid !== -1) {
        groupIds.push(gid);
      }
    }

    // Only include sessions whose parent group is NOT checked
    for (const sid of this.checkedSessions) {
      // Find session's parent group
      const session = this.sessionManager.getSession(sid);
      const parentGroupId = session?.group?.valid ? session.group.id : -1;
      if (!this.checkedGroups.has(parentGroupId)) {
        sessionIds.push(sid);
      }
    }

    return { groupIds, sessionIds };
  }

  // Handle checkbox state change from TreeView
  handleCheckboxChange(
    item: SessionSelectorItem,
    state: vscode.TreeItemCheckboxState
  ): void {
    if (item instanceof GroupItem) {
      const groupId = item.isUngrouped ? -1 : item.group.id;
      if (state === vscode.TreeItemCheckboxState.Checked) {
        this.checkedGroups.add(groupId);
        this.lockedGroups.add(groupId);
        // Auto-check all sessions in this group
        const sessions =
          groupId === -1
            ? this.sessionManager.getUngroupedSessions()
            : this.sessionManager.getSessionsByGroup(groupId);
        for (const s of sessions) {
          this.checkedSessions.add(s.sid);
        }
      } else {
        this.checkedGroups.delete(groupId);
        this.lockedGroups.delete(groupId);
        // Uncheck all sessions in this group
        const sessions =
          groupId === -1
            ? this.sessionManager.getUngroupedSessions()
            : this.sessionManager.getSessionsByGroup(groupId);
        for (const s of sessions) {
          this.checkedSessions.delete(s.sid);
        }
      }
    } else if (item instanceof SelectorSessionItem) {
      // Only allow if parent group is NOT locked
      if (this.lockedGroups.has(item.parentGroupId)) {
        // Revert - refresh to show locked state
        this.refresh();
        vscode.window.showInformationMessage(
          "Deselect the group first to modify individual sessions"
        );
        return;
      }
      if (state === vscode.TreeItemCheckboxState.Checked) {
        this.checkedSessions.add(item.session.sid);
      } else {
        this.checkedSessions.delete(item.session.sid);
      }
    }
    this.refresh();
  }

  isGroupLocked(groupId: number): boolean {
    return this.lockedGroups.has(groupId);
  }

  // TreeDataProvider implementation
  getTreeItem(element: SessionSelectorItem): vscode.TreeItem {
    if (element instanceof GroupItem) {
      const groupId = element.isUngrouped ? -1 : element.group.id;
      element.checkboxState = this.checkedGroups.has(groupId)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    } else if (element instanceof SelectorSessionItem) {
      element.checkboxState = this.checkedSessions.has(element.session.sid)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      // Visual indicator for locked sessions
      if (this.lockedGroups.has(element.parentGroupId)) {
        element.description = `sid=${element.session.sid} (locked by group)`;
      } else {
        element.description = `sid=${element.session.sid}`;
      }
    }
    return element;
  }

  async getChildren(
    element?: SessionSelectorItem
  ): Promise<SessionSelectorItem[]> {
    if (!element) {
      // Root: return groups
      const groups = this.sessionManager.getAllGroups();
      const ungroupedSessions = this.sessionManager.getUngroupedSessions();
      const items: SessionSelectorItem[] = [];

      for (const group of groups) {
        const sessions = this.sessionManager.getSessionsByGroup(group.id);
        items.push(new GroupItem(group, sessions.length));
      }

      if (ungroupedSessions.length > 0) {
        items.push(
          new GroupItem(
            {
              id: -1,
              hash: "",
              alias: "Ungrouped",
              sids: new Set(),
            } as ddb_api.LogicalGroup,
            ungroupedSessions.length,
            true
          )
        );
      }

      return items;
    } else if (element instanceof GroupItem) {
      // Group children: return sessions
      const groupId = element.isUngrouped ? -1 : element.group.id;
      const sessions =
        groupId === -1
          ? this.sessionManager.getUngroupedSessions()
          : this.sessionManager.getSessionsByGroup(groupId);
      return sessions.map((s) => new SelectorSessionItem(s, groupId));
    }
    return [];
  }
}
