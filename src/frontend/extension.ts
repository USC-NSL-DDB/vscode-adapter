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
import { BreakpointManager } from "../common/ddb_breakpoint_mgr";
import * as ddb_api from "../common/ddb_api";
import { Session, SubBreakpoint } from "../common/ddb_api";
import { SubBkpt, SubBkptType } from "../backend/backend";
import { OTelService } from "../common/otel";
import {
  getOrCreateUserId,
  generateSessionId,
} from "../common/user_session";

// Helper functions to extract groupIds/sessionIds from subbkpts for display
// These work with both SubBkpt (DAP format) and SubBreakpoint (API format)
function extractGroupIds(subbkpts: SubBkpt[] | SubBreakpoint[] | undefined): number[] {
  if (!subbkpts) return [];
  return subbkpts
    .filter(s => s.type === "group")
    .map(s => {
      // Handle both formats: SubBkpt uses 'target', SubBreakpoint uses 'target_group'
      if ('target' in s) return (s as SubBkpt).target;
      return (s as SubBreakpoint).target_group!;
    });
}

function extractSessionIds(subbkpts: SubBkpt[] | SubBreakpoint[] | undefined): number[] {
  if (!subbkpts) return [];
  return subbkpts
    .filter(s => s.type === "session")
    .map(s => {
      // Handle both formats: SubBkpt uses 'target', SubBreakpoint uses 'target_session'
      if ('target' in s) return (s as SubBkpt).target;
      return (s as SubBreakpoint).target_session!;
    });
}
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
      subbkpts?: SubBkpt[];
      transactionId?: number;
      sessionAliases?: string[];
    }
    interface Breakpoint {
      subbkpts?: SubBkpt[];
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
    subbkpts?: SubBkpt[];
    processing?: boolean;
    transactionId?: number;
  }
}

interface BreakpointTarget {
  subbkpts: SubBkpt[];
}

const breakpointSelectionsMap = new Map<string, BreakpointTarget>();
const breakpointHitSessionMap = new Map<string, number[]>(); // Map breakpoint ID to the session ID that hit it

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

// Return type for session selection - unified SubBkpt array (DAP format)
interface SessionSelection {
  subbkpts: SubBkpt[];
}

