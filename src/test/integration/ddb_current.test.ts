import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { execFileSync } from "child_process";
import WebSocket from "ws";
import { MI2 } from "../../backend/mi2/mi2";
import { MI2DebugSession } from "../../mibase";
import { MINode } from "../../backend/mi_parse";
import { SubBkptType } from "../../backend/backend";
import * as api from "../../common/ddb_api";

const binary = process.env.DDB_TEST_BINARY;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await delay(20);
	}
}

class Session extends MI2DebugSession {
	events: any[] = [];
	queries: Promise<void>[] = [];
	constructor(backend: MI2) {
		super(true);
		this.miDebugger = backend;
		backend.on("thread-created", (info: MINode) =>
			this.queries.push(this.threadCreatedEvent(info)),
		);
		backend.on("thread-exited", (info: MINode) => this.threadExitedEvent(info));
	}
	override sendEvent(event: any) {
		this.events.push(event);
	}
	threads() {
		return [...this.m_threads.values()];
	}
	private responses = new Map<number, (response: any) => void>();
	private sequence = 0;
	override sendResponse(response: any) {
		this.responses.get(response.request_seq)?.(response);
		this.responses.delete(response.request_seq);
	}
	request(command: string, args: any = {}): Promise<any> {
		const seq = ++this.sequence;
		const response: any = {
			type: "response",
			command,
			request_seq: seq,
			seq: 0,
			success: true,
		};
		return new Promise((resolve) => {
			this.responses.set(seq, resolve);
			switch (command) {
				case "threads":
					this.threadsRequest(response);
					break;
				case "stackTrace":
					this.stackTraceRequest(response, args);
					break;
				case "scopes":
					this.scopesRequest(response, args);
					break;
				case "variables":
					void this.variablesRequest(response, args);
					break;
				case "evaluate":
					void this.evaluateRequest(response, args);
					break;
				case "next":
					this.nextRequest(response, args);
					break;
				case "pause":
					this.pauseRequest(response, args);
					break;
				case "continue":
					this.continueRequest(response, args);
					break;
			}
		});
	}
}

