import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { Logger } from "@opentelemetry/api-logs";

/**
 * Sets up the logger provider with OTLP gRPC exporter.
 * Note: Does NOT register globally to prevent other extensions from using it.
 */
export function setupLogger(
  resource: Resource,
  endpoint: string
): LoggerProvider {
  const exporter = new OTLPLogExporter({
    url: endpoint,
  });

  const loggerProvider = new LoggerProvider({
    resource,
  });

  loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter));

  // Don't call logs.setGlobalLoggerProvider() - keep provider private
  // This prevents other extensions from sending logs through our exporter

  return loggerProvider;
}

/**
 * Gets a logger instance directly from the provider.
 */
export function getLogger(provider: LoggerProvider, name: string): Logger {
  return provider.getLogger(name);
}
