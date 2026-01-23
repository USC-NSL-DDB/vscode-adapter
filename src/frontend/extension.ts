import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { activate as ddbviewactivate } from "../DDBViewProvider";
import { Breakpoint } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import { get } from "http";
import { logger } from "../logger";
import { SessionManager } from "../common/ddb_session_mgr";
import { integer } from "yaml-language-server";
import * as ddb_api from "../common/ddb_api";
import { Session } from "../common/ddb_api";
// class GDBDebugAdapterTracker implements vscode.DebugAdapterTracker {
// 	private stateEmitter: vscode.EventEmitter<any>;

// 	constructor(
// 		private session: vscode.DebugSession
// 	) {
// 		this.session = session
// 	}

// 	onWillReceiveMessage(message: any) {
// 		if (message.type === 'request' && message.command === 'customStateRequest') {
// 			console.log('Sending customStateRequest to debug adapter');
// 		}
// 	}

// 	onDidSendMessage(message: any) {
// 		if (message.type === 'event' && message.event === 'stopped') {
// 			console.log('Execution stopped, requesting updated state');
// 			this.sendCustomStateRequest();
// 		} else if (message.type === 'event' && message.event === 'customStateEvent') {
// 			console.log('Received customStateEvent');
// 			this.stateEmitter.fire(message.body);
// 		}
// 	}

// 	private sendCustomStateRequest() {
// 		this.session.customRequest('customStateRequest')
// 			.then(response => {
// 				// Handle the response if needed
// 			})
// 	}
// }
// Map breakpoint ID to session selection (groups and individual sessions)
declare module "vscode-debugprotocol" {
  namespace DebugProtocol {
    interface SourceBreakpoint {
      source: {
        path: string;
        name: string;
      };
      groupIds?: number[];
      sessionIds?: number[];
      transactionId?: number;
      sessionAliases?: string[];
    }
    interface Breakpoint {
      groupIds?: number[];
      sessionIds?: number[];
    }
    interface SetBreakpointsArguments {
      transactionId?: number;
    }
    interface SetBreakpointsResponse {
      transactionId?: number;
    }
  }
}

declare module "vscode" {
  interface Breakpoint {
    groupIds?: number[];
    sessionIds?: number[];
    // sessionAliases?: string[];
    processing?: boolean;
    transactionId?: number;
  }
}

interface BreakpointTarget {
  groupIds: number[];
  sessionIds: number[];
}

const breakpointSelectionsMap = new Map<string, BreakpointTarget>();
const breakpointSessionsMapExp = new Map<string, string[]>(); // Map breakpoint ID to session IDs (for display)

function getBreakpointId(bp: vscode.Breakpoint): string {
  // VSCode doesn't expose an ID directly, but you can generate one based on its properties
  if (bp instanceof vscode.SourceBreakpoint) {
    // Convert URI to file system path
    const filePath = vscode.Uri.parse(bp.location.uri.toString()).fsPath;
    // Normalize the path to ensure consistency
    const normalizedPath = path.normalize(filePath);
    return `${normalizedPath}:${bp.location.range.start.line + 1}`;
  } else if (bp instanceof vscode.FunctionBreakpoint) {
    return bp.functionName;
  } else {
    return ""; // Handle other breakpoint types if necessary
  }
}

function getBreakpointIdFromDAP(
  bp: DebugProtocol.SourceBreakpoint,
  dapPath: string
): string {
  // Normalize the DAP path to ensure consistency
  const normalizedPath = path.normalize(dapPath);
  return `${normalizedPath}:${bp.line}`;
}

function associateBreakpointWithSelection(
  bp: vscode.Breakpoint,
  selection: BreakpointTarget
) {
  const bpId = getBreakpointId(bp);
  breakpointSelectionsMap.set(bpId, selection);
}

// Define a custom QuickPickItem type that can hold our session data
interface SessionQuickPickItem extends vscode.QuickPickItem {
  sessionId?: number; // Session ID (number, optional for group headers)
  groupId?: number; // Used to identify group ids
  isGroupHeader?: boolean; // Distinguish group headers from session items
}

