import * as assert from "assert";
import { MI2 } from "../../backend/mi2/mi2";
import { MI2DebugSession } from "../../mibase";
import { parseMI } from "../../backend/mi_parse";
import { MIError, SubBkptType } from "../../backend/backend";

class TestSession extends MI2DebugSession {
  events: any[] = [];
  responses: any[] = [];
  constructor(public backend: MI2) { super(true); this.miDebugger = backend; }
  override sendEvent(event: any) { this.events.push(event); }
  create() { return this.threadCreatedEvent(parseMI('=thread-created,id="1",session-id="1",group-id="i1"')); }
  exit() { this.threadExitedEvent(parseMI('=thread-exited,id="1"')); }
  threads() { return this.m_threads; }
  override sendResponse(response: any) { this.responses.push(response); }
  prepareBreakpointRequest() {
    this.setBreakPointsRequest({type: "response", command: "setBreakpoints", request_seq: 77, seq: 0, success: true, body: {breakpoints: []}}, {source: {path: "main.c", name: "main.c"}, breakpoints: [{line: 9, source: {path: "main.c", name: "main.c"}}]});
  }
  failBreakpointRequest() {
    return this.customRequest("setSessionBreakpoints", {type: "response", command: "setSessionBreakpoints", request_seq: 78, seq: 0, success: true}, {seq: 77, arguments: {source: {path: "main.c", name: "main.c"}, breakpoints: [{line: 9, source: {path: "main.c", name: "main.c"}}]}});
  }
}

suite("DDB compatibility", () => {
  test("startup thread query survives session registration race", async () => {
    const backend = new MI2("", [], [], undefined);
    let calls = 0;
    backend.sendCommand = async () => {
      if (++calls === 1) throw new MIError("Session 1 does not exist", "thread-info --thread 1");
      return parseMI('2^done,threads=[{id="1",name="main",target-id="Thread 1",state="stopped"}]');
    };
    const session = new TestSession(backend);
    await session.create();
    assert.strictEqual(calls, 2);
    assert.ok(session.threads().get(1)?.name.includes("main"));
    assert.strictEqual(session.events.filter(e => e.event === "thread" && e.body.reason === "started").length, 1);
  });

  test("thread exit during metadata lookup does not resurrect thread", async () => {
    const backend = new MI2("", [], [], undefined);
    const session = new TestSession(backend);
    backend.sendCommand = async () => { session.exit(); return parseMI('1^error,msg="Session 1 does not exist"'); };
    await session.create();
    assert.strictEqual(session.threads().size, 0);
  });

  test("permanent thread query failure preserves a usable thread entry", async () => {
    const backend = new MI2("", [], [], undefined);
    let calls = 0;
    backend.sendCommand = async () => { calls++; return parseMI('1^error,msg="Permission denied"'); };
    const session = new TestSession(backend);
    await session.create();
    assert.strictEqual(calls, 1);
    assert.strictEqual(session.threads().get(1)?.pending, false);
  });

  test("breakpoint target IDs are decoded from MI dictionaries", async () => {
    const backend = new MI2("", [], [], undefined);
    backend.sendCommand = async () => parseMI('1^done,bkpt={id="7",fullname="main.c",line="9"},subbkpt=[{id="8",type="session",target_id="2"},{id="9",type="group",target_id="3"}]');
    const result = await backend.addBreakPoint({ file: "main.c", line: 9, condition: "", subbkpts: [] });
    assert.deepStrictEqual(result.subbkpts, [{id: 8, type: SubBkptType.Session, target: 2}, {id: 9, type: SubBkptType.Group, target: 3}]);
  });

  test("MI errors reject with the backend diagnostic", async () => {
    const backend = new MI2("", [], [], undefined);
    backend.sendRaw = raw => backend.onOutput(`${raw.match(/^\d+/)![0]}^error,msg="Session 9 does not exist"`);
    await assert.rejects(Promise.resolve(backend.sendCommand("thread-info --session 9")), /Session 9 does not exist/);
  });
  test("failed breakpoint insertion completes both VS Code requests with errors", async () => {
    const backend = new MI2("", [], [], undefined);
    backend.addBreakPoint = async () => { throw new Error("Cannot insert breakpoint"); };
    const session = new TestSession(backend);
    session.prepareBreakpointRequest();
    await session.failBreakpointRequest();
    await Promise.resolve();
    assert.strictEqual(session.responses.length, 2);
    assert.ok(session.responses.every(response => response.success === false));
  });

  test("distributed frames preserve parent session, thread and boundary metadata", async () => {
    const backend = new MI2("", [], [], undefined);
    backend.sendCommand = async () => parseMI('1^done,stack=[{level="0",session="1",thread="4",func="child",fullname="child.c",file="child.c",line="3"},{level="0",session="2",thread="7",boundary_frame="1"},{level="1",session="2",thread="7",func="parent",fullname="parent.c",file="parent.c",line="8"}]');
    const frames = await backend.getStack(0, 0, 4);
    assert.deepStrictEqual(frames.map(frame => [frame.session, frame.thread, frame.is_boundary]), [[1, 4, false], [2, 7, true], [2, 7, false]]);
  });

  test("breakpoint failure is retained when the custom request arrives first", async () => {
    const backend = new MI2("", [], [], undefined);
    backend.addBreakPoint = async () => { throw new Error("Cannot insert breakpoint"); };
    const session = new TestSession(backend);
    await session.failBreakpointRequest();
    session.prepareBreakpointRequest();
    await Promise.resolve();
    assert.strictEqual(session.responses.length, 2);
    assert.ok(session.responses.every(response => response.success === false));
  });

});
