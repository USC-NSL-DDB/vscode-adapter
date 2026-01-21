import axios from "axios";
import * as vscode from "vscode";

const apiBaseUrl = process.env.DDB_API_URL || "http://localhost:5000";

enum Endpoint {
  GetSessions = "/sessions",
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
    id: string;
    hash: number;
  };
}

export async function getSessions(): Promise<Session[]> {
  const response = await axios.get<Session[]>(get_url(Endpoint.GetSessions));
  return response.data;
}
