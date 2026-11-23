/**
 * #6151 S3 — client wrappers for the saved-preset routes.
 * Every call goes through apiFetch (the CSRF header for mutations
 * is merged there, and 401/403 keep their codes). A non-2xx
 * response is a thrown Error carrying the body code (or the HTTP
 * status), so the settings page can surface the exact failure —
 * including the 409 on a duplicate preset name — and revert its
 * optimistic state.
 */
import { apiFetch } from "./apiFetch";
import type { NavPresetRecord, NavPresetStateRecord } from "../data/navPresetPorts";

export interface NavPresetListResponse {
  ok: boolean;
  presets: NavPresetRecord[];
  activePresetId: string | null;
  /** The stored custom selection map (null when a preset — or nothing — is active). */
  stateMap: Record<string, boolean> | null;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data: unknown = await resp.json().catch(() => null);
  if (!resp.ok) {
    const code =
      data !== null &&
      typeof data === "object" &&
      typeof (data as { code?: unknown }).code === "string"
        ? (data as { code: string }).code
        : `HTTP_${resp.status}`;
    const error = new Error(code);
    (error as Error & { code: string }).code = code;
    throw error;
  }
  return data as T;
}

export async function listNavPresets(): Promise<NavPresetListResponse> {
  return requestJson<NavPresetListResponse>("/api/platform/nav-presets");
}

export async function saveNavPreset(
  name: string,
  map: Record<string, boolean>,
): Promise<NavPresetRecord> {
  const data = await requestJson<{ preset: NavPresetRecord }>("/api/platform/nav-presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, map }),
  });
  return data.preset;
}

export async function renameNavPreset(
  id: string,
  name: string,
): Promise<NavPresetRecord> {
  const data = await requestJson<{ preset: NavPresetRecord }>(
    `/api/platform/nav-presets/${encodeURIComponent(id)}/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  return data.preset;
}

export async function deleteNavPreset(
  id: string,
): Promise<{ activePresetId: string | null }> {
  return requestJson<{ ok: boolean; deletedId: string; activePresetId: string | null }>(
    `/api/platform/nav-presets/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function applyNavPreset(
  id: string,
): Promise<{ preset: NavPresetRecord; visibleTabs: Record<string, boolean> }> {
  return requestJson<{ preset: NavPresetRecord; visibleTabs: Record<string, boolean> }>(
    `/api/platform/nav-presets/${encodeURIComponent(id)}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
}

export async function setNavSelection(
  map: Record<string, boolean>,
): Promise<{ visibleTabs: Record<string, boolean> }> {
  return requestJson<{ ok: boolean; visibleTabs: Record<string, boolean> }>(
    "/api/platform/nav-presets/selection",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map }),
    },
  );
}

export type { NavPresetRecord, NavPresetStateRecord };
