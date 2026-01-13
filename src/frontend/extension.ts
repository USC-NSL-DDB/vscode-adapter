import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { activate as ddbviewactivate } from "../DDBViewProvider";
import axios from "axios";
import { Breakpoint } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import { get } from "http";
import { logger } from "../logger";
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
const breakpointSessionsMap = new Map<string, string[]>(); // Map breakpoint ID to session IDs
const breakpointSessionsMapExp = new Map<string, string[]>(); // Map breakpoint ID to session IDs
function getBreakpointId(bp: vscode.Breakpoint): string {
	// VSCode doesn't expose an ID directly, but you can generate one based on its properties
	if (bp instanceof vscode.SourceBreakpoint) {
		// Convert URI to file system path
		const filePath = vscode.Uri.parse(bp.location.uri.toString()).fsPath;
		// Normalize the path to ensure consistency
		const normalizedPath = path.normalize(filePath);
		return `${normalizedPath}:${bp.location.range.start.line + 1}`;
	}
	else if (bp instanceof vscode.FunctionBreakpoint) {
		return bp.functionName;
	} else {
		return ''; // Handle other breakpoint types if necessary
	}
}
function getBreakpointIdFromDAP(bp: DebugProtocol.SourceBreakpoint, dapPath: string): string {
	// Normalize the DAP path to ensure consistency
	const normalizedPath = path.normalize(dapPath);
	return `${normalizedPath}:${bp.line}`;
}
function associateBreakpointWithSessions(bp: vscode.Breakpoint, sessionIds: string[]) {
	const bpId = getBreakpointId(bp);
	breakpointSessionsMap.set(bpId, sessionIds);
}

