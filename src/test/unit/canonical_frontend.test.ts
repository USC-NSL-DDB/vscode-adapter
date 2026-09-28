import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

function moduleWithVscode(name: string, vscode: object): any {
	const exports = {};
	vm.runInNewContext(
		fs.readFileSync(path.join(__dirname, "../../common", name + ".js"), "utf8"),
		{
			exports,
			module: { exports },
			require: (id: string) => {
				assert.strictEqual(id, "vscode");
				return vscode;
			},
			setTimeout,
			clearTimeout,
			console,
		},
	);
	return exports;
}

suite("Canonical frontend transport", () => {
	test("sidebar queries route through the active DAP session and normalize memberships", async () => {
		const commands: string[] = [];
		const vscode = {
			debug: {
				activeDebugSession: {
					type: "ddb",
					id: "one",
					customRequest: async (command: string) => {
						commands.push(command);
						return {
							groups: [
								{ id: 7, hash: "opaque-group", alias: "group", sids: [3, 4] },
							],
							bkpts: [{ id: 9, times: "9007199254740993" }],
						};
					},
				},
			},
		};
		const api = moduleWithVscode("ddb_dap_api", vscode);
		const groups = await api.getGroups();
		assert.deepStrictEqual(Array.from(groups[0].sids), [3, 4]);
		assert.strictEqual((await api.getGroup({ grp_id: 7 })).alias, "group");
		assert.strictEqual(
			(await api.getBreakpoints())[0].times,
			"9007199254740993",
		);
		assert.deepStrictEqual(commands, [
			"ddb.getGroups",
			"ddb.getGroups",
			"ddb.getBreakpoints",
		]);
		vscode.debug.activeDebugSession.type = "other";
		await assert.rejects(api.getGroups(), /No active DDB/);
	});

	test("adapter notifications coalesce, filter other sessions and stop cleanly", async () => {
		let listener: ((event: any) => void) | undefined;
		let disposed = 0;
		const vscode = {
			workspace: { getConfiguration: () => ({ get: () => true }) },
			debug: {
				activeDebugSession: { id: "one" },
				onDidReceiveDebugSessionCustomEvent: (
					callback: (event: any) => void,
				) => {
					listener = callback;
					return {
						dispose: () => {
							disposed++;
						},
					};
				},
			},
		};
		const { NotificationService } = moduleWithVscode(
			"ddb_notification_service",
			vscode,
		);
		const service = NotificationService.getInstance();
		let changes = 0;
		service.onNotification("SnapshotChanged", () => {
			changes++;
		});
		service.start();
		assert.strictEqual(service.isConnected(), true);
		listener!({
			session: { type: "ddb", id: "other" },
			event: "ddb.stateChanged",
		});
		listener!({
			session: { type: "ddb", id: "one" },
			event: "ddb.stateChanged",
		});
		listener!({
			session: { type: "ddb", id: "one" },
			event: "ddb.stateChanged",
		});
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.strictEqual(changes, 1);
		listener!({
			session: { type: "ddb", id: "one" },
			event: "ddb.stateChanged",
		});
		service.stop();
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.strictEqual(changes, 1);
		assert.strictEqual(disposed, 1);
		assert.strictEqual(service.isConnected(), false);
	});
});
