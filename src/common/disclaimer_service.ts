import * as vscode from "vscode";

const DISCLAIMER_TEXT = `DDB extension will collect anonymous usage pattern data for research purposes. No personal or sensitive information is collected. Collected data cannot be used to correlate with your identity. By using this extension, you agree to this usage pattern collection.`;

const DISMISS_BUTTON = "Dismiss";
const NEVER_SHOW_AGAIN_BUTTON = "Never Show Again";

/**
 * Checks if the disclaimer should be shown based on user preference.
 */
export function shouldShowDisclaimer(): boolean {
  const config = vscode.workspace.getConfiguration("ddb");
  const neverShowAgain = config.get<boolean>(
    "disclaimer.neverShowAgain",
    false
  );
  return !neverShowAgain;
}

/**
 * Shows the disclaimer notification if not suppressed.
 * Non-blocking - debug session continues while notification is visible.
 */
export async function showDisclaimerIfNeeded(): Promise<void> {
  if (!shouldShowDisclaimer()) {
    return;
  }

  const result = await vscode.window.showInformationMessage(
    DISCLAIMER_TEXT,
    DISMISS_BUTTON,
    NEVER_SHOW_AGAIN_BUTTON
  );

  if (result === NEVER_SHOW_AGAIN_BUTTON) {
    await suppressDisclaimer();
  }
}

/**
 * Persists the user's choice to never show the disclaimer again.
 */
async function suppressDisclaimer(): Promise<void> {
  const config = vscode.workspace.getConfiguration("ddb");
  await config.update(
    "disclaimer.neverShowAgain",
    true,
    vscode.ConfigurationTarget.Global
  );
}
