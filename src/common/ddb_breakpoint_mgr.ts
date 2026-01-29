import { DDBBreakpoint, getBreakpoints } from "./ddb_api";

let vscode: any;
try {
  vscode = require("vscode");
} catch (e) {
  vscode = null;
}

/**
 * Type for tracking pending update operations
 */
type PendingUpdate = "all" | "breakpoints";

/**
 * BreakpointManager - Singleton class that serves as the single source of truth
 * for all DDB breakpoints.
 *
 * Features:
 * - Debounced updates to prevent backend overload
 * - Auto-refresh with configurable interval
 * - Event-driven updates with listener support
 * - Caching by ID and by file path
 *
 * API Design:
 * - get*() methods: Read from cache (fast, no API call)
 * - fetch*() methods: Update cache with fresh data, then return it
 * - update*() methods: Update cache in background (debounced)
 *
 * Usage:
 * ```typescript
 * const mgr = BreakpointManager.getInstance();
 *
 * // Cached reads (fast)
 * const breakpoints = mgr.getAllBreakpoints();
 * const bp = mgr.getBreakpoint(1);
 * const fileBps = mgr.getBreakpointsByFile('/path/to/file.rs');
 *
 * // Fresh fetches (triggers API call)
 * const freshBps = await mgr.fetchAllBreakpoints();
 *
 * // Background updates
 * await mgr.updateAll();
 *
 * // Listen to updates
 * const unsubscribe = mgr.onDataUpdated(() => {
 *   console.log('Breakpoints updated!');
 * });
 *
 * // Auto-refresh (typically started when debug session begins)
 * mgr.startAutoRefresh();
 * mgr.stopAutoRefresh();
 * ```
 */
export class BreakpointManager {
  // ============================================================================
  // Singleton Instance
  // ============================================================================
  private static instance: BreakpointManager | null = null;

  /**
   * Get the singleton instance of BreakpointManager.
   * Does not auto-initialize - caller must explicitly start auto-refresh when needed.
   */
  public static getInstance(): BreakpointManager {
    if (!BreakpointManager.instance) {
      BreakpointManager.instance = new BreakpointManager();
    }
    return BreakpointManager.instance;
  }

  /**
   * Reset the singleton instance.
   * Useful for testing purposes.
   */
  public static resetInstance(): void {
    if (BreakpointManager.instance) {
      BreakpointManager.instance.dispose();
      BreakpointManager.instance = null;
    }
  }

  // ============================================================================
  // Data Caches
  // ============================================================================
  private breakpointsById: Map<number, DDBBreakpoint>;
  private breakpointsByFile: Map<string, DDBBreakpoint[]>;

  // ============================================================================
  // Metadata
  // ============================================================================
  private lastUpdateTime: number | null;
  private updateListeners: Set<() => void>;
  private initialized: boolean;

  // ============================================================================
  // Auto-refresh & Debouncing
  // ============================================================================
  private refreshInterval: NodeJS.Timeout | null;
  private debounceTimeout: NodeJS.Timeout | null;
  private pendingUpdates: Set<string>;
  private readonly DEBOUNCE_MS = 50; // Debounce interval in milliseconds
  private readonly AUTO_REFRESH_MS = 15000; // Default 15 seconds
  private wsActive: boolean = false; // Flag to control polling when WebSocket is active

  // ============================================================================
  // Constructor (Private - Singleton Pattern)
  // ============================================================================
  private constructor() {
    // Initialize data caches
    this.breakpointsById = new Map();
    this.breakpointsByFile = new Map();

    // Initialize metadata
    this.lastUpdateTime = null;
    this.updateListeners = new Set();
    this.initialized = false;

    // Initialize auto-refresh & debouncing
    this.refreshInterval = null;
    this.debounceTimeout = null;
    this.pendingUpdates = new Set();
  }

  // ============================================================================
  // Debouncing Logic
  // ============================================================================

  /**
   * Schedule an update with debouncing to prevent rapid consecutive calls.
   */
  private scheduleUpdate(updateType: PendingUpdate): void {
    this.pendingUpdates.add(updateType);

    // Clear existing debounce timer
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    // Schedule consolidated update
    this.debounceTimeout = setTimeout(() => {
      this.executeQueuedUpdates();
    }, this.DEBOUNCE_MS);
  }

  /**
   * Execute all queued updates in an optimized manner.
   */
  private async executeQueuedUpdates(): Promise<void> {
    const updates = Array.from(this.pendingUpdates);
    this.pendingUpdates.clear();
    this.debounceTimeout = null;

    // Optimize: if 'all' or 'breakpoints' is requested, just do a full update
    if (updates.includes("all") || updates.includes("breakpoints")) {
      await this.performUpdateAll();
    }
  }

