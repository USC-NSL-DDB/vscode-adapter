import type * as VSCode from "vscode";
import type { SessionControlItem } from "./DDBViewProvider";

type Host = Pick<typeof VSCode, "commands" | "window" | "debug">;

/** Capture the owning debug session before a dialog can change focus. */
export function registerSessionControls(vscode: Host, context: Pick<VSCode.ExtensionContext, "subscriptions">): void {
  const activeSession = () => {
    const session = vscode.debug.activeDebugSession;
    if (session?.type === "ddb") return session;
    void vscode.window.showErrorMessage("No active DDB debug session");
    return undefined;
  };
  const activeTarget = (item?: SessionControlItem) => {
    const session = activeSession();
    if (!session) return undefined;
    const sessionId = item?.sessionId;
    if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
      void vscode.window.showErrorMessage("Select a process in the DDB Sessions panel.");
      return undefined;
    }
    return { session, sessionId };
  };
  const request = async (session: VSCode.DebugSession, command: string, args: object) => {
    try {
      await session.customRequest(command, args);
    } catch (error) {
      void vscode.window.showErrorMessage(`DDB ${command} failed: ${error}`);
    }
  };

  for (const command of ["pause", "continue"] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(`ddbSessionsExplorer.${command}Session`, async (item?: SessionControlItem) => {
      const target = activeTarget(item);
      if (target) await request(target.session, command, { sessionId: target.sessionId });
    }));
  }

  context.subscriptions.push(vscode.commands.registerCommand("ddbSessionsExplorer.killSession", async (item?: SessionControlItem) => {
    const target = activeTarget(item);
    if (!target) return;
    const { session, sessionId } = target;
    try {
      const answer = await vscode.window.showWarningMessage(
        `Are you sure you want to kill session ${sessionId}? This will terminate the process.`,
        { modal: true }, "Yes", "No"
      );
      if (answer === "Yes") await request(session, "send-signal", { sessionId, signal: "SIGKILL" });
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not confirm session termination: ${error}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("ddbSessionsExplorer.sendSignal", async (item?: SessionControlItem) => {
    const target = activeTarget(item);
    if (!target) return;
    const { session, sessionId } = target;
    interface SignalItem extends VSCode.QuickPickItem { signalName: string }
    const picker = vscode.window.createQuickPick<SignalItem>();
    picker.title = `Send Signal to Session ${sessionId}`;
    picker.placeholder = "Loading available signals...";
    picker.busy = true;
    picker.enabled = false;
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = true;
    let closed = false;
    const subscriptions: VSCode.Disposable[] = [];
    const close = () => {
      if (closed) return;
      closed = true;
      for (const subscription of subscriptions) subscription.dispose();
      picker.dispose();
    };
    subscriptions.push(picker.onDidHide(close));
    subscriptions.push(picker.onDidAccept(async () => {
      if (closed || picker.busy) return;
      const selected = picker.selectedItems[0];
      close();
      if (selected) await request(session, "send-signal", { sessionId, signal: selected.signalName });
    }));
    picker.show();
    try {
      const response = await session.customRequest("list-signals", { sessionId });
      if (closed) return;
      picker.items = response.signals.map((signal: any) => ({
        label: signal.name,
        description: `stop:${signal.stop} print:${signal.print} pass:${signal.pass}`,
        detail: signal.desc,
        signalName: signal.name,
      }));
      picker.busy = false;
      picker.enabled = true;
      picker.placeholder = "Select a signal to send";
    } catch (error) {
      if (closed) return;
      close();
      void vscode.window.showErrorMessage(`Failed to fetch signals: ${error}`);
    }
  }));
}
