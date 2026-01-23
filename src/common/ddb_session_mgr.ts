import {
  Session,
  LogicalGroup,
  getSessions,
  getGroups,
  getGroup,
  resolveSrcToGroups,
  resolveSrcToGroupIds,
} from "./ddb_api";

let vscode: any;
try {
  vscode = require("vscode");
} catch (e) {
  vscode = null;
}

/**
 * Type for tracking pending update operations
 */
type PendingUpdate =
  | "all"
  | "sessions"
  | "groups"
  | { type: "group"; id: number };

/**
 * SessionManager - Singleton class that serves as the single source of truth
 * for all DDB sessions and logical groups.
 *
 * Features:
 * - Debounced updates to prevent backend overload
 * - Auto-refresh with configurable interval
 * - Event-driven updates with listener support
 * - Comprehensive caching and query APIs
 *
 * API Design:
 * - get*() methods: Read from cache (fast, no API call)
 * - fetch*() methods: Update cache with fresh data, then return it
 * - update*() methods: Update cache in background (debounced)
 *
 * Usage:
 * ```typescript
 * const mgr = SessionManager.getInstance();
 *
 * // Cached reads (fast)
 * const sessions = mgr.getAllSessions();
 * const groups = mgr.getAllGroups();
 *
 * // Fresh fetches (triggers API call)
 * const freshSessions = await mgr.fetchAllSessions();
 * const freshGroups = await mgr.fetchAllGroups();
 *
 * // Background updates
 * await mgr.updateSessions();
 *
 * // Listen to updates
 * const unsubscribe = mgr.onDataUpdated(() => {
 *   console.log('Data updated!');
 * });
 *
 * // Auto-refresh (typically started when debug session begins)
 * mgr.startAutoRefresh();
 * mgr.stopAutoRefresh();
 * ```
 */
export class SessionManager {
  // ============================================================================
  // Singleton Instance
  // ============================================================================
  private static instance: SessionManager | null = null;

