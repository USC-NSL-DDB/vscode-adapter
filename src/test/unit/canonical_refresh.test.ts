import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";

function manager(kind: "session" | "breakpoint", fetch: () => Promise<any[]>) {
	const exports: any = {};
	const api = {
		getSessions: fetch,
		getGroups: async () => [],
		getBreakpoints: fetch,
	};
	runInNewContext(
		readFileSync(join(__dirname, `../../common/ddb_${kind}_mgr.js`), "utf8"),
		{
			exports,
			module: { exports },
			require: (id: string) => (id === "vscode" ? null : api),
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			console: { ...console, error: () => {} },
		},
	);
	return exports[
		kind === "session" ? "SessionManager" : "BreakpointManager"
	].getInstance();
}

suite("Canonical UI refresh completion", () => {
	for (const kind of ["session", "breakpoint"] as const) {
		test(`${kind}: debounced refresh waits for the fetch and propagates its error`, async () => {
			let reject!: (error: Error) => void;
			const gate = new Promise<any[]>((_resolve, fail) => {
				reject = fail;
			});
			let started = false;
			const instance = manager(kind, () => {
				started = true;
				return gate;
			});
			let settled = false;
			const update = instance.updateAll().finally(() => {
				settled = true;
			});
			const failed = assert.rejects(update, /fetch failed/);
			const deadline = Date.now() + 1000;
			while (!started) {
				assert.ok(Date.now() < deadline);
				await delay(10);
			}
			await delay(60);
			assert.equal(
				settled,
				false,
				"timer firing must not count as fetch completion",
			);
			reject(new Error("fetch failed"));
			await failed;
			instance.dispose();
		});

		test(`${kind}: clear cancels queued work and discards in-flight results`, async () => {
			let release!: (items: any[]) => void;
			let calls = 0;
			const gate = new Promise<any[]>((resolve) => {
				release = resolve;
			});
			const instance = manager(kind, () => {
				calls++;
				return gate;
			});
			const queued = instance.updateAll();
			instance.clearCache();
			await queued;
			assert.equal(calls, 0);
			const running = instance.immediateUpdateAll();
			assert.equal(calls, 1);
			instance.clearCache();
			release(
				kind === "session"
					? [{ sid: 1, tag: "s", alias: "s", status: "stopped" }]
					: [{ id: 1, location: { src: "main.c", line: 1 }, subbkpts: [] }],
			);
			await running;
			assert.equal(
				(kind === "session"
					? instance.getAllSessions()
					: instance.getAllBreakpoints()
				).length,
				0,
			);
			instance.dispose();
		});
	}
});
