import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { Meter } from "@opentelemetry/api";

/**
 * Sets up the meter provider with OTLP gRPC exporter.
 * Note: Does NOT register globally to prevent other extensions from using it.
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

  // Don't call metrics.setGlobalMeterProvider() - keep provider private
  // This prevents other extensions from sending metrics through our exporter

  return meterProvider;
}

/**
 * Gets a meter instance directly from the provider.
 */
export function getMeter(provider: MeterProvider, name: string): Meter {
  return provider.getMeter(name);
}
