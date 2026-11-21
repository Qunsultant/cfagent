/**
 * Issue #4782 S3 — the pipeline-policy settings (`pipeline.*`
 * globals) as a per-tenant settings family, extracted from
 * OrchestratorAgent the way the report-dispatch HITL setting is:
 * the class keeps state/lifecycle ownership and composes these
 * functions through its reportDispatchContext; each function
 * receives its dependencies explicitly via ReportDispatchContext.
 *
 * The values live in mas_settings (per-tenant by construction —
 * the orchestrator reads its own instance's table), which is the
 * same store the resolver reads through `readSettingRaw`. A
 * stored value beats env; an absent key stays env-only.
 * Writes are validated by name (see validatePipelinePolicySetting)
 * — refused, never clamped — and a batch with one bad entry
 * writes nothing.
 */
import {
  PIPELINE_POLICY_DEFAULTS,
  PIPELINE_POLICY_SETTING_KEYS,
  validatePipelinePolicySetting,
} from "../../services/pipelinePolicy";
import { readSettingRaw, writeSetting, type ReportDispatchContext } from "./reportDispatch";

/** The stored `pipeline.*` values (only keys the operator set). */
export function getPipelinePolicySettings(
  ctx: ReportDispatchContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PIPELINE_POLICY_SETTING_KEYS) {
    const value = readSettingRaw(ctx, key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * Validate + write a batch of settings. Returns the first error
 * (naming the key) without writing anything, or null on success.
 * Callers surface the error as a 400; the atomicity is the point —
 * a half-written batch would leave the operator's intent unclear.
 */
export function setPipelinePolicySettings(
  ctx: ReportDispatchContext,
  settings: Record<string, unknown>,
): string | null {
  const entries = Object.entries(settings);
  for (const [key, value] of entries) {
    const error = validatePipelinePolicySetting(key, String(value));
    if (error) return error;
  }
  for (const [key, value] of entries) {
    writeSetting(ctx, key, String(value).trim());
  }
  return null;
}

/** The resolver's defaults as stored-setting strings (see the resolver). */
export function pipelinePolicyDefaults(): Record<string, string> {
  return { ...PIPELINE_POLICY_DEFAULTS };
}
