import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { join } from "node:path";
import { ui } from "./ui_helpers";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** Exercises VS Code's debug content provider and the registered navigation command. */
export async function testSourceNavigation(): Promise<void> {
	const content = "// supplied by the debugger\nint remote_value = 42;\n";
	let sourceReads = 0;
	let sourcePath: string | undefined;
	let unavailable = false;
	let missingPath: string | undefined;
	const root =
		vscode.extensions.getExtension("ddb.ddb-debugger")!.extensionPath;
	const { DdbInspection } = await import(
		pathToFileURL(join(root, "out/src/v2/inspection.mjs")).href
	);
	const { CanonicalDebugSession } = await import(
		pathToFileURL(join(root, "out/src/v2/session.mjs")).href
	);
	const { DdbApiError } = await import(
		pathToFileURL(
			join(root, "node_modules/@ddb-debugger/api-client/dist/client.js"),
		).href
	);
	const inspection = new DdbInspection({
		state: { get: () => ({ sessionId: "session" }) },
		client: {
			call: async () => {
				throw new DdbApiError(404, {
					code: "DDB_ERROR_CODE_NOT_FOUND",
					message: "source was not found",
				});
			},
			collect: async () => [
				{
					frameId: "library",
					functionName: "library_wait",
					module: "libexample.so",
					location: { path: missingPath, address: "0x1234" },
				},
			],
		},
	});
	let missingStack = await inspection.stack({
		threadId: inspection.threadHandle("thread"),
	});
	const emitter = new vscode.EventEmitter<any>();
	const sourceResponses: any[] = [];
	class SourceAdapter extends CanonicalDebugSession {
		handleMessage(message: any) {
			this.dispatchRequest(message);
		}
		sendResponse(response: any) {
			sourceResponses.push(response);
			emitter.fire(response);
		}
	}
	const sourceAdapter = new SourceAdapter();
	Object.assign(sourceAdapter, { inspection });
	let sequence = 0;
	const event = (name: string, body?: object) =>
		emitter.fire({ seq: ++sequence, type: "event", event: name, body });
	const factory = vscode.debug.registerDebugAdapterDescriptorFactory("ddb", {
		createDebugAdapterDescriptor: () =>
			new vscode.DebugAdapterInlineImplementation({
				onDidSendMessage: emitter.event,
				dispose: () => {},
				handleMessage: async (message: any) => {
					let body: any = {};
					switch (message.command) {
						case "initialize":
							body = { supportsConfigurationDoneRequest: true };
							break;
						case "threads":
							body = { threads: [{ id: 1, name: "remote" }] };
							break;
						case "stackTrace":
							body = unavailable
								? missingStack
								: {
										stackFrames: [
											{
												id: 1,
												name: "remote",
												line: 2,
												column: 1,
												source: {
													name: "remote.c",
													path: sourcePath,
													sourceReference: 7,
												},
											},
										],
										totalFrames: 1,
									};
							break;
						case "scopes":
							body = { scopes: [] };
							break;
						case "source": {
							sourceReads++;
							if (unavailable) {
								sourceAdapter.handleMessage(message);
								return;
							}
							assert.equal(message.arguments.sourceReference, 7);
							body = { content, mimeType: "text/x-c" };
							break;
						}
						case "ddb.status":
							body = { status: "up" };
							break;
						case "ddb.getSessions":
							body = { sessions: [] };
							break;
						case "ddb.getGroups":
							body = { groups: [] };
							break;
						case "ddb.getBreakpoints":
							body = { bkpts: [] };
							break;
					}
					emitter.fire({
						seq: ++sequence,
						type: "response",
						request_seq: message.seq,
						command: message.command,
						success: true,
						body,
					});
					if (message.command === "launch") event("initialized");
					if (message.command === "configurationDone")
						event("stopped", {
							reason: "entry",
							threadId: 1,
							allThreadsStopped: true,
						});
					if (message.command === "disconnect") event("terminated");
				},
			}),
	});
	let session: vscode.DebugSession | undefined;
	try {
		assert.equal(
			await vscode.debug.startDebugging(undefined, {
				type: "ddb",
				request: "launch",
				name: "Remote source UI fixture",
			}),
			true,
		);
		const deadline = Date.now() + 10000;
		while (
			!(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame) ||
			vscode.debug.activeDebugSession?.name !== "Remote source UI fixture"
		) {
			assert.ok(Date.now() < deadline, "fixture must focus a stack frame");
			await delay(50);
		}
		session = vscode.debug.activeDebugSession;
		for (const path of [undefined, "/remote/project/remote.c"]) {
			sourcePath = path;
			// Move away from the editor that VS Code automatically opens on stop.
			await vscode.window.showTextDocument(
				await vscode.workspace.openTextDocument({
					content: "navigation starts here",
				}),
			);
			await vscode.commands.executeCommand("ddb.jumpToFocusedFrame");
			assert.equal(
				vscode.window.activeTextEditor?.document.uri.scheme,
				"debug",
				"source references must take precedence over remote paths",
			);
			assert.equal(vscode.window.activeTextEditor?.document.getText(), content);
			assert.equal(vscode.window.activeTextEditor?.selection.start.line, 1);
		}
		assert.ok(sourceReads > 0, "VS Code must fetch the source through DAP");
		unavailable = true;
		event("stopped", {
			reason: "breakpoint",
			threadId: 1,
			allThreadsStopped: true,
		});
		const missingDeadline = Date.now() + 10000;
		while (
			!vscode.window.activeTextEditor?.document
				.getText()
				.includes("No source information is available for library_wait")
		) {
			assert.ok(
				Date.now() < missingDeadline,
				"a source-less frame must open the standard unavailable-source document",
			);
			await delay(50);
		}
		assert.equal(vscode.window.activeTextEditor.document.uri.scheme, "debug");
		assert.match(
			vscode.window.activeTextEditor.document.getText(),
			/Could not load source/,
		);
		assert.ok(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame);
		assert.ok(sourceResponses.length);
		assert.ok(
			sourceResponses.every(
				(response) =>
					response.success === false && response.body.error.showUser === false,
			),
		);
		missingPath = "/missing/library-build/library.c";
		inspection.invalidate();
		missingStack = await inspection.stack({
			threadId: inspection.threadHandle("thread"),
		});
		event("stopped", {
			reason: "breakpoint",
			threadId: 1,
			allThreadsStopped: true,
		});
		const remoteDeadline = Date.now() + 10000;
		while (
			!vscode.window.activeTextEditor?.document
				.getText()
				.includes("pathSubstitutions")
		) {
			assert.ok(
				Date.now() < remoteDeadline,
				"unavailable remote file must explain how to locate matching sources",
			);
			await delay(50);
		}
		assert.match(
			vscode.window.activeTextEditor.document.getText(),
			/missing\/library-build\/library.c/,
		);
		assert.ok(
			sourceResponses.every(
				(response) =>
					response.success === false && response.body.error.showUser === false,
			),
		);
		const popupErrors = ui(
			`Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item')).some(row => /source was not found|No source information|Source file .* is not available/.test(row.textContent))`,
		);
		assert.equal(
			popupErrors,
			false,
			"source failures must stay in the native unavailable-source document",
		);
		console.log(
			"Unavailable-source UI passed: real DAP handlers, missing metadata and remote files, no popup errors",
		);
	} finally {
		if (session) await vscode.debug.stopDebugging(session);
		factory.dispose();
		emitter.dispose();
	}
}
