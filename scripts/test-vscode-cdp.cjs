// Used only by the isolated extension-host tests; requires the Node test runtime.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
(async () => {
	const port = Number(
		readFileSync(join(process.argv[2], "DevToolsActivePort"), "utf8").split(
			"\n",
		)[0],
	);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Invalid local DevTools port");
	const targets = await (
		await fetch(`http://127.0.0.1:${port}/json/list`)
	).json();
	const target = targets.find(
		(item) => item.type === "page" && item.url.includes("workbench"),
	);
	if (!target) throw new Error("VS Code workbench target not found");
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	const result = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error("DevTools request timed out"));
		}, 5000);
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("DevTools connection failed"));
		});
		socket.addEventListener("open", () =>
			socket.send(
				JSON.stringify({
					id: 1,
					method: "Runtime.evaluate",
					params: {
						expression: process.argv[3],
						returnByValue: true,
						awaitPromise: true,
					},
				}),
			),
		);
		socket.addEventListener("message", (event) => {
			const response = JSON.parse(event.data);
			if (response.id !== 1) return;
			clearTimeout(timer);
			socket.close();
			if (response.error || response.result.exceptionDetails)
				reject(
					new Error(
						JSON.stringify(response.error ?? response.result.exceptionDetails),
					),
				);
			else resolve(response.result.result.value);
		});
	});
	process.stdout.write(JSON.stringify(result ?? null));
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
