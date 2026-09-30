import * as assert from "assert";
import { EventEmitter } from "events";
import { PausedFrameNavigation } from "../../pausedFrameNavigation";

class Events<T> {
	private readonly emitter = new EventEmitter();
	event = (listener: (value: T) => void) => {
		this.emitter.on("change", listener);
		return { dispose: () => this.emitter.off("change", listener) };
	};
	fire(value: T) {
		this.emitter.emit("change", value);
	}
	dispose() {
		this.emitter.removeAllListeners();
	}
}

function fixture() {
	const activeChanged = new Events<void>();
	let trackerFactory: any;
	const commands: string[] = [];
	const host = {
		EventEmitter: Events,
		DebugStackFrame: class {
			constructor(
				public session: any,
				public threadId: number,
				public frameId: number,
			) {}
		},
		debug: {
			activeStackItem: undefined as any,
			onDidChangeActiveStackItem: activeChanged.event,
			registerDebugAdapterTrackerFactory: (_type: string, factory: any) => {
				trackerFactory = factory;
				return { dispose() {} };
			},
		},
		commands: {
			executeCommand: async (command: string) => {
				commands.push(command);
			},
		},
	};
	const navigation = new PausedFrameNavigation(host as any);
	const session = { id: "ddb", customRequest: async () => ({ frameId: 12 }) };
	const tracker = trackerFactory.createDebugAdapterTracker(session);
	const hit = {
		breakpointId: 1,
		sessionId: 1,
		threadId: 2,
		threadName: "worker",
		stopRevision: "1",
	};
	const request = (seq: number) =>
		tracker.onWillReceiveMessage({
			type: "request",
			command: "stackTrace",
			seq,
		});
	const response = (seq: number) =>
		tracker.onDidSendMessage({
			type: "response",
			command: "stackTrace",
			request_seq: seq,
		});
	const select = (frameId: number) => {
		host.debug.activeStackItem = new host.DebugStackFrame(
			session,
			hit.threadId,
			frameId,
		);
		activeChanged.fire();
	};
	return {
		navigation,
		session,
		hit,
		tracker,
		commands,
		host,
		request,
		response,
		select,
	};
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

suite("Paused-frame navigation", () => {
	test("waits for both the target frame and all concurrent stack replies before selecting the row", async () => {
		const f = fixture();
		try {
			const focus = f.navigation.focus(f.session as any, f.hit);
			await turn();
			f.request(1);
			f.request(2);
			f.select(12);
			f.response(1);
			await turn();
			assert.equal(
				f.commands.length,
				1,
				"an active frame alone does not mean its row is ready",
			);
			f.response(2);
			await focus;
			assert.deepStrictEqual(f.commands, [
				"workbench.debug.action.focusCallStackView",
				"workbench.debug.action.focusCallStackView",
				"workbench.action.debug.callStackTop",
			]);
		} finally {
			f.navigation.dispose();
		}
	});

	test("does not replace a user's new selection during the UI round trip", async () => {
		const f = fixture();
		try {
			f.host.commands.executeCommand = async (command) => {
				f.commands.push(command);
				if (f.commands.length === 2) f.select(99);
			};
			const focus = f.navigation.focus(f.session as any, f.hit);
			await turn();
			f.request(1);
			f.select(12);
			f.response(1);
			await focus;
			assert.equal(f.commands.length, 2);
		} finally {
			f.navigation.dispose();
		}
	});

	test("leaving the target while another reply is pending cancels navigation", async () => {
		const f = fixture();
		try {
			const focus = f.navigation.focus(f.session as any, f.hit);
			await turn();
			f.request(1);
			f.request(2);
			f.select(12);
			f.response(1);
			f.select(99);
			await focus;
			f.response(2);
			await turn();
			assert.equal(f.commands.length, 1);
		} finally {
			f.navigation.dispose();
		}
	});

	test("session termination rejects pending navigation without issuing a selection command", async () => {
		const f = fixture();
		try {
			const focus = f.navigation.focus(f.session as any, f.hit);
			const rejected = assert.rejects(focus, /debug session ended/);
			await turn();
			f.tracker.onWillStopSession();
			await rejected;
			assert.equal(f.commands.length, 1);
		} finally {
			f.navigation.dispose();
		}
	});

	test("a newer navigation cancels the previous waiter", async () => {
		const f = fixture();
		try {
			const first = f.navigation.focus(f.session as any, f.hit);
			await turn();
			const second = f.navigation.focus(f.session as any, f.hit);
			await first;
			await turn();
			f.request(1);
			f.select(12);
			f.response(1);
			await second;
			assert.equal(
				f.commands.filter((command) => command.endsWith("callStackTop")).length,
				1,
			);
		} finally {
			f.navigation.dispose();
		}
	});
});
