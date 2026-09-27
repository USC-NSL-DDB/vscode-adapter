import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Click actual session tree items, whose handle types must survive the UI boundary. */
export async function testSessionControls(): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "ddb-session-controls-ui-"));
	const messages: any[] = [];
	const tracker = vscode.debug.registerDebugAdapterTrackerFactory("ddb", {
		createDebugAdapterTracker: () => ({ onWillReceiveMessage: message => messages.push(message), onDidSendMessage: message => messages.push(message) }),
	});
	const ui = (expression: string) => JSON.parse(execFileSync(process.env.DDB_TEST_NODE!, [process.env.DDB_TEST_CDP_SCRIPT!, process.env.DDB_TEST_PROFILE!, expression], { encoding: "utf8" }));
	const until = async (predicate: () => boolean | Promise<boolean>, message: string) => {
		const deadline = Date.now() + 10000;
		while (!await predicate()) { assert.ok(Date.now() < deadline, message); await delay(50); }
	};
	let session: vscode.DebugSession | undefined;
	try {
		const source = join(directory, "main.c"), binary = join(directory, "main"), config = join(directory, "ddb.yaml");
		await writeFile(source, "#include <unistd.h>\nint main(int argc, char **argv) { if (argc > 1) return 0; while (1) sleep(1); }\n");
		execFileSync("cc", ["-g", "-O0", source, "-o", binary]);
		await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${directory}/base\n  log_dir: ${directory}/logs\n  Debugger:\n    backend: gdb\nStaticSessions:\n` + ["server", "client"].map((name, i) => `  - tag: ${name}\n    alias: ${name}\n    hash: ${name}\n    pid: ${9801 + i}\n    start_delay_ms: ${i * 500}\n    start_mode: binary\n    binary_path: ${binary}\n    binary_args: ${i ? '["exit"]' : "[]"}\n    stop_at_entry: true\n`).join(""));
		assert.ok(await vscode.debug.startDebugging(undefined, { type: "ddb", name: "Session controls UI", request: "launch", ddbpath: process.env.DDB_TEST_BINARY, configFilePath: config, cwd: directory }));
		await until(() => messages.filter(message => message.event === "stopped").length >= 2, "both processes must initially pause");
		session = vscode.debug.activeDebugSession!;
		const threads = (await session.customRequest("threads")).threads;
		const server = threads.find((thread: any) => thread.name.startsWith("server ("));
		const client = threads.find((thread: any) => thread.name.startsWith("client ("));
		assert.ok(server && client);
		const clientFrame = (await session.customRequest("stackTrace", { threadId: client.id })).stackFrames[0];
		await vscode.commands.executeCommand("ddbSessionsExplorer.focus");
		await vscode.commands.executeCommand("ddbSessionsExplorer.refresh");
		await vscode.commands.executeCommand("ddbSessionsExplorer.toggleGrouping");
		const rows = `Array.from(document.querySelectorAll('[aria-label="DDB Sessions"] .monaco-list-row'))`;
		const button = (name: string) => `${rows}.find(row => row.textContent.includes('server ('))?.querySelector('[aria-label="${name}"]')`;
		await until(() => ui(`!!(${button("Continue Session")})`), "server row must provide a continue button");
		const beforeControl = messages.length;
		assert.ok(ui(`(() => { ${button("Continue Session")}.click(); return true; })()`));
		await until(() => messages.some(message => message.type === "response" && message.command === "continue"), "sidebar continue must receive a response");
		const response = messages.find(message => message.type === "response" && message.command === "continue");
		assert.equal(response.success, true, response.message);
		assert.equal(response.body.allThreadsContinued, false);
		await until(() => messages.slice(beforeControl).some(message => message.event === "continued" && message.body.threadId === server.id), "only server must resume");
		assert.ok(!messages.slice(beforeControl).some(message => message.event === "continued" && message.body.threadId === client.id), "client must remain paused");
		assert.ok((await session.customRequest("scopes", { frameId: clientFrame.id })).scopes.length);
		assert.ok(ui(`(() => { ${button("Pause Session")}.click(); return true; })()`));
		await until(() => messages.filter(message => message.event === "stopped" && message.body.threadId === server.id).length >= 2, "sidebar pause must stop the server again");
		assert.equal(ui(`Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item')).some(row => /Unknown or expired|DDB (continue|pause) failed/.test(row.textContent))`), false);
		await vscode.window.showTextDocument(vscode.Uri.file(source));
		const decorationText = () => ui(`Array.from(document.querySelectorAll('.monaco-editor .view-line span')).flatMap(e => [getComputedStyle(e, '::before').content, getComputedStyle(e, '::after').content]).join(' ')`) as string;
		const clientMetadata = await session.customRequest("ddb.frameMetadata", { frameId: clientFrame.id });
		const clientLabel = `Session ${clientMetadata.session_id}, Thread ${client.id}`;
		await until(() => decorationText().includes(clientLabel), "paused client must have an execution label before exiting");
		await session.customRequest("continue", { sessionId: clientMetadata.session_id });
		await until(async () => !(await session!.customRequest("threads")).threads.some((thread: any) => thread.id === client.id), "client must finish while the server remains attached");
		await until(() => !decorationText().includes(clientLabel), "finished client must not retain its execution label");
		assert.ok((await session.customRequest("threads")).threads.some((thread: any) => thread.id === server.id));
		console.log("Real client exit decoration cleanup passed while server remains attached");
		console.log("Session tree controls passed: actual continue/pause buttons, staggered processes, paused peer preserved");
	} finally {
		if (session) await vscode.debug.stopDebugging(session);
		tracker.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}
