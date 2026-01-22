import WebSocket from "ws";
import { getWebSocketUrl } from "./ddb_api";

// Conditionally import vscode - only available in extension host
let vscode: any;
try {
  vscode = require("vscode");
} catch (e) {
  // vscode module not available (running in debug adapter process)
  vscode = null;
}

/**
 * Notification interface matching the backend protocol
 */
interface Notification {
  version: number;
  timestamp: number;
  notification_id: string;
  payload: {
    type:
      | "SessionListChanged"
      | "BreakpointChanged"
      | "SessionStatusChanged"
      | "Custom";
    data: any;
  };
}

/**
 * Connection state enum
 */
enum ConnectionState {
  DISCONNECTED = "DISCONNECTED",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  ERROR = "ERROR",
}

/**
 * NotificationService - Singleton WebSocket client for DDB notifications
 *
 * Features:
 * - Manages WebSocket connection to DDB backend notification endpoint
 * - Type-safe notification handling with event listeners
 * - Automatic reconnection with exponential backoff
 * - Connection state management and monitoring
 *
 * Usage:
 * ```typescript
 * const service = NotificationService.getInstance();
 *
 * // Subscribe to specific notification types
 * const unsubscribe = service.onNotification('SessionListChanged', (data) => {
 *   console.log('Sessions changed:', data);
 * });
 *
 * // Start/stop connection
 * service.start();
 * service.stop();
 *
 * // Cleanup
 * unsubscribe();
 * service.dispose();
 * ```
 */
export class NotificationService {
  // ============================================================================
  // Singleton Instance
  // ============================================================================
  private static instance: NotificationService | null = null;

  /**
   * Get the singleton instance of NotificationService.
   */
  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Reset the singleton instance (useful for testing).
   */
  public static resetInstance(): void {
    if (NotificationService.instance) {
      NotificationService.instance.dispose();
      NotificationService.instance = null;
    }
  }

  // ============================================================================
  // Private State
  // ============================================================================
  private ws: WebSocket | null = null;
  private state: ConnectionState = ConnectionState.DISCONNECTED;

  // Event listeners: Map<notification_type, Set<callback>>
  private listeners: Map<string, Set<(data: any) => void>> = new Map();

  // Connection state change listeners
  private stateListeners: Set<(connected: boolean) => void> = new Set();

  // Reconnection logic
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // 30 seconds max
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false; // Only reconnect if connection was intentional

  private constructor() {
    // Private constructor for singleton pattern
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Start the WebSocket connection to the notification service.
   */
  public start(): void {
    // Check if notifications are enabled
    if (vscode) {
      const config = vscode.workspace.getConfiguration("ddb");
      const enabled = config.get("notifications.enabled", true);
      if (!enabled) {
        console.info("[NotificationService] Notifications disabled in settings");
        return;
      }
    }

    if (
      this.state === ConnectionState.CONNECTED ||
      this.state === ConnectionState.CONNECTING
    ) {
      console.debug("[NotificationService] Already connected or connecting");
      return;
    }

    this.shouldReconnect = true;
    this.connect();
  }

  /**
   * Stop the WebSocket connection gracefully.
   */
  public stop(): void {
    console.info("[NotificationService] Stopping connection");
    this.shouldReconnect = false;
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.state = ConnectionState.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.notifyStateChange(false);
  }

  /**
   * Check if the WebSocket is currently connected.
   */
  public isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }

  /**
   * Subscribe to a specific notification type.
   * @param type - Notification type to listen for (e.g., 'SessionListChanged')
   * @param callback - Function to call when notification is received
   * @returns Unsubscribe function
   */
  public onNotification(
    type: string,
    callback: (data: any) => void
  ): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);

    // Return unsubscribe function
    return () => {
      const typeListeners = this.listeners.get(type);
      if (typeListeners) {
        typeListeners.delete(callback);
        if (typeListeners.size === 0) {
          this.listeners.delete(type);
        }
      }
    };
  }

  /**
   * Subscribe to connection state changes.
   * @param callback - Function to call when connection state changes (true = connected, false = disconnected)
   * @returns Unsubscribe function
   */
  public onConnectionStateChange(
    callback: (connected: boolean) => void
  ): () => void {
    this.stateListeners.add(callback);

    // Return unsubscribe function
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Dispose of all resources and cleanup.
   */
  public dispose(): void {
    this.stop();
    this.listeners.clear();
    this.stateListeners.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Establish WebSocket connection.
   */
  private connect(): void {
    try {
      const wsUrl = getWebSocketUrl();
      console.log(`[NotificationService] Connecting to ${wsUrl}`);

      this.state = ConnectionState.CONNECTING;
      this.ws = new WebSocket(wsUrl);

      this.ws!.on("open", () => this.handleOpen());
      this.ws!.on("message", (data: WebSocket.Data) =>
        this.handleMessage(data)
      );
      this.ws!.on("error", (error: Error) => this.handleError(error));
      this.ws!.on("close", (code: number, reason: Buffer) =>
        this.handleClose(code, reason)
      );
    } catch (error) {
      console.error("[NotificationService] Failed to create WebSocket:", error);
      this.state = ConnectionState.ERROR;
      this.scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket open event.
   */
  private handleOpen(): void {
    console.log("[NotificationService] Connected to DDB notifications");
    this.state = ConnectionState.CONNECTED;
    this.reconnectAttempts = 0;
    this.notifyStateChange(true);
  }

  /**
   * Handle incoming WebSocket messages.
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = data.toString();
      const notification: Notification = JSON.parse(message);

      console.log(
        `[NotificationService] Received notification: ${notification.payload.type}`
      );

      // Dispatch to registered listeners for this type
      const typeListeners = this.listeners.get(notification.payload.type);
      if (typeListeners && typeListeners.size > 0) {
        typeListeners.forEach((callback) => {
          try {
            callback(notification.payload.data);
          } catch (error) {
            console.error(
              `[NotificationService] Error in listener for ${notification.payload.type}:`,
              error
            );
          }
        });
      }
    } catch (error) {
      console.error(
        "[NotificationService] Failed to parse notification:",
        error
      );
    }
  }

  /**
   * Handle WebSocket error event.
   */
  private handleError(error: Error): void {
    console.error("[NotificationService] WebSocket error:", error);
    this.state = ConnectionState.ERROR;
  }

  /**
   * Handle WebSocket close event.
   */
  private handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString() || "Unknown reason";
    console.log(
      `[NotificationService] Connection closed: ${code} - ${reasonStr}`
    );

    this.state = ConnectionState.DISCONNECTED;
    this.ws = null;
    this.notifyStateChange(false);

    // Only reconnect if we were intentionally connected (not stopped manually)
    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    // Calculate delay with exponential backoff: 1s, 2s, 4s, 8s, 16s, ... max 30s
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    console.log(
      `[NotificationService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Clear any pending reconnection timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Notify all state change listeners.
   */
  private notifyStateChange(connected: boolean): void {
    this.stateListeners.forEach((callback) => {
      try {
        callback(connected);
      } catch (error) {
        console.error(
          "[NotificationService] Error in state change listener:",
          error
        );
      }
    });
  }
}