  /**
   * Get the singleton instance of SessionManager.
   * Does not auto-initialize - caller must explicitly start auto-refresh when needed.
   */
  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
      // No auto-initialization - caller controls when to start
    }
    return SessionManager.instance;
  }

  /**
   * Reset the singleton instance.
   * Useful for testing purposes.
   */
  public static resetInstance(): void {
    if (SessionManager.instance) {
      SessionManager.instance.dispose();
      SessionManager.instance = null;
    }
  }

  // ============================================================================
  // Data Caches
  // ============================================================================
  private sessions: Map<number, Session>;
  private groups: Map<number, LogicalGroup>;
  private groupsByHash: Map<string, LogicalGroup>;
  private groupsByAlias: Map<string, LogicalGroup[]>;
  private sessionsByGroup: Map<number, Set<number>>;
  private ungroupedSessions: Set<number>;
  private srcToGroups: Map<string, Set<number>>;

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
    this.sessions = new Map();
    this.groups = new Map();
    this.groupsByHash = new Map();
    this.groupsByAlias = new Map();
    this.sessionsByGroup = new Map();
    this.ungroupedSessions = new Set();
    this.srcToGroups = new Map();

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
    // Convert update type to string key for Set storage
    const updateKey =
      typeof updateType === "string" ? updateType : `group:${updateType.id}`;

    this.pendingUpdates.add(updateKey);

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

    // Optimize: if 'all' is requested, skip everything else
    if (updates.includes("all")) {
      await this.performUpdateAll();
      return;
    }

    // Otherwise execute consolidated updates
    const needSessions = updates.includes("sessions");
    const needGroups = updates.includes("groups");
    const groupIds = updates
      .filter((u) => u.startsWith("group:"))
      .map((u) => parseInt(u.split(":")[1]));

    const promises: Promise<void>[] = [];

    if (needSessions) {
      promises.push(this.performUpdateSessions());
    }

    if (needGroups) {
      promises.push(this.performUpdateGroups());
    }

    groupIds.forEach((id) => {
      promises.push(this.performUpdateGroup(id));
    });

    await Promise.all(promises);
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
   * Update all sessions and groups.
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateAll(): Promise<void> {
    this.scheduleUpdate("all");
    await this.waitForPendingUpdates();
  }
  
  public async immediateUpdateAll(): Promise<void> {
    this.performUpdateAll();
  }

  /**
   * Update only sessions.
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateSessions(): Promise<void> {
    this.scheduleUpdate("sessions");
    await this.waitForPendingUpdates();
  }

  public async immediateUpdateSessions(): Promise<void> {
    this.performUpdateSessions();
  }

  /**
   * Update all groups.
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateGroups(): Promise<void> {
    this.scheduleUpdate("groups");
    await this.waitForPendingUpdates();
  }

  public async immediateUpdateGroups(): Promise<void> {
    this.performUpdateGroups();
  }

  /**
   * Update a specific logical group by ID.
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateGroup(groupId: number): Promise<void> {
    this.scheduleUpdate({ type: "group", id: groupId });
    await this.waitForPendingUpdates();
  }

  public async immediateUpdateGroup(groupId: number): Promise<void> {
    this.performUpdateGroup(groupId);
  }

  /**
   * Update a specific logical group by hash.
   * Debounced to prevent rapid consecutive calls.
   */
  public async updateGroupByHash(hash: string): Promise<void> {
    const group = this.groupsByHash.get(hash);
    if (group) {
      await this.updateGroup(group.id);
    }
  }

  /**
   * Cache source-to-groups mappings.
   */
  public async updateSrcMappings(src: string): Promise<void> {
    try {
      const group_ids = await resolveSrcToGroupIds(src);
      this.srcToGroups.set(src, group_ids);
      this.notifyListeners();
    } catch (error) {
      console.error(`Failed to update src mappings for ${src}:`, error);
    }
  }

  // ============================================================================
  // Update Methods (Private - Actual Implementation)
  // ============================================================================

  /**
   * Perform the actual update of all sessions and groups.
   */
  private async performUpdateAll(): Promise<void> {
    try {
      const [sessions, groups] = await Promise.all([
        getSessions(),
        getGroups(),
      ]);

      this.rebuildCache(sessions, groups);
      this.lastUpdateTime = Date.now();
      this.initialized = true;
      this.notifyListeners();
    } catch (error) {
      console.error("Failed to update all data:", error);
      throw error;
    }
  }

  /**
   * Perform the actual update of sessions only.
   */
  private async performUpdateSessions(): Promise<void> {
    try {
      const sessions = await getSessions();
      this.updateSessionCache(sessions);
      this.lastUpdateTime = Date.now();
      this.initialized = true;
      this.notifyListeners();
    } catch (error) {
      console.error("Failed to update sessions:", error);
    }
  }

  /**
   * Perform the actual update of all groups.
   */
  private async performUpdateGroups(): Promise<void> {
    try {
      const groups = await getGroups();
      this.updateGroupCache(groups);
      this.lastUpdateTime = Date.now();
      this.initialized = true;
      this.notifyListeners();
    } catch (error) {
      console.error("Failed to update groups:", error);
    }
  }

  /**
   * Perform the actual update of a specific group.
   */
  private async performUpdateGroup(groupId: number): Promise<void> {
    try {
      const group = await getGroup({ grp_id: groupId });
      this.updateSingleGroup(group);
      this.lastUpdateTime = Date.now();
      this.initialized = true;
      this.notifyListeners();
    } catch (error) {
      console.error(`Failed to update group ${groupId}:`, error);
    }
  }

  // ============================================================================
  // Cache Rebuild and Update Logic
  // ============================================================================

  /**
   * Rebuild all caches from scratch with new sessions and groups data.
   */
  private rebuildCache(sessions: Session[], groups: LogicalGroup[]): void {
    // Clear all caches
    this.sessions.clear();
    this.groups.clear();
    this.groupsByHash.clear();
    this.groupsByAlias.clear();
    this.sessionsByGroup.clear();
    this.ungroupedSessions.clear();

    // Rebuild group caches
    for (const group of groups) {
      this.groups.set(group.id, group);
      this.groupsByHash.set(group.hash, group);

      if (!this.groupsByAlias.has(group.alias)) {
        this.groupsByAlias.set(group.alias, []);
      }
      this.groupsByAlias.get(group.alias)!.push(group);

      this.sessionsByGroup.set(group.id, new Set(group.sids));
    }

    // Rebuild session caches
    for (const session of sessions) {
      this.sessions.set(session.sid, session);

      if (session.group?.valid && session.group.id >= 0) {
        // Session belongs to a group
        const groupId = session.group.id;
        if (!this.sessionsByGroup.has(groupId)) {
          this.sessionsByGroup.set(groupId, new Set());
        }
        this.sessionsByGroup.get(groupId)!.add(session.sid);
      } else {
        // Ungrouped session
        this.ungroupedSessions.add(session.sid);
      }
    }
  }

  /**
   * Update session cache with new session data.
   */
  private updateSessionCache(sessions: Session[]): void {
    // Clear session-related caches
    this.sessions.clear();
    this.ungroupedSessions.clear();

    // Clear session mappings in groups
    this.sessionsByGroup.forEach((sids) => sids.clear());

    // Rebuild session caches
    for (const session of sessions) {
      this.sessions.set(session.sid, session);

      if (session.group?.valid && session.group.id >= 0) {
        const groupId = session.group.id;
        if (!this.sessionsByGroup.has(groupId)) {
          this.sessionsByGroup.set(groupId, new Set());
        }
        this.sessionsByGroup.get(groupId)!.add(session.sid);
      } else {
        this.ungroupedSessions.add(session.sid);
      }
    }
  }

  /**
   * Update group cache with new group data.
   */
  private updateGroupCache(groups: LogicalGroup[]): void {
    // Clear group-related caches
    this.groups.clear();
    this.groupsByHash.clear();
    this.groupsByAlias.clear();
    this.sessionsByGroup.clear();

    // Rebuild group caches
    for (const group of groups) {
      this.groups.set(group.id, group);
      this.groupsByHash.set(group.hash, group);

      if (!this.groupsByAlias.has(group.alias)) {
        this.groupsByAlias.set(group.alias, []);
      }
      this.groupsByAlias.get(group.alias)!.push(group);

      this.sessionsByGroup.set(group.id, new Set(group.sids));
    }
  }

  /**
   * Update a single group in the cache.
   */
  private updateSingleGroup(group: LogicalGroup): void {
    // Update or add the group
    this.groups.set(group.id, group);
    this.groupsByHash.set(group.hash, group);

    // Update alias mapping
    const aliasGroups = this.groupsByAlias.get(group.alias) || [];
    const existingIndex = aliasGroups.findIndex((g) => g.id === group.id);
    if (existingIndex >= 0) {
      aliasGroups[existingIndex] = group;
    } else {
      aliasGroups.push(group);
    }
    this.groupsByAlias.set(group.alias, aliasGroups);

    // Update session mappings
    this.sessionsByGroup.set(group.id, new Set(group.sids));
  }

  // ============================================================================
  // Session Query APIs
  // ============================================================================

  /**
   * Get all sessions.
   */
  public getAllSessions(): Session[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getAllSessions");
      return [];
    }
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session by session ID.
   */
  public getSession(sid: number): Session | undefined {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getSession");
      return undefined;
    }
    return this.sessions.get(sid);
  }

  /**
   * Get all sessions belonging to a specific group.
   */
  public getSessionsByGroup(groupId: number): Session[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getSessionsByGroup");
      return [];
    }
    const sids = this.sessionsByGroup.get(groupId);
    if (!sids) return [];
    return Array.from(sids)
      .map((sid) => this.sessions.get(sid))
      .filter((s) => s !== undefined) as Session[];
  }

  /**
   * Get all sessions that don't belong to any valid group.
   */
  public getUngroupedSessions(): Session[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getUngroupedSessions");
      return [];
    }
    return Array.from(this.ungroupedSessions)
      .map((sid) => this.sessions.get(sid))
      .filter((s) => s !== undefined) as Session[];
  }

  /**
   * Get all sessions with a specific status.
   */
  public getSessionsByStatus(status: string): Session[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getSessionsByStatus");
      return [];
    }
    return this.getAllSessions().filter((s) => s.status === status);
  }

  /**
   * Get all active sessions (status !== 'stopped').
   */
  public getActiveSessions(): Session[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getActiveSessions");
      return [];
    }
    return this.getAllSessions().filter((s) => s.status !== "stopped");
  }

  /**
   * Get all stopped sessions (status === 'stopped').
   */
  public getStoppedSessions(): Session[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getStoppedSessions");
      return [];
    }
    return this.getSessionsByStatus("stopped");
  }

  // ============================================================================
  // Group Query APIs
  // ============================================================================

  /**
   * Get all logical groups.
   */
  public getAllGroups(): LogicalGroup[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getAllGroups");
      return [];
    }
    return Array.from(this.groups.values());
  }

  /**
   * Get a specific group by group ID.
   */
  public getGroup(groupId: number): LogicalGroup | undefined {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getGroup");
      return undefined;
    }
    return this.groups.get(groupId);
  }

  /**
   * Get a specific group by hash.
   */
  public getGroupByHash(hash: string): LogicalGroup | undefined {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getGroupByHash");
      return undefined;
    }
    return this.groupsByHash.get(hash);
  }

  /**
   * Get all groups with a specific alias.
   * Multiple groups can share the same alias.
   */
  public getGroupsByAlias(alias: string): LogicalGroup[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getGroupsByAlias");
      return [];
    }
    return this.groupsByAlias.get(alias) || [];
  }

  /**
   * Get the logical group that a session belongs to.
   */
  public getGroupForSession(sid: number): LogicalGroup | undefined {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getGroupForSession");
      return undefined;
    }
    const session = this.sessions.get(sid);
    if (!session?.group?.valid) return undefined;
    return this.groups.get(session.group.id);
  }

  /**
   * Get groups by source string (from cache).
   * Must call updateSrcMappings() first to populate the cache.
   */
  public getGroupsBySrc(src: string): LogicalGroup[] {
    if (!this.isInitialized()) {
      this.warnNotInitialized("getGroupsBySrc");
      return [];
    }
    let grpIds = this.srcToGroups.get(src);
    let groups: LogicalGroup[] = [];
    for (const gid of grpIds || []) {
      let grp = this.getGroup(gid);
      if (grp) {
        groups.push(grp);
      }
    }
    return groups;
  }

  // ============================================================================
  // Fresh Fetch APIs (Update cache, then return fresh data)
  // ============================================================================

  /**
   * Fetch all sessions with fresh data from backend.
   * Updates the cache, then returns the fresh data.
   */
  public async fetchAllSessions(): Promise<Session[]> {
    await this.updateSessions();
    return this.getAllSessions();
  }

  public async immediateFetchAllSessions(): Promise<Session[]> {
    await this.immediateUpdateSessions();
    return this.getAllSessions();
  }

  /**
   * Fetch a specific session with fresh data from backend.
   * Updates the cache, then returns the fresh data.
   */
  public async fetchSession(sid: number): Promise<Session | undefined> {
    await this.updateSessions();
    return this.getSession(sid);
  }

  public async immediateFetchSession(sid: number): Promise<Session | undefined> {
    await this.immediateUpdateSessions();
    return this.getSession(sid);
  }

  /**
   * Fetch all groups with fresh data from backend.
   * Updates the cache, then returns the fresh data.
   */
  public async fetchAllGroups(): Promise<LogicalGroup[]> {
    await this.updateGroups();
    return this.getAllGroups();
  }

  public async immediateFetchAllGroups(): Promise<LogicalGroup[]> {
    await this.immediateUpdateGroups();
    return this.getAllGroups();
  }

  /**
   * Fetch a specific group with fresh data from backend.
   * Updates the cache, then returns the fresh data.
   */
  public async fetchGroup(groupId: number): Promise<LogicalGroup | undefined> {
    await this.updateGroup(groupId);
    return this.getGroup(groupId);
  }

  public async immediateFetchGroup(groupId: number): Promise<LogicalGroup | undefined> {
    await this.immediateUpdateGroup(groupId);
    return this.getGroup(groupId);
  }

  /**
   * Fetch all data (sessions and groups) with fresh data from backend.
   * Updates the cache, then returns both sessions and groups.
   */
  public async fetchAll(): Promise<{
    sessions: Session[];
    groups: LogicalGroup[];
  }> {
    await this.updateAll();
    return {
      sessions: this.getAllSessions(),
      groups: this.getAllGroups(),
    };
  }

  public async immediateFetchAll(): Promise<{
    sessions: Session[];
    groups: LogicalGroup[];
  }> {
    await this.immediateUpdateAll();
    return {
      sessions: this.getAllSessions(),
      groups: this.getAllGroups(),
    };
  }

  /**
   * Fetch sessions for a specific group with fresh data from backend.
   * Updates the specific group, then returns sessions belonging to it.
   */
  public async fetchSessionsByGroup(groupId: number): Promise<Session[]> {
    await this.updateGroup(groupId);
    return this.getSessionsByGroup(groupId);
  }

  public async immediateFetchSessionsByGroup(groupId: number): Promise<Session[]> {
    await this.immediateUpdateGroup(groupId);
    return this.getSessionsByGroup(groupId);
  }

  /**
   * Fetch groups by source with fresh data from backend.
   * Updates the src mappings, then returns the groups.
   */
  public async fetchGroupsBySrc(src: string): Promise<LogicalGroup[]> {
    await this.updateSrcMappings(src);
    return this.getGroupsBySrc(src);
  }

  // Just an alias to fetchGroupsBySrc.
  public async immediateFetchGroupsBySrc(src: string): Promise<LogicalGroup[]> {
    return this.fetchGroupsBySrc(src);
  }

  // ============================================================================
  // Utility and Helper Methods
  // ============================================================================

  /**
   * Check if a session belongs to a specific group.
   */
  public isSessionInGroup(sid: number, groupId: number): boolean {
    const sids = this.sessionsByGroup.get(groupId);
    return sids?.has(sid) ?? false;
  }

  /**
   * Check if the SessionManager has any data loaded.
   */
  public hasData(): boolean {
    return this.sessions.size > 0 || this.groups.size > 0;
  }

  /**
   * Get the timestamp of the last successful update.
   */
  public getLastUpdateTime(): number | null {
    return this.lastUpdateTime;
  }

  /**
   * Get the total number of sessions.
   */
  public getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get the total number of groups.
   */
  public getGroupCount(): number {
    return this.groups.size;
  }

  /**
   * Check if the SessionManager has been initialized (first fetch completed).
   * @returns true if initialized (data has been fetched at least once), false otherwise
   */
  private isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Show a warning message when SessionManager is accessed before initialization.
   */
  private warnNotInitialized(methodName: string): void {
    const message = `SessionManager.${methodName}() called before initialization. Start a debug session first.`;
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
   * Will not start polling if WebSocket is active.
   *
   * @param intervalMs Optional custom interval in milliseconds (default: 5000)
   */
  public startAutoRefresh(intervalMs?: number): void {
    this.stopAutoRefresh();

    // Don't start polling if WebSocket is handling updates
    if (this.wsActive) {
      console.debug(
        "[SessionManager] WebSocket active, skipping auto-refresh polling"
      );
      return;
    }

    // Read from VSCode config if not provided
    let interval = intervalMs;
    if (!interval && vscode) {
      const config = vscode.workspace.getConfiguration("ddb");
      interval = config.get(
        "sessionManager.autoRefreshMs",
        this.AUTO_REFRESH_MS
      );
    } else {
      interval = intervalMs || this.AUTO_REFRESH_MS;
    }

    console.debug(
      `[SessionManager] Starting auto-refresh with ${interval}ms interval`
    );
    this.refreshInterval = setInterval(() => {
      console.debug("[SessionManager] Auto-refresh triggered");
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
   * Set whether WebSocket notifications are active.
   * When WebSocket is active, auto-refresh polling is disabled.
   * When WebSocket is inactive, auto-refresh polling can resume.
   *
   * @param active - true if WebSocket is connected and handling updates
   */
  public setWebSocketActive(active: boolean): void {
    this.wsActive = active;
    console.log(`[SessionManager] WebSocket active: ${active}`);
  }

  /**
   * Clear all cached data.
   * Useful when debug session ends and data is no longer valid.
   */
  public clearCache(): void {
    this.sessions.clear();
    this.groups.clear();
    this.groupsByHash.clear();
    this.groupsByAlias.clear();
    this.sessionsByGroup.clear();
    this.ungroupedSessions.clear();
    this.srcToGroups.clear();
    this.lastUpdateTime = null;
    this.initialized = false;
    // Notify listeners so UI can update to empty state
    this.notifyListeners();
  }

  /**
   * Dispose of all resources and clear all data.
   * Should be called when the SessionManager is no longer needed.
   */
  public dispose(): void {
    this.stopAutoRefresh();
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }
    this.updateListeners.clear();
    this.sessions.clear();
    this.groups.clear();
    this.groupsByHash.clear();
    this.groupsByAlias.clear();
    this.sessionsByGroup.clear();
    this.ungroupedSessions.clear();
    this.srcToGroups.clear();
    this.pendingUpdates.clear();
  }
}
