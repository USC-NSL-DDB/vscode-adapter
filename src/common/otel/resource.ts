import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { OTelConfig } from "./types";

// Custom attribute names for user and session
const ATTR_USER_ID = "user.id";
const ATTR_SESSION_ID = "session.id";

/**
 * Creates an OpenTelemetry Resource with service, user, and session attributes.
 */
export function createResource(config: OTelConfig, version: string): Resource {
  return new Resource({
    [ATTR_SERVICE_NAME]: config.appName,
    [ATTR_SERVICE_VERSION]: version,
    [ATTR_USER_ID]: config.userId,
    [ATTR_SESSION_ID]: config.sessionId,
  });
}
