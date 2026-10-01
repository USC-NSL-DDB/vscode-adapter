import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DdbClient } from "@ddb-debugger/api-client";
import { DdbState } from "../../v2/state.mjs";
import { DdbInspection } from "../../v2/inspection.mjs";
import { DdbSidebar } from "../../v2/sidebar.mjs";
import { DdbBreakpoints } from "../../v2/breakpoints.mjs";
import type { DdbConnection } from "../../v2/connection.mjs";

async function withSourceServer(
	groupIds: string[],
	delayMs: number,
	work: (
		sidebar: DdbSidebar,
		requests: { group: string; deadline: number }[],
	) => Promise<void>,
) {
	const timers: NodeJS.Timeout[] = [];
	const requests: { group: string; deadline: number }[] = [];
	const server = createServer((request, response) => {
		assert.ok(request.url?.endsWith("/ResolveSource"));
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			const payload = JSON.parse(body);
			const group = payload.target.group.groupId;
			requests.push({ group, deadline: Date.parse(payload.context.deadline) });
			timers.push(
				setTimeout(() => {
					response.setHeader("content-type", "application/json");
					if (group === "server") {
						response.statusCode = 404;
						response.end(
							JSON.stringify({
								code: "DDB_ERROR_CODE_NOT_FOUND",
								message: "source for target was not found",
							}),
						);
					} else
						response.end(
							JSON.stringify({ source: { path: "/src/client.cc" } }),
						);
				}, delayMs),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	let client: DdbClient | undefined;
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		client = new DdbClient({ endpoint: `http://127.0.0.1:${address.port}` });
		const state = new DdbState();
		state.hydrate({
			serverInstanceId: "test",
			stateEventCursor: { serverInstanceId: "test" },
			groups: groupIds.map((groupId) => ({ groupId, displayName: groupId })),
		});
		const model = new DdbInspection({
			client,
			state,
		} as unknown as DdbConnection);
		await work(new DdbSidebar(model, new DdbBreakpoints(model)), requests);
	} finally {
		client?.close();
		for (const timer of timers) clearTimeout(timer);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

suite("Breakpoint source discovery", function () {
	this.timeout(15000);
	test("a cold source lookup may finish after the SDK default timeout", async () => {
		await withSourceServer(["server", "client"], 11000, async (sidebar) => {
			assert.deepEqual(
				(await sidebar.sourceGroups("/src/client.cc")).map((g) => g.alias),
				["client"],
			);
		});
	});

	test("group batches share one deadline and stop querying when it expires", async () => {
		const groups = Array.from({ length: 9 }, (_, i) => `group-${i}`);
		await withSourceServer(groups, 150, async (sidebar, requests) => {
			await assert.rejects(
				sidebar.sourceGroups("/src/client.cc", 250),
				/timed out/,
			);
			assert.equal(requests.length, 8, "the third batch must not start");
			const deadlines = requests.map((r) => r.deadline);
			assert.ok(
				Math.max(...deadlines) - Math.min(...deadlines) < 50,
				"later batches must retain the original deadline",
			);
		});
	});
});
