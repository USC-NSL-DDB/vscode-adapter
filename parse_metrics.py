#!/usr/bin/env python3
"""
Parse DDB telemetry JSONL data and compute per-session metrics.

Session definition: A debug session is bounded by the ddb-da service's
OTel initialization message and the ddb-ext's debug_session_stopped message,
grouped by user.id. Events from both ddb-da and ddb-ext with the same user.id
within a time window belong to the same debug session.

Usage:
    python3 parse_metrics.py <jsonl_file>
    python3 parse_metrics.py data_exported_2026-02-10_000152.jsonl
"""

import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class DebugSession:
    user_id: str
    da_session_id: str = ""
    ext_session_id: str = ""
    start_ts: int = 0  # nanoseconds
    end_ts: int = 0
    events: list = field(default_factory=list)

    # Counters
    step_count: int = 0  # step_over + step_in + step_out
    breakpoint_ops: int = 0  # set_breakpoints
    frame_switches: int = 0  # select_frame
    dbt_frame_switches: int = 0  # select_frame with after_boundary=true
    pause_count: int = 0
    continue_count: int = 0
    jump_count: int = 0  # reverse_continue, step_back
    signal_count: int = 0  # (none found in data, placeholder)
    variable_examinations: int = 0  # expand_variable + evaluate
    unique_sessions_viewed: set = field(default_factory=set)  # session= values in select_frame

    # Time tracking for stepping operations
    step_start_times: list = field(default_factory=list)
    step_durations: list = field(default_factory=list)

    # Time tracking for pausing
    pause_start_times: list = field(default_factory=list)
    pause_durations: list = field(default_factory=list)

    # State machine
    _in_stepping: bool = False
    _last_step_ts: int = 0
    _is_paused: bool = False
    _last_pause_ts: int = 0

    @property
    def duration_seconds(self) -> float:
        if self.start_ts and self.end_ts:
            return (self.end_ts - self.start_ts) / 1e9
        return 0.0

    @property
    def total_stepping_time_seconds(self) -> float:
        return sum(self.step_durations) / 1e9

    @property
    def total_pause_time_seconds(self) -> float:
        return sum(self.pause_durations) / 1e9


def parse_activity(body: str) -> tuple[str, dict]:
    """Parse [activity] log lines into (action, params)."""
    m = re.match(r"\[activity\]\s+(\S+)\s*(.*)", body)
    if not m:
        return ("", {})
    action = m.group(1)
    params_str = m.group(2)
    params = {}
    for kv in re.findall(r"(\w+)=(\S+)", params_str):
        params[kv[0]] = kv[1]
    return action, params


def build_debug_sessions(events: list) -> list[DebugSession]:
    """
    Group events into debug sessions using non-overlapping intervals.

    Each ddb-da OTel init starts a session. It ends at the earliest of:
    (a) the next ddb-da init for the same user, or
    (b) the next ddb-ext debug_session_stopped for the same user.
    """
    user_events = defaultdict(list)
    for ev in events:
        uid = ev["resources_string"].get("user.id", "")
        if uid:
            user_events[uid].append(ev)

    sessions = []

    for uid, evs in user_events.items():
        evs.sort(key=lambda e: e["timestamp"])

        da_inits = []
        stop_events = []
        for ev in evs:
            body = ev["body"]
            svc = ev["resources_string"].get("service.name", "")
            if svc == "ddb-da" and body.startswith("[OTel] Debugger Adapter initialized"):
                da_inits.append(ev)
            elif svc == "ddb-ext" and body == "[activity] debug_session_stopped":
                stop_events.append(ev)
            elif svc == "ddb" and body == "API server stopped":
                stop_events.append(ev)

        stop_events.sort(key=lambda e: e["timestamp"])

        stop_idx = 0
        for i, init_ev in enumerate(da_inits):
            init_ts = init_ev["timestamp"]
            da_sid = init_ev["resources_string"].get("session.id", "")

            next_init_ts = da_inits[i + 1]["timestamp"] if i + 1 < len(da_inits) else float("inf")
            next_stop_ts = float("inf")
            while stop_idx < len(stop_events):
                if stop_events[stop_idx]["timestamp"] > init_ts:
                    next_stop_ts = stop_events[stop_idx]["timestamp"]
                    break
                stop_idx += 1

            end_candidate = min(next_init_ts, next_stop_ts)
            if next_stop_ts <= next_init_ts and next_stop_ts != float("inf"):
                stop_idx += 1

            end_ts = int(end_candidate) if end_candidate != float("inf") else evs[-1]["timestamp"]

            session = DebugSession(user_id=uid, da_session_id=da_sid, start_ts=init_ts, end_ts=end_ts)

            for ev in evs:
                if init_ts <= ev["timestamp"] <= end_ts:
                    session.events.append(ev)

            sessions.append(session)

    return sessions


