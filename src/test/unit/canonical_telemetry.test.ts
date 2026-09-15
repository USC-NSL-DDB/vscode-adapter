import * as assert from "node:assert/strict";
import { backendTelemetryArguments } from "../../common/ddb_launch_telemetry";

suite("Canonical launch telemetry", () => {
	const config = { enabled: true, endpoint: "http://127.0.0.1:54317", appName: "ddb", userId: "test-user", sessionId: "test-session" };
	test("forwards enabled telemetry and correlation settings without modifying input", () => {
		const args = ["--console-level", "warn"];
		assert.deepEqual(backendTelemetryArguments(args, config), [...args, "--enable-otel", "--otel-endpoint", config.endpoint, "--user-id", config.userId, "--session-id", config.sessionId]);
		assert.deepEqual(args, ["--console-level", "warn"]);
	});
	test("disabled settings do not enable backend telemetry", () => {
		assert.deepEqual(backendTelemetryArguments([], { ...config, enabled: false }), []);
	});
	test("explicit CLI values take precedence and repeated resolution is idempotent", () => {
		const args = ["--enable-otel", "--otel-endpoint=http://localhost:4317", "--user-id", "custom-user", "--session-id=custom-session"];
		assert.deepEqual(backendTelemetryArguments(args, config), args);
		const generated = backendTelemetryArguments([], config);
		assert.deepEqual(backendTelemetryArguments(generated, config), generated);
	});
});
