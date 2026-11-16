# Tenant Isolation — Future Dimensions Decision & Design (#4620)

Parent: `#2856` | Issue: `#4620` | Depends on: `#4615` (uniform provenance tuple), `#4619` (per-tenant observability view).

This document records the architecture decisions and implementation designs for the four future isolation dimensions identified in [`platform-entity-capability-map.md`](platform-entity-capability-map.md) §6. Implementation builds follow as separate scoped issues.

---

## 1. Data Residency

- **Decision:** Model residency as a tenant-level policy attribute (`residencyRegion`: `"us" | "eu" | "global"`, default `"us"`) stored in `agent_tenant_settings` and resolved at Worker / Durable Object / R2 / D1 entry boundaries via `resolveTenantResidency(env)`.
- **Design:**
  - Storage routing: R2 object keys and DO namespace jurisdiction hints (`locationHint` / regional bucket binding map) are selected from the tenant's `residencyRegion` before any write.
  - Cross-region refusal: If a request's Worker jurisdiction or configured storage binding cannot satisfy the tenant's `residencyRegion`, fail closed with `403 FAILURE_RESIDENCY_VIOLATION` and emit a `"denial"` audit record carrying the 5-leg `ProvenanceTuple` (`#4615`).
  - No cross-tenant sharing: Regional buckets and DO instances remain keyed by `tenantId`.

---

## 2. Retention & Per-Tenant Purge

- **Decision:** Enforce per-tenant retention policies (`retentionClass` + `retentionDays`) and a single deterministic `purgeTenantData(tenantId)` orchestration seam covering DO SQLite, D1, R2, and KV caches, while preserving immutable financial/audit hash chains as tombstoned/redacted records where legally required.
- **Design:**
  - Every tenant-owned table (`mas_data_captures`, `mas_reports`, `agent_tenant_settings`, `tenant_creds`) carries `tenant_id` (or `user_login` mapped to `tenantId`) and `retention_class` (`ephemeral`, `retained-30d`, `retained-365d`, `permanent-audit`).
  - Scheduled purge sweep reads expired rows per tenant, deletes R2 objects (`reports/`, capture blobs), deletes KV keys (`tenant_creds:v1:<tenantId>:*`, token cache via `invalidateTokenCacheFor`), and records a `"run"` audit event summarizing purged counts per store.
  - Offboarding purge (`purgeTenantData(tenantId)`) executes all store deletions idempotently and returns a per-store receipt.

---

## 3. Cost Attribution

- **Decision:** Shift the spend/usage ledger of record from login/tier-only attribution to mandatory `(tenantId, userId, providerId, channel)` cost attribution, so multi-user tenants roll up compute, LLM, data-provider, and payment fees accurately per tenant.
- **Design:**
  - Extend usage/spend ledger entries (`usage_events` / billing ledger) with required `tenantId` alongside `userId`, `providerId`, `operationKind`, and `costMicros`.
  - Reuse `#4615`'s `ProvenanceTuple` at metering emission sites so every metered run, delivery, or provider fetch stamps `tenantId` + `providerId` without a post-hoc join.
  - Expose `summarizeTenantSpend(tenantId, window)` for tenant-admin billing and quota enforcement.

---

## 4. Cross-Tenant Incident Response

- **Decision:** Build incident blast-radius queries and containment actions directly on top of `#4615`'s 5-leg `ProvenanceTuple` (`tenantId`, `userId`, `providerId`, `brokerId`, `channel`) and `#4619`'s `buildTenantObservabilityView`.
- **Design:**
  - **Trace & Blast Radius:** Given any incident key (`providerId`, `brokerId`, `channel`, `runId`, or `timeWindow`), query the audit projection and group affected records by `tenantId` using `readProvenanceTuple()` — zero manual joins required.
  - **Containment Playbook:**
    1. Isolate affected tenant/provider via per-tenant credential revocation (`deleteCredential(tenantId, kind, id)` from `#4614`) and token cache eviction (`invalidateTokenCacheFor(userLogin, tenantId)` from `#4618`).
    2. Emit a `"denial"` / `"fallback"` audit record per affected tenant.
    3. Export per-tenant incident timeline via `buildTenantObservabilityView(auditReader, tenantId)` (`#4619`).
