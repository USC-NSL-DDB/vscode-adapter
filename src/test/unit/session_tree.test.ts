import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

function fixture() {
	const vscode = {
		debug: { activeDebugSession: { id: "debug-one" } },
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		TreeItem: class {
			constructor(
				public label: string,
				public collapsibleState: number,
			) {}
		},
		ThemeIcon: class {
			constructor(
				public id: string,
				public color: unknown,
			) {}
		},
		ThemeColor: class {
			constructor(public id: string) {}
		},
		MarkdownString: class {
			value = "";
			appendText(value: string) {
				this.value += value;
			}
			appendMarkdown(value: string) {
				this.value += value;
			}
		},
	};
	const exports: any = {};
	runInNewContext(
		readFileSync(join(__dirname, "../../sessionTreeItems.js"), "utf8"),
		{
			exports,
			module: { exports },
			require: (id: string) => {
				assert.equal(id, "vscode");
				return vscode;
			},
		},
	);
	const group = {
		id: 7,
		alias: "greeter_server",
		hash: "full-group-hash",
		sids: new Set([1, 2]),
	};
	const session = {
		sid: 1,
		alias: "greeter_server (127.0.0.1:-123)",
		tag: "greeter_server (127.0.0.1:-123)",
		status: "stopped",
	};
	return { ...exports, vscode, group, session };
}

suite("Session tree presentation", () => {
	test("compact rows retain full metadata and distinguish flat and grouped identity", () => {
		const { SessionItem, LogicalGroupItem, group, session } = fixture();
		const item = new SessionItem(session, group);
		assert.equal(item.label, "Session 1");
		assert.equal(item.description, "Paused");
		assert.equal(item.collapsibleState, 1);
		for (const value of [session.alias, session.tag, group.alias, group.hash]) {
			assert.ok(item.copyDetails().includes(value));
			assert.ok(item.tooltip.value.includes(value));
		}
		assert.equal(
			new SessionItem(session, group, true).label,
			"greeter_server · Session 1",
		);
		assert.equal(new LogicalGroupItem(group, 1).description, "1 session");
		assert.equal(new LogicalGroupItem(group, 2).description, "2 sessions");
		assert.equal(new LogicalGroupItem(group, 2).collapsibleState, 2);
	});
	test("custom aliases and ungrouped sessions remain identifiable", () => {
		const { SessionItem, session, group } = fixture();
		assert.equal(
			new SessionItem({ ...session, alias: "worker-west" }, group).label,
			"worker-west · Session 1",
		);
		assert.equal(
			new SessionItem(
				{ ...session, alias: "worker-west", tag: "worker-west" },
				group,
			).label,
			"worker-west · Session 1",
		);
		const ungrouped = new SessionItem(session);
		assert.ok(ungrouped.label.includes(session.alias));
		assert.equal(ungrouped.sessionDetails.Group, "Ungrouped");
		assert.equal(ungrouped.sessionDetails["Group ID"], undefined);
	});
	test("refresh and state changes preserve identity, new debug launches do not", () => {
		const { SessionItem, LogicalGroupItem, session, group, vscode } = fixture();
		const paused = new SessionItem(session, group);
		const running = new SessionItem(
			{ ...session, status: "running" },
			group,
			true,
		);
		assert.equal(paused.id, running.id);
		assert.equal(paused.contextValue, "sessionItem.paused");
		assert.equal(running.contextValue, "sessionItem.running");
		assert.equal(running.description, "Running");
		assert.equal(
			new SessionItem({ ...session, status: "starting" }, group).contextValue,
			"sessionItem.other",
		);
		const groupId = new LogicalGroupItem(group, 1).id;
		assert.equal(new LogicalGroupItem(group, 2).id, groupId);
		vscode.debug.activeDebugSession.id = "debug-two";
		assert.notEqual(new SessionItem(session, group).id, paused.id);
		assert.notEqual(new LogicalGroupItem(group, 1).id, groupId);
	});
});