async function getAvailableSessions(): Promise<any[]> {
	const apiBaseUrl = process.env.DDB_API_URL || 'http://localhost:5000';
	try {
		const response = await axios.get(`${apiBaseUrl}/sessions`);
		return response.data; // Adjust according to your API's response format
	} catch (error) {
		vscode.window.showErrorMessage('Failed to fetch sessions');
		return [];
	}
}
// async function promptForSessions(): Promise<Array<{ sessionId: string }>> {
// 	const sessions = await getAvailableSessions(); // Implement this function
// 	return await vscode.window.showQuickPick(
// 		sessions.map(session => ({
// 			label: `[${session.alias}] sid=${session.sid}, tag=${session.tag}`,
// 			description: session.status,
// 			sessionId: session.sid
// 		})),
// 		{
// 			canPickMany: true,
// 			placeHolder: 'Select sessions to apply the breakpoint to'
// 		}
// 	);
// }
// Define a custom QuickPickItem type that can hold our session data
interface SessionQuickPickItem extends vscode.QuickPickItem {
	sessionId?: string; // Make it optional for separators
	groupId?: string; // Used to identify group headers
}
async function promptForSessions(): Promise<Array<{ sessionId: string }> | undefined> {
	const sessions = await getAvailableSessions();

	if (!sessions || sessions.length === 0) {
		vscode.window.showInformationMessage("No debug sessions available.");
		return [];
	}

	// 1. Group sessions by their groupId
	const groupedSessions: Map<string, any[]> = new Map();
	const UNGROUPED_KEY = "Ungrouped";

	for (const session of sessions) {
		// Use 'group_id' from your Rust backend
		const groupId = session.groupId || UNGROUPED_KEY;
		if (!groupedSessions.has(groupId)) {
			groupedSessions.set(groupId, []);
		}
		groupedSessions.get(groupId)!.push(session);
	}

	// 2. Build the list for the Quick Pick UI, with group headers
	const quickPickItems: SessionQuickPickItem[] = [];
	const sortedGroupIds = Array.from(groupedSessions.keys()).sort();

	// Track which items belong to which group header
	const groupHeaderToItems: Map<SessionQuickPickItem, SessionQuickPickItem[]> = new Map();

	for (const groupId of sortedGroupIds) {
		const sessionGroup = groupedSessions.get(groupId)!;

		// Add a visually distinct HEADER item for the group
		const headerItem: SessionQuickPickItem = {
			label: `$(folder) ${groupId.toUpperCase()}`,
			description: `(${sessionGroup.length} sessions)`,
			groupId: groupId // Mark this as a group header
		};
		quickPickItems.push(headerItem);

		const groupItems: SessionQuickPickItem[] = [];

		// Add the actual selectable session items for this group
		for (const session of sessionGroup) {
			const sessionItem: SessionQuickPickItem = {
				label: `   ${session.alias || 'UNKNOWN'}`,
				description: `sid=${session.sid}`,
				sessionId: session.sid
			};
			quickPickItems.push(sessionItem);
			groupItems.push(sessionItem);
		}

		groupHeaderToItems.set(headerItem, groupItems);
	}

	// 3. Use createQuickPick for more control over selection behavior
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
		quickPick.items = quickPickItems;
		quickPick.canSelectMany = true;
		quickPick.placeholder = 'Select sessions to apply the breakpoint to';

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
				if (item.groupId && groupHeaderToItems.has(item) && !prevSet.has(item)) {
					// Header was just selected - add all items in this group
					for (const groupItem of groupHeaderToItems.get(item)!) {
						newSelection.add(groupItem);
					}
				}
			}

			// Check if any group header was just deselected (was in previous, not in current)
			for (const item of previousSelection) {
				if (item.groupId && groupHeaderToItems.has(item) && !newSelection.has(item)) {
					// Header was just deselected - remove all items in this group
					for (const groupItem of groupHeaderToItems.get(item)!) {
						newSelection.delete(groupItem);
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
			const result = quickPick.selectedItems
				.filter(item => item.sessionId !== undefined)
				.map(item => ({ sessionId: item.sessionId! }));
			quickPick.dispose();
			resolve(result);
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
	const location = new vscode.Location(uri, new vscode.Position(bp.line - 1, bp.column ? bp.column - 1 : 0));
	return new vscode.SourceBreakpoint(location, bp.enabled, bp.condition, bp.hitCondition, bp.logMessage);
}

declare module 'vscode-debugprotocol' {
	module DebugProtocol {
		interface SourceBreakpoint {
			source: {
				path: string;
				name: string;
			};
			sessionIds?: string[];
			transactionId?: number;
			sessionAliases?: string[];
		}
		interface Breakpoint {
			sessionIds?: string[];
		}
		interface SetBreakpointsArguments {
			transactionId?: number;
		}
		interface SetBreakpointsResponse {
			transactionId?: number;
		}
	}
}
declare module 'vscode' {
	interface Breakpoint {
		sessionIds?: string[];
		// sessionAliases?: string[];
		processing?: boolean;
		transactionId?: number;
	}
}
async function handleSetBreakpoints(message: any) {
	console.log("Handling setBreakpoints message: ", message);
	console.log("debug0", message.arguments)
	const messageArguments = message.arguments as DebugProtocol.SetBreakpointsArguments;
	const breakpoints = messageArguments.breakpoints
	const source = message.arguments.source;
	const breakpointsToRemove = [];
	console.log("debug1", breakpoints)
	for (const bp of breakpoints) {
		// Check if the breakpoint already has session IDs
		const bkptLinePathId = getBreakpointIdFromDAP(bp, source.path);
		if (!breakpointSessionsMap.has(bkptLinePathId)) {
			breakpointSessionsMap.set(bkptLinePathId, []);
		}
		let sessionIdsToAssign = breakpointSessionsMap.get(bkptLinePathId);
		if (!sessionIdsToAssign || sessionIdsToAssign.length === 0) {
			let selectedSessions = await promptForSessions();
			console.log("debug2", selectedSessions)
			if (!selectedSessions || selectedSessions?.length === 0) {
				selectedSessions = await getAvailableSessions();
				console.log("debug3", selectedSessions)
			}
			sessionIdsToAssign = selectedSessions ? selectedSessions.map(s => s.sessionId) : [];

			// Update the map with the determined session IDs (even if it's an empty list)
			breakpointSessionsMap.set(bkptLinePathId, sessionIdsToAssign);
		}
		console.log("debug4", sessionIdsToAssign)
		bp.sessionIds = sessionIdsToAssign;
	}
	updateInlineDecorations();
	// Send the modified setBreakpoints request to the debug adapter
	// message.arguments.breakpoints = message.arguments.breakpoints.filter(bp => !breakpointsToRemove.includes(bp));
	const session = vscode.debug.activeDebugSession;
	const response: DebugProtocol.SetBreakpointsResponse = await session.customRequest('setSessionBreakpoints', message);
	console.log("debug5", JSON.stringify(response, null, 2))
	// add sessionids to vscode breakpoints
	for (const vscodebp of vscode.debug.breakpoints) {
		if (vscodebp instanceof vscode.SourceBreakpoint) {
			const bpLine = vscodebp.location.range.start.line + 1;
			const bpUri = vscodebp.location.uri.toString()
			//@ts-ignore
			const found = response.breakpoints.find((bp: DebugProtocol.Breakpoint) => bp.line === bpLine && bpUri.endsWith(bp.source.path));
			if (found) {
				vscodebp.sessionIds = found.sessionIds;
				vscodebp.processing = false;
			}
		}
	}
	breakpointSessionsMapExp.clear();
	//@ts-ignore
	for (const bp of response.breakpoints) {
		breakpointSessionsMapExp.set(getBreakpointIdFromDAP(bp, bp.source.path), bp.sessionIds);
	}
	updateInlineDecorations();
}

class MyDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
	createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
		return new MyDebugAdapterTracker();
	}
}
class MyDebugAdapterTracker implements vscode.DebugAdapterTracker {
	async onWillReceiveMessage(message: any) {
		if (message.command === 'setBreakpoints') {
			// Intercept the setBreakpoints request
			await handleSetBreakpoints(message);

		}
	}
	async onDidSendMessage(message: any) {
		if (message.command === 'setSessionBreakpoints') {
			// Intercept the setBreakpoints request
			// updateBreakpointDecorations();
			// updateInlineDecorations();
		}
	}
}