  /**
   * Wait for any pending debounced updates to complete.
   */
  private async waitForPendingUpdates(): Promise<void> {
    return new Promise((resolve) => {
      const checkComplete = () => {
        if (!this.debounceTimeout) {
          resolve();
        } else {
          setTimeout(checkComplete, 50);
        }
      };
      checkComplete();
    });
  }

  // ============================================================================
  // Update Methods (Public)
  // ============================================================================

  /**
   * Update all breakpoints.
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateAll(): Promise<void> {
    this.scheduleUpdate("all");
    await this.waitForPendingUpdates();
  }

  /**
   * Immediate update without debouncing.
   */
  public async immediateUpdateAll(): Promise<void> {
    await this.performUpdateAll();
  }

  /**
   * Update breakpoints (alias for updateAll since we only have one data type).
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateBreakpoints(): Promise<void> {
    this.scheduleUpdate("breakpoints");
    await this.waitForPendingUpdates();
  }

  /**
   * Immediate update breakpoints without debouncing.
   */
  public async immediateUpdateBreakpoints(): Promise<void> {
    await this.performUpdateAll();
  }

  // ============================================================================
  // Update Methods (Private - Actual Implementation)
  // ============================================================================

  /**
   * Perform the actual update of all breakpoints.
   */
  private async performUpdateAll(): Promise<void> {
    try {
      const breakpoints = await getBreakpoints();
      this.rebuildCache(breakpoints);
      this.lastUpdateTime = Date.now();
      this.initialized = true;
      this.notifyListeners();
    } catch (error) {
      console.error("Failed to update breakpoints:", error);
      throw error;
    }
  }

  // ============================================================================
  // Cache Rebuild Logic
  // ============================================================================

  /**
   * Rebuild all caches from scratch with new breakpoint data.
   */
  private rebuildCache(breakpoints: DDBBreakpoint[]): void {
    // Clear all caches
    this.breakpointsById.clear();
    this.breakpointsByFile.clear();

    // Rebuild caches
    for (const bp of breakpoints) {
      this.breakpointsById.set(bp.id, bp);

      const filePath = bp.location.src;
      if (!this.breakpointsByFile.has(filePath)) {
        this.breakpointsByFile.set(filePath, []);
      }
      this.breakpointsByFile.get(filePath)!.push(bp);
    }

    // Sort breakpoints within each file by line number
    for (const [, bps] of this.breakpointsByFile) {
      bps.sort((a, b) => a.location.line - b.location.line);
    }
  }

  // ============================================================================
  // Breakpoint Query APIs
  // ============================================================================

