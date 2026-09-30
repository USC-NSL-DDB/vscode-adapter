import type * as vscode from "vscode";
import type { BreakpointHit } from "./common/ddb_dap_api";

interface StackRequests {
	pending: Set<number>;
	completed: number;
}

/** Synchronizes explicit navigation with VS Code's asynchronous stack loading. */
export class PausedFrameNavigation implements vscode.Disposable {
	private readonly stacks = new Map<string, StackRequests>();
	private readonly changed: vscode.EventEmitter<void>;
	private navigation = 0;
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly host: typeof vscode) {
		this.changed = new host.EventEmitter<void>();
		this.subscriptions = [
			this.host.debug.registerDebugAdapterTrackerFactory("ddb", {
				createDebugAdapterTracker: (session) => {
					const stack: StackRequests = { pending: new Set(), completed: 0 };
					this.stacks.set(session.id, stack);
					return {
						onWillReceiveMessage: (message) => {
							if (
								message.type === "request" &&
								message.command === "stackTrace"
							) {
								stack.pending.add(message.seq);
							}
						},
						onDidSendMessage: (message) => {
							if (
								message.type === "response" &&
								stack.pending.delete(message.request_seq)
							) {
								stack.completed++;
								this.changed.fire();
							}
						},
						onWillStopSession: () => {
							this.stacks.delete(session.id);
							this.changed.fire();
						},
					};
				},
			}),
			this.host.debug.onDidChangeActiveStackItem(() => this.changed.fire()),
		];
	}

	async focus(session: vscode.DebugSession, hit: BreakpointHit): Promise<void> {
		const navigation = ++this.navigation;
		this.changed.fire();
		const before = this.stacks.get(session.id)?.completed ?? 0;
		await this.host.commands.executeCommand(
			"workbench.debug.action.focusCallStackView",
		);
		const target: { frameId: number } = await session.customRequest(
			"ddb.focusBreakpointHit",
			hit,
		);
		let reachedTarget = false;
		let cancelled = false;
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				subscription.dispose();
				if (error) reject(error);
				else resolve();
			};
			const check = () => {
				if (navigation !== this.navigation) return finish();
				const stack = this.stacks.get(session.id);
				if (!stack)
					return finish(
						new Error("The debug session ended during frame navigation"),
					);
				const active = this.host.debug.activeStackItem;
				const isTarget =
					active instanceof this.host.DebugStackFrame &&
					active.session.id === session.id &&
					active.threadId === hit.threadId &&
					active.frameId === target.frameId;
				if (reachedTarget && !isTarget) {
					cancelled = true;
					return finish();
				}
				reachedTarget ||= isTarget;
				if (stack.completed > before && stack.pending.size === 0 && isTarget)
					finish();
			};
			const subscription = this.changed.event(check);
			const timer = setTimeout(
				() => finish(new Error("Paused-frame selection did not complete")),
				10000,
			);
			check();
		});
		if (cancelled || navigation !== this.navigation) return;
		// Trackers observe replies before VS Code consumes them. This UI command
		// provides a round trip to the workbench before we select its current
		// frame object, which concurrent stack replies may have replaced.
		await this.host.commands.executeCommand(
			"workbench.debug.action.focusCallStackView",
		);
		const active = this.host.debug.activeStackItem;
		if (
			navigation !== this.navigation ||
			!(active instanceof this.host.DebugStackFrame) ||
			active.session.id !== session.id ||
			active.threadId !== hit.threadId ||
			active.frameId !== target.frameId
		)
			return;
		await this.host.commands.executeCommand(
			"workbench.action.debug.callStackTop",
		);
	}

	dispose(): void {
		this.navigation++;
		this.changed.fire();
		for (const subscription of this.subscriptions) subscription.dispose();
		this.changed.dispose();
		this.stacks.clear();
	}
}
