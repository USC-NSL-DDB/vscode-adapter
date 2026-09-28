import { execFileSync } from "node:child_process";

/** Evaluate an expression in the isolated test window's renderer. */
export function ui(expression: string): any {
	return JSON.parse(
		execFileSync(
			process.env.DDB_TEST_NODE!,
			[
				process.env.DDB_TEST_CDP_SCRIPT!,
				process.env.DDB_TEST_PROFILE!,
				expression,
			],
			{ encoding: "utf8" },
		),
	);
}
