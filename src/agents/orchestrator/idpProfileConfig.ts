/**
 * Issue #5160 — the IDP profile config's orchestrator-side
 * execution, extracted from OrchestratorAgent following the #992
 * decomposition pattern (thin delegating wrapper on the class,
 * execution here). This keeps orchestrator.ts within its standing
 * size budget.
 *
 * This function must run on the Orchestrator instance's storage:
 * the runtime config values live in that instance's mas_settings
 * (SettingsPort) under `idp_profile.attribute_set` (JSON) and
 * `idp_profile.retention_days` (integer days). The worker-side
 * sign-in path has no SettingsPort, so the admin config surface
 * reaches the values through these RPC methods on the shared
 * orchestrator stub — the same precedent as seedGovernanceHalt.
 * Shipped defaults live in config/idp-profile.json and are the
 * fallback whenever no runtime value is set or a stored value is
 * invalid (fail closed: an operator typo can never silently stop
 * attribute storage or delete profiles).
 */
import { createOrmPorts } from "../../data/createOrmPorts";
import {
  IDP_PROFILE_ATTRIBUTE_SET_KEY,
  IDP_PROFILE_RETENTION_DAYS_KEY,
  loadIdpProfileConfig,
  validateIdpProfileConfig,
  type IdpProfileConfig,
} from "../../security/idpProfileConfig";

export interface IdpProfileConfigContext {
  sql: Parameters<typeof createOrmPorts>[0];
}

/** Read the effective IDP profile config (runtime overrides over shipped defaults). */
export function runGetIdpProfileConfig(ctx: IdpProfileConfigContext): IdpProfileConfig {
  const settings = createOrmPorts(ctx.sql).settings;
  settings.ensureSchema();
  return loadIdpProfileConfig(settings);
}

/**
 * Write the IDP profile config (platform-admin only — the caller
 * enforces the gate). Re-validates before writing: an invalid value
 * is refused with an Error, never stored. Returns the effective
 * config after the write.
 */
export function runSetIdpProfileConfig(
  ctx: IdpProfileConfigContext,
  value: unknown,
): IdpProfileConfig {
  const checked = validateIdpProfileConfig(value);
  if (!checked.ok) {
    throw new Error(`Invalid IDP profile config: ${checked.reason}`);
  }
  const settings = createOrmPorts(ctx.sql).settings;
  settings.ensureSchema();
  settings.set(
    IDP_PROFILE_ATTRIBUTE_SET_KEY,
    JSON.stringify({
      storeAll: checked.value.storeAll,
      excludedAttributes: checked.value.excludedAttributes,
    }),
  );
  settings.set(IDP_PROFILE_RETENTION_DAYS_KEY, String(checked.value.retentionDays));
  return loadIdpProfileConfig(settings);
}
