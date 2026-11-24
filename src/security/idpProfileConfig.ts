/**
 * Issue #5160 — IDP profile config: shipped defaults + runtime overrides.
 *
 * The attribute set and retention are configurable, externalized,
 * and manageable through UX (admin-gated, audited, fail-closed)
 * per the standing directives. Shipped defaults live in
 * `config/idp-profile.json` (DEFAULT_IDP_PROFILE_CONFIG); runtime
 * values live in the operator-config store (mas_settings
 * SettingsPort) under `idp_profile.attribute_set` (JSON) and
 * `idp_profile.retention_days` (integer days). Default is
 * store-all per the owner directive (2026-11-17).
 *
 * Fail-closed: an invalid runtime value is ignored and the
 * previous (or default) value stands — an operator typo can never
 * silently stop attribute storage or delete profiles. Validation
 * never throws.
 */
import type { SettingsPort } from "../data/settingsReadPorts";
import {
  DEFAULT_IDP_PROFILE_CONFIG,
  type IdpProfileConfigShape,
} from "../config/idpProfile";

export type IdpProfileConfig = IdpProfileConfigShape;
export { DEFAULT_IDP_PROFILE_CONFIG };

export const IDP_PROFILE_ATTRIBUTE_SET_KEY = "idp_profile.attribute_set";
export const IDP_PROFILE_RETENTION_DAYS_KEY = "idp_profile.retention_days";

export type IdpProfileConfigValidation =
  | { ok: true; value: IdpProfileConfig }
  | { ok: false; reason: string };

/** Structural validation of a config value (never throws). */
export function validateIdpProfileConfig(value: unknown): IdpProfileConfigValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not-object" };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.storeAll !== "boolean") return { ok: false, reason: "storeAll" };
  if (
    !Array.isArray(v.excludedAttributes) ||
    !v.excludedAttributes.every((s) => typeof s === "string")
  ) {
    return { ok: false, reason: "excludedAttributes" };
  }
  if (
    typeof v.retentionDays !== "number" ||
    !Number.isInteger(v.retentionDays) ||
    v.retentionDays < 0
  ) {
    return { ok: false, reason: "retentionDays" };
  }
  return {
    ok: true,
    value: {
      storeAll: v.storeAll,
      excludedAttributes: [...(v.excludedAttributes as string[])],
      retentionDays: v.retentionDays,
    },
  };
}

/**
 * Load the effective config: shipped defaults, then the runtime
 * overrides from mas_settings. Each key is validated
 * independently — an invalid key falls back to its default and
 * never poisons the other key.
 */
export function loadIdpProfileConfig(settings: SettingsPort | null): IdpProfileConfig {
  const base = DEFAULT_IDP_PROFILE_CONFIG;
  if (!settings) return { ...base, excludedAttributes: [...base.excludedAttributes] };
  let storeAll = base.storeAll;
  let excludedAttributes = [...base.excludedAttributes];
  let retentionDays = base.retentionDays;
  try {
    const rawSet = settings.get(IDP_PROFILE_ATTRIBUTE_SET_KEY);
    if (rawSet !== null) {
      const parsed: unknown = JSON.parse(rawSet);
      const checked = validateIdpProfileConfig({
        storeAll:
          typeof (parsed as Record<string, unknown>)?.storeAll === "boolean"
            ? (parsed as Record<string, unknown>).storeAll
            : base.storeAll,
        excludedAttributes:
          (parsed as Record<string, unknown>)?.excludedAttributes ?? base.excludedAttributes,
        retentionDays: base.retentionDays,
      });
      if (checked.ok) {
        storeAll = checked.value.storeAll;
        excludedAttributes = checked.value.excludedAttributes;
      }
    }
  } catch {
    // Unparsable attribute set: keep the default (fail closed).
  }
  try {
    const rawDays = settings.get(IDP_PROFILE_RETENTION_DAYS_KEY);
    if (rawDays !== null) {
      const days = Number(rawDays);
      if (Number.isInteger(days) && days >= 0) retentionDays = days;
    }
  } catch {
    // Invalid retention: keep the default (fail closed).
  }
  return { storeAll, excludedAttributes, retentionDays };
}
