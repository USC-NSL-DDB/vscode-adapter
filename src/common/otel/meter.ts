import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { metrics, Meter } from "@opentelemetry/api";

/**
 * Sets up the meter provider with OTLP gRPC exporter.
 */
export function setupMeter(
  resource: Resource,
  endpoint: string
): MeterProvider {
  const exporter = new OTLPMetricExporter({
    url: endpoint,
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60000, // Export every 60 seconds
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);

  return meterProvider;
}

/**
 * Gets a meter instance by name.
 */
export function getMeter(name: string): Meter {
  return metrics.getMeter(name);
}
