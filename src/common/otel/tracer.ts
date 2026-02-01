import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { Tracer } from "@opentelemetry/api";

/**
 * Sets up the tracer provider with OTLP gRPC exporter.
 * Note: Does NOT register globally to prevent other extensions from using it.
 */
export function setupTracer(
  resource: Resource,
  endpoint: string
): NodeTracerProvider {
  const exporter = new OTLPTraceExporter({
    url: endpoint,
  });

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  // Don't call provider.register() - keep provider private
  // This prevents other extensions from sending traces through our exporter

  return provider;
}

/**
 * Gets a tracer instance directly from the provider.
 */
export function getTracer(provider: NodeTracerProvider, name: string): Tracer {
  return provider.getTracer(name);
}