  /**
   * Get all breakpoints.
   */
  public getAllBreakpoints(): DDBBreakpoint[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getAllBreakpoints");
      return [];
    }
    return Array.from(this.breakpointsById.values());
  }

  /**
   * Get a specific breakpoint by ID.
   */
  public getBreakpoint(id: number): DDBBreakpoint | undefined {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getBreakpoint");
      return undefined;
    }
    return this.breakpointsById.get(id);
  }

  /**
   * Get all breakpoints for a specific file.
   */
  public getBreakpointsByFile(filePath: string): DDBBreakpoint[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getBreakpointsByFile");
      return [];
    }
    return this.breakpointsByFile.get(filePath) || [];
  }

  /**
   * Get all unique file paths that have breakpoints.
   */
  public getUniqueFiles(): string[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getUniqueFiles");
      return [];
    }
    return Array.from(this.breakpointsByFile.keys()).sort();
  }

  /**
   * Get the total number of breakpoints.
   */
  public getBreakpointsCount(): number {
    return this.breakpointsById.size;
  }

  /**
   * Get the number of unique files with breakpoints.
   */
  public getFilesCount(): number {
    return this.breakpointsByFile.size;
  }

  // ============================================================================
  // Fresh Fetch APIs (Update cache, then return fresh data)
  // ============================================================================

  /**
   * Fetch all breakpoints with fresh data from backend.
   * Updates the cache, then returns the fresh data.
   */
  public async fetchAllBreakpoints(): Promise<DDBBreakpoint[]> {
    await this.updateAll();
    return this.getAllBreakpoints();
  }

  /**
   * Fetch all breakpoints immediately without debouncing.
   */
  public async immediateFetchAllBreakpoints(): Promise<DDBBreakpoint[]> {
    await this.immediateUpdateAll();
    return this.getAllBreakpoints();
  }

  /**
   * Fetch a specific breakpoint with fresh data from backend.
   * Updates the cache, then returns the fresh data.
   */
  public async fetchBreakpoint(id: number): Promise<DDBBreakpoint | undefined> {
    await this.updateAll();
    return this.getBreakpoint(id);
  }

  /**
   * Fetch a specific breakpoint immediately without debouncing.
   */
  public async immediateFetchBreakpoint(
    id: number
  ): Promise<DDBBreakpoint | undefined> {
    await this.immediateUpdateAll();
    return this.getBreakpoint(id);
  }

  /**
   * Fetch breakpoints for a specific file with fresh data from backend.
   */
  public async fetchBreakpointsByFile(
    filePath: string
  ): Promise<DDBBreakpoint[]> {
    await this.updateAll();
    return this.getBreakpointsByFile(filePath);
  }

  /**
   * Fetch breakpoints for a specific file immediately without debouncing.
   */
  public async immediateFetchBreakpointsByFile(
    filePath: string
  ): Promise<DDBBreakpoint[]> {
    await this.immediateUpdateAll();
    return this.getBreakpointsByFile(filePath);
  }

  // ============================================================================
  // Utility and Helper Methods
  // ============================================================================

  /**
   * Check if the BreakpointManager has any data loaded.
   */
  public hasData(): boolean {
    return this.breakpointsById.size > 0;
  }

  /**
   * Get the timestamp of the last successful update.
   */
  public getLastUpdateTime(): number | null {
    return this.lastUpdateTime;
  }

  /**
   * Check if the BreakpointManager has been initialized (first fetch completed).
   * @returns true if initialized (data has been fetched at least once), false otherwise
   */
  private isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Show a warning message when BreakpointManager is accessed before initialization.
   */
  private warnNotInitialized(methodName: string): void {
    const message = `BreakpointManager.${methodName}() called before initialization. Start a debug session first.`;
    console.warn(message);
    if (vscode) {
      vscode.window.showInformationMessage(message);
    }
  }

  // ============================================================================
  // Event System and Lifecycle Management
  // ============================================================================

  /**
   * Register a listener to be notified when data is updated.
   * Returns an unsubscribe function.
   *
   * @param callback Function to call when data is updated
   * @returns Unsubscribe function
   */
  public onDataUpdated(callback: () => void): () => void {
    this.updateListeners.add(callback);
    return () => {
      this.updateListeners.delete(callback);
    };
  }
  
  // Used to notify listeners externally (e.g., from extension.ts)
  // So that it can refresh its view.
  public notifyDataChange(): void {
    this.notifyListeners();
  }

  /**
   * Notify all registered listeners that data has been updated.
   */
  private notifyListeners(): void {
    this.updateListeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("Error in update listener:", error);
      }
    });
  }

  /**
   * Start automatic periodic refresh of data.
   *
   * @param intervalMs Optional custom interval in milliseconds (default: 15000)
   */
  public startAutoRefresh(intervalMs?: number): void {
    // Don't start polling if WebSocket is handling updates
    if (this.wsActive) {
      console.debug(
        "[BreakpointManager] WebSocket active, skipping auto-refresh polling"
      );
      return;
    }

    this.stopAutoRefresh();

    // Read from VSCode config if not provided
    let interval = intervalMs;
    if (!interval && vscode) {
      const config = vscode.workspace.getConfiguration("ddb");
      interval = config.get(
        "breakpointManager.autoRefreshMs",
        this.AUTO_REFRESH_MS
      );
    } else {
      interval = intervalMs || this.AUTO_REFRESH_MS;
    }

    console.debug(
      `[BreakpointManager] Starting auto-refresh with ${interval}ms interval`
    );
    this.refreshInterval = setInterval(() => {
      console.debug("[BreakpointManager] Auto-refresh triggered");
      this.updateAll().catch((error) => {
        console.error("Auto-refresh failed:", error);
      });
    }, interval);
  }

  /**
   * Stop automatic periodic refresh.
   */
  public stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Set WebSocket active state.
   * When WebSocket is active, auto-refresh polling is disabled.
   * When WebSocket is inactive, auto-refresh polling can resume.
   *
   * @param active - true if WebSocket is connected and handling updates
   */
  public setWebSocketActive(active: boolean): void {
    this.wsActive = active;
    console.log(`[BreakpointManager] WebSocket active: ${active}`);
  }

  /**
   * Clear all cached data.
   * Useful when debug session ends and data is no longer valid.
   */
  public clearCache(): void {
    this.breakpointsById.clear();
    this.breakpointsByFile.clear();
    this.lastUpdateTime = null;
    this.initialized = false;
    // Notify listeners so UI can update to empty state
    this.notifyListeners();
  }

  /**
   * Dispose of all resources and clear all data.
   * Should be called when the BreakpointManager is no longer needed.
   */
  public dispose(): void {
    this.stopAutoRefresh();
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }
    this.updateListeners.clear();
    this.breakpointsById.clear();
    this.breakpointsByFile.clear();
    this.pendingUpdates.clear();
  }
}
