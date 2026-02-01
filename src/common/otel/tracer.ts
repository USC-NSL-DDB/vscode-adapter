import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { trace, Tracer } from "@opentelemetry/api";

/**
 * Sets up the tracer provider with OTLP gRPC exporter.
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

  provider.register();

  return provider;
}

/**
 * Gets a tracer instance by name.
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}
