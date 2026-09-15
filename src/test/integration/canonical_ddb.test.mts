import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CanonicalHarness } from "./helpers/canonical_session.mjs";
import { DdbConnection } from "../../v2/connection.mjs";

async function until(predicate: () => boolean, detail: string) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${detail}`);
		await delay(20);
	}
}

suite("Canonical DDB binary", function () {
	this.timeout(30000);
	setup(function () { if (!process.env.DDB_TEST_BINARY) this.skip(); });
	for (const backend of ["mock", "gdb"] as const) {
		test(`${backend}: authenticated managed startup, snapshots, typed inspection and operations`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "ddb-v2-test-"));
			let connection: DdbConnection | undefined;
			const dap = new CanonicalHarness();
			let streamError: unknown;
			const output: string[] = [];
			try {
				const source = join(dir, "main.c");
				const executable = join(dir, "main");
				await writeFile(source, '#include <unistd.h>\nint main(void) {\n int counter = 42; int values[2] = {3, 5};\n while (counter) {\n  sleep(1);\n  counter--;\n }\n return 0;\n}\n');
				if (backend === "gdb") execFileSync("cc", ["-g", "-O0", source, "-o", executable]);
				const config = join(dir, "ddb.yaml");
				const sessions = [1, 2].map(id => `  - tag: session-${id}\n    alias: session-${id}\n    hash: group-${id}\n    pid: ${4400 + id}\n` + (backend === "mock"
					? `    mock:\n      source_file: ${JSON.stringify(source)}\n      source_line: 4\n      function: main\n`
					: `    start_mode: binary\n    binary_path: ${JSON.stringify(executable)}\n    stop_at_entry: true\n`)).join("");
				await writeFile(config, `Framework: unspecified\nConf:\n  auto_shutdown: false\n  on_exit: kill\n  base_dir: ${JSON.stringify(join(dir, "base"))}\n  log_dir: ${JSON.stringify(join(dir, "logs"))}\n  Debugger:\n    backend: ${backend}\nStaticSessions:\n${sessions}`);
				connection = await DdbConnection.launch({ binary: process.env.DDB_TEST_BINARY!, configFilePath: config, cwd: dir, onOutput: (_category, text) => output.push(text) });
				const c = connection;
				assert.equal(c.handshake.capabilities.apiVersion, "v2");
				await dap.begin(c);
				await until(() => c.state.all("thread").filter(thread => thread.state === "THREAD_STATE_STOPPED").length === 2 || streamError !== undefined, "both stopped threads from canonical state");
				if (streamError) throw streamError;
				assert.equal(c.state.all("session").length, 2);
				assert.equal(c.state.all("group").length, 2);
				const thread = c.state.all("thread")[0];
				const target = { thread: { threadId: thread.threadId } };
				await c.complete(await c.client.call("DebuggerControlService.SelectThread", { target }));
				const frames = await c.client.collect("DebuggerService.ListFrames", { threadId: thread.threadId });
				assert.ok(frames.length > 0);
				assert.equal(frames[0].location?.path, source);
				const scopes = await c.client.collect("DebuggerService.ListScopes", { frameId: frames[0].frameId });
				assert.ok(scopes.length > 0);
				await c.client.collect("DebuggerService.ListVariables", { scopeId: scopes[0].scopeId });
				const evaluation = await c.complete(await c.client.call("DebuggerControlService.Evaluate", { target, frameId: frames[0].frameId, expression: "1 + 2", evaluationContext: "EVALUATION_CONTEXT_WATCH" }));
				assert.ok(evaluation.evaluation?.value !== undefined);
				if (backend === "gdb") assert.equal(evaluation.evaluation.value, "3");
				const breakpoint = await c.complete(await c.client.call("DebuggerControlService.CreateBreakpoint", { target: { multiple: { targets: c.state.all("group").map(group => ({ group: { groupId: group.groupId } })) } }, breakpoint: { source: { source, line: 5 }, enabled: true } }));
				assert.ok(breakpoint.breakpoint?.breakpointId);
				await until(() => c.state.all("breakpoint").length === 1 || streamError !== undefined, "breakpoint stream upsert");
				if (streamError) throw streamError;
				await c.complete(await c.client.call("DebuggerControlService.DeleteBreakpoint", { target: { broadcast: {} }, breakpointId: breakpoint.breakpoint.breakpointId }));
				await until(() => c.state.all("breakpoint").length === 0 || streamError !== undefined, "breakpoint stream deletion");
				if (streamError) throw streamError;
				const dapThreads = await dap.request("threads");
				assert.equal(dapThreads.success, true, dapThreads.message);
				assert.equal(dapThreads.body.threads.length, 2);
				const dapThreadId = dapThreads.body.threads[0].id;
				const dapStack = await dap.request("stackTrace", { threadId: dapThreadId });
				assert.equal(dapStack.success, true, dapStack.message);
				const dapFrame = dapStack.body.stackFrames[0];
				assert.equal(dapFrame.source.path, source);
				const metadata = await dap.request("ddb.frameMetadata", { frameId: dapFrame.id });
				assert.equal(metadata.success, true, metadata.message);
				assert.equal(metadata.body.thread_id, dapThreadId);
				assert.equal(metadata.body.file, source);
				const uiSessions = await dap.request("ddb.getSessions");
				assert.equal(uiSessions.success, true, uiSessions.message);
				assert.equal(uiSessions.body.sessions.length, 2);
				assert.ok(uiSessions.body.sessions.some((session: {sid: number}) => session.sid === metadata.body.session_id));
				const selectedThread = await dap.request("ddb.selectThread", { threadId: dapThreadId });
				assert.equal(selectedThread.success, true, selectedThread.message);
				const signals = await dap.request("list-signals", { sessionId: metadata.body.session_id });
				assert.equal(signals.success, true, signals.message);
				assert.ok(signals.body.signals.some((signal: {name: string}) => signal.name === "SIGINT"));
				assert.equal((await dap.request("send-signal", { sessionId: metadata.body.session_id, signal: "" })).success, false);
				const dapScopes = await dap.request("scopes", { frameId: dapFrame.id });
				assert.equal(dapScopes.success, true, dapScopes.message);
				for (const scope of dapScopes.body.scopes) {
					const variables = await dap.request("variables", { variablesReference: scope.variablesReference });
					assert.equal(variables.success, true, variables.message);
					assert.ok(Array.isArray(variables.body.variables));
				}
				const watch = await dap.request("evaluate", { expression: "1 + 2", frameId: dapFrame.id, context: "watch" });
				assert.equal(watch.success, true, watch.message);
				if (backend === "gdb") assert.equal(watch.body.result, "3");
				const invalid = await dap.request("next", { threadId: 2147483647 });
				assert.equal(invalid.success, false);
				const dapBreakpoints = await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: 5, condition: "1 == 1" }] });
				assert.equal(dapBreakpoints.success, true, dapBreakpoints.message);
				assert.equal(dapBreakpoints.body.breakpoints.length, 1);
				assert.ok(dapBreakpoints.body.breakpoints[0].id, dapBreakpoints.body.breakpoints[0].message);
				const originalBreakpointId = dapBreakpoints.body.breakpoints[0].id;
				const unchanged = await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: 5, condition: "1 == 1" }] });
				assert.equal(unchanged.body.breakpoints[0].id, originalBreakpointId);
				const changed = await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: 5, condition: "1 == 2" }] });
				assert.equal(changed.success, true, changed.message);
				assert.ok(changed.body.breakpoints[0].id, changed.body.breakpoints[0].message);
				const actualBreakpoints = await c.client.collect("DebuggerService.ListBreakpoints", {});
				assert.equal(actualBreakpoints.length, 1);
				assert.equal(actualBreakpoints[0].spec?.condition, "1 == 2");
				const removed = await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [] });
				assert.equal(removed.success, true, removed.message);
				assert.deepEqual(removed.body.breakpoints, []);
				await until(() => c.state.all("breakpoint").length === 0, "DAP breakpoint deletion");
				dap.enablePairedBreakpoints();
				const uiGroups = await dap.request("ddb.getGroups");
				assert.equal(uiGroups.success, true, uiGroups.message);
				assert.equal((await dap.request("ddb.status")).body.status, "up");
				const sourceGroups = await dap.request("ddb.resolveSourceGroups", { src: source });
				assert.equal(sourceGroups.success, true, sourceGroups.message);
				assert.equal(sourceGroups.body.grps.length, 2);
				const missingSource = await dap.request("ddb.resolveSourceGroups", { src: join(dir, "missing.c") });
				assert.equal(missingSource.success, true, missingSource.message);
				assert.deepEqual(missingSource.body.grps, []);
				const selected = { source: { path: source }, breakpoints: [{ line: 5, subbkpts: [{ type: "group", target: uiGroups.body.groups[0].id }] }] };
				let seq = dap.nextSequence;
				const standardFirst = dap.request("setBreakpoints", selected);
				const customSecond = await dap.request("setSessionBreakpoints", { seq, arguments: selected });
				assert.equal(customSecond.success, true, customSecond.message);
				const paired = await standardFirst;
				assert.equal(paired.success, true, paired.message);
				assert.ok(paired.body.breakpoints[0].id, paired.body.breakpoints[0].message);
				assert.equal(paired.body.breakpoints[0].verified, true);
				const selectedBreakpoints = await c.client.collect("DebuggerService.ListBreakpoints", {});
				assert.equal(selectedBreakpoints.length, 1);
				assert.equal(selectedBreakpoints[0].target?.group?.groupId, c.state.all("group")[0].groupId);
				await until(() => c.state.all("breakpoint").some(item => item.breakpointId === selectedBreakpoints[0].breakpointId), "sidebar breakpoint projection");
				const sidebarBreakpoints = await dap.request("ddb.getBreakpoints");
				assert.equal(sidebarBreakpoints.success, true, sidebarBreakpoints.message);
				assert.equal(sidebarBreakpoints.body.bkpts.length, 1);
				assert.equal(sidebarBreakpoints.body.bkpts[0].verified, true);
				assert.equal(sidebarBreakpoints.body.bkpts[0].id, paired.body.breakpoints[0].id);
				assert.equal(sidebarBreakpoints.body.bkpts[0].subbkpts[0].target_group, uiGroups.body.groups[0].id);
				seq = dap.nextSequence + 1;
				const empty = { source: { path: source }, breakpoints: [] };
				const customFirst = await dap.request("setSessionBreakpoints", { seq, arguments: empty });
				assert.equal(customFirst.success, true, customFirst.message);
				const standardSecond = await dap.request("setBreakpoints", empty);
				assert.equal(standardSecond.success, true, standardSecond.message);
				assert.deepEqual(standardSecond.body.breakpoints, []);
				const invalidSelection = { source: { path: source }, breakpoints: [{ line: 5, subbkpts: [{ type: "group", target: 2147483647 }] }] };
				seq = dap.nextSequence;
				const failingStandard = dap.request("setBreakpoints", invalidSelection);
				const failingCustom = await dap.request("setSessionBreakpoints", { seq, arguments: invalidSelection });
				assert.equal(failingCustom.success, false);
				assert.equal((await failingStandard).success, false);
				seq = dap.nextSequence + 1;
				assert.equal((await dap.request("setSessionBreakpoints", { seq, arguments: invalidSelection })).success, false);
				assert.equal((await dap.request("setBreakpoints", invalidSelection)).success, false);
				const beforeStepEvents = dap.events.length;
				const beforeStep = BigInt(c.state.get("thread", thread.threadId!)?.revision ?? "0");
				await c.complete(await c.client.call("DebuggerControlService.Execute", { target, action: "EXECUTION_ACTION_NEXT" }));
				await until(() => (c.state.get("thread", thread.threadId!)?.state === "THREAD_STATE_STOPPED" && BigInt(c.state.get("thread", thread.threadId!)?.revision ?? "0") > beforeStep) || streamError !== undefined, "step stop");
				const stoppedState = await c.client.call("DebuggerService.GetExecutionState", { target });
				assert.equal(stoppedState.executionState?.stopReason?.kind, "STOP_REASON_KIND_STEP", "canonical API must preserve the step stop reason");
				assert.equal(stoppedState.executionState?.stopReason?.threadId, thread.threadId);
				await until(() => dap.events.slice(beforeStepEvents).some(event => event.event === "stopped" && event.body.threadId === dapThreadId && event.body.reason === "step"), "DAP step reason");
				if (streamError) throw streamError;
				if (backend === "gdb") {
					const freshStack = await dap.request("stackTrace", { threadId: dapThreadId });
					assert.equal(freshStack.success, true, freshStack.message);
					const freshFrame = freshStack.body.stackFrames[0];
					const freshScopes = await dap.request("scopes", { frameId: freshFrame.id });
					assert.equal(freshScopes.success, true, freshScopes.message);
					const locals = freshScopes.body.scopes.find((scope: {name: string}) => scope.name !== "Registers");
					assert.ok(locals);
					const localValues = await dap.request("variables", { variablesReference: locals.variablesReference });
					assert.equal(localValues.success, true, localValues.message);
					const compound = localValues.body.variables.find((variable: {name: string}) => variable.name === "values");
					assert.ok(compound?.variablesReference > 0, JSON.stringify(localValues.body));
					const children = await dap.request("variables", { variablesReference: compound.variablesReference });
					assert.equal(children.success, true, children.message);
					assert.equal(children.body.variables.length, 2);
					const assignment = await dap.request("setVariable", { variablesReference: locals.variablesReference, name: "counter", value: "7" });
					assert.equal(assignment.success, true, assignment.message);
					const assigned = await dap.request("evaluate", { frameId: freshFrame.id, expression: "counter", context: "watch" });
					assert.equal(assigned.success, true, assigned.message);
					assert.equal(assigned.body.result, "7");
					const consoleSet = await dap.request("evaluate", { frameId: freshFrame.id, expression: "set variable counter = 19", context: "repl" });
					assert.equal(consoleSet.success, true, consoleSet.message);
					const consoleValue = await dap.request("evaluate", { frameId: freshFrame.id, expression: "counter", context: "watch" });
					assert.equal(consoleValue.body.result, "19");
					const rawConsole = await dap.request("evaluate", { frameId: freshFrame.id, expression: '-data-evaluate-expression "1 + 2"', context: "repl" });
					assert.equal(rawConsole.success, true, rawConsole.message);
					assert.equal(rawConsole.body.result, "3");
					const childAssignment = await dap.request("setVariable", { variablesReference: compound.variablesReference, name: children.body.variables[0].name, value: "101" });
					assert.equal(childAssignment.success, true, childAssignment.message);
					assert.equal(childAssignment.body.value, "101");
					const compoundWatch = await dap.request("evaluate", { frameId: freshFrame.id, expression: "*(&values)", context: "watch" });
					assert.equal(compoundWatch.success, true, compoundWatch.message);
					assert.ok(compoundWatch.body.variablesReference > 0);
					const watchChildren = await dap.request("variables", { variablesReference: compoundWatch.body.variablesReference });
					assert.equal(watchChildren.success, true, watchChildren.message);
					assert.equal(watchChildren.body.variables.length, 2);
					assert.equal(watchChildren.body.variables[0].value, "101");
					const watchAssignment = await dap.request("setVariable", { variablesReference: compoundWatch.body.variablesReference, name: watchChildren.body.variables[1].name, value: "202" });
					assert.equal(watchAssignment.success, true, watchAssignment.message);
					const element = await dap.request("evaluate", { frameId: freshFrame.id, expression: "values[1]", context: "hover" });
					assert.equal(element.success, true, element.message);
					assert.equal(element.body.result, "202");
				}
				if (backend === "gdb") {
					const hit = await c.complete(await c.client.call("DebuggerControlService.CreateBreakpoint", {
						target: { group: { groupId: thread.groupId } }, breakpoint: { source: { source, line: 6 }, enabled: true },
					}));
					assert.equal(hit.breakpoint?.verified, true, "installed group breakpoint must be verified");
					assert.equal(hit.breakpoint?.subBreakpoints?.length, 1);
					assert.equal(hit.breakpoint?.subBreakpoints?.[0].inheritedFromGroupId, thread.groupId);
					const beforeHit = dap.events.length;
					await c.complete(await c.client.call("DebuggerControlService.Execute", { target, action: "EXECUTION_ACTION_CONTINUE" }));
					await until(() => dap.events.slice(beforeHit).some(event => event.event === "stopped" && event.body.threadId === dapThreadId && event.body.reason === "breakpoint"), "real DAP breakpoint hit");
					const hitState = (await c.client.call("DebuggerService.GetExecutionState", { target })).executionState;
					assert.equal(hitState?.stopReason?.breakpointId, hit.breakpoint?.breakpointId);
					assert.equal(hitState?.stopReason?.threadId, thread.threadId);
					const hitEvent = dap.events.slice(beforeHit).find(event => event.event === "stopped" && event.body.reason === "breakpoint")!;
					assert.equal(hitEvent.body.hitBreakpointIds.length, 1);
					assert.ok(hitEvent.body.hitBreakpointIds[0] > 0);
					await c.complete(await c.client.call("DebuggerControlService.DeleteBreakpoint", { target: { broadcast: {} }, breakpointId: hit.breakpoint?.breakpointId }));
				}
				const controlledThread = c.state.all("thread").find(item => item.threadId === thread.threadId)!;
				const continued = await dap.request("continue", { sessionId: metadata.body.session_id });
				assert.equal(continued.success, true, continued.message);
				assert.equal(continued.body.allThreadsContinued, false);
				await until(() => c.state.get("thread", controlledThread.threadId!)?.state === "THREAD_STATE_RUNNING", "session continue");
				assert.ok(c.state.all("thread").some(item => item.threadId !== controlledThread.threadId && item.state === "THREAD_STATE_STOPPED"));
				const beforePauseEvents = dap.events.length;
				const paused = await dap.request("pause", { sessionId: metadata.body.session_id });
				assert.equal(paused.success, true, paused.message);
				await until(() => c.state.get("thread", controlledThread.threadId!)?.state === "THREAD_STATE_STOPPED", "session pause");
				if (backend === "gdb") {
					const signalState = (await c.client.call("DebuggerService.GetExecutionState", { target })).executionState;
					assert.equal(signalState?.stopReason?.kind, "STOP_REASON_KIND_SIGNAL");
					assert.equal(signalState?.stopReason?.signalName, "SIGINT");
					await until(() => dap.events.slice(beforePauseEvents).some(event => event.event === "stopped" && event.body.text === "SIGINT"), "signal name in DAP stop");
					const killed = await dap.request("send-signal", { sessionId: metadata.body.session_id, signal: "SIGKILL" });
					assert.equal(killed.success, true, killed.message);
					await until(() => !c.state.get("thread", controlledThread.threadId!), "killed session thread removal");
					assert.equal(c.state.all("thread").length, 1);
				}

			} catch (error) {
				console.error(output.join(""));
				if (error && typeof error === "object" && "operation" in error) console.error(JSON.stringify(error.operation, null, 2));
				throw error;
			} finally {
				if (connection) await dap.request("disconnect");
				await connection?.close();

				await rm(dir, { recursive: true, force: true });
			}
		});
	}
});
