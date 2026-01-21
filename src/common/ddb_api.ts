import axios from "axios";
import * as vscode from "vscode";

const apiBaseUrl = process.env.DDB_API_URL || "http://localhost:5000";

enum Endpoint {
  GetSessions = "/sessions",
  PendingCommands = "/pcommands",
  FinishedCommands = "/fcommands",
  Status = "/status",
}

function get_url(endpoint: Endpoint): string {
  return `${apiBaseUrl}${endpoint}`;
}

export interface Session {
  sid: number;
  tag: string;
  alias: string;
  status: string;
  group?: {
    valid: boolean;
    id: number;
    hash: number;
  };
}

export interface ServiceStatus {
  status: "up" | "down";
}

export async function getSessions(): Promise<Session[]> {
  const response = await axios.get<Session[]>(get_url(Endpoint.GetSessions));
  return response.data;
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  const response = await axios.get<ServiceStatus>(get_url(Endpoint.Status));
  return response.data;
}

export async function waitForServiceReady(
  maxAttempts?: number,
  intervalMs?: number
): Promise<void> {
  // Read from VSCode settings or use defaults
  const config = vscode.workspace.getConfiguration("ddb");
  const attempts = maxAttempts ?? config.get<number>("pollMaxAttempts", 30);
  const interval = intervalMs ?? config.get<number>("pollIntervalMs", 1000);

  let currentAttempt = 0;

  while (currentAttempt < attempts) {
    try {
      const status = await getServiceStatus();
      if (status.status === "up") {
        console.log("DDB service is ready!");
        return;
      }
    } catch (error) {
      // Service not ready, continue polling
    }

    currentAttempt++;
    if (currentAttempt >= attempts) {
      throw new Error(`DDB service not ready after ${attempts} attempts`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