// Return type for session selection - tracks groups and individual sessions separately
interface SessionSelection {
  groupIds: number[]; // Groups selected (use g<id> in command)
  sessionIds: number[]; // Individual sessions selected (use s<id> in command)
}

async function promptForSessions(source: DebugProtocol.Source): Promise<SessionSelection | undefined> {
  if (!source || !source.path) {
    vscode.window.showErrorMessage("Invalid source for breakpoint.");
    return undefined;
  }
  const src_path = path.normalize(source.path);
  const sessionManager = SessionManager.getInstance();
  const [_, groups] = await Promise.all([
    sessionManager.immediateUpdateAll(),
    sessionManager.fetchGroupsBySrc(src_path)
  ]);
  const sessions = sessionManager.getAllSessions();

  if (!sessions || sessions.length === 0) {
    vscode.window.showInformationMessage("No debug sessions available.");
    return { groupIds: [], sessionIds: [] };
  }

  const groupMap: Map<number, ddb_api.LogicalGroup> = new Map();
  for (const group of groups) {
    groupMap.set(group.id, group);
  }

  const groupedSessions: Map<number, ddb_api.Session[]> = new Map();
  const ungroupedSessions: ddb_api.Session[] = [];

  for (const session of sessions) {
    if (session.group?.valid 
      && session.group !== undefined 
      && session.group.id !== undefined 
      && session.group.id !== -1
    ) {
      const groupId = session.group.id;
      if (groupMap.has(groupId)) {
        // Sessions belongs to one of groups associated with the source
        if (!groupedSessions.has(groupId)) {
          groupedSessions.set(groupId, []);
        }
        groupedSessions.get(groupId)!.push(session);
      }
    } else {
      ungroupedSessions.push(session);
    }
  }

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
    quickPick.canSelectMany = true;

    let isGroupsView = true; // Start with Groups view
    let accepted = false;

    // Track selected groups across view switches
    const selectedGroupIds = new Set<number>();
    const selectedSessionIds = new Set<number>();

    // Build items for Groups view (shows only logical groups)
    function buildGroupItems(): SessionQuickPickItem[] {
      const items: SessionQuickPickItem[] = [];
      const sortedGroupIds = Array.from(groupedSessions.keys()).sort(
        (a, b) => a - b
      );

      for (const groupId of sortedGroupIds) {
        const group = groupMap.get(groupId);
        const sessionList = groupedSessions.get(groupId)!;

        const groupItem: SessionQuickPickItem = {
          label: `$(folder) ${group?.alias || `Group ${groupId}`}`,
          description: `(${sessionList.length} sessions)`,
          detail: group ? `Group ID: ${group.id} | Hash: ${group.hash}` : undefined,
          groupId: groupId,
          isGroupHeader: true,
        };
        items.push(groupItem);
      }

      // Add separator for ungrouped sessions info (not selectable)
      if (ungroupedSessions.length > 0) {
        items.push({
          label: "Ungrouped Sessions",
          kind: vscode.QuickPickItemKind.Separator,
        } as SessionQuickPickItem);
        items.push({
          label: `$(info) ${ungroupedSessions.length} ungrouped sessions (switch to Sessions view to select)`,
          description: "",
          detail: "Ungrouped sessions can only be selected individually",
        } as SessionQuickPickItem);
      }

      return items;
    }

    // Build items for Sessions view (shows all individual sessions)
    function buildSessionItems(): SessionQuickPickItem[] {
      const items: SessionQuickPickItem[] = [];
      const sortedGroupIds = Array.from(groupedSessions.keys()).sort(
        (a, b) => a - b
      );

      // Add grouped sessions
      for (const groupId of sortedGroupIds) {
        const group = groupMap.get(groupId);
        const sessionList = groupedSessions.get(groupId)!;

        // Add group separator
        const groupSelected = selectedGroupIds.has(groupId);
        items.push({
          label: groupSelected
            ? `Group: ${group?.alias || `${groupId}`}`
            : `Group: ${group?.alias || `${groupId}`}`,
          kind: vscode.QuickPickItemKind.Separator,
        } as SessionQuickPickItem);

        // Add sessions under this group
        for (const session of sessionList) {
          const sessionItem: SessionQuickPickItem = {
            label: `$(debug) ${session.alias || "UNKNOWN"}`,
            description: groupSelected
              ? "Group Breakpoint (parent group selected)"
              : "Session Breakpoint",
            detail: `Session ID: ${session.sid} | Status: ${session.status} | Tag: ${session.tag}`,
            sessionId: session.sid,
            groupId: groupId,
          };
          items.push(sessionItem);
        }
      }

      // Add ungrouped sessions
      if (ungroupedSessions.length > 0) {
        items.push({
          label: "Ungrouped Sessions",
          kind: vscode.QuickPickItemKind.Separator,
        } as SessionQuickPickItem);

        for (const session of ungroupedSessions) {
          const sessionItem: SessionQuickPickItem = {
            label: `$(debug) ${session.alias || "UNKNOWN"}`,
            description: "Session Breakpoint",
            detail: `Session ID: ${session.sid} | Status: ${session.status} | Tag: ${session.tag}`,
            sessionId: session.sid,
            groupId: -1,
          };
          items.push(sessionItem);
        }
      }

      return items;
    }

    // Update the view
    function updateView() {
      if (isGroupsView) {
        quickPick.placeholder =
          "Select logical groups (use toggle to switch to Sessions view)";
        quickPick.items = buildGroupItems();

        // Restore selected groups
        const items = quickPick.items.filter(
          (item) => item.isGroupHeader && selectedGroupIds.has(item.groupId!)
        );
        quickPick.selectedItems = items;
      } else {
        quickPick.placeholder =
          "Select individual sessions (use toggle to switch to Groups view)";
        quickPick.items = buildSessionItems();

        // Restore selected sessions (excluding those whose group is selected)
        const items = quickPick.items.filter(
          (item) =>
            item.sessionId !== undefined &&
            selectedSessionIds.has(item.sessionId)
        );
        quickPick.selectedItems = items;
      }
    }

    // Function to create toggle button based on current view
    function createToggleButton(): vscode.QuickInputButton {
      return {
        iconPath: new vscode.ThemeIcon(
          isGroupsView ? "list-flat" : "list-tree"
        ),
        tooltip: isGroupsView
          ? "Switch to Sessions view"
          : "Switch to Groups view",
      };
    }

    quickPick.buttons = [createToggleButton()];

    // Handle toggle button click
    quickPick.onDidTriggerButton(() => {
      // Save current selections before switching
      if (isGroupsView) {
        // Save selected groups
        for (const item of quickPick.selectedItems) {
          if (item.isGroupHeader && item.groupId !== undefined) {
            selectedGroupIds.add(item.groupId);
          }
        }
      } else {
        // Save selected sessions
        selectedSessionIds.clear();
        for (const item of quickPick.selectedItems) {
          if (item.sessionId !== undefined && !item.isGroupHeader) {
            selectedSessionIds.add(item.sessionId);
          }
        }
      }

      // Toggle view
      isGroupsView = !isGroupsView;

      // Update button by recreating it
      quickPick.buttons = [createToggleButton()];

      // Rebuild items
      updateView();
    });

    // Handle selection changes
    quickPick.onDidChangeSelection((selected) => {
      if (isGroupsView) {
        // In Groups view, track selected groups
        selectedGroupIds.clear();
        for (const item of selected) {
          if (item.isGroupHeader && item.groupId !== undefined) {
            selectedGroupIds.add(item.groupId);
          }
        }
      } else {
        // In Sessions view, track selected sessions
        selectedSessionIds.clear();
        for (const item of selected) {
          if (item.sessionId !== undefined) {
            selectedSessionIds.add(item.sessionId);
          }
        }
      }
    });

    // Handle accept
    quickPick.onDidAccept(() => {
      accepted = true;

      // Build final selection
      const groupIds: number[] = Array.from(selectedGroupIds);
      const sessionIds: number[] = [];

      // Only include sessions that are NOT covered by a selected group
      for (const sid of selectedSessionIds) {
        const session = sessions.find((s) => s.sid === sid);
        if (session) {
          const sessionGroupId = session.group?.valid ? session.group.id : -1;
          // Include if ungrouped OR if parent group is not selected
          if (sessionGroupId === -1 || !selectedGroupIds.has(sessionGroupId)) {
            sessionIds.push(sid);
          }
        }
      }

      quickPick.dispose();
      resolve({ groupIds, sessionIds });
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      if (!accepted) {
        resolve(undefined);
      }
    });

    // Initialize view and show
    updateView();
    quickPick.show();
  });
}

