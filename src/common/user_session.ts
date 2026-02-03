import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

/**
 * Gets the user ID from ~/.config/ddb/user_id, creating it if it doesn't exist.
 * This ID is shared across extension and adapter processes.
 */
export async function getOrCreateUserId(): Promise<string> {
  const userIdPath = path.join(os.homedir(), ".config", "ddb", "user_id");

  try {
    const userId = await fs.promises.readFile(userIdPath, "utf-8");
    return userId.trim();
  } catch (err: any) {
    if (err.code === "ENOENT") {
      const newUserId = crypto.randomUUID();
      const dir = path.dirname(userIdPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(userIdPath, newUserId, "utf-8");
      return newUserId;
    }
    throw err;
  }
}

/**
 * Generates a new session ID (UUID v4).
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}