def process_session(session: DebugSession):
    """Process events within a session to compute all counters."""
    # Sort events chronologically
    session.events.sort(key=lambda e: e["timestamp"])

    for ev in session.events:
        body = ev["body"]
        svc = ev["resources_string"].get("service.name", "")
        ts = ev["timestamp"]
        action, params = parse_activity(body)

        if not action:
            continue

        # Track debuggee sessions from any event carrying session=
        sess_num = params.get("session", "")
        if sess_num and sess_num != "undefined":
            session.unique_sessions_viewed.add(sess_num)

        # Step operations (from ddb-da)
        if action in ("step_over", "step_in", "step_out"):
            session.step_count += 1
            if not session._in_stepping:
                session._in_stepping = True
                session._last_step_ts = ts

        # Stop events end a stepping operation
        if action == "stop" and svc == "ddb-da":
            reason = params.get("reason", "")
            # Stepping stops
            if reason in ("end-stepping-range", "function-finished") and session._in_stepping:
                session.step_durations.append(ts - session._last_step_ts)
                session._in_stepping = False

            # All stops are effectively a pause start
            if not session._is_paused:
                session._is_paused = True
                session._last_pause_ts = ts

        # Continue/step resume ends a pause
        if action == "continue" and svc == "ddb-da":
            if session._is_paused:
                session.pause_durations.append(ts - session._last_pause_ts)
                session._is_paused = False
            session.continue_count += 1

        if action in ("step_over", "step_in", "step_out") and session._is_paused:
            session.pause_durations.append(ts - session._last_pause_ts)
            session._is_paused = False

        # Breakpoint operations
        if action == "set_breakpoints":
            session.breakpoint_ops += 1

        if action == "select_frame":
            session.frame_switches += 1
            after_boundary = params.get("after_boundary", "false")
            if after_boundary == "true":
                session.dbt_frame_switches += 1

        # Pause
        if action == "pause":
            session.pause_count += 1

        # Jumps (reverse_continue, step_back)
        if action in ("reverse_continue", "step_back"):
            session.jump_count += 1

        # Variable examination
        if action == "expand_variable":
            session.variable_examinations += 1
        if action == "evaluate":
            session.variable_examinations += 1


