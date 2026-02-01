import type { OTelConfig } from "./types";

const DEFAULT_ENDPOINT = "http://ruby1.nsl.usc.edu:54317";

// Conditional vscode import - works in both extension and adapter processes
let vscode: any;
try {
  vscode = require("vscode");
} catch (e) {
  vscode = null;
}

/**
 * Gets the OTEL configuration, reading from VSCode settings if available.
 */
export function getOTelConfig(
  appName: string,
  userId: string,
  sessionId: string
): OTelConfig {
  // Check environment variable first (highest priority)
  let endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let enabled = process.env.OTEL_SDK_DISABLED !== "true";

  // If in VSCode extension context, read from settings
  if (vscode) {
    const config = vscode.workspace.getConfiguration("ddb");
    if (!endpoint) {
      endpoint = config.get("otel.endpoint", DEFAULT_ENDPOINT) as string;
    }
    const configEnabled = config.get("otel.enabled", true) as boolean;
    enabled = enabled && configEnabled;
  }

  // Fallback to default
  if (!endpoint) {
    endpoint = DEFAULT_ENDPOINT;
  }

  return {
    endpoint,
    appName,
    userId,
    sessionId,
    enabled,
  };
}
