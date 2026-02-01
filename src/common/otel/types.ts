/**
 * Configuration for OpenTelemetry initialization.
 */
export interface OTelConfig {
  /** OTLP gRPC endpoint (e.g., "http://ruby1.nsl.usc.edu:54317") */
  endpoint: string;
  /** Application name (e.g., "ddb-ext" or "ddb-da") */
  appName: string;
  /** User ID (shared across extension and adapter) */
  userId: string;
  /** Session ID (unique per session) */
  sessionId: string;
  /** Whether OTEL is enabled */
  enabled: boolean;
}