def safe_avg(values: list, default=0.0) -> float:
    if not values:
        return default
    return sum(values) / len(values)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <jsonl_file>")
        sys.exit(1)

    filepath = sys.argv[1]

    # Load all events
    events = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))

    print(f"Loaded {len(events)} events")

    # Build debug sessions
    sessions = build_debug_sessions(events)
    print(f"Found {len(sessions)} debug sessions across {len(set(s.user_id for s in sessions))} users")

    # Process each session
    for s in sessions:
        process_session(s)

    # Filter out empty sessions (no activity events at all)
    active_sessions = [s for s in sessions if s.step_count > 0 or s.breakpoint_ops > 0 or s.frame_switches > 0]
    print(f"Active sessions (with at least one activity): {len(active_sessions)}")
    print()

    if not active_sessions:
        print("No active sessions found.")
        return

    n = len(active_sessions)

    # Flag duration outliers (sessions > 24h likely have missing stop events)
    MAX_REASONABLE_DURATION_NS = 24 * 3600 * 1e9
    outlier_count = sum(1 for s in active_sessions if (s.end_ts - s.start_ts) > MAX_REASONABLE_DURATION_NS)
    if outlier_count > 0:
        print(f"WARNING: {outlier_count} session(s) exceed 24h duration (likely missing stop events)")
        print(f"  Metrics 7-9 exclude these outliers for accuracy\n")
    time_filtered = [s for s in active_sessions if (s.end_ts - s.start_ts) <= MAX_REASONABLE_DURATION_NS]

    # 1. Average number of steps per session
    avg_steps = safe_avg([s.step_count for s in active_sessions])
    print(f"1. Average number of steps per session:                {avg_steps:.2f}")

    # 2. Average number of breakpoint operations per session
    avg_bp_ops = safe_avg([s.breakpoint_ops for s in active_sessions])
    print(f"2. Average number of breakpoint operations per session:{avg_bp_ops:.2f}")

    # 3. Average number of frame switching per session
    avg_frame_sw = safe_avg([s.frame_switches for s in active_sessions])
    print(f"3. Average number of frame switches per session:       {avg_frame_sw:.2f}")

    # 4. Average number of dbt frame switching per session
    avg_dbt_frame = safe_avg([s.dbt_frame_switches for s in active_sessions])
    print(f"4. Average number of dbt frame switches per session:   {avg_dbt_frame:.2f}")

    # 5. Average time on stepping operations (start stepping to continue)
    all_step_durations = []
    for s in active_sessions:
        all_step_durations.extend(s.step_durations)
    avg_step_time = safe_avg(all_step_durations) / 1e9 if all_step_durations else 0.0
    total_step_time = sum(all_step_durations) / 1e9 if all_step_durations else 0.0
    print(f"5. Average time per stepping operation:                {avg_step_time:.2f}s ({len(all_step_durations)} operations, total {total_step_time:.2f}s)")

    # 6. Percentage of sessions which view more than 1 session (unified view)
    multi_session_count = sum(1 for s in active_sessions if len(s.unique_sessions_viewed) > 1)
    pct_multi = (multi_session_count / n) * 100
    print(f"6. Pct of sessions viewing >1 debuggee sessions:      {pct_multi:.1f}% ({multi_session_count}/{n})")

    # 7. Average time per session (excluding outliers)
    avg_duration = safe_avg([s.duration_seconds for s in time_filtered])
    print(f"7. Average time per session:                           {avg_duration:.2f}s ({avg_duration/60:.1f}min)")

    # 8. Average time of pausing per session (excluding outliers)
    avg_pause_time = safe_avg([s.total_pause_time_seconds for s in time_filtered])
    print(f"8. Average pause time per session:                     {avg_pause_time:.2f}s ({avg_pause_time/60:.1f}min)")

    # 9. Percentage of paused time over total time aggregated over all sessions (excluding outliers)
    total_pause_all = sum(s.total_pause_time_seconds for s in time_filtered)
    total_time_all = sum(s.duration_seconds for s in time_filtered)
    pct_pause = (total_pause_all / total_time_all) * 100 if total_time_all > 0 else 0.0
    print(f"9. Pct of paused time over total time (aggregated):    {pct_pause:.1f}% ({total_pause_all:.1f}s / {total_time_all:.1f}s)")

    # 10. Average number of jumps per session
    avg_jumps = safe_avg([s.jump_count for s in active_sessions])
    print(f"10. Average number of jumps per session:               {avg_jumps:.2f}")

    # 11. Average number of signaling (including KILL) per session
    avg_signals = safe_avg([s.signal_count for s in active_sessions])
    print(f"11. Average number of signals per session:             {avg_signals:.2f}")

    # 12. Average number of variable examination per session
    avg_var_exam = safe_avg([s.variable_examinations for s in active_sessions])
    print(f"12. Average number of variable examinations per session:{avg_var_exam:.2f}")

    # Summary table
    w = 175
    print("\n" + "=" * w)
    print("PER-SESSION BREAKDOWN")
    print("=" * w)
    print(f"{'#':<4} {'Session ID':<38} {'User ID':<38} {'Dur':>8} {'Steps':>6} {'BpOps':>6} {'Frames':>6} {'DbtFr':>5} {'Vars':>5} {'Paused':>8} {'Debuggees':>12}")
    print("-" * w)
    for i, s in enumerate(active_sessions):
        dur = f"{s.duration_seconds:.0f}s"
        pause = f"{s.total_pause_time_seconds:.0f}s"
        sess_viewed = ",".join(sorted(s.unique_sessions_viewed)) if s.unique_sessions_viewed else "-"
        print(f"{i+1:<4} {s.da_session_id:<38} {s.user_id:<38} {dur:>8} {s.step_count:>6} {s.breakpoint_ops:>6} {s.frame_switches:>6} {s.dbt_frame_switches:>5} {s.variable_examinations:>5} {pause:>8} {sess_viewed:>12}")


if __name__ == "__main__":
    main()
