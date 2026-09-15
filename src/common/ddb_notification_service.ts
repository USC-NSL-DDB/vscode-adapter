import * as vscode from "vscode";

/** Routes canonical adapter state changes to the extension's cached views. */
export class NotificationService {
	private static instance: NotificationService | undefined;
	static getInstance(): NotificationService { return this.instance ??= new NotificationService(); }
	static resetInstance(): void { this.instance?.dispose(); this.instance = undefined; }
	private subscription?: vscode.Disposable;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly listeners = new Map<string, Set<(data: any) => void>>();
	private readonly stateListeners = new Set<(connected: boolean) => void>();
	start(): void {
		if (this.subscription || !vscode.workspace.getConfiguration("ddb").get("notifications.enabled", true)) return;
		this.subscription = vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
			if (event.session.type !== "ddb" || event.session.id !== vscode.debug.activeDebugSession?.id || event.event !== "ddb.stateChanged") return;
			if (this.timer) return;
			this.timer = setTimeout(() => {
				this.timer = undefined;
				for (const callback of this.listeners.get("SnapshotChanged") ?? []) callback(undefined);
			}, 100);
		});
		for (const callback of this.stateListeners) callback(true);
	}
	stop(): void {
		this.subscription?.dispose(); this.subscription = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const callback of this.stateListeners) callback(false);
	}
	isConnected(): boolean { return this.subscription !== undefined; }
	onNotification(type: string, callback: (data: any) => void): () => void {
		let listeners = this.listeners.get(type);
		if (!listeners) this.listeners.set(type, listeners = new Set());
		listeners.add(callback);
		return () => { listeners!.delete(callback); };
	}
	onConnectionStateChange(callback: (connected: boolean) => void): () => void {
		this.stateListeners.add(callback);
		return () => { this.stateListeners.delete(callback); };
	}
	dispose(): void { this.stop(); this.listeners.clear(); this.stateListeners.clear(); }
}
