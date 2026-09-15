import assert from "node:assert/strict";
import { managedArguments } from "../../v2/connection.mjs";

suite("Managed DDB arguments", () => {
	test("preserves argument boundaries and forwards configured DDB flags", () => {
		const args = managedArguments({ binary: "ddb", configFilePath: "config file.yaml", cwd: "/tmp/work", debuggerArgs: ["--console-level", "warn", "--user-id", "user with spaces"] }, "/tmp/token file", "/tmp/report file");
		assert.deepEqual(args, ["serve", "/tmp/work/config file.yaml", "--console-level", "warn", "--user-id", "user with spaces", "--managed", "--api-auth-token-file", "/tmp/token file", "--startup-report", "/tmp/report file"]);
	});
	test("rejects transport overrides in both flag syntaxes", () => {
		for (const flag of ["--api-bind", "--api-port", "--api-auth-token-file", "--startup-report", "--managed"]) {
			for (const args of [[flag, "override"], [`${flag}=override`]]) {
				assert.throws(() => managedArguments({ binary: "ddb", configFilePath: "ddb.yaml", cwd: "/tmp", debuggerArgs: args }, "token", "report"), /managed by the adapter/);
			}
		}
	});
});
