import type { ExecuteRequest, StopReason } from "@ddb-debugger/api-client";
import type { DdbConnection } from "./connection.mjs";

/** Coordinates visible stops while keeping automatic pauses out of the focus path. */
export class DdbExecution {
	private readonly pending = new Map<string, symbol>();
	private readonly pauses = new Map<string, { kind: "automatic" | "explicit"; token: symbol }>();
	constructor(private readonly connection: DdbConnection, private readonly error: (message: string) => void) {}

	observe(): void {
		const threads = this.connection.state.all("thread");
		for (const session of this.pending.keys()) {
			if (!threads.some(thread => thread.sessionId === session && thread.state === "THREAD_STATE_RUNNING")) this.pending.delete(session);
		}
		for (const session of this.pauses.keys()) {
			if (!threads.some(thread => thread.sessionId === session)) this.pauses.delete(session);
		}
	}

	resumed(sessionId: string): void { this.pauses.delete(sessionId); this.pending.delete(sessionId); }

	userControl(request: ExecuteRequest): () => void {
		const rollback: (() => void)[] = [];
		const sessions = new Set(this.connection.state.all("thread").filter(thread =>
			request.target?.broadcast || request.target?.session?.sessionId === thread.sessionId || request.target?.thread?.threadId === thread.threadId,
		).map(thread => thread.sessionId).filter((id): id is string => !!id));
		for (const session of sessions) {
			this.pending.delete(session);
			if (request.action === "EXECUTION_ACTION_INTERRUPT") {
				const previous = this.pauses.get(session);
				const marker = { kind: "explicit" as const, token: Symbol() };
				this.pauses.set(session, marker);
				rollback.push(() => {
					if (this.pauses.get(session) !== marker) return;
					if (previous) this.pauses.set(session, previous); else this.pauses.delete(session);
				});
			} else this.pauses.delete(session);
		}
		return () => { for (const undo of rollback) undo(); };
	}

	pauseKind(sessionId: string, reason?: StopReason): "automatic" | "explicit" | undefined {
		if (reason?.kind === "STOP_REASON_KIND_PAUSE" || (reason?.kind === "STOP_REASON_KIND_SIGNAL" && reason.signalName === "SIGINT")) return this.pauses.get(sessionId)?.kind;
		return undefined;
	}

	interruptOthers(exceptSession: string): void {
		const sessions = new Set(this.connection.state.all("thread").filter(thread => thread.state === "THREAD_STATE_RUNNING").map(thread => thread.sessionId));
		for (const sessionId of sessions) {
			if (!sessionId || sessionId === exceptSession || this.pending.has(sessionId)) continue;
			const token = Symbol();
			this.pending.set(sessionId, token);
			this.pauses.set(sessionId, { kind: "automatic", token });
			void this.connection.client.call("DebuggerControlService.Execute", { target: { session: { sessionId } }, action: "EXECUTION_ACTION_INTERRUPT" })
				.then(admission => this.connection.complete(admission))
				.catch(error => {
					if (this.pauses.get(sessionId)?.token !== token) return;
					this.pending.delete(sessionId);
					this.pauses.delete(sessionId);
					this.error(`Could not pause DDB session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				});
		}
	}
}
