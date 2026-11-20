### Changed

- **Operator-list degrade is loud; audit pagination default externalized (#5611):** when the store operator read fails, the commercial handler now emits a structured log (`agenticPayments.store_operator_read_failed`) and an audit record (`payments.store_operator_read_failed` on the payments funnel) instead of degrading silently — the degrade itself is unchanged (env-only, no lockout, no 500). The audit list default (`GET /api/audit`, 50) now reads from `COMMERCIAL_DEFAULTS.auditDefaultLimit` (`config/commercial-defaults.json`); the value is unchanged.
