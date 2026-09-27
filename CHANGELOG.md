# Changelog

## Unreleased

- Use the typed DDB API v2 SDK for launch, inspection, execution and breakpoints.
- Add managed backend startup and attachment to an existing authenticated server.
- Preserve concurrent breakpoint hits and navigate to their paused call-stack frames.
- Simplify breakpoint labels, use native breakpoint colors and add source actions.
- Keep missing-source and inspection errors inline; preserve session-specific controls.
- Clear execution annotations on resume, thread exit and replacement stops.
- Cover transport recovery, real GDB sessions and packaged VS Code behavior.

## 0.0.11

- Support DDB 0.1.15 startup ordering and commands with silent MI completions.
- Repair distributed thread enumeration and breakpoint target decoding.
- Propagate backend failures through DAP, including breakpoint and signal requests.
- Honor launch environment/cwd and the configured service URL.
- Fix expression quoting, register/assignment targeting and WebSocket welcome handling.
- Add mock and real GDB integration coverage. See the migration notes in `docs/`.
