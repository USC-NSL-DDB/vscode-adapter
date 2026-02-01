import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { diag, DiagConsoleLogger, DiagLogLevel, Tracer, Meter } from "@opentelemetry/api";
import { Logger, SeverityNumber } from "@opentelemetry/api-logs";

import type { OTelConfig } from "./types";
import { getOTelConfig } from "./config";
import { createResource } from "./resource";
import { setupTracer } from "./tracer";
import { setupMeter } from "./meter";
import { setupLogger } from "./logger";

// Version from package.json - update when version changes
const VERSION = "0.0.8";

/**
 * Singleton service for OpenTelemetry tracing, metrics, and logging.
 * Supports both VSCode extension and debug adapter processes.
 *
 * Note: Providers are NOT registered globally to prevent other extensions
 * from sending telemetry through our exporters.
 */
export class OTelService {
  private static instance: OTelService | null = null;

  private config: OTelConfig;
  private tracerProvider: NodeTracerProvider | null = null;
  private meterProvider: MeterProvider | null = null;
  private loggerProvider: LoggerProvider | null = null;
  private initialized: boolean = false;

  private constructor(config: OTelConfig) {
    this.config = config;
  }

  /**
   * Initializes the OTelService singleton.
   * Call this once at startup with the app name, user ID, and session ID.
   */
  public static initialize(
    appName: string,
    userId: string,
    sessionId: string
  ): OTelService {
    if (OTelService.instance) {
      console.warn("[OTel] OTelService already initialized");
      return OTelService.instance;
    }

    const config = getOTelConfig(appName, userId, sessionId);
    OTelService.instance = new OTelService(config);

    if (config.enabled) {
      OTelService.instance.setup();
    } else {
      console.log("[OTel] Disabled by configuration");
    }

    return OTelService.instance;
  }

  /**
   * Gets the initialized OTelService instance.
   * Throws if not initialized.
   */
  public static getInstance(): OTelService {
    if (!OTelService.instance) {
      throw new Error(
        "OTelService not initialized. Call OTelService.initialize() first."
      );
    }
    return OTelService.instance;
  }

  /**
   * Checks if OTEL is available and initialized.
   */
  public static isAvailable(): boolean {
    return OTelService.instance?.initialized ?? false;
  }

  /**
   * Sets up all OTEL providers (tracer, meter, logger).
   */
  private setup(): void {
    try {
      // Set default OTEL diagnostic log level to INFO
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

      const resource = createResource(this.config, VERSION);

      this.tracerProvider = setupTracer(resource, this.config.endpoint);
      this.meterProvider = setupMeter(resource, this.config.endpoint);
      this.loggerProvider = setupLogger(resource, this.config.endpoint);

      this.initialized = true;

      console.log(
        `[OTel] Initialized for ${this.config.appName} -> ${this.config.endpoint}`
      );
    } catch (error) {
      console.error("[OTel] Failed to initialize:", error);
      this.initialized = false;
    }
  }

  /**
   * Gets a tracer instance directly from the provider.
   * @param name Optional tracer name, defaults to app name
   */
  public tracer(name?: string): Tracer {
    if (!this.tracerProvider) {
      throw new Error("Tracer provider not initialized");
    }
    return this.tracerProvider.getTracer(name ?? this.config.appName);
  }

  /**
   * Gets a meter instance directly from the provider.
   * @param name Optional meter name, defaults to app name
   */
  public meter(name?: string): Meter {
    if (!this.meterProvider) {
      throw new Error("Meter provider not initialized");
    }
    return this.meterProvider.getMeter(name ?? this.config.appName);
  }

  /**
   * Gets a logger instance directly from the provider.
   * @param name Optional logger name, defaults to app name
   */
  public logger(name?: string): Logger {
    if (!this.loggerProvider) {
      throw new Error("Logger provider not initialized");
    }
    return this.loggerProvider.getLogger(name ?? this.config.appName);
  }

  public static log_trace(message: string): void {
    OTelService.instance?.logger().emit({ body: message, severityNumber: SeverityNumber.TRACE, severityText: "TRACE" });
  }

  public static log_debug(message: string): void {
    OTelService.instance?.logger().emit({ body: message, severityNumber: SeverityNumber.DEBUG, severityText: "DEBUG" });
  }

  public static log_info(message: string): void {
    OTelService.instance?.logger().emit({ body: message, severityNumber: SeverityNumber.INFO, severityText: "INFO" });
  }

  public static log_warn(message: string): void {
    OTelService.instance?.logger().emit({ body: message, severityNumber: SeverityNumber.WARN, severityText: "WARN" });
  }

  public static log_error(message: string): void {
    OTelService.instance?.logger().emit({ body: message, severityNumber: SeverityNumber.ERROR, severityText: "ERROR" });
  }

  public static log_fatal(message: string): void {
    OTelService.instance?.logger().emit({ body: message, severityNumber: SeverityNumber.FATAL, severityText: "FATAL" });
  }

  /**
   * Gets the current configuration.
   */
  public getConfig(): OTelConfig {
    return { ...this.config };
  }

  /**
   * Shuts down all OTEL providers gracefully.
   * Call this when the extension/adapter is deactivating.
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const promises: Promise<void>[] = [];

    if (this.tracerProvider) {
      promises.push(this.tracerProvider.shutdown());
    }
    if (this.meterProvider) {
      promises.push(this.meterProvider.shutdown());
    }
    if (this.loggerProvider) {
      promises.push(this.loggerProvider.shutdown());
    }

    try {
      await Promise.all(promises);
      console.log(`[OTel] Shutdown complete for ${this.config.appName}`);
    } catch (error) {
      console.error("[OTel] Error during shutdown:", error);
    }

    this.initialized = false;
    OTelService.instance = null;
  }
}

export type { OTelConfig };
