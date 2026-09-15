# Changelog

## 0.0.11

- Support DDB 0.1.15 startup ordering and commands with silent MI completions.
- Repair distributed thread enumeration and breakpoint target decoding.
- Propagate backend failures through DAP, including breakpoint and signal requests.
- Honor launch environment/cwd and the configured service URL.
- Fix expression quoting, register/assignment targeting and WebSocket welcome handling.
- Add mock and real GDB integration coverage. See the migration notes in `docs/`.
