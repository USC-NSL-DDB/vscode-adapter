import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

function pickerFixture(request: (command: string) => Promise<unknown>) {
	let hide = () => {};
	let disposed = false;
	let lateWrites = 0;
	const errors: string[] = [];
	const picker = new Proxy(
		{
			show() {},
			dispose() {
				if (!disposed) {
					disposed = true;
					hide();
				}
			},
			onDidHide(callback: () => void) {
				hide = callback;
				return { dispose() {} };
			},
			onDidTriggerButton() {
				return { dispose() {} };
			},
		},
		{
			set(target, key, value) {
				if (disposed) lateWrites++;
				return Reflect.set(target, key, value);
			},
		},
	);
	const vscode = {
		window: {
			createQuickPick: () => picker,
			createTextEditorDecorationType: () => ({}),
			showErrorMessage: (message: string) => errors.push(message),
		},
		ThemeIcon: class {},
		DecorationRangeBehavior: {},
	};
	const exports: any = {};
	// Exercise the compiled frontend function with a controllable VS Code host.
	// This avoids exporting a private picker solely for unit tests.
	runInNewContext(
		readFileSync(path.join(__dirname, "../../frontend/extension.js"), "utf8") +
			"\nexports.promptForSessions = promptForSessions;",
		{
			exports,
			module: { exports },
			require: (name: string) =>
				name === "vscode" ? vscode : name === "path" ? path : {},
			setTimeout,
			clearTimeout,
			console,
		},
	);
	return {
		start: () =>
			exports.promptForSessions(
				{ path: "/fixture.c" },
				{ customRequest: request },
			),
		cancel: () => picker.dispose(),
		errors,
		lateWrites: () => lateWrites,
	};
}

suite("Breakpoint picker request lifecycle", () => {
	test("cancellation completes before discovery and ignores its late results", async () => {
		let release!: (value: unknown) => void;
		const loading = new Promise((resolve) => {
			release = resolve;
		});
		const fixture = pickerFixture(() => loading);
		const selection = fixture.start();
		fixture.cancel();
		assert.equal(await selection, undefined);
		release({ sessions: [{ sid: 1 }], grps: [] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fixture.lateWrites(), 0);
		assert.deepEqual(fixture.errors, []);
	});

	test("waits for session activation before resolving groups", async () => {
		const commands: string[] = [];
		let requests = 0;
		const fixture = pickerFixture(async (command) => {
			commands.push(command);
			if (command === "ddb.getSessions")
				return {
					sessions: [
						{ sid: 1, status: ++requests === 1 ? "starting" : "stopped" },
					],
				};
			// Cancelling here keeps this test focused on discovery ordering.
			fixture.cancel();
			return { grps: [] };
		});
		assert.equal(await fixture.start(), undefined);
		assert.deepEqual(commands, [
			"ddb.getSessions",
			"ddb.getSessions",
			"ddb.resolveSourceGroups",
		]);
		assert.equal(fixture.lateWrites(), 0);
	});

	test("does not wait for an unrelated starting session when a target is ready", async () => {
		const commands: string[] = [];
		const fixture = pickerFixture(async (command) => {
			commands.push(command);
			if (command === "ddb.getSessions")
				return {
					sessions: [
						{ sid: 1, status: "stopped" },
						{ sid: 2, status: "starting" },
					],
				};
			fixture.cancel();
			return { grps: [] };
		});
		assert.equal(await fixture.start(), undefined);
		assert.deepEqual(commands, ["ddb.getSessions", "ddb.resolveSourceGroups"]);
	});

	test("discovery failure closes the picker and completes selection", async () => {
		const fixture = pickerFixture(async () => {
			throw new Error("discovery failed");
		});
		assert.equal(await fixture.start(), undefined);
		assert.equal(fixture.errors.length, 1);
		assert.match(fixture.errors[0], /discovery failed/);
	});
});