function convertToVSCodeBreakpoint(bp: any, source: any): vscode.Breakpoint {
  const uri = vscode.Uri.parse(source.path);
  const location = new vscode.Location(
    uri,
    new vscode.Position(bp.line - 1, bp.column ? bp.column - 1 : 0)
  );
  return new vscode.SourceBreakpoint(
    location,
    bp.enabled,
    bp.condition,
    bp.hitCondition,
    bp.logMessage
  );
}


async function handleSetBreakpoints(message: any) {
  console.log("Handling setBreakpoints message: ", message);
  console.log("debug0", message.arguments);
  const messageArguments =
    message.arguments as DebugProtocol.SetBreakpointsArguments;
  const breakpoints = messageArguments.breakpoints;
  const source = messageArguments.source;
  console.log("debug1", breakpoints);
  if (!breakpoints || breakpoints.length === 0 || !source || !source.path) {
    return;
  }
  for (const bp of breakpoints) {
    // Check if the breakpoint already has a selection
    const bkptLinePathId = getBreakpointIdFromDAP(bp, source.path);
    let existingSelection = breakpointSelectionsMap.get(bkptLinePathId);

    if (
      !existingSelection ||
      (existingSelection.groupIds.length === 0 &&
        existingSelection.sessionIds.length === 0)
    ) {
      const selection = await promptForSessions(source);
      console.log("debug2", selection);

      if (!selection) {
        // User cancelled - default to all sessions (empty means all)
        existingSelection = { groupIds: [], sessionIds: [] };
      } else if (
        selection.groupIds.length === 0 &&
        selection.sessionIds.length === 0
      ) {
        // No selection made - default to all sessions
        existingSelection = { groupIds: [], sessionIds: [] };
      } else {
        existingSelection = selection;
      }

      // Update the map with the selection
      breakpointSelectionsMap.set(bkptLinePathId, existingSelection);
    }

    console.log("debug4", existingSelection);
    // Assign both groupIds and sessionIds to the breakpoint
    bp.groupIds = existingSelection.groupIds;
    bp.sessionIds = existingSelection.sessionIds;
  }
  updateInlineDecorations();
  // Send the modified setBreakpoints request to the debug adapter
  // message.arguments.breakpoints = message.arguments.breakpoints.filter(bp => !breakpointsToRemove.includes(bp));
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    return;
  }
  const response: DebugProtocol.SetBreakpointsResponse =
    await session.customRequest("setSessionBreakpoints", message);
  console.log("debug5", JSON.stringify(response, null, 2));
  // add sessionids to vscode breakpoints
  for (const vscodebp of vscode.debug.breakpoints) {
    if (vscodebp instanceof vscode.SourceBreakpoint) {
      const bpLine = vscodebp.location.range.start.line + 1;
      const bpUri = vscodebp.location.uri.toString();
      //@ts-ignore
      const found = response.breakpoints.find(
        (bp: DebugProtocol.Breakpoint) =>
          bp.line === bpLine &&
          bp.source?.path &&
          bpUri.endsWith(bp.source.path)
      );
      if (found) {
        vscodebp.sessionIds = found.sessionIds;
        vscodebp.processing = false;
      }
    }
  }
  breakpointSessionsMapExp.clear();
  //@ts-ignore
  for (const bp of response.breakpoints) {
    breakpointSessionsMapExp.set(
      getBreakpointIdFromDAP(bp, bp.source.path),
      bp.sessionIds
    );
  }
  updateInlineDecorations();
}

