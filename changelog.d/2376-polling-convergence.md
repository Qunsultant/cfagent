### Client

- **Converge live-update polling onto the shared contract (#2376 slice 1):** Goal Screen saga status, journey gates, staged-run tracking, Ask Agent gates, and Checkout payment status now poll through the shared `startPolling` / `usePolling` scheduler (new `immediate` knob: run once at subscribe, then follow the cadence). Intervals, data shapes, and stop semantics are unchanged; polling stays the reconnect fallback. WebSocket push and webhook subscriptions are later slices and are not in this change.
