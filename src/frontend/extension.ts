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

async function promptForSessions(): Promise<SessionSelection | undefined> {
  const sessionManager = SessionManager.getInstance();

  // Fetch fresh data for both sessions and groups
  const [sessions, groups] = await Promise.all([
    sessionManager.fetchAllSessions(),
    sessionManager.fetchAllGroups(),
  ]);

  if (!sessions || sessions.length === 0) {
    vscode.window.showInformationMessage("No debug sessions available.");
    return { groupIds: [], sessionIds: [] };
  }

  // 1. Build map from groupId -> LogicalGroup for quick lookup
  const groupMap: Map<number, ddb_api.LogicalGroup> = new Map();
  for (const group of groups) {
    groupMap.set(group.id, group);
  }

  // 2. Group sessions by their groupId
  const groupedSessions: Map<number, ddb_api.Session[]> = new Map();
  const ungroupedSessions: ddb_api.Session[] = [];

  for (const session of sessions) {
    if (session.group?.valid && session.group.id !== undefined) {
      const groupId = session.group.id;
      if (!groupedSessions.has(groupId)) {
        groupedSessions.set(groupId, []);
      }
      groupedSessions.get(groupId)!.push(session);
    } else {
      ungroupedSessions.push(session);
    }
  }

  // 3. Build QuickPick items with better visual hierarchy
  const quickPickItems: SessionQuickPickItem[] = [];
  const groupHeaderToItems: Map<SessionQuickPickItem, SessionQuickPickItem[]> =
    new Map();

  // Add grouped sessions first (sorted by group ID)
  const sortedGroupIds = Array.from(groupedSessions.keys()).sort((a, b) => a - b);

  for (const groupId of sortedGroupIds) {
    const group = groupMap.get(groupId);
    const sessionList = groupedSessions.get(groupId)!;

    // Group header with folder icon
    const headerItem: SessionQuickPickItem = {
      label: `$(folder) ${group?.alias || `Group ${groupId}`}`,
      description: `(${sessionList.length} sessions)`,
      detail: group ? `ID: ${group.id} | Hash: ${group.hash}` : undefined,
      groupId: groupId,
      isGroupHeader: true,
    };
    quickPickItems.push(headerItem);

    const groupItems: SessionQuickPickItem[] = [];

    // Session items with indentation and debug icon
    for (const session of sessionList) {
      const sessionItem: SessionQuickPickItem = {
        label: `    $(debug) ${session.alias || "UNKNOWN"}`,
        description: `sid=${session.sid}`,
        detail: `    Status: ${session.status} | Tag: ${session.tag}`,
        sessionId: session.sid,
        groupId: groupId,
      };
      quickPickItems.push(sessionItem);
      groupItems.push(sessionItem);
    }

    groupHeaderToItems.set(headerItem, groupItems);
  }

  // Add ungrouped sessions (if any)
  if (ungroupedSessions.length > 0) {
    const ungroupedHeader: SessionQuickPickItem = {
      label: `$(folder-opened) Ungrouped`,
      description: `(${ungroupedSessions.length} sessions)`,
      groupId: -1,
      isGroupHeader: true,
    };
    quickPickItems.push(ungroupedHeader);

    const ungroupedItems: SessionQuickPickItem[] = [];

    for (const session of ungroupedSessions) {
      const sessionItem: SessionQuickPickItem = {
        label: `    $(debug) ${session.alias || "UNKNOWN"}`,
        description: `sid=${session.sid}`,
        detail: `    Status: ${session.status} | Tag: ${session.tag}`,
        sessionId: session.sid,
        groupId: -1,
      };
      quickPickItems.push(sessionItem);
      ungroupedItems.push(sessionItem);
    }

    groupHeaderToItems.set(ungroupedHeader, ungroupedItems);
  }

  // 3. Use createQuickPick for more control over selection behavior
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
    quickPick.items = quickPickItems;
    quickPick.canSelectMany = true;
    quickPick.placeholder = "Select sessions or groups to apply the breakpoint to";

    let isUpdating = false;
    let previousSelection: readonly SessionQuickPickItem[] = [];
    let accepted = false;

    quickPick.onDidChangeSelection((selected) => {
      if (isUpdating) return;
      isUpdating = true;

      const newSelection = new Set(selected);
      const prevSet = new Set(previousSelection);

      // Check if any group header was just selected (wasn't in previous, now in current)
      for (const item of selected) {
        if (
          item.isGroupHeader &&
          groupHeaderToItems.has(item) &&
          !prevSet.has(item)
        ) {
          // Header was just selected - add all items in this group
          for (const groupItem of groupHeaderToItems.get(item)!) {
            newSelection.add(groupItem);
          }
        }
      }

      // Check if any group header was just deselected (was in previous, not in current)
      for (const item of previousSelection) {
        if (
          item.isGroupHeader &&
          groupHeaderToItems.has(item) &&
          !newSelection.has(item)
        ) {
          // Header was just deselected - remove all items in this group
          for (const groupItem of groupHeaderToItems.get(item)!) {
            newSelection.delete(groupItem);
          }
        }
      }

      // Check if any child session was deselected while parent group is still selected
      // If so, deselect the parent group header
      for (const item of previousSelection) {
        if (!item.isGroupHeader && item.groupId !== undefined && !newSelection.has(item)) {
          // A session was just deselected - find and deselect its parent group header
          for (const [header] of groupHeaderToItems) {
            if (header.groupId === item.groupId && newSelection.has(header)) {
              // Parent group header is selected but child was deselected - deselect header
              newSelection.delete(header);
              break;
            }
          }
        }
      }

      const newSelectionArray = Array.from(newSelection);
      quickPick.selectedItems = newSelectionArray;
      previousSelection = newSelectionArray;
      isUpdating = false;
    });

    quickPick.onDidAccept(() => {
      accepted = true;

      const groupIds: number[] = [];
      const sessionIds: number[] = [];

      // Get set of selected group headers
      const selectedGroupHeaders = new Set<number>();
      for (const item of quickPick.selectedItems) {
        if (item.isGroupHeader && item.groupId !== undefined) {
          selectedGroupHeaders.add(item.groupId);
          // Only add valid group IDs (not -1 for ungrouped)
          if (item.groupId !== -1) {
            groupIds.push(item.groupId);
          }
        }
      }

      // Add individual sessions that are NOT covered by a selected group
      for (const item of quickPick.selectedItems) {
        if (item.sessionId !== undefined && !item.isGroupHeader) {
          // If this session's parent group was selected, don't add it individually
          // (the backend will resolve group to sessions)
          // Exception: ungrouped sessions (groupId === -1) must be added individually
          if (
            item.groupId === -1 ||
            !selectedGroupHeaders.has(item.groupId!)
          ) {
            sessionIds.push(item.sessionId); // Already a number now
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
      const selection = await promptForSessions();
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
  implements vscode.DebugAdapterTrackerFactory
{
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
          `**Breakpoint Info**\n- Line: ${
            bp.location.range.start.line
          }\n- Column: ${
            bp.location.range.start.character
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
