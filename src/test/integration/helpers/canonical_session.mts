import type { DebugProtocol } from "vscode-debugprotocol";
import { CanonicalDebugSession } from "../../../v2/session.mjs";
import type { DdbConnection } from "../../../v2/connection.mjs";

export class CanonicalHarness extends CanonicalDebugSession {
	readonly events: DebugProtocol.Event[] = [];
	private sequence = 0;
	private readonly pending = new Map<
		number,
		(response: DebugProtocol.Response) => void
	>();
	get nextSequence(): number {
		return this.sequence + 1;
	}
	enablePairedBreakpoints(enabled = true): void {
		this.pairedBreakpoints = enabled;
	}
	async begin(connection: DdbConnection): Promise<void> {
		await this.useConnection(connection);
		await this.request("configurationDone");
	}
	override sendEvent(event: DebugProtocol.Event): void {
		this.events.push(event);
	}
	override sendResponse(response: DebugProtocol.Response): void {
		this.pending.get(response.request_seq)?.(response);
		this.pending.delete(response.request_seq);
	}
	request(command: string, args: object = {}): Promise<DebugProtocol.Response> {
		const seq = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP ${command} did not respond`));
			}, 15000);
			this.pending.set(seq, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			this.dispatchRequest({ type: "request", seq, command, arguments: args });
		});
	}
}