function getSessionIdsFromBreakpoint(bp: vscode.SourceBreakpoint): string[] {
	// Extract session IDs from the breakpoint's condition
	if (bp.condition && bp.condition.startsWith('Sessions: ')) {
		return bp.condition.substring('Sessions: '.length).split(', ').map(id => id.trim());
	}
	return [];
}

const inlineDecorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(0, 255, 255, 0.1)', // Light cyan background
	before: {
		contentText: '$(debug-breakpoint) ', // Breakpoint icon
		color: '#00CCCC', // Darker cyan for text
		fontWeight: 'normal',
		fontStyle: 'normal',
		margin: '0 8px 0 0',
	},
	after: {
		contentText: ' ', // Space to extend background
		margin: '0 0 0 8px',
	},
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

function updateInlineDecorations() {
	// Update decorations for all visible text editors
	vscode.window.visibleTextEditors.forEach(editor => {
		updateEditorDecorations(editor);
	});
}

function updateEditorDecorations(editor: vscode.TextEditor) {
	const decorations: vscode.DecorationOptions[] = [];
	const activeSession = vscode.debug.activeDebugSession;
	if (!activeSession || activeSession.type !== 'ddb') {
		editor.setDecorations(inlineDecorationType, []);
		return;
	}
	for (const bp of vscode.debug.breakpoints) {
		if (bp instanceof vscode.SourceBreakpoint && bp.location.uri.toString() === editor.document.uri.toString()) {
			const line = bp.location.range.start.line;
			const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);

			let statusText: string;
			let backgroundColor: string;
			let foregroundColor: string;

			if (bp.processing) {
				statusText = '⟳ Processing...';
				backgroundColor = 'rgba(255, 165, 0, 0.2)'; // Light orange background
				foregroundColor = '#D68000'; // Darker orange text
			} else {
				statusText = `✓ Sessions: ${bp.sessionIds?.join(", ")}`;
				backgroundColor = 'rgba(0, 204, 0, 0.2)'; // Light green background
				foregroundColor = '#008000'; // Darker green text
			}

			const decoration = {
				range: range,
				hoverMessage: new vscode.MarkdownString(`**Breakpoint Info**\n- Line: ${bp.location.range.start.line}\n- Column: ${bp.location.range.start.character}\n- Session IDs: ${bp.sessionIds?.join(', ')}`),
				renderOptions: {
					before: {
						contentText: statusText,
						color: foregroundColor,
						fontWeight: 'bold',
						margin: '0 8px 0 0',
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

	console.log("Starting gdb adapter extension.......");
	let disposable = vscode.commands.registerCommand('extension.showInfo', () => {
		vscode.window.showInformationMessage('Hello from your VSCode extension!');
		const breakpoints = vscode.debug.breakpoints;
		console.log("Breakpoints: ", breakpoints);
	});
	context.subscriptions.push(disposable);
	vscode.debug.onDidStartDebugSession((session) => {
		console.log("Debug session started: ", session);
		breakpointSessionsMap.clear();
		breakpointSessionsMapExp.clear();
	})
	vscode.debug.onDidChangeBreakpoints(async (event) => {
		console.log("Breakpoints changed: ", event);
		event.added.forEach(
			async (bp) => {
				// const selectedSessions = await promptForSessions();
				bp.processing = true;
				bp.transactionId = trasactionId;
				breakpointSessionsMap.set(getBreakpointId(bp), []);
			}
		);
		event.removed.forEach(
			(bp) => {
				breakpointSessionsMap.delete(getBreakpointId(bp));
			}
		);
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
			if (session.type === 'ddb') {
				// Remove all breakpoints from the UI
				const allBreakpoints = vscode.debug.breakpoints;
				vscode.debug.removeBreakpoints(allBreakpoints);
				
				// Clear the maps
				breakpointSessionsMap.clear();
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
	vscode.debug.registerDebugAdapterTrackerFactory('ddb', new MyDebugAdapterTrackerFactory());
	ddbviewactivate(context, breakpointSessionsMapExp)
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
