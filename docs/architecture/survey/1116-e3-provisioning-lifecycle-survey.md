# E3 survey — provisioning lifecycle API (main @ ba627ad0, 2026-10-23)

## Store layer already exists (P1/E2)
providerConfigStore.ts: tables mas_data_providers + mas_data_provider_routes; lifecycle
registered|configured|verified|enabled|disabled|deprovisioned; upsertProviderConfig,
getProviderConfig, listProviderConfigs, setProviderLifecycleState, setProviderEnabled,
route CRUD, seeds, bootstrapDataProviders (E2: seed + enable etrade only).
MISSING for E3: legal-transition validation, verify step, audit emission, HTTP API.

## HTTP surface pattern
src/agents/routes/*.ts modules export handle<Name>Routes(request, url, path, sessionId, ctx),
imported + invoked in OrchestratorAgent.routeRequest's sequential matching sequence
(audit at orchestrator.ts:1767, schedules at :2021). Mutations must be session-gated with
the SAME mechanism #1156 (de6f4ef1) applied to /api/schedule/* — find and reuse it.

## Audit pattern
Single owner: recordAudit() seam (issue #270); read/write routes in routes/audit.ts
(GET/POST /api/audit). Lifecycle transitions audit through recordAudit, not a new table.

## HARD CONSTRAINT — orchestrator.ts size gate (#992)
orchestrator.ts is 94,394 B after E2 vs BUDGET_BYTES 94,400 (BUDGET_LINES 2075, used 2050).
A new import + dispatch block (~400-700 B) BUSTS the gate. E3 must keep orchestrator.ts
within budget — the in-pattern remedy is extracting an existing dispatch block's context
construction into its routes module (#992 pattern), NOT raising the budget.

## Verify material
etrade adapter getStatus exists (ETradeService). Conformance kit: dataProviders/conformance.ts
(P1). Servability rule (registry.resolveRoute): config enabled + flag + adapter registered +
capability declared. Config-layer provider ids are strings; the contract union governs
adapters — a config for an adapter-less id can be registered/configured but never servable.
