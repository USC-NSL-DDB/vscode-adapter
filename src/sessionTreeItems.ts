import * as vscode from "vscode";
import type { LogicalGroup, Session } from "./common/ddb_dap_api";

function treeId(kind: string, id: number): string {
	return `${vscode.debug.activeDebugSession?.id ?? "ddb"}:${kind}:${id}`;
}

function detailTooltip(details: Record<string, string>): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString();
	for (const [label, value] of Object.entries(details)) {
		tooltip.appendMarkdown(`**${label}:** `);
		tooltip.appendText(value);
		tooltip.appendMarkdown("\n\n");
	}
	return tooltip;
}

export class LogicalGroupItem extends vscode.TreeItem {
	constructor(
		public readonly group: LogicalGroup,
		public readonly sessionCount: number,
		public readonly isUngrouped = false,
	) {
		super(
			isUngrouped ? "Ungrouped" : group.alias,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		this.id = treeId("group", group.id);
		this.description = `${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
		this.contextValue = "logicalGroup";
		this.tooltip = isUngrouped
			? "Sessions without a logical group"
			: detailTooltip({
					Group: group.alias,
					"Group ID": String(group.id),
					"Group hash": group.hash,
					Sessions: String(sessionCount),
				});
	}
}

export class SessionItem extends vscode.TreeItem {
	readonly sessionId: number;
	readonly sessionDetails: Record<string, string>;
	constructor(session: Session, group?: LogicalGroup, flat = false) {
		const alias = String(session.alias ?? "");
		const repeatsGroup =
			group &&
			(alias === group.alias ||
				(alias === session.tag &&
					alias.startsWith(`${group.alias} (`) &&
					alias.endsWith(")")));
		const distinctAlias = alias && !repeatsGroup;
		const name = distinctAlias
			? alias
			: flat || !group
				? group?.alias || alias
				: "";
		super(
			`${name ? `${name} · ` : ""}Session ${session.sid}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		this.sessionId = session.sid;
		this.id = treeId("session", session.sid);
		const status = (session.status ?? "unknown").toLowerCase();
		const paused = status === "stopped" || status === "paused";
		const running = status === "running";
		this.description = paused
			? "Paused"
			: status === "unspecified"
				? "Unknown"
				: status.charAt(0).toUpperCase() + status.slice(1);
		this.contextValue = paused
			? "sessionItem.paused"
			: running
				? "sessionItem.running"
				: "sessionItem.other";
		this.iconPath = new vscode.ThemeIcon(
			paused
				? "debug-pause"
				: running
					? "debug-start"
					: status === "starting"
						? "loading"
						: "debug-disconnect",
			paused
				? new vscode.ThemeColor("debugIcon.pauseForeground")
				: running
					? new vscode.ThemeColor("debugIcon.startForeground")
					: undefined,
		);
		this.sessionDetails = {
			"Session ID": String(session.sid),
			State: this.description,
			Alias: alias,
			Tag: session.tag,
			Group: group?.alias ?? "Ungrouped",
			...(group
				? { "Group ID": String(group.id), "Group hash": group.hash }
				: {}),
		};
		this.tooltip = detailTooltip(this.sessionDetails);
		this.accessibilityInformation = {
			label: `${this.label}, ${this.description}`,
		};
	}

	copyDetails(): string {
		return Object.entries(this.sessionDetails)
			.map(([key, value]) => `${key}: ${value}`)
			.join("\n");
	}
}

export class SessionItemDetail extends vscode.TreeItem {
	constructor(label: string, description: string, ownerId?: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.tooltip = `${label}: ${description}`;
		if (ownerId) this.id = `${ownerId}:detail:${label}`;
	}
}