async function promptForSessions(
  source: DebugProtocol.Source
): Promise<SessionSelection | undefined> {
  if (!source || !source.path) {
    vscode.window.showErrorMessage("Invalid source for breakpoint.");
    return undefined;
  }
  const src_path = path.normalize(source.path);
  const sessionManager = SessionManager.getInstance();

  return new Promise(async (resolve) => {
    const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
    quickPick.canSelectMany = true;

    // Create cancel button
    const cancelButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("close"),
      tooltip: "Cancel",
    };

    // Show immediately with loading state
    quickPick.busy = true;
    quickPick.enabled = false;
    quickPick.placeholder = "Loading sessions and groups...";
    quickPick.items = [
      {
        label: "$(loading~spin) Loading...",
        description: "Fetching sessions and logical groups",
        detail: "This may take a moment",
      } as SessionQuickPickItem,
    ];
    quickPick.buttons = [cancelButton];
    quickPick.ignoreFocusOut = true; // Keep open during loading
    quickPick.show();

    let accepted = false;
    let timedOut = false;

    // Set up 30 second timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      quickPick.dispose();
      vscode.window.showWarningMessage(
        "Loading sessions timed out after 30 seconds. Please try again or check your connection."
      );
      resolve(undefined);
    }, 30000);

    // Handle cancel button click during loading
    const cancelDisposable = quickPick.onDidTriggerButton((button) => {
      if (button === cancelButton) {
        clearTimeout(timeoutId);
        quickPick.dispose();
        resolve(undefined);
      }
    });

    // Handle early dismissal during loading
    quickPick.onDidHide(() => {
      clearTimeout(timeoutId);
      quickPick.dispose();
      if (!accepted && !timedOut) {
        resolve(undefined);
      }
    });

    // Fetch data asynchronously
    let groups: ddb_api.LogicalGroup[];
    let sessions: ddb_api.Session[];
    let groupMap: Map<number, ddb_api.LogicalGroup>;
    let groupedSessions: Map<number, ddb_api.Session[]>;
    let ungroupedSessions: ddb_api.Session[];

    try {
      const [_, fetchedGroups] = await Promise.all([
        sessionManager.immediateUpdateAll(),
        sessionManager.fetchGroupsBySrc(src_path),
      ]);

      groups = fetchedGroups;

      // Clear timeout since loading succeeded
      clearTimeout(timeoutId);

      if (timedOut) {
        return; // Already handled by timeout
      }

      sessions = sessionManager.getAllSessions();

      if (!sessions || sessions.length === 0) {
        quickPick.dispose();
        vscode.window.showInformationMessage("No debug sessions available.");
        resolve({ subbkpts: [] });
        return;
      }

      // Build data structures
      groupMap = new Map();
      for (const group of groups) {
        groupMap.set(group.id, group);
      }

      groupedSessions = new Map();
      ungroupedSessions = sessionManager.getUngroupedSessions();

      for (const group of groups) {
        const groupId = group.id;
        if (groupId !== undefined) {
          const sess = sessionManager.getSessionsByGroup(groupId);
          groupedSessions.set(groupId, sess);
        }
      }

      // Data loaded - update UI state
      quickPick.busy = false;
      quickPick.enabled = true;
      quickPick.ignoreFocusOut = false;

      // Remove cancel button, add toggle button
      cancelDisposable.dispose();
    } catch (error) {
      clearTimeout(timeoutId);
      quickPick.dispose();
      vscode.window.showErrorMessage(`Failed to load sessions: ${error}`);
      resolve(undefined);
      return;
    }

    let isGroupsView = true; // Start with Groups view

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
          detail: group
            ? `Group ID: ${group.id} | Hash: ${group.hash}`
            : undefined,
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

    // Set toggle button (after loading)
    quickPick.buttons = [createToggleButton()];

    // Handle toggle button click (replace cancel handler)
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

      // Build final selection as SubBkpt array (DAP format)
      const subbkpts: SubBkpt[] = [];

      // Add selected groups
      for (const groupId of selectedGroupIds) {
        subbkpts.push({ type: SubBkptType.Group, target: groupId });
      }

      // Only include sessions that are NOT covered by a selected group
      for (const sid of selectedSessionIds) {
        const session = sessions.find((s) => s.sid === sid);
        if (session) {
          const sessionGroupId = session.group?.valid ? session.group.id : -1;
          // Include if ungrouped OR if parent group is not selected
          if (sessionGroupId === -1 || !selectedGroupIds.has(sessionGroupId)) {
            subbkpts.push({ type: SubBkptType.Session, target: sid });
          }
        }
      }

      quickPick.dispose();
      resolve({ subbkpts });
    });

    // Note: onDidHide is already set up earlier to handle dismissal during loading
    // and will also handle dismissal after data is loaded

    // Initialize view with loaded data (QuickPick is already shown during loading)
    updateView();
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
  if (!breakpoints || !source || !source.path) {
    return;
  }

  // Track breakpoints to actually send to the debug adapter
  const breakpointsToSend: DebugProtocol.SourceBreakpoint[] = [];

  for (const bp of breakpoints) {
    // Check if the breakpoint already has a selection
    const bkptLinePathId = getBreakpointIdFromDAP(bp, source.path);
    let existingSelection = breakpointSelectionsMap.get(bkptLinePathId);

    if (
      !existingSelection ||
      existingSelection.subbkpts.length === 0
    ) {
      const selection: SessionSelection | undefined = await promptForSessions(source);
      console.log("debug2", selection);

      const noSelection = (!selection) || selection.subbkpts.length === 0;

      if (noSelection) {
        // User cancelled / select none - remove the breakpoint from UI
        console.log(
          "User cancelled session selection, removing breakpoint:",
          bkptLinePathId
        );

        const allBreakpoints = vscode.debug.breakpoints;
        const bpToRemove = allBreakpoints.find((vsbp) => {
          if (vsbp instanceof vscode.SourceBreakpoint) {
            return getBreakpointId(vsbp) === bkptLinePathId;
          }
          return false;
        });

        if (bpToRemove) {
          vscode.debug.removeBreakpoints([bpToRemove]);
        }

        // Clean up the map entry
        breakpointSelectionsMap.delete(bkptLinePathId);

        // Skip this breakpoint - don't send to debug adapter
        continue;
      } else {
        existingSelection = selection;
      }

      // Update the map with the selection
      breakpointSelectionsMap.set(bkptLinePathId, existingSelection);
    }

    console.log("debug4", existingSelection);
    // Assign subbkpts to the breakpoint
    bp.subbkpts = existingSelection.subbkpts;

    // Add to the list of breakpoints to send
    breakpointsToSend.push(bp);
  }

  // updateInlineDecorations();

  // Send the modified setBreakpoints request to the debug adapter
  message.arguments.breakpoints = breakpointsToSend;
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    return;
  }
  const response: DebugProtocol.SetBreakpointsResponse =
    await session.customRequest("setSessionBreakpoints", message);
  console.log("debug5", response);
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
        // Update the map with data from backend response (source of truth for decorations)
        const bpId = getBreakpointId(vscodebp);
        breakpointSelectionsMap.set(bpId, { subbkpts: found.subbkpts ?? [] });
        vscodebp.processing = false;
      }
    }
  }
  // Refresh BreakpointManager to update the breakpoints panel
  await BreakpointManager.getInstance().immediateUpdateAll();
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
    if (message.type === "event") {
      console.log("Received event ", message, message.body.threadId);
      if (message.event === "stopped" && message.body?.reason === "breakpoint") {
        const breakpointInfo = (message as DebugProtocol.StoppedEvent).breakpointInfo;
        if (breakpointInfo) {
          const bpId = `${path.normalize(breakpointInfo.file)}:${breakpointInfo.line}`;
          if (!breakpointHitSessionMap.has(bpId)) {
            breakpointHitSessionMap.set(bpId, []);
          }
          breakpointHitSessionMap.get(bpId)?.push(breakpointInfo.session_id);
          updateInlineDecorations();
        }
      }
      if (message.event === "continued") {
        breakpointHitSessionMap.clear();
        updateInlineDecorations();
      }
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

      // Look up subbkpts from the map (source of truth) - VSCode breakpoint objects don't support custom properties
      const bpId = getBreakpointId(bp);
      const selection = breakpointSelectionsMap.get(bpId);

      if (bp.processing) {
        statusText = "⟳ Processing...";
        backgroundColor = "rgba(255, 165, 0, 0.2)"; // Light orange background
        foregroundColor = "#D68000"; // Darker orange text
      } else {
        const groupIds = extractGroupIds(selection?.subbkpts);
        const sessionIds = extractSessionIds(selection?.subbkpts);
        const groupPart = groupIds.length ? `Groups: ${groupIds.join(", ")}` : "";
        const sessionPart = sessionIds.length ? `Sessions: ${sessionIds.join(", ")}` : "";
        const separator = groupPart && sessionPart ? " | " : "";
        const hitSessionId = breakpointHitSessionMap.get(bpId);
        hitSessionId?.sort((a, b) => a - b);
        const hitPart = hitSessionId != null ? ` | Hit by Session: ${hitSessionId}` : "";
        statusText = `✓ ${groupPart}${separator}${sessionPart}${hitPart}`;
        if (hitSessionId != null) {
          backgroundColor = "rgba(255, 100, 100, 0.2)"; // Light red for hit breakpoint
          foregroundColor = "#CC0000"; // Red text
        } else {
          backgroundColor = "rgba(0, 204, 0, 0.2)"; // Light green background
          foregroundColor = "#008000"; // Darker green text
        }
      }

      const groupIdsDisplay = extractGroupIds(selection?.subbkpts);
      const sessionIdsDisplay = extractSessionIds(selection?.subbkpts);
      const decoration = {
        range: range,
        hoverMessage: new vscode.MarkdownString(
          `**Breakpoint Info**\n- Line: ${bp.location.range.start.line + 1
          }\n- Column: ${bp.location.range.start.character
          }\n- Group IDs: ${groupIdsDisplay.join(", ") || "none"
          }\n- Session IDs: ${sessionIdsDisplay.join(", ") || "none"}`
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
// Status bar item for showing current stack frame info
let stackFrameStatusBar: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  logger.info("Starting gdb adapter extension.......");

  // Create status bar item for stack frame display
  stackFrameStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    -1
  );
  stackFrameStatusBar.name = "Current Stack Frame";
  context.subscriptions.push(stackFrameStatusBar);

  // Initialize OpenTelemetry
  try {
    const userId = await getOrCreateUserId();
    const sessionId = generateSessionId();
    const otel = OTelService.initialize("ddb-ext", userId, sessionId);

    // Register shutdown handler
    context.subscriptions.push({
      dispose: async () => {
        await otel.shutdown();
      },
    });

    logger.info(`[OTel] VSCode Extension Host initialized with userId=${userId}, sessionId=${sessionId}`);
    OTelService.log_info(`[OTel] VSCode Extension Host initialized with userId=${userId}, sessionId=${sessionId}`);
  } catch (error) {
    logger.error("[OTel] Failed to initialize OpenTelemetry:", error);
  }

  vscode.debug.onDidStartDebugSession((session) => {
    console.log("Debug session started: ", session);
    breakpointSelectionsMap.clear();
    breakpointHitSessionMap.clear();
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
    vscode.debug.onDidChangeBreakpoints((event) => {
      console.log("Breakpoints changed: ", event);
      event.added.forEach(async (bp) => {
        // const selectedSessions = await promptForSessions();
        bp.processing = true;
        bp.transactionId = trasactionId;
        bp.subbkpts = [];  // Initialize subbkpts on the breakpoint object
        breakpointSelectionsMap.set(getBreakpointId(bp), {
          subbkpts: [],
        });
      });
      event.removed.forEach((bp) => {
        breakpointSelectionsMap.delete(getBreakpointId(bp));
      });
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
        breakpointHitSessionMap.clear();
        stackFrameStatusBar.hide();
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

  // Update status bar when user focuses a different stack frame or thread
  context.subscriptions.push(
    vscode.debug.onDidChangeActiveStackItem((stackItem) => {
      if (vscode.debug.activeDebugSession?.type !== "ddb") {
        stackFrameStatusBar.hide();
        return;
      }
      if (stackItem instanceof vscode.DebugStackFrame) {
        const frameId = stackItem.frameId;
        const sessionId = frameId >>> 24;
        const level = (frameId >> 16) & 0xff;
        const threadId = stackItem.threadId;
        stackFrameStatusBar.text = `$(debug-stackframe) Session ${sessionId} | Thread ${threadId}, Frame ${level}`;
        stackFrameStatusBar.tooltip = `Session: ${sessionId}\nThread: ${threadId}\nFrame Level: ${level}`;
        stackFrameStatusBar.show();
      } else if (stackItem instanceof vscode.DebugThread) {
        stackFrameStatusBar.text = `$(debug-stackframe) Thread ${stackItem.threadId}`;
        stackFrameStatusBar.tooltip = `Thread ${stackItem.threadId}`;
        stackFrameStatusBar.show();
      } else {
        stackFrameStatusBar.hide();
      }
    })
  );

  // Internal commands for DDBViewProvider to trigger decoration updates
  context.subscriptions.push(
    vscode.commands.registerCommand("ddb.internal.updateDecorations", () => {
      updateInlineDecorations();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ddb.internal.syncBreakpointSelections",
      (breakpoints: ddb_api.DDBBreakpoint[]) => {
        // Rebuild breakpointSelectionsMap from DDBBreakpoint data
        for (const bp of breakpoints) {
          const bpId = `${path.normalize(bp.location.src)}:${bp.location.line}`;
          const subbkpts: SubBkpt[] = bp.subbkpts.map((sub) => ({
            type: sub.type as SubBkptType,
            target:
              sub.type === "group" ? sub.target_group! : sub.target_session!,
          }));
          breakpointSelectionsMap.set(bpId, { subbkpts });
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ddb.internal.removeBreakpointSelection",
      (bpId: string) => {
        const allBreakpoints = vscode.debug.breakpoints;
        const bpToRemove = allBreakpoints.find((vsbp) => {
          if (vsbp instanceof vscode.SourceBreakpoint) {
            return getBreakpointId(vsbp) === bpId;
          }
          return false;
        });

        breakpointSelectionsMap.delete(bpId);
        if (bpToRemove) {
          vscode.debug.removeBreakpoints([bpToRemove]);
        }
      }
    )
  );

  vscode.debug.registerDebugAdapterTrackerFactory(
    "ddb",
    new MyDebugAdapterTrackerFactory()
  );
  ddbviewactivate(context);
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
