### Observability

- **#3515 S5: SLI/SLO definitions + monitoring (#5425)** — the two #3515 SLOs (uptime, P95 API latency) are defined as metric + config threshold on the S2 metrics model: gauges `slo.api.uptime` / `slo.api.p95_latency` on the one recorder, thresholds externalized as tenant-scoped config (migration 0079) manageable through the tenant admin panel, compliance reported on the observability surface (new "SLOs" view, GET /api/otel/v1/slo). Unconfigured SLOs report "unconfigured" and claim no compliance.
