/**
 * Issue #5160 — client for the IAAA Admin "Identity profile"
 * section: the IDP profile config (attribute set + retention) and
 * the admin identity lookup.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule). This
 * module never decides authorization — the routes are server-gated
 * (platform-admin for the config, admin for the lookup) and a 403
 * here means the server refused, never a client bug. Values are
 * never logged; the lookup returns ids + tenant + source only.
 */
import { apiFetch } from "./apiFetch";

/** The IDP profile config, as the config route returns it. */
export interface IdpProfileConfigView {
  storeAll: boolean;
  excludedAttributes: string[];
  retentionDays: number;
}

/** One identity matching an attribute lookup. */
export interface IdpProfileLookupMatch {
  internalUserId: string;
  tenantId: string;
  source: string;
}

export interface IdpProfileLookupResult {
  matches: IdpProfileLookupMatch[];
  ambiguous: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(value: unknown): IdpProfileConfigView {
  if (!isRecord(value)) throw new Error("Invalid identity profile config.");
  if (typeof value.storeAll !== "boolean") throw new Error("Invalid identity profile config.");
  if (
    !Array.isArray(value.excludedAttributes) ||
    !value.excludedAttributes.every((s) => typeof s === "string")
  ) {
    throw new Error("Invalid identity profile config.");
  }
  if (typeof value.retentionDays !== "number" || !Number.isInteger(value.retentionDays)) {
    throw new Error("Invalid identity profile config.");
  }
  return {
    storeAll: value.storeAll,
    excludedAttributes: [...value.excludedAttributes],
    retentionDays: value.retentionDays,
  };
}

/** Read the effective IDP profile config (platform-admin only). */
export async function fetchIdpProfileConfig(): Promise<IdpProfileConfigView> {
  const res = await apiFetch("/api/iaaa/identity-profile/config");
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(
      typeof data.error === "string" && data.error
        ? data.error
        : "Failed to load the identity profile config.",
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return parseConfig(data.config);
}

/** Write the IDP profile config (platform-admin only, audited server-side). */
export async function saveIdpProfileConfig(
  config: IdpProfileConfigView,
): Promise<IdpProfileConfigView> {
  const res = await apiFetch("/api/iaaa/identity-profile/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" && data.error
        ? data.error
        : "Failed to save the identity profile config.",
    );
  }
  return parseConfig(data.config);
}

/**
 * Exact-match lookup by a stored IDP attribute (admin-gated,
 * tenant-scoped server-side). Returns ALL matches in scope —
 * never a silent winner; ambiguous=true means the caller must
 * not pick one.
 */
export async function lookupIdentityByAttribute(
  attribute: string,
  value: string,
  tenantId?: string | null,
): Promise<IdpProfileLookupResult> {
  const params = new URLSearchParams({ attribute, value });
  if (tenantId) params.set("tenantId", tenantId);
  const res = await apiFetch(`/api/iaaa/identity/lookup?${params.toString()}`);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" && data.error
        ? data.error
        : "Identity lookup failed.",
    );
  }
  const matches = Array.isArray(data.matches)
    ? data.matches.filter(
        (m): m is IdpProfileLookupMatch =>
          isRecord(m) &&
          typeof m.internalUserId === "string" &&
          typeof m.tenantId === "string" &&
          typeof m.source === "string",
      )
    : [];
  return { matches, ambiguous: data.ambiguous === true };
}
