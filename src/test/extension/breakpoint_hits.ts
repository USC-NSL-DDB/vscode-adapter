import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Snapshot } from "@ddb-debugger/api-client" with { "resolution-mode": "import" };
import type { DdbConnection } from "../../v2/connection.mjs" with { "resolution-mode": "import" };
import type { DebugProtocol } from "vscode-debugprotocol";

/** Real adapter and VS Code UI with deterministic simultaneous backend stops. */
export async function testBreakpointHits(): Promise<void> {
	const extension = vscode.extensions.getExtension("ddb.ddb-debugger")!;
	await extension.activate();
	const root = extension.extensionPath;
	const { CanonicalDebugSession } = await import(pathToFileURL(join(root, "out/src/v2/session.mjs")).href);
	const { DdbState } = await import(pathToFileURL(join(root, "out/src/v2/state.mjs")).href);
	const directory = await mkdtemp(join(tmpdir(), "ddb-hit-ui-"));
	const source = join(directory, "hits.c");
	await writeFile(source, "// fixture\nint shared_hit;\nint other_hit;\n");
	const snapshot: Snapshot = {
		serverInstanceId: "fixture", stateEventCursor: { serverInstanceId: "fixture" },
		groups: [{ groupId: "workers", displayName: "workers", sessionIds: ["a", "b"] }],
		sessions: ["a", "b"].map(id => ({ sessionId: id, displayName: `worker-${id}`, groupId: "workers", status: "SESSION_STATUS_STOPPED" })),
		threads: ["a", "b", "other"].map(id => ({ threadId: id, sessionId: id === "a" ? "a" : "b", name: id, state: "THREAD_STATE_STOPPED", location: { path: source, line: id === "other" ? 3 : 2 } })),
		breakpoints: [
			{ breakpointId: "shared", target: { group: { groupId: "workers" } }, spec: { source: { source, line: 2 } }, hitCount: "12" },
			{ breakpointId: "other", target: { session: { sessionId: "b" } }, spec: { source: { source, line: 3 } }, hitCount: "8" },
		],
		executionStates: ["a", "b", "other"].map(id => ({ executionStateId: id, revision: "1", target: { thread: { threadId: id } }, stopReason: { kind: "STOP_REASON_KIND_BREAKPOINT", threadId: id, breakpointId: id === "other" ? "other" : "shared" } })),
	};
	const state = new DdbState();
	const connection = {
		state, handshake: { capabilities: {} },
		async *states() { state.hydrate(snapshot); yield { type: "snapshot", snapshot }; },
		client: {
			async *subscribeOutput() {},
			collect: async (method: string, args: any) => {
				if (method === "DebuggerService.ListFrames") return [{ frameId: `${args.threadId}-frame`, functionName: args.threadId, location: { path: source, line: args.threadId === "other" ? 3 : 2 } }];
				if (method === "DebuggerService.ListScopes") return [];
				throw new Error(`Unexpected fixture collection ${method}`);
			},
			call: async (method: string) => { assert.equal(method, "DebuggerControlService.SelectThread"); return {}; },
		},
		complete: async () => ({}), close: async () => {},
	} as unknown as DdbConnection;
	const emitter = new vscode.EventEmitter<any>();
	const trace: any[] = [];
	class Fixture extends CanonicalDebugSession {
		handleMessage(message: any) { trace.push({ command: message.command, args: message.arguments }); this.dispatchRequest(message); }
		sendEvent(event: any) { emitter.fire(event); }
		sendResponse(response: any) { trace.push({ response: response.command, success: response.success, message: response.message, body: response.body }); emitter.fire(response); }
		async launchRequest(response: DebugProtocol.LaunchResponse) {
			await this.useConnection(connection);
			this.sendResponse(response);
			this.sendEvent({ type: "event", event: "initialized", seq: 0 });
		}
		update() { state.hydrate(snapshot); (this as any).stateChanged({ type: "event", event: {} }); }
	}
	const adapter = new Fixture();
	const factory = vscode.debug.registerDebugAdapterDescriptorFactory("ddb", { createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation({ onDidSendMessage: emitter.event, handleMessage: message => adapter.handleMessage(message), dispose() {} }) });
	const ui = (expression: string) => JSON.parse(execFileSync(process.env.DDB_TEST_NODE!, [process.env.DDB_TEST_CDP_SCRIPT!, process.env.DDB_TEST_PROFILE!, expression], { encoding: "utf8" }));
	const until = async (predicate: () => boolean | Promise<boolean>, message: string) => {
		const deadline = Date.now() + 12000;
		while (!await predicate()) { assert.ok(Date.now() < deadline, message); await delay(50); }
	};
	const rows = `Array.from(document.querySelectorAll('[aria-label="DDB Breakpoints"] .monaco-list-row'))`;
	const row = (label: string) => `${rows}.find(row => row.textContent.includes(${JSON.stringify(label)}))`;
	const click = (label: string, selector: string) => ui(`(() => { const button = (${row(label)})?.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`);
	let session: vscode.DebugSession | undefined;
	try {
		assert.ok(await vscode.debug.startDebugging(undefined, { type: "ddb", request: "launch", name: "Concurrent breakpoint hits" }));
		await until(() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame, "fixture must select its first stop");
		session = vscode.debug.activeDebugSession!;
		const breakpoints = (await session.customRequest("ddb.getBreakpoints")).bkpts;
		const shared = breakpoints.find((bp: any) => bp.location.line === 2);
		const target = shared.hits.find((hit: any) => hit.threadName === "b");
		await vscode.commands.executeCommand("ddbBreakpointsExplorer.focus");
		await delay(400);
		await until(() => ui(`${row('hits.c:2')}?.textContent.includes('Hit · 2 sessions') ?? false`), "shared breakpoint must show both current hits");
		assert.ok(click("hits.c:2", ".monaco-tl-twistie"));
		await until(() => ui(`!!(${row('[Group,')})`), "group must be rendered");
		await delay(200);
		assert.ok(ui(`${row('[Group,')}.textContent.includes('Hit · 2 sessions')`));
		assert.ok(click("[Group,", ".monaco-tl-twistie"));
		await until(() => ui(`!!(${row('] worker-b')})`), "session hit must be rendered");
		await delay(400);
		assert.ok(ui(`${row('] worker-b')}.textContent.includes('Hit')`));
		assert.ok(click("] worker-b", '[aria-label="Go to Paused Frame"]'));
		await until(() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame && vscode.debug.activeStackItem.threadId === target.threadId, "hit button must focus the chosen session's frame");
		assert.equal(vscode.window.activeTextEditor?.selection.start.line, 1);
		// Parent actions present every current hit and can navigate back to another session.
		assert.ok(click("hits.c:2", '[aria-label="Go to Paused Frame"]'));
		await until(() => ui(`document.querySelector('.quick-input-widget')?.textContent.includes('Go to Paused Frame') ?? false`), "concurrent hits must offer a choice");
		await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
		await until(() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame && vscode.debug.activeStackItem.threadId === shared.hits[0].threadId, "picker must select the other hit");
		snapshot.threads![1].state = "THREAD_STATE_RUNNING";
		snapshot.executionStates![1].running = true;
		adapter.update();
		await until(() => ui(`${row('hits.c:2')}?.textContent.includes('Hit · 1 session') ?? false`), "resuming one hit must preserve the other session's marker");
		await until(() => ui(`!(${row('] worker-b')})?.querySelector('[aria-label="Go to Paused Frame"]')`), "resumed session must lose its navigation action");
		assert.ok(ui(`${row('hits.c:3')}.textContent.includes('Hit · 1 session')`), "another breakpoint in that session must remain marked");
		await vscode.commands.executeCommand("ddbBreakpointsExplorer.toggleGroupByFile");
		await until(() => ui(`${row('hits.c (2 breakpoints)')}?.textContent.includes('Hit · 2 sessions') ?? false`), "file grouping must preserve current hit summaries");
		assert.ok(ui(`!!(${row('hits.c (2 breakpoints)')})?.querySelector('[aria-label="Go to Paused Frame"]')`));
		for (const thread of snapshot.threads!) thread.state = "THREAD_STATE_RUNNING";
		for (const execution of snapshot.executionStates!) execution.running = true;
		adapter.update();
		await until(() => ui(`${rows}.every(row => !row.textContent.includes('Hit') && !row.querySelector('[aria-label="Go to Paused Frame"]'))`), "resuming all targets must clear every hit marker and action");
		console.log("Concurrent breakpoint hit UI passed: parent/group/session indicators, frame focus, hit picker and resume cleanup");
	} catch (error) {
		console.error("Hit UI diagnostic", JSON.stringify(trace.slice(-25)));
		throw error;
	} finally {
		if (session) await vscode.debug.stopDebugging(session);
		factory.dispose(); emitter.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}
