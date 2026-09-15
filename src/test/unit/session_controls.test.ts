import * as assert from "assert";
import { registerSessionControls } from "../../sessionControls";

function fixture(answer = "Yes") {
 const commands = new Map<string, (item: { sessionId: number }) => Promise<void>>();
 const requests: { command: string; args: any }[] = [];
 const errors: string[] = [];
 const debugSession = { type: "ddb", customRequest: async (command: string, args: any): Promise<any> => { requests.push({ command, args }); } };
 const host = {
  commands: { registerCommand: (name: string, callback: any) => { commands.set(name, callback); return { dispose() {} }; } },
  debug: { activeDebugSession: debugSession },
  window: { showWarningMessage: async () => answer, showInformationMessage() {}, showErrorMessage: (message: string) => errors.push(message) },
 };
 registerSessionControls(host as any, { subscriptions: [] });
 return { commands, requests, errors, host, debugSession };
}

suite("Session sidebar controls", () => {
 test("confirmed kill terminates the selected inferior", async () => {
  const f = fixture();
  await f.commands.get("ddbSessionsExplorer.killSession")!({ sessionId: 7 });
  assert.deepStrictEqual(f.requests, [{ command: "send-signal", args: { sessionId: 7, signal: "SIGKILL" } }]);
 });
 test("cancelled kill sends no request", async () => {
  const f = fixture("No");
  await f.commands.get("ddbSessionsExplorer.killSession")!({ sessionId: 7 });
  assert.deepStrictEqual(f.requests, []);
 });
 for (const name of ["pauseSession", "continueSession", "killSession"]) {
  test(`${name} waits for completion and reports failures`, async () => {
   const f = fixture();
   let reject!: (error: Error) => void;
   f.debugSession.customRequest = () => new Promise((_resolve, fail) => { reject = fail; });
   let finished = false;
   const command = f.commands.get(`ddbSessionsExplorer.${name}`)!({ sessionId: 7 }).then(() => { finished = true; });
   await Promise.resolve();
   await Promise.resolve();
   assert.strictEqual(finished, false);
   reject(new Error("backend rejected control"));
   await command;
   assert.strictEqual(f.errors.length, 1);
   assert.ok(f.errors[0].includes("backend rejected control"));
  });
 }
 test("kill keeps its owning debug session while confirmation is open", async () => {
  const f = fixture();
  let confirm!: (answer: string) => void;
  f.host.window.showWarningMessage = () => new Promise(resolve => { confirm = resolve; });
  const command = f.commands.get("ddbSessionsExplorer.killSession")!({ sessionId: 7 });
  f.host.debug.activeDebugSession = { type: "other", customRequest: async () => { throw new Error("wrong session"); } };
  confirm("Yes");
  await command;
  assert.strictEqual(f.requests[0].args.signal, "SIGKILL");
  assert.deepStrictEqual(f.errors, []);
 });
 test("controls reject non-DDB sessions before issuing requests", async () => {
  const f = fixture();
  f.debugSession.type = "other";
  for (const command of f.commands.values()) await command({ sessionId: 7 });
  assert.deepStrictEqual(f.requests, []);
  assert.strictEqual(f.errors.length, 4);
 });

 test("cancelling signal selection while loading ignores the late response", async () => {
  const f = fixture();
  let hide!: () => void;
  let disposed = false;
  let populate = 0;
  const picker = {
   onDidHide(callback: () => void) { hide = callback; return { dispose() {} }; },
   onDidAccept() { return { dispose() {} }; },
   show() {}, dispose() { disposed = true; },
   set items(_value: any) { populate++; },
  };
  (f.host.window as any).createQuickPick = () => picker;
  let complete!: (response: any) => void;
  f.debugSession.customRequest = () => new Promise(resolve => { complete = resolve; });
  const command = f.commands.get("ddbSessionsExplorer.sendSignal")!({ sessionId: 7 });
  hide();
  complete({ signals: [{ name: "SIGINT" }] });
  await command;
  assert.strictEqual(disposed, true);
  assert.strictEqual(populate, 0);
  assert.deepStrictEqual(f.errors, []);
 });
 test("signal delivery failures are reported from the selection callback", async () => {
  const f = fixture();
  let accept!: () => Promise<void>;
  const picker = {
   busy: false, selectedItems: [{ signalName: "SIGUSR1" }],
   onDidHide() { return { dispose() {} }; },
   onDidAccept(callback: () => Promise<void>) { accept = callback; return { dispose() {} }; },
   show() {}, dispose() {},
  };
  (f.host.window as any).createQuickPick = () => picker;
  f.debugSession.customRequest = async command => {
   if (command === "list-signals") return { signals: [] };
   throw new Error("signal rejected");
  };
  await f.commands.get("ddbSessionsExplorer.sendSignal")!({ sessionId: 7 });
  await accept();
  assert.strictEqual(f.errors.length, 1);
  assert.ok(f.errors[0].includes("signal rejected"));
 });

});
