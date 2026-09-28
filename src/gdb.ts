import { DebugSession } from "vscode-debugadapter";

void import("./v2/session.mjs")
	.then(({ CanonicalDebugSession }) => {
		DebugSession.run(CanonicalDebugSession);
	})
	.catch((error) => {
		process.stderr.write(`DDB adapter failed to start: ${String(error)}\n`);
		process.exitCode = 1;
	});