class MyDebugAdapterTrackerFactory
  implements vscode.DebugAdapterTrackerFactory {
  createDebugAdapterTracker(
    session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
    return new MyDebugAdapterTracker();
  }
}
class MyDebugAdapterTracker implements vscode.DebugAdapterTracker {
  async onWillReceiveMessage(message: any) {
    if (message.command === "setBreakpoints") {
      // Intercept the setBreakpoints request
      await handleSetBreakpoints(message);
    }
  }
  async onDidSendMessage(message: any) {
    if (message.command === "setSessionBreakpoints") {
      // Intercept the setBreakpoints request
      // updateBreakpointDecorations();
      // updateInlineDecorations();
    }
  }
}

function getSessionIdsFromBreakpoint(bp: vscode.SourceBreakpoint): string[] {
  // Extract session IDs from the breakpoint's condition
  if (bp.condition && bp.condition.startsWith("Sessions: ")) {
    return bp.condition
      .substring("Sessions: ".length)
      .split(", ")
      .map((id) => id.trim());
  }
  return [];
}

const inlineDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(0, 255, 255, 0.1)", // Light cyan background
  before: {
    contentText: "$(debug-breakpoint) ", // Breakpoint icon
    color: "#00CCCC", // Darker cyan for text
    fontWeight: "normal",
    fontStyle: "normal",
    margin: "0 8px 0 0",
  },
  after: {
    contentText: " ", // Space to extend background
    margin: "0 0 0 8px",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

function updateInlineDecorations() {
  // Update decorations for all visible text editors
  vscode.window.visibleTextEditors.forEach((editor) => {
    updateEditorDecorations(editor);
  });
}

function updateEditorDecorations(editor: vscode.TextEditor) {
  const decorations: vscode.DecorationOptions[] = [];
  const activeSession = vscode.debug.activeDebugSession;
  if (!activeSession || activeSession.type !== "ddb") {
    editor.setDecorations(inlineDecorationType, []);
    return;
  }
  for (const bp of vscode.debug.breakpoints) {
    if (
      bp instanceof vscode.SourceBreakpoint &&
      bp.location.uri.toString() === editor.document.uri.toString()
    ) {
      const line = bp.location.range.start.line;
      const range = new vscode.Range(
        line,
        0,
        line,
        editor.document.lineAt(line).text.length
      );

      let statusText: string;
      let backgroundColor: string;
      let foregroundColor: string;

      if (bp.processing) {
        statusText = "⟳ Processing...";
        backgroundColor = "rgba(255, 165, 0, 0.2)"; // Light orange background
        foregroundColor = "#D68000"; // Darker orange text
      } else {
        statusText = `✓ Sessions: ${bp.sessionIds?.join(", ")}`;
        backgroundColor = "rgba(0, 204, 0, 0.2)"; // Light green background
        foregroundColor = "#008000"; // Darker green text
      }

      const decoration = {
        range: range,
        hoverMessage: new vscode.MarkdownString(
          `**Breakpoint Info**\n- Line: ${bp.location.range.start.line
          }\n- Column: ${bp.location.range.start.character
          }\n- Session IDs: ${bp.sessionIds?.join(", ")}`
        ),
        renderOptions: {
          before: {
            contentText: statusText,
            color: foregroundColor,
            fontWeight: "bold",
            margin: "0 8px 0 0",
          },
          backgroundColor: backgroundColor,
          isWholeLine: true,
        },
      };
      decorations.push(decoration);
    }
  }
  editor.setDecorations(inlineDecorationType, decorations);
}
const trasactionId = 0;
export function activate(context: vscode.ExtensionContext) {
  logger.info("Starting gdb adapter extension.......");
  // let disposable = vscode.commands.registerCommand("extension.showInfo", () => {
  //   vscode.window.showInformationMessage("Hello from your VSCode extension!");
  //   const breakpoints = vscode.debug.breakpoints;
  //   console.log("Breakpoints: ", breakpoints);
  // });
  // context.subscriptions.push(disposable);
  vscode.debug.onDidStartDebugSession((session) => {
    console.log("Debug session started: ", session);
    breakpointSelectionsMap.clear();
    breakpointSessionsMapExp.clear();
  });
  vscode.debug.onDidChangeBreakpoints(async (event) => {
    console.log("Breakpoints changed: ", event);
    event.added.forEach(async (bp) => {
      // const selectedSessions = await promptForSessions();
      bp.processing = true;
      bp.transactionId = trasactionId;
      breakpointSelectionsMap.set(getBreakpointId(bp), {
        groupIds: [],
        sessionIds: [],
      });
    });
    event.removed.forEach((bp) => {
      breakpointSelectionsMap.delete(getBreakpointId(bp));
    });
  });
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateInlineDecorations();
    })
  );

  // Update decorations when the visible editors change
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      updateInlineDecorations();
    })
  );

  // Update decorations when breakpoints change
  context.subscriptions.push(
    vscode.debug.onDidChangeBreakpoints(() => {
      updateInlineDecorations();
    })
  );
  // Clear decorations when debug session ends
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "ddb") {
        // Remove all breakpoints from the UI
        const allBreakpoints = vscode.debug.breakpoints;
        vscode.debug.removeBreakpoints(allBreakpoints);

        // Clear the maps
        breakpointSelectionsMap.clear();
        breakpointSessionsMapExp.clear();
      }
      updateInlineDecorations();
    })
  );

  // Update decorations when switching between debug sessions
  context.subscriptions.push(
    vscode.debug.onDidChangeActiveDebugSession(() => {
      updateInlineDecorations();
    })
  );
  vscode.debug.registerDebugAdapterTrackerFactory(
    "ddb",
    new MyDebugAdapterTrackerFactory()
  );
  ddbviewactivate(context, breakpointSessionsMapExp);
  // const rootPath =
  // 	vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
  // 		? vscode.workspace.workspaceFolders[0].uri.fsPath
  // 		: undefined;
  // const ddbViewProvider=new DDBViewProvider(rootPath)
  // vscode.window.registerTreeDataProvider(
  // 	'nodeDependencies',
  // 	ddbViewProvider
  // );
  // vscode.debug.registerDebugAdapterTrackerFactory("gdb", {
  // 	createDebugAdapterTracker(session) {
  // 		return new GDBDebugAdapterTracker(session)
  // 	},
  // })
  // context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("debugmemory", new MemoryContentProvider()));
  // context.subscriptions.push(vscode.commands.registerCommand("code-debug.examineMemoryLocation", examineMemory));
  // context.subscriptions.push(vscode.commands.registerCommand("code-debug.getFileNameNoExt", () => {
  // 	if (!vscode.window.activeTextEditor || !vscode.window.activeTextEditor.document || !vscode.window.activeTextEditor.document.fileName) {
  // 		vscode.window.showErrorMessage("No editor with valid file name active");
  // 		return;
  // 	}
  // 	const fileName = vscode.window.activeTextEditor.document.fileName;
  // 	const ext = path.extname(fileName);
  // 	return fileName.substring(0, fileName.length - ext.length);
  // }));
  // context.subscriptions.push(vscode.commands.registerCommand("code-debug.getFileBasenameNoExt", () => {
  // 	if (!vscode.window.activeTextEditor || !vscode.window.activeTextEditor.document || !vscode.window.activeTextEditor.document.fileName) {
  // 		vscode.window.showErrorMessage("No editor with valid file name active");
  // 		return;
  // 	}
  // 	const fileName = path.basename(vscode.window.activeTextEditor.document.fileName);
  // 	const ext = path.extname(fileName);
  // 	return fileName.substring(0, fileName.length - ext.length);
  // }));
}