async function fixture(backend: "mock" | "gdb") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ddb-adapter-test-"));
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	api.configureServiceUrl(`http://127.0.0.1:${port}`);
	const source = path.join(dir, "main.c");
	fs.writeFileSync(
		source,
		"#include <unistd.h>\nint main(void) {\n int counter = 42;\n while (counter) {\n  sleep(1);\n  counter--;\n }\n return 0;\n}\n",
	);
	const executable = path.join(dir, "main");
	if (backend === "gdb")
		execFileSync("cc", ["-g", "-O0", source, "-o", executable]);
	const sessions = [1, 2]
		.map(
			(id) =>
				`  - tag: service-${id}\n    alias: service-${id}\n    hash: group-${id}\n    pid: ${
					4000 + id
				}\n` +
				(backend === "mock"
					? `    mock:\n      source_file: ${JSON.stringify(
							source,
						)}\n      source_line: 4\n      function: main\n`
					: `    start_mode: binary\n    binary_path: ${JSON.stringify(
							executable,
						)}\n    stop_at_entry: true\n`),
		)
		.join("");
	const config = path.join(dir, "ddb.yaml");
	fs.writeFileSync(
		config,
		`Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  api_server_port: ${port}\n  base_dir: ${JSON.stringify(
			path.join(dir, "base"),
		)}\n  log_dir: ${JSON.stringify(
			path.join(dir, "logs"),
		)}\n  Debugger:\n    backend: ${backend}\nStaticSessions:\n${sessions}`,
	);
	const mi = new MI2(binary!, [config], [], { DDB_ADAPTER_FIXTURE: "present" });
	mi.printCalls = true;
	const session = new Session(mi);
	const watchdog = setTimeout(() => {
		void mi.stop();
	}, 20000);
	const output: string[] = [];
	mi.on("msg", (_type, text) => output.push(text));
	const stops: MINode[] = [];
	mi.on("exec-async-output", (record) => {
		if (record.outOfBandRecord[0]?.asyncClass === "stopped") stops.push(record);
	});
	try {
		await mi.load(dir, "", "", "", []);
		await until(
			() =>
				session.threads().length === 2 &&
				session.threads().every((t) => !t.pending),
			"thread registration",
		);
		await Promise.all(session.queries);
		return {
			mi,
			session,
			source,
			stops,
			output,
			dir,
			close: async () => {
				clearTimeout(watchdog);
				await mi.stop();
				fs.rmSync(dir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		clearTimeout(watchdog);
		await mi.stop();
		fs.rmSync(dir, { recursive: true, force: true });
		throw new Error(`${error}\n${output.join("\n")}`);
	}
}

suite("Current DDB binary", function () {
	this.timeout(30000);
	setup(function () {
		if (!binary) this.skip();
	});

	for (const backend of ["mock", "gdb"] as const) {
		test(`${backend}: startup, HTTP, WebSocket, inspection, breakpoints and execution`, async () => {
			const f = await fixture(backend);
			let ws: WebSocket | undefined;
			try {
				assert.ok(
					f.session.threads().every((t) => !t.name.includes("loading")),
				);
				assert.ok(
					!f.output.some((line) =>
						/Could not load thread|WARNING: Error/.test(line),
					),
					f.output.join("\n"),
				);
				const sessions = await api.getSessions();
				assert.strictEqual(sessions.length, 2);
				const groups = await api.getGroups();
				assert.strictEqual(groups.length, 2);
				assert.ok(
					groups.every(
						(group) => group.sids instanceof Set && group.sids.size === 1,
					),
				);
				assert.strictEqual(
					(await api.getGroup({ grp_id: groups[0].id })).sids.size,
					1,
				);
				assert.strictEqual((await api.resolveSrcToGroups(f.source)).length, 2);
				assert.strictEqual((await api.resolveSrcToGroupIds(f.source)).size, 2);
				const threads = await f.mi.getThreads();
				assert.strictEqual(threads.length, 2);
				const thread = threads[0].id;
				if (backend === "gdb")
					await until(() => f.stops.length >= 2, "entry stops");
				assert.ok(await f.mi.switchThread(thread));
				const stack = await f.mi.getStack(0, 20, thread);
				assert.ok(stack.length > 0);
				assert.ok(
					stack.every((frame) => frame.session > 0 && frame.thread > 0),
				);
				assert.strictEqual(stack[0].file, f.source);
				await f.mi.getStackVariables(thread, 0, stack[0].session);
				const dapThreads = await f.session.request("threads");
				assert.strictEqual(
					dapThreads.body.threads.filter((t: any) => t.id > 0).length,
					2,
				);
				const dapStack = await f.session.request("stackTrace", {
					threadId: thread,
				});
				assert.strictEqual(dapStack.success, true, JSON.stringify(dapStack));
				const frameId = dapStack.body.stackFrames[0].id;
				const scopes = await f.session.request("scopes", { frameId });
				const locals = await f.session.request("variables", {
					variablesReference: scopes.body.scopes[0].variablesReference,
				});
				assert.strictEqual(locals.success, true, JSON.stringify(locals));
				const evaluation = await f.session.request("evaluate", {
					frameId,
					expression: "1 + 2",
					context: "watch",
				});
				assert.strictEqual(
					evaluation.success,
					true,
					JSON.stringify(evaluation),
				);
				const rejectedStep = await f.session.request("next", {
					threadId: 999999,
				});
				assert.strictEqual(
					rejectedStep.success,
					false,
					JSON.stringify(rejectedStep),
				);
				const evaluated = await f.mi.evalExpression(
					"1 + 2",
					thread,
					0,
					stack[0].session,
				);
				assert.ok(evaluated.result("value") !== undefined);
				if (backend === "gdb") {
					assert.strictEqual(evaluated.result("value"), "3");
					assert.ok((await f.mi.getRegisters(thread)).length > 0);
					const variable = await f.mi.varCreate(
						thread,
						0,
						"1 + 2",
						"adapter_expression",
					);
					assert.strictEqual(variable.value, "3");
				}
				const notifications: any[] = [];
				ws = new WebSocket(api.getWebSocketUrl());
				ws.on("message", (data) =>
					notifications.push(JSON.parse(data.toString())),
				);
				await new Promise<void>((resolve, reject) => {
					ws!.once("open", resolve);
					ws!.once("error", reject);
				});
				const breakpoint = await f.mi.addBreakPoint({
					file: f.source,
					line: 5,
					condition: "",
					subbkpts: [{ id: 0, type: SubBkptType.Group, target: groups[0].id }],
				});
				assert.ok(Number.isFinite(breakpoint.id));
				assert.deepStrictEqual(
					breakpoint.subbkpts.map((b) => b.target),
					[groups[0].id],
				);
				assert.ok(
					(await api.getBreakpoints()).some((b) => b.id === breakpoint.id),
				);
				await until(
					() =>
						notifications.some(
							(n) =>
								n.payload?.type === "BreakpointChanged" &&
								n.payload.data.type === "Added",
						),
					"breakpoint notification",
				);
				await f.mi.setBreakPointCondition(breakpoint.id!, "1");
				await f.mi.sendCommand(`break-disable ${breakpoint.id}`);
				await f.mi.sendCommand(`break-enable ${breakpoint.id}`);
				assert.ok(await f.mi.removeBreakPoint(breakpoint));
				await assert.rejects(
					Promise.resolve(f.mi.sendCommand("thread-info --thread 999999")),
				);
				assert.ok(await f.mi.next(thread));
				if (backend === "gdb")
					await until(() => f.stops.length >= 3, "step stop");
				if (backend === "mock") assert.ok(await f.mi.stepOut(thread));
				else {
					assert.ok(await f.mi.step(thread));
					await until(() => f.stops.length >= 4, "step-in stop");
					await f.mi.sendCommand(`list-signals --session ${stack[0].session}`);
				}
				await assert.rejects(Promise.resolve(f.mi.next(999999)));
				await f.mi.sendCommand("exec-continue --all");
				await f.mi.sendCommand("exec-interrupt --all");
				assert.strictEqual(
					f.session.events.filter(
						(e) => e.event === "thread" && e.body.reason === "started",
					).length,
					2,
				);
				if (backend === "gdb") {
					await f.mi.sendCommand(
						`send-signal SIGKILL --session ${stack[0].session}`,
					);
					await until(
						() => f.session.threads().length === 1,
						"killed session thread exit",
					);
				}
			} catch (error) {
				throw new Error(
					`${error}\nRecent adapter output:\n${f.output.slice(-15).join("\n")}`,
				);
			} finally {
				ws?.terminate();
				await f.close();
				await f.mi.stop(); // Already-exited shutdown must complete.
			}
		});
	}
});
