import { ui } from "./ui_helpers";
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Snapshot } from "@ddb-debugger/api-client" with {
	"resolution-mode": "import",
};
import type { DdbConnection } from "../../v2/connection.mjs" with {
	"resolution-mode": "import",
};
import type { DebugProtocol } from "vscode-debugprotocol";

/** Real adapter and VS Code UI with deterministic simultaneous backend stops. */
export async function testBreakpointHits(): Promise<void> {
	const extension = vscode.extensions.getExtension("ddb.ddb-debugger")!;
	await extension.activate();
	const root = extension.extensionPath;
	const { CanonicalDebugSession } = await import(
		pathToFileURL(join(root, "out/src/v2/session.mjs")).href
	);
	const { DdbState } = await import(
		pathToFileURL(join(root, "out/src/v2/state.mjs")).href
	);
	const directory = await mkdtemp(join(tmpdir(), "ddb-hit-ui-"));
	const source = join(directory, "hits.c");
	await writeFile(source, "// fixture\nint shared_hit;\nint other_hit;\n");
	const snapshot: Snapshot = {
		serverInstanceId: "fixture",
		stateEventCursor: { serverInstanceId: "fixture" },
		groups: [
			{ groupId: "workers", displayName: "workers", sessionIds: ["a", "b"] },
		],
		sessions: ["a", "b"].map((id) => ({
			sessionId: id,
			displayName: `worker-${id}`,
			groupId: "workers",
			status: "SESSION_STATUS_STOPPED",
		})),
		threads: ["a", "b", "other"].map((id) => ({
			threadId: id,
			sessionId: id === "a" ? "a" : "b",
			name: id,
			state: "THREAD_STATE_STOPPED",
			location: { path: source, line: id === "other" ? 3 : 2 },
		})),
		breakpoints: [
			{
				breakpointId: "shared",
				target: { group: { groupId: "workers" } },
				spec: { source: { source, line: 2 } },
				hitCount: "12",
			},
			{
				breakpointId: "other",
				target: { session: { sessionId: "b" } },
				spec: { source: { source, line: 3 } },
				hitCount: "8",
			},
		],
		executionStates: ["a", "b", "other"].map((id) => ({
			executionStateId: id,
			revision: "1",
			target: { thread: { threadId: id } },
			stopReason: {
				kind: "STOP_REASON_KIND_BREAKPOINT",
				threadId: id,
				breakpointId: id === "other" ? "other" : "shared",
			},
		})),
	};
	if (process.env.DDB_HIT_ALL_STOPPED !== "1")
		snapshot.threads!.push({
			threadId: "running",
			sessionId: "b",
			name: "running",
			state: "THREAD_STATE_RUNNING",
		});
	const state = new DdbState();
	const distributed = process.env.DDB_HIT_DISTRIBUTED === "1";
	const connection = {
		state,
		handshake: { capabilities: {} },
		async *states() {
			state.hydrate(structuredClone(snapshot));
			yield { type: "snapshot", snapshot };
		},
		client: {
			async *subscribeOutput() {},
			collect: async (method: string, args: any) => {
				// A real backend takes longer than VS Code's 50 ms tree refresh.
				if (method === "DebuggerService.ListFrames") await delay(250);
				if (method === "DebuggerService.ListFrames")
					return [
						{
							frameId: `${args.threadId}-frame`,
							functionName: args.threadId,
							location: {
								path: source,
								line: args.threadId === "other" ? 3 : 2,
							},
						},
						{
							frameId: `${args.threadId}-caller`,
							level: 1,
							functionName: `${args.threadId}_caller`,
							location: { path: source, line: 1 },
						},
					];
				if (
					method === "DebuggerService.ListScopes" ||
					method === "DebuggerService.ListRegisters"
				)
					return [];
				throw new Error(`Unexpected fixture collection ${method}`);
			},
			call: async (method: string, args: any) => {
				if (method === "DebuggerControlService.RunDistributedBacktrace") {
					const threadId = args.target.thread.threadId;
					const frames = await connection.client.collect(
						"DebuggerService.ListFrames",
						{ threadId },
					);
					return {
						distributedBacktrace: {
							frames: frames.map((frame, index) => ({
								frame,
								index,
								threadId,
								sessionId: threadId === "a" ? "a" : "b",
							})),
						},
					} as any;
				}
				assert.equal(method, "DebuggerControlService.SelectThread");
				return {};
			},
		},
		complete: async (result: unknown) => result,
		close: async () => {},
	} as unknown as DdbConnection;
	const emitter = new vscode.EventEmitter<any>();
	const trace: any[] = [];
	class Fixture extends CanonicalDebugSession {
		handleMessage(message: any) {
			trace.push({ command: message.command, args: message.arguments });
			this.dispatchRequest(message);
		}
		sendEvent(event: any) {
			emitter.fire(event);
		}
		sendResponse(response: any) {
			trace.push({
				response: response.command,
				success: response.success,
				message: response.message,
				body: response.body,
			});
			if (response.command === "stackTrace") {
				// Remote adapter replies can arrive after the tree refresh starts.
				// Backend-only delay misses this because DDB preloads the stack.
				setTimeout(
					() => emitter.fire(response),
					Number(process.env.DDB_HIT_STACK_DELAY_MS ?? 150),
				);
			} else {
				emitter.fire(response);
			}
		}
		async launchRequest(response: DebugProtocol.LaunchResponse) {
			Object.assign(this, { distributed });
			await this.useConnection(connection);
			this.sendResponse(response);
			this.sendEvent({ type: "event", event: "initialized", seq: 0 });
		}
		update() {
			state.hydrate(structuredClone(snapshot));
			(this as any).stateChanged({ type: "event", event: {} });
		}
	}
	const adapter = new Fixture();
	const factory = vscode.debug.registerDebugAdapterDescriptorFactory("ddb", {
		createDebugAdapterDescriptor: () =>
			new vscode.DebugAdapterInlineImplementation({
				onDidSendMessage: emitter.event,
				handleMessage: (message) => adapter.handleMessage(message),
				dispose() {},
			}),
	});
	const until = async (
		predicate: () => boolean | Promise<boolean>,
		message: string,
	) => {
		const deadline = Date.now() + 12000;
		while (!(await predicate())) {
			assert.ok(Date.now() < deadline, message);
			await delay(50);
		}
	};
	const rows = `Array.from(document.querySelectorAll('[aria-label="DDB Breakpoints"] .monaco-list-row'))`;
	const row = (label: string) =>
		`${rows}.find(row => row.textContent.includes(${JSON.stringify(label)}))`;
	const click = (label: string, selector: string) =>
		ui(
			`(() => { const button = (${row(label)})?.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`,
		);
	let session: vscode.DebugSession | undefined;
	try {
		assert.ok(
			await vscode.debug.startDebugging(undefined, {
				type: "ddb",
				request: "launch",
				name: "Concurrent breakpoint hits",
			}),
		);
		await until(
			() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame,
			"fixture must select its first stop",
		);
		session = vscode.debug.activeDebugSession!;
		const breakpoints = (await session.customRequest("ddb.getBreakpoints"))
			.bkpts;
		const shared = breakpoints.find((bp: any) => bp.location.line === 2);
		const target = shared.hits.find((hit: any) => hit.threadName === "b");
		await vscode.commands.executeCommand("ddbBreakpointsExplorer.focus");
		await delay(400);
		await until(
			() =>
				ui(
					`${row("hits.c:2")}?.textContent.includes('Hit · 2 sessions') ?? false`,
				),
			"shared breakpoint must show both current hits",
		);
		assert.ok(click("hits.c:2", ".monaco-tl-twistie"));
		await until(() => ui(`!!(${row("workers")})`), "group must be rendered");
		await delay(200);
		assert.ok(ui(`${row("workers")}.textContent.includes('Hit · 2 sessions')`));
		assert.ok(click("workers", ".monaco-tl-twistie"));
		await until(
			() => ui(`!!(${row("worker-b")})`),
			"session hit must be rendered",
		);
		await delay(400);
		assert.ok(ui(`${row("worker-b")}.textContent.includes('Hit')`));
		assert.ok(
			ui(`${rows}.every(row => !/\\[(bkpt|Group|sid:)/.test(row.textContent))`),
			"tree labels must omit internal IDs and repeated type prefixes",
		);
		assert.ok(
			ui(
				`(() => { const row = Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).find(row => row.textContent.includes('worker-b: b')); if (!row) return false; if (row.getAttribute('aria-expanded') === 'true') row.querySelector('.monaco-tl-twistie').click(); return true; })()`,
			),
		);
		await delay(200);
		assert.ok(
			ui(
				`(() => { const pane = document.querySelector('[aria-label="Debug Call Stack"]')?.closest('.pane'); const header = pane?.querySelector('.pane-header'); if (!header) return false; header.click(); return true; })()`,
			),
		);
		await delay(200);
		assert.ok(click("worker-b", '[aria-label="Go to Paused Frame"]'));
		await until(
			() =>
				vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
				vscode.debug.activeStackItem.threadId === target.threadId,
			"hit button must focus the chosen session's frame",
		);
		assert.equal(vscode.window.activeTextEditor?.selection.start.line, 1);
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row[aria-selected="true"]')).some(row => row.textContent.includes('[breakpoint] b'))`,
				),
			"hit navigation must reveal and select the matching call-stack row",
		);
		await vscode.commands.executeCommand(
			"workbench.action.debug.callStackBottom",
		);
		await until(
			() => vscode.window.activeTextEditor?.selection.start.line === 0,
			"fixture must select a caller before returning to the hit",
		);
		assert.ok(click("worker-b", '[aria-label="Go to Paused Frame"]'));
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row[aria-selected="true"]')).some(row => row.textContent.includes('[breakpoint] b'))`,
				),
			"repeated hit navigation must leave the caller and select the paused frame",
		);
		// A manual selection in another thread must not prevent explicit hit navigation.
		assert.ok(
			ui(
				`(() => { const row = Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).find(row => row.textContent.includes('worker-a: a')); if (!row) return false; if (row.getAttribute('aria-expanded') !== 'true') row.querySelector('.monaco-tl-twistie').click(); return true; })()`,
			),
		);
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).some(row => row.textContent.includes('[breakpoint] a'))`,
				),
			"other thread's frame must be visible",
		);
		assert.ok(
			ui(
				`(() => { const row = Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).find(row => row.textContent.includes('[breakpoint] a')); if (!row) return false; row.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`,
			),
		);
		await until(
			() =>
				vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
				vscode.debug.activeStackItem.threadId ===
					shared.hits.find((hit: any) => hit.threadName === "a").threadId,
			"manual click must select the other thread",
		);
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).some(row => row.textContent.includes('a_caller'))`,
				),
			"other thread's caller must be visible",
		);
		assert.ok(
			ui(
				`(() => { const row = Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).find(row => row.textContent.includes('a_caller')); if (!row) return false; row.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`,
			),
		);
		await until(
			() => vscode.window.activeTextEditor?.selection.start.line === 0,
			"manual click must select another thread's caller",
		);
		assert.ok(click("worker-b", '[aria-label="Go to Paused Frame"]'));
		await until(
			() =>
				vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
				vscode.debug.activeStackItem.threadId === target.threadId,
			"hit navigation must override manual selection in another thread",
		);
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row[aria-selected="true"]')).some(row => row.textContent.includes('[breakpoint] b'))`,
				),
			"hit navigation must select its row after another thread was manually selected",
		);
		// A second stopped thread in the same process must work as well.
		const sibling = breakpoints.find((bp: any) => bp.location.line === 3)
			.hits[0];
		await vscode.commands.executeCommand("ddbBreakpointsExplorer.focusHit", {
			hits: [sibling],
		});
		await vscode.commands.executeCommand(
			"workbench.action.debug.callStackBottom",
		);
		await until(
			() =>
				vscode.window.activeTextEditor?.selection.start.line === 0 &&
				vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
				vscode.debug.activeStackItem.threadId === sibling.threadId,
			"same-process sibling caller must be selected",
		);
		assert.ok(click("worker-b", '[aria-label="Go to Paused Frame"]'));
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row[aria-selected="true"]')).some(row => row.textContent.includes('[breakpoint] b'))`,
				),
			"hit navigation must select its row after inspecting a sibling thread",
		);
		// Parent actions present every current hit and can navigate back to another session.
		assert.ok(click("hits.c:2", '[aria-label="Go to Paused Frame"]'));
		await until(
			() =>
				ui(
					`document.querySelector('.quick-input-widget')?.textContent.includes('Go to Paused Frame') ?? false`,
				),
			"concurrent hits must offer a choice",
		);
		await vscode.commands.executeCommand(
			"workbench.action.acceptSelectedQuickOpenItem",
		);
		await until(
			() =>
				vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
				vscode.debug.activeStackItem.threadId === shared.hits[0].threadId,
			"picker must select the other hit",
		);
		snapshot.threads![1].state = "THREAD_STATE_RUNNING";
		snapshot.executionStates![1].running = true;
		adapter.update();
		await until(
			() =>
				ui(
					`${row("hits.c:2")}?.textContent.includes('Hit · 1 session') ?? false`,
				),
			"resuming one hit must preserve the other session's marker",
		);
		await until(
			() =>
				ui(
					`!(${row("worker-b")})?.querySelector('[aria-label="Go to Paused Frame"]')`,
				),
			"resumed session must lose its navigation action",
		);
		assert.ok(
			ui(`${row("hits.c:3")}.textContent.includes('Hit · 1 session')`),
			"another breakpoint in that session must remain marked",
		);
		await vscode.commands.executeCommand(
			"ddbBreakpointsExplorer.toggleGroupByFile",
		);
		await until(
			() =>
				ui(
					`${row("hits.c")}?.textContent.includes('Hit · 2 sessions') ?? false`,
				),
			"file grouping must preserve current hit summaries",
		);
		assert.ok(
			ui(
				`!!(${row("hits.c")})?.querySelector('[aria-label="Go to Paused Frame"]')`,
			),
		);
		for (const thread of snapshot.threads!)
			thread.state = "THREAD_STATE_RUNNING";
		for (const execution of snapshot.executionStates!) execution.running = true;
		adapter.update();
		await until(
			() =>
				ui(
					`${rows}.every(row => !row.textContent.includes('Hit') && !row.querySelector('[aria-label="Go to Paused Frame"]'))`,
				),
			"resuming all targets must clear every hit marker and action",
		);
		await until(
			() =>
				ui(
					`!!document.querySelector('[aria-label="Show Flat Breakpoint List"]')`,
				),
			"grouped view must offer the flat-list action",
		);
		await vscode.commands.executeCommand("ddbBreakpointsExplorer.showFlat");
		await until(
			() => ui(`!!(${row("hits.c:2")})`),
			"flat-list action must restore filename and line labels",
		);
		await until(
			() =>
				ui(
					`!!document.querySelector('[aria-label="Group Breakpoints by File"]')`,
				),
			"flat view must offer grouping by file",
		);
		// A short-lived target may exit without a separately observed running event.
		// Both labels share a line; deleting one thread must preserve its peer.
		const executionText = () =>
			ui(
				`Array.from(document.querySelectorAll('.monaco-editor .view-line span')).flatMap(e => [getComputedStyle(e, '::before').content, getComputedStyle(e, '::after').content]).join(' ')`,
			) as string;
		await vscode.window.showTextDocument(vscode.Uri.file(source));
		for (const id of ["a", "b"]) {
			snapshot.threads!.find((thread) => thread.threadId === id)!.state =
				"THREAD_STATE_STOPPED";
			const execution = snapshot.executionStates!.find(
				(execution) => execution.executionStateId === id,
			)!;
			execution.running = false;
			execution.revision = "2";
		}
		adapter.update();
		const first = shared.hits.find((hit: any) => hit.threadName === "a")!;
		const second = shared.hits.find((hit: any) => hit.threadName === "b")!;
		await until(
			() =>
				executionText().includes(`S${first.sessionId},T${first.threadId}`) &&
				executionText().includes(`S${second.sessionId},T${second.threadId}`),
			"both stopped targets must decorate their shared source line",
		);
		snapshot.threads = snapshot.threads!.filter(
			(thread) => thread.threadId !== "b",
		);
		snapshot.executionStates = snapshot.executionStates!.filter(
			(execution) => execution.executionStateId !== "b",
		);
		adapter.update();
		await until(
			() =>
				executionText().includes(
					`Executing by: Session ${first.sessionId}, Thread ${first.threadId}`,
				) && !executionText().includes(`T${second.threadId}`),
			"exiting client must clear its label while the server stays decorated",
		);
		// A fresh stop can replace the old stop without an intervening continue.
		const owner = snapshot.threads!.find((thread) => thread.threadId === "a")!;
		owner.location = { path: source, line: 3 };
		const ownerExecution = snapshot.executionStates!.find(
			(execution) => execution.executionStateId === "a",
		)!;
		ownerExecution.location = owner.location;
		ownerExecution.revision = "3";
		adapter.update();
		await until(
			() =>
				ui(
					`Array.from(document.querySelectorAll('.monaco-editor .view-line')).some(line => line.textContent.includes('other_hit') && Array.from(line.querySelectorAll('span')).some(span => getComputedStyle(span, '::after').content.includes('Executing by:')))`,
				),
			"new stop must decorate its new source line",
		);
		await until(
			() => (executionText().match(/Executing by:/g) ?? []).length === 1,
			"a new stop must remove the previous location",
		);
		const peer = snapshot.threads!.find(
			(thread) => thread.threadId === "other",
		)!;
		peer.state = "THREAD_STATE_STOPPED";
		const peerExecution = snapshot.executionStates!.find(
			(execution) => execution.executionStateId === "other",
		)!;
		peerExecution.running = false;
		peerExecution.revision = "2";
		adapter.update();
		await until(
			() => executionText().includes("[2 threads]"),
			"continue-all test must have two decorated threads",
		);
		adapter.sendEvent({
			type: "event",
			seq: 0,
			event: "continued",
			body: { threadId: first.threadId, allThreadsContinued: true },
		});
		await until(
			() => !executionText().includes("Executing by:"),
			"continue-all must clear execution labels",
		);
		console.log(
			"Execution decoration lifecycle passed: thread exit preserves peer, new stop replaces old location, continue-all clears labels",
		);
		console.log(
			"Concurrent breakpoint hit UI passed: parent/group/session indicators, frame focus, hit picker and resume cleanup",
		);
	} catch (error) {
		console.error(
			"Execution lines",
			ui(
				`Array.from(document.querySelectorAll('.monaco-editor .view-line')).map(line => ({ text: line.textContent, labels: Array.from(line.querySelectorAll('span')).flatMap(span => [getComputedStyle(span, '::before').content, getComputedStyle(span, '::after').content]).filter(text => text.includes('Executing by:')) })).filter(line => line.labels.length)`,
			),
		);
		console.error(
			"Hit UI diagnostic",
			JSON.stringify({
				calls: trace.slice(-10),
				stack: ui(
					`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).map(row => ({text: row.textContent, selected: row.getAttribute('aria-selected'), expanded: row.getAttribute('aria-expanded')}))`,
				),
			}),
		);
		throw error;
	} finally {
		if (session) await vscode.debug.stopDebugging(session);
		factory.dispose();
		emitter.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}
