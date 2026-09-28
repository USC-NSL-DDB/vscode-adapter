import type { OTelConfig } from "./otel/types";

/** Pass extension settings to managed DDB without overriding explicit CLI options. */
export function backendTelemetryArguments(
	args: string[],
	config: OTelConfig,
): string[] {
	const result = [...args];
	if (!config.enabled) return result;
	const has = (flag: string) =>
		result.some((value) => value === flag || value.startsWith(`${flag}=`));
	if (!has("--enable-otel")) result.push("--enable-otel");
	for (const [flag, value] of [
		["--otel-endpoint", config.endpoint],
		["--user-id", config.userId],
		["--session-id", config.sessionId],
	]) {
		if (!has(flag)) result.push(flag, value);
	}
	return result;
}
