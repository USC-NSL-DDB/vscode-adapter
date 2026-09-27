import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** Exercises VS Code's debug content provider and the registered navigation command. */
export async function testSourceNavigation(): Promise<void> {
	const content = "// supplied by the debugger\nint remote_value = 42;\n";
	let sourceReads = 0;
	let sourcePath: string | undefined;
	let unavailable = false;
	const root = vscode.extensions.getExtension("ddb.ddb-debugger")!.extensionPath;
	const { DdbInspection } = await import(pathToFileURL(join(root, "out/src/v2/inspection.mjs")).href);
	const inspection = new DdbInspection({ state: { get: () => ({ sessionId: "session" }) }, client: {
		collect: async () => [{ frameId: "library", functionName: "library_wait", module: "libexample.so", location: { address: "0x1234" } }],
	} });
	const missingStack = await inspection.stack({ threadId: inspection.threadHandle("thread") });
	const emitter = new vscode.EventEmitter<any>();
	let sequence = 0;
	const event = (name: string, body?: object) => emitter.fire({ seq: ++sequence, type: "event", event: name, body });
	const factory = vscode.debug.registerDebugAdapterDescriptorFactory("ddb", {
		createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation({
			onDidSendMessage: emitter.event,
			dispose: () => {},
			handleMessage: async (message: any) => {
				let body: any = {};
				switch (message.command) {
					case "initialize": body = { supportsConfigurationDoneRequest: true }; break;
					case "threads": body = { threads: [{ id: 1, name: "remote" }] }; break;
					case "stackTrace": body = unavailable ? missingStack : { stackFrames: [{ id: 1, name: "remote", line: 2, column: 1, source: { name: "remote.c", path: sourcePath, sourceReference: 7 } }], totalFrames: 1 }; break;
					case "scopes": body = { scopes: [] }; break;
					case "source": {
						sourceReads++;
						if (unavailable) {
							try { await inspection.readSource(message.arguments.sourceReference); }
							catch (error) { emitter.fire({ seq: ++sequence, type: "response", request_seq: message.seq, command: message.command, success: false, message: String(error) }); return; }
						}
						assert.equal(message.arguments.sourceReference, 7); body = { content, mimeType: "text/x-c" }; break;
					}
					case "ddb.status": body = { status: "up" }; break;
					case "ddb.getSessions": body = { sessions: [] }; break;
					case "ddb.getGroups": body = { groups: [] }; break;
					case "ddb.getBreakpoints": body = { bkpts: [] }; break;
				}
				emitter.fire({ seq: ++sequence, type: "response", request_seq: message.seq, command: message.command, success: true, body });
				if (message.command === "launch") event("initialized");
				if (message.command === "configurationDone") event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
				if (message.command === "disconnect") event("terminated");
			},
		}),
	});
	let session: vscode.DebugSession | undefined;
	try {
		assert.equal(await vscode.debug.startDebugging(undefined, { type: "ddb", request: "launch", name: "Remote source UI fixture" }), true);
		const deadline = Date.now() + 10000;
		while (!(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame) || vscode.debug.activeDebugSession?.name !== "Remote source UI fixture") {
			assert.ok(Date.now() < deadline, "fixture must focus a stack frame"); await delay(50);
		}
		session = vscode.debug.activeDebugSession;
		for (const path of [undefined, "/remote/project/remote.c"]) {
			sourcePath = path;
			// Move away from the editor that VS Code automatically opens on stop.
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: "navigation starts here" }));
			await vscode.commands.executeCommand("ddb.jumpToFocusedFrame");
			assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "debug", "source references must take precedence over remote paths");
			assert.equal(vscode.window.activeTextEditor?.document.getText(), content);
			assert.equal(vscode.window.activeTextEditor?.selection.start.line, 1);
		}
		assert.ok(sourceReads > 0, "VS Code must fetch the source through DAP");
		unavailable = true;
		event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
		const missingDeadline = Date.now() + 10000;
		while (!vscode.window.activeTextEditor?.document.getText().includes("No source information is available for library_wait")) {
			assert.ok(Date.now() < missingDeadline, "a source-less frame must open the standard unavailable-source document"); await delay(50);
		}
		assert.equal(vscode.window.activeTextEditor.document.uri.scheme, "debug");
		assert.match(vscode.window.activeTextEditor.document.getText(), /Could not load source/);
		assert.ok(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame);
		console.log("Unavailable-source UI passed: native debug error document and selectable frame");
	} finally {
		if (session) await vscode.debug.stopDebugging(session);
		factory.dispose(); emitter.dispose();
	}
}
