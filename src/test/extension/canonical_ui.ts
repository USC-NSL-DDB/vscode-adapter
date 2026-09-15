import { testSourceNavigation } from "./source_navigation";
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

async function until(predicate: () => boolean | Promise<boolean>, description: string) {
	const deadline = Date.now() + 15000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, description);
		await delay(50);
	}
}

/** Run with VS Code's --extensionTestsPath, not the Node-only test runner. */
export async function run(): Promise<void> {
	assert.ok(process.env.DDB_TEST_BINARY, "Set DDB_TEST_BINARY");
	const directory = await mkdtemp(join(tmpdir(), "ddb-extension-test-"));
	const messages: any[] = [];
	const unhandled: unknown[] = [];

	const onUnhandled = (error: unknown) => { unhandled.push(error); };
	process.on("unhandledRejection", onUnhandled);
	const tracker = vscode.debug.registerDebugAdapterTrackerFactory("ddb", {
		createDebugAdapterTracker: () => ({ onDidSendMessage: message => { messages.push(message); } }),
	});
	let session: vscode.DebugSession | undefined;
	const unrelated: vscode.Breakpoint[] = [];
	try {
		const extension = vscode.extensions.getExtension("ddb.ddb-debugger");
		assert.ok(extension, "DDB extension must be installed in the test host");
		if (process.env.DDB_TEST_EXTENSION_DIRECTORY) assert.equal(extension.extensionPath, resolve(process.env.DDB_TEST_EXTENSION_DIRECTORY), "test host must load the extracted extension");
		await extension.activate();
		assert.equal(extension.isActive, true);
		const commands = await vscode.commands.getCommands(true);
		for (const command of ["ddbSessionsExplorer.refresh", "ddbSessionsExplorer.toggleGrouping", "ddbBreakpointsExplorer.refresh", "ddb.jumpToFocusedFrame"]) assert.ok(commands.includes(command), command);
		const source = join(directory, "main.c");
		const executable = join(directory, "main");
		unrelated.push(new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(join(directory, "unrelated.c")), new vscode.Position(0, 0)), false));
		unrelated.push(new vscode.FunctionBreakpoint("unrelated_function", false));
		vscode.debug.addBreakpoints(unrelated);
		await writeFile(source, "#include <unistd.h>\nint main(void) {\n int counter = 1;\n while (counter) {\n  counter++;\n  sleep(1);\n }\n return 0;\n}\n");
		execFileSync("cc", ["-g", "-O0", source, "-o", executable]);
		const config = join(directory, "ddb.yaml");
		await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(directory, "base"))}\n  log_dir: ${JSON.stringify(join(directory, "logs"))}\n  Debugger:\n    backend: gdb\nStaticSessions:\n  - tag: ui\n    alias: ui\n    hash: ui-group\n    pid: 4501\n    start_mode: binary\n    binary_path: ${JSON.stringify(executable)}\n    stop_at_entry: true\n`);
		const sourceBreakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(4, 0)));
		vscode.debug.addBreakpoints([sourceBreakpoint]);
		assert.equal(await vscode.debug.startDebugging(undefined, { type: "ddb", name: "Canonical UI test", request: "launch", ddbpath: process.env.DDB_TEST_BINARY, configFilePath: config, cwd: directory }), true);
		await until(() => messages.some(message => message.type === "response" && message.command === "ddb.resolveSourceGroups"), "breakpoint selection must resolve source groups");
		await delay(700);
		await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
		await vscode.commands.executeCommand("workbench.action.quickPickManyToggle");
		await delay(200);
		await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
		await until(() => !!vscode.debug.activeDebugSession && messages.some(message => message.event === "stopped"), "debug session must stop at entry");
		session = vscode.debug.activeDebugSession!;
		const groups = await session.customRequest("ddb.getGroups");
		assert.equal(groups.groups.length, 1);
		for (const command of ["ddbSessionsExplorer.refresh", "ddbSessionsExplorer.toggleGrouping", "ddbSessionsExplorer.toggleGrouping", "ddbBreakpointsExplorer.refresh"]) await vscode.commands.executeCommand(command);
		await until(() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame, "VS Code must focus a stack frame");
		await vscode.commands.executeCommand("ddb.jumpToFocusedFrame");
		await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === source, "focused-frame navigation must open the source file");
		const before = messages.filter(message => message.event === "stopped").length;
		await vscode.commands.executeCommand("workbench.action.debug.stepOver");
		await until(() => messages.filter(message => message.event === "stopped").length > before, "VS Code step-over must stop again");
		const threadId = messages.filter(message => message.event === "stopped").at(-1).body.threadId;
		const stack = await session.customRequest("stackTrace", { threadId });
		assert.equal(stack.stackFrames[0].source.path, source);
		const scopes = await session.customRequest("scopes", { frameId: stack.stackFrames[0].id });
		assert.ok(scopes.scopes.length > 0);
		const hasBreakpoint = async () => (await session!.customRequest("ddb.getBreakpoints")).bkpts.some((bp: any) => bp.location.src === source && bp.location.line === 5);
		await until(hasBreakpoint, "selected group must install the source breakpoint");
		await vscode.commands.executeCommand("workbench.debug.viewlet.action.disableAllBreakpoints");
		await until(async () => !(await hasBreakpoint()), "disabling must remove the backend breakpoint");
		await delay(500);
		assert.ok(vscode.debug.breakpoints.some(bp => bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === source && !bp.enabled), "disabled source breakpoint must remain in VS Code");
		vscode.debug.removeBreakpoints(unrelated);
		await vscode.commands.executeCommand("workbench.debug.viewlet.action.enableAllBreakpoints");
		await until(hasBreakpoint, "re-enabling must retain the selected group and reinstall the breakpoint");
		vscode.debug.addBreakpoints(unrelated);
		await vscode.debug.stopDebugging(session);
		await until(() => !vscode.debug.activeDebugSession, "disconnect must remove the debug session");
		await delay(1200);
		assert.deepEqual(unhandled, [], "UI refreshes must not produce unhandled rejections");
		for (const breakpoint of unrelated) assert.ok(vscode.debug.breakpoints.some(item => item.id === breakpoint.id), "DDB disconnect must preserve unrelated breakpoints");
		assert.ok(!vscode.debug.breakpoints.some(item => item.id === sourceBreakpoint.id), "session-targeted DDB source breakpoints must still be cleaned up");
		console.log("Canonical extension-host activation, sidebar, navigation, stepping, breakpoint selection/disable/re-enable and disconnect passed");
	} finally {
		if (session) await vscode.debug.stopDebugging(session);
		vscode.debug.removeBreakpoints(unrelated);
		tracker.dispose();
		process.off("unhandledRejection", onUnhandled);
		await rm(directory, { recursive: true, force: true });
	}
	await testSourceNavigation();

}
