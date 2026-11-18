/**
 * Issue #5039 — Single source of truth for the deployment-default tenant.
 *
 * Replaces the diverging default-tenant literals across IAAA
 * (`"primary"`), provider captures (`"default"`), report seeding
 * (`"primary"`), chain-schedule reconciliation (`"primary"`), and
 * workflow-runs fallback (`"primary"`).
 *
 * Single-tenant / first-tenant deployments resolve to
 * `DEPLOYMENT_DEFAULT_TENANT_ID` (`"primary"`) unless overridden by
 * `env.IAAA_TENANT_ID` via `resolveIaaaTenant(env)`.
 *
 * Third-tenant migration consequence:
 * - All IAAA, telemetry, schedule-reconciliation, workflow-runs, and
 *   canonical-report paths already stamp `"primary"`.
 * - Unifying provider captures (`providerCapturePorts.resolveRunContext`,
 *   `providerCapturePorts.resolveCaptureUserLogin`, and
 *   `routes/dataProviders.CAPTURE_TENANT_ID`) from `"default"` onto
 *   `DEPLOYMENT_DEFAULT_TENANT_ID` (`"primary"`) means any historical
 *   pre-change rows in `agent_data_captures` / `provider_captures`
 *   carrying `tenant_id = 'default'` require a one-time backfill
 *   (`UPDATE ... SET tenant_id = 'primary' WHERE tenant_id = 'default'`)
 *   if pre-change captures are queried under `"primary"`.
 * - Adding a second or third tenant later requires NO migration of
 *   `"primary"` rows, provided every additional tenant supplies an
 *   explicit `tenantId` (from `IAAA_TENANT_ID` or authenticated tenant
 *   context) and never falls back to `DEPLOYMENT_DEFAULT_TENANT_ID`.
 */
export const DEPLOYMENT_DEFAULT_TENANT_ID = "primary";

/** Default workspace scope paired with `DEPLOYMENT_DEFAULT_TENANT_ID`. */
export const DEPLOYMENT_DEFAULT_WORKSPACE_ID = DEPLOYMENT_DEFAULT_TENANT_ID;
