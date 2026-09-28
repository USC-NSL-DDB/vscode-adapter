import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { DdbConnection } from "../../v2/connection.mjs";
import { CanonicalHarness } from "../integration/helpers/canonical_session.mjs";

async function until(predicate: () => boolean, detail: string) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, detail);
		await delay(10);
	}
}

suite("Canonical HTTP stream recovery", function () {
	this.timeout(15000);
	test("an admitted operation can finish after the SDK's default ten-second polling limit", async () => {
		const started = Date.now();
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			const method = request.url?.split("/").pop();
			const value =
				method === "GetServerInfo"
					? { serverInfo: { serverInstanceId: "server", apiVersions: ["v2"] } }
					: method === "GetCapabilities"
						? {
								capabilities: {
									serverInstanceId: "server",
									apiVersion: "v2",
									schemaVersion: "2.0",
								},
							}
						: {
								operation: {
									operationId: "slow-op",
									state:
										Date.now() - started < 11000
											? "OPERATION_STATE_RUNNING"
											: "OPERATION_STATE_COMPLETED",
									result: { evaluation: { value: "42" } },
								},
							};
			request.resume();
			response.end(JSON.stringify(value));
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const connection = await DdbConnection.connect({
			endpoint: `http://127.0.0.1:${address.port}`,
		});
		try {
			assert.equal(
				(
					await connection.complete({
						operation: {
							operationId: "slow-op",
							state: "OPERATION_STATE_ACCEPTED",
						},
					})
				).evaluation?.value,
				"42",
			);
		} finally {
			await connection.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});
	for (const restarted of [false, true]) {
		test(
			restarted
				? "terminates when recovery encounters a different server instance"
				: "reconnects output by cursor, reports loss, and rehydrates state after a replay gap",
			async () => {
				let outputStream: ServerResponse | undefined;
				let stateStream: ServerResponse | undefined;
				const outputRequests: any[] = [];
				const stateRequests: any[] = [];
				let snapshots = 0;
				const failures: Error[] = [];
				const cursor = (sequence: string) => ({
					serverInstanceId: "server",
					sequence,
				});
				const server = createServer((request, response) => {
					void (async () => {
						let body = "";
						for await (const chunk of request) body += chunk;
						const args = JSON.parse(body);
						const json = (value: unknown, status = 200) => {
							response.writeHead(status, {
								"content-type": "application/json",
							});
							response.end(JSON.stringify(value));
						};
						const stream = () => {
							response.writeHead(200, {
								"content-type": "application/x-ndjson",
							});
							response.flushHeaders();
						};
						switch (request.url?.split("/").pop()) {
							case "GetServerInfo":
								json({
									serverInfo: {
										serverInstanceId: "server",
										apiVersions: ["v2"],
									},
								});
								break;
							case "GetCapabilities":
								json({
									capabilities: {
										serverInstanceId: "server",
										apiVersion: "v2",
										schemaVersion: "2.0",
									},
								});
								break;
							case "GetSnapshot": {
								snapshots++;
								const instance =
									restarted && snapshots > 1 ? "replacement-server" : "server";
								json({
									snapshot: {
										serverInstanceId: instance,
										stateEventCursor: {
											serverInstanceId: instance,
											sequence: snapshots === 1 ? "1" : "20",
										},
										groups: [
											{
												groupId: snapshots === 1 ? "old-group" : "new-group",
												revision: "1",
											},
										],
									},
								});
								break;
							}
							case "SubscribeStateEvents": {
								stateRequests.push(args);
								if (stateRequests.length === 2)
									json(
										{
											code: "DDB_ERROR_CODE_REPLAY_GAP",
											message: "requested state history is no longer retained",
											earliestCursor: cursor("10"),
											currentCursor: cursor("20"),
										},
										409,
									);
								else {
									stream();
									stateStream = response;
								}
								break;
							}
							case "SubscribeOutput": {
								outputRequests.push(args);
								stream();
								outputStream = response;
								if (outputRequests.length === 1)
									response.write(
										JSON.stringify({
											cursor: cursor("1"),
											stream: "OUTPUT_STREAM_KIND_INFERIOR_STDOUT",
											text: "before disconnect\n",
										}) + "\n",
									);
								else {
									response.write(
										JSON.stringify({
											cursor: cursor("4"),
											gap: {
												firstMissingSequence: "2",
												lastMissingSequence: "4",
												droppedEvents: "3",
												reason: "output retention limit",
											},
										}) + "\n",
									);
									response.write(
										JSON.stringify({
											cursor: cursor("5"),
											stream: "OUTPUT_STREAM_KIND_INFERIOR_STDOUT",
											text: "after reconnect\n",
										}) + "\n",
									);
								}
								break;
							}
							default:
								throw new Error(`Unexpected RPC: ${request.url}`);
						}
					})().catch((error) => {
						failures.push(error);
						response.destroy(error);
					});
				});
				await new Promise<void>((resolve) => {
					server.listen(0, "127.0.0.1", resolve);
				});
				const address = server.address();
				assert.ok(address && typeof address !== "string");
				let connection: DdbConnection | undefined;
				const dap = new CanonicalHarness();
				try {
					connection = await DdbConnection.connect({
						endpoint: `http://127.0.0.1:${address.port}`,
					});
					await dap.begin(connection);
					const outputs = () =>
						dap.events
							.filter((event) => event.event === "output")
							.map((event) => event.body.output);
					await until(
						() => outputs().includes("before disconnect\n") && !!stateStream,
						"initial streams must deliver",
					);
					outputStream!.destroy();
					stateStream!.destroy();
					if (restarted) {
						await until(
							() => dap.events.some((event) => event.event === "terminated"),
							"changed server instance must terminate the old session",
						);
						assert.ok(outputs().some((text) => text.includes("DDB restarted")));
						assert.equal(connection.client.closed, true);
						assert.deepEqual(
							connection.state.all("group").map((group) => group.groupId),
							["old-group"],
							"must not apply resources from a different server",
						);
						assert.equal(snapshots, 2);
						assert.deepEqual(failures, []);
						return;
					}
					await until(
						() =>
							outputs().includes("after reconnect\n") &&
							stateRequests.length >= 3,
						"streams must recover after their sockets close",
					);
					assert.equal(
						outputs().filter((text) => text === "before disconnect\n").length,
						1,
					);
					assert.equal(
						outputs().filter((text) => text.includes("DDB output was lost"))
							.length,
						1,
					);
					assert.deepEqual(outputRequests[1].afterCursor, cursor("1"));
					assert.deepEqual(stateRequests[1].afterCursor, cursor("1"));
					assert.deepEqual(stateRequests[2].afterCursor, cursor("20"));
					assert.equal(snapshots, 2);
					assert.deepEqual(
						connection.state.all("group").map((group) => group.groupId),
						["new-group"],
					);
					assert.ok(!dap.events.some((event) => event.event === "terminated"));
					assert.deepEqual(failures, []);
				} finally {
					await dap.request("disconnect");
					await connection?.close();
					server.closeAllConnections();
					await new Promise<void>((resolve) => {
						server.close(() => resolve());
					});
				}
			},
		);
	}
});
