import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { logs, Logger } from "@opentelemetry/api-logs";

/**
 * Sets up the logger provider with OTLP gRPC exporter.
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

  logs.setGlobalLoggerProvider(loggerProvider);

  return loggerProvider;
}

/**
 * Gets a logger instance by name.
 */
export function getLogger(name: string): Logger {
  return logs.getLogger(name);
}
