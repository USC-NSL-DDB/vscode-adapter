import { ui } from "./ui_helpers";
import { once } from "node:events";
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

async function until(
	predicate: () => boolean | Promise<boolean>,
	detail: string,
) {
	const deadline = Date.now() + 20000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, detail);
		await delay(25);
	}
}

/** Opt-in test against the DDB-instrumented gRPC greeter client and server. */
export async function run(): Promise<void> {
	const workspace = process.env.DDB_GREETER_WORKSPACE!;
	assert.ok(workspace && process.env.DDB_TEST_BINARY);
	const directory = await mkdtemp(join(tmpdir(), "ddb-greeter-ui-"));
	const discoveryFile = "/tmp/ddb/service_discovery/config";
	let discovery: Buffer | undefined;
	try {
		discovery = await readFile(discoveryFile);
	} catch {
		/* No earlier discovery configuration. */
	}
	const messages: any[] = [];
	const children: ChildProcess[] = [];
	const appOutput: Record<string, string> = {};
	let broker: ChildProcess | undefined;
	const tracker = vscode.debug.registerDebugAdapterTrackerFactory("ddb", {
		createDebugAdapterTracker: () => ({
			onWillReceiveMessage: (message) =>
				messages.push({ ...message, incoming: true }),
			onDidSendMessage: (message) => messages.push(message),
		}),
	});
	let session: vscode.DebugSession | undefined;
	let failed = false;
	let failure: unknown;
	const app = (name: string, args: string[]) => {
		const child = spawn(
			join(workspace, "build", `greeter_${name}`),
			["--ddb", ...args],
			{ cwd: join(workspace, "build"), stdio: ["ignore", "pipe", "pipe"] },
		);
		children.push(child);
		const capture = (data: Buffer) => {
			appOutput[name] = ((appOutput[name] ?? "") + data.toString()).slice(
				-8000,
			);
		};
		child.stdout!.on("data", capture);
		child.stderr!.on("data", capture);
		return child;
	};
	let breakpointSequence = 1000000;
	const setBreakpoint = async (file: string, line: number, group: string) => {
		const groups = (await session!.customRequest("ddb.getGroups")).groups;
		const selected = groups.find((item: any) => item.alias.includes(group));
		assert.ok(selected, `missing group ${group}`);
		// Group picker interaction is covered by canonical_ui. Install its selected
		// target here so this test isolates actual RPC stop and frame behavior.
		await session!.customRequest("setSessionBreakpoints", {
			seq: ++breakpointSequence,
			arguments: {
				source: { path: join(workspace, file) },
				breakpoints: [
					{ line, subbkpts: [{ type: "group", target: selected.id }] },
				],
			},
		});
		await until(
			async () =>
				(await session!.customRequest("ddb.getBreakpoints")).bkpts.some(
					(b: any) =>
						b.location.src === join(workspace, file) &&
						b.location.line === line &&
						b.verified,
				),
			"selected group breakpoint must be installed",
		);
	};

	try {
		const extension = vscode.extensions.getExtension("ddb.ddb-debugger")!;
		if (process.env.DDB_TEST_EXTENSION_DIRECTORY)
			assert.equal(
				extension.extensionPath,
				resolve(process.env.DDB_TEST_EXTENSION_DIRECTORY),
			);
		await extension.activate();
		await writeFile(
			join(directory, "mosquitto.conf"),
			"listener 28883 127.0.0.1\nallow_anonymous true\npersistence false\n",
		);
		// Own the isolated test broker directly. The production managed-broker
		// cleanup currently kills all Mosquitto processes on the host.
		broker = spawn("mosquitto", ["-c", join(directory, "mosquitto.conf")], {
			stdio: "ignore",
		});
		await once(broker, "spawn");
		await until(async () => {
			assert.equal(broker!.exitCode, null, "isolated broker must stay running");
			const socket = createConnection({ host: "127.0.0.1", port: 28883 });
			try {
				await once(socket, "connect");
				return true;
			} catch {
				return false;
			} finally {
				socket.destroy();
			}
		}, "isolated broker must accept connections");
		await mkdir("/tmp/ddb/service_discovery", { recursive: true });
		await writeFile(
			discoveryFile,
			"tcp://127.0.0.1:28883\nservice_discovery/report\n\n",
		);
		const config = join(directory, "ddb.yaml");
		await writeFile(
			config,
			`Framework: grpc\nFrameFilter:\n  filter_preset: [cpp-stdlib, protobuf-gen, ddb-runtime]\nServiceDiscovery:\n  Broker:\n    hostname: 127.0.0.1\n    port: 28883\nConf:\n  Debugger:\n    backend: ${process.env.DDB_TEST_BACKEND ?? "gdb"}\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${directory}/base\n  log_dir: ${directory}/logs\n`,
		);
		assert.equal(
			await vscode.debug.startDebugging(undefined, {
				type: "ddb",
				request: "launch",
				name: "Greeter RPC UI regression",
				ddbpath: process.env.DDB_TEST_BINARY,
				configFilePath: config,
				cwd: workspace,
				distributedStack: true,
				valuesFormatting: "prettyPrinters",
			}),
			true,
		);
		await until(
			() => !!vscode.debug.activeDebugSession,
			"DDB session must start",
		);
		session = vscode.debug.activeDebugSession!;
		const server = app("server", ["--port=50059"]);
		await until(
			() => messages.some((m) => m.event === "stopped"),
			"server must attach",
		);
		const serverThread = messages.find((m) => m.event === "stopped").body
			.threadId;
		const stackStart = Date.now();
		await session.customRequest("stackTrace", { threadId: serverThread });
		assert.ok(
			Date.now() - stackStart < 1000,
			"initial stack must not wait for unavailable library source",
		);
		await setBreakpoint("greeter_server.cc", 59, "greeter_server");
		await session.customRequest("continue", { threadId: serverThread });
		await delay(300);
		const beforeClient = messages.filter((m) => m.event === "stopped").length;
		const client = app("client", ["--target=localhost:50059"]);
		await until(
			() => messages.filter((m) => m.event === "stopped").length > beforeClient,
			"client must attach",
		);
		const clientThread = messages.filter((m) => m.event === "stopped").at(-1)
			.body.threadId;
		await setBreakpoint("greeter_client.cc", 70, "greeter_client");
		await session.customRequest("continue", { threadId: clientThread });
		await until(
			() =>
				vscode.window.activeTextEditor?.document.uri.fsPath ===
					join(workspace, "greeter_client.cc") &&
				vscode.window.activeTextEditor.selection.start.line === 69,
			"client RPC breakpoint must be highlighted automatically",
		);
		// Let VS Code finish inspecting the selected client frame before continuing.
		await until(
			() =>
				messages.some(
					(m) => m.command === "scopes" && m.type === "response" && m.success,
				) &&
				messages
					.filter((m) => m.command === "scopes" && m.type === "request")
					.every((request) =>
						messages.some(
							(response) =>
								response.type === "response" &&
								response.request_seq === request.seq,
						),
					),
			"client frame scopes must finish loading",
		);
		await session.customRequest("continue", { threadId: clientThread });
		await until(
			() =>
				vscode.window.activeTextEditor?.document.uri.fsPath ===
					join(workspace, "greeter_server.cc") &&
				vscode.window.activeTextEditor.selection.start.line === 58,
			"server handler breakpoint must be highlighted automatically",
		);
		const stableStop = messages.length;
		const hit = messages
			.filter((m) => m.event === "stopped" && m.body.reason === "breakpoint")
			.at(-1);
		assert.ok(!hit.body.preserveFocusHint);
		const threads = (await session.customRequest("threads")).threads;
		assert.equal(
			threads[0].id,
			hit.body.threadId,
			"actual breakpoint thread must appear first",
		);
		assert.match(threads[0].name, /breakpoint at greeter_server.cc:59/);
		const stack = await session.customRequest("stackTrace", {
			threadId: hit.body.threadId,
		});
		assert.match(
			stack.stackFrames[0].name,
			/\[breakpoint\].*GreeterServiceImpl::SayHello/,
		);
		const caller = stack.stackFrames.find((f: any) =>
			f.name.includes("GreeterClient::SayHello"),
		);
		assert.ok(caller, "distributed stack must include the caller");
		assert.equal(
			caller.source?.path,
			join(workspace, "greeter_client.cc"),
			`caller frame must identify its source: ${JSON.stringify(caller)}`,
		);
		assert.ok(
			stack.stackFrames.some((f: any) =>
				/distributed call boundary.*Caller: greeter_client/.test(f.name),
			),
		);
		for (const frame of [stack.stackFrames[0], caller]) {
			const scopes = await session.customRequest("scopes", {
				frameId: frame.id,
			});
			assert.ok(scopes.scopes.length);
			await session.customRequest("variables", {
				variablesReference: scopes.scopes[0].variablesReference,
			});
		}
		await vscode.commands.executeCommand("workbench.view.debug");
		// Reveal the end of the stack through VS Code's navigation command. Its
		// virtualized tree only renders visible rows; then exercise an actual click.
		await vscode.commands.executeCommand(
			"workbench.action.debug.callStackBottom",
		);
		const callerVisible = () =>
			ui(
				`Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).some(row => row.textContent.includes('GreeterClient::SayHello'))`,
			);
		// LLDB may expose more startup/library frames below the caller than GDB.
		// Reveal earlier rows through the same navigation a user can perform.
		for (
			let step = 0;
			step < stack.stackFrames.length && !callerVisible();
			step++
		) {
			await vscode.commands.executeCommand(
				"workbench.action.debug.callStackUp",
			);
			await delay(100);
		}
		await until(
			callerVisible,
			"caller must be present in the rendered VS Code call stack",
		);
		await vscode.window.showTextDocument(
			vscode.Uri.file(join(workspace, "greeter_server.cc")),
		);
		assert.equal(
			ui(
				`(() => { const row = Array.from(document.querySelectorAll('[aria-label="Debug Call Stack"] .monaco-list-row')).find(row => row.textContent.includes('GreeterClient::SayHello')); if (!row) return false; row.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`,
			),
			true,
		);
		await until(
			() =>
				vscode.window.activeTextEditor?.document.uri.fsPath ===
					join(workspace, "greeter_client.cc") &&
				vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
				vscode.debug.activeStackItem.frameId === caller.id,
			"clicking the remote caller frame must select it and open its source",
		);
		await vscode.commands.executeCommand("ddbBreakpointsExplorer.focus");
		// Let VS Code finish fetching tree items before sending the inline action.
		await delay(1500);
		const sourceAction = `Array.from(document.querySelectorAll('[aria-label="DDB Breakpoints"] .monaco-list-row')).find(row => row.textContent.includes('greeter_server.cc:59'))?.querySelector('.codicon-go-to-file')`;
		await until(
			() => ui(`!!(${sourceAction})`),
			"server breakpoint must expose its inline source action",
		);
		ui(
			`(() => { const action = ${sourceAction}; action.click(); return true; })()`,
		);
		await until(
			() =>
				vscode.window.activeTextEditor?.document.uri.fsPath ===
					join(workspace, "greeter_server.cc") &&
				vscode.window.activeTextEditor.selection.start.line === 58,
			"breakpoint source action must open the handler line",
		);
		const errors = messages
			.slice(stableStop)
			.filter(
				(m) =>
					m.type === "response" &&
					m.success === false &&
					/expired|handle 0/i.test(m.message ?? ""),
			);
		assert.deepEqual(
			errors,
			[],
			"real frame selection must not produce expired inspection errors",
		);
		await vscode.debug.stopDebugging(session);
		await until(
			() =>
				children.every(
					(child) => child.exitCode !== null || child.signalCode !== null,
				),
			"disconnect must terminate both attached greeter processes",
		);
		assert.equal(server.signalCode, "SIGKILL");
		assert.equal(client.signalCode, "SIGKILL");
		console.log(
			"Greeter VS Code UI passed: client/server highlights, breakpoint thread labels, caller selection, source navigation, variable inspection and inferior cleanup",
		);
	} catch (error) {
		failed = true;
		failure = error;
		try {
			await cp(directory, "/tmp/ddb-greeter-failure", { recursive: true });
			const item = vscode.debug.activeStackItem;
			const diagnostic = {
				appOutput,
				editor: vscode.window.activeTextEditor?.document.uri.toString(),
				selection: vscode.window.activeTextEditor?.selection,
				active:
					item instanceof vscode.DebugStackFrame
						? { threadId: item.threadId, frameId: item.frameId }
						: undefined,
				calls: messages
					.filter((m) => ["stackTrace", "scopes", "source"].includes(m.command))
					.slice(-30)
					.map((m) => ({
						command: m.command,
						type: m.type,
						args: m.arguments,
						success: m.success,
						message: m.message,
						frames: m.body?.stackFrames?.slice(0, 80),
					})),
			};
			Object.assign(diagnostic, {
				breakpointRow: ui(
					`Array.from(document.querySelectorAll('[aria-label="DDB Breakpoints"] .monaco-list-row')).find(row => row.textContent.includes('greeter_server.cc:59'))?.outerHTML ?? ''`,
				),
				tree: ui(
					`Array.from(document.querySelectorAll('.monaco-list')).map(node => ({ label: node.getAttribute('aria-label'), parent: node.parentElement?.parentElement?.className, text: Array.from(node.querySelectorAll('.monaco-list-row')).map(row => row.textContent).join('\\n').slice(0, 8000) }))`,
				),
			});
			await writeFile(
				"/tmp/ddb-greeter-ui-failure.json",
				JSON.stringify(diagnostic, null, 2),
			);
			console.error(
				"Greeter UI diagnostic saved to /tmp/ddb-greeter-ui-failure.json",
			);
		} catch (diagnosticError) {
			console.error(
				"Could not save greeter failure diagnostics",
				diagnosticError,
			);
		}
	} finally {
		try {
			try {
				if (session) await vscode.debug.stopDebugging(session);
			} finally {
				try {
					const cleanup = await Promise.allSettled(
						[...children, ...(broker ? [broker] : [])].map(async (child) => {
							if (child.exitCode !== null || child.signalCode !== null) return;
							const exited = once(child, "exit", {
								signal: AbortSignal.timeout(2000),
							});
							child.kill("SIGKILL");
							await exited;
						}),
					);
					for (const result of cleanup)
						if (result.status === "rejected")
							console.error("Greeter child cleanup failed", result.reason);
				} finally {
					tracker.dispose();
					if (discovery) await writeFile(discoveryFile, discovery);
					else await rm(discoveryFile, { force: true });
					await rm(directory, { recursive: true, force: true });
				}
			}
		} catch (cleanupError) {
			if (!failed) {
				failed = true;
				failure = cleanupError;
			} else {
				console.error("Greeter cleanup failed", cleanupError);
			}
		}
	}
	if (failed) throw failure;
}
