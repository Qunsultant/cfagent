/**
 * Issue #4782 S3 — the pipeline-policy settings API
 * (GET/POST /api/trading/settings/pipeline-policy).
 *
 * The `pipeline.*` globals are per-tenant settings in mas_settings;
 * this module is the panel's only read/write path — no localStorage,
 * no second copy of the values. The server validates writes by name
 * (unknown key / out-of-range → 400 naming the key, never clamped);
 * a failed save throws with the server's message so the panel can
 * show which key was refused.
 */
export interface PipelinePolicySettingsResponse {
  /** Only the keys the operator set (absent = env/default). */
  settings: Record<string, string>;
  /** The resolver's defaults as stored-setting strings. */
  defaults: Record<string, string>;
}

const PATH = "/api/trading/settings/pipeline-policy";

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" && data.error ? data.error : res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function fetchPipelinePolicySettings(): Promise<PipelinePolicySettingsResponse> {
  const res = await fetch(PATH, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as PipelinePolicySettingsResponse;
  return {
    settings: data.settings ?? {},
    defaults: data.defaults ?? {},
  };
}

export async function savePipelinePolicySettings(
  settings: Record<string, string>,
): Promise<PipelinePolicySettingsResponse> {
  const res = await fetch(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as PipelinePolicySettingsResponse;
  return {
    settings: data.settings ?? {},
    defaults: data.defaults ?? {},
  };
}
