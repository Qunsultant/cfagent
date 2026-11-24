/**
 * Issue #4821 — the IAAA Admin Overview sub-tabs.
 *
 * The Overview tab used to stack its sections in one long scroll; each
 * section is now its own sub-tab under iaaa-admin, addressable by URL:
 * `?tab=security-hub&view=iaaa-admin&iaaaTab=overview&iaaaSection=<section>`.
 * The sections re-home the existing panels — nothing is rebuilt, only
 * moved — and the PolicyProposalsPanel is NOT one of them: it moved to
 * the PAP tab (`?tab=security-hub&view=pap`, issue 4658) and never
 * comes back here.
 *
 * This module is pure: URLSearchParams in, values out. No window, no
 * fetch, no Cloudflare — the same hexagonal shape as `securityHubView.ts`.
 */

/** The Overview's sections, in tab-bar order. */
export type IaaaAdminSection =
  | "summary"
  | "service-user"
  | "service-tokens"
  | "role-grants"
  | "bootstrap-proposals"
  | "logged-in-users"
  | "deactivate"
  | "access-requests"
  | "audit-events"
  | "identity-profile";

export const IAAA_ADMIN_SECTIONS: readonly IaaaAdminSection[] = [
  "summary",
  "service-user",
  "service-tokens",
  "role-grants",
  "bootstrap-proposals",
  "logged-in-users",
  "deactivate",
  "access-requests",
  "audit-events",
  "identity-profile",
];

export const IAAA_ADMIN_SECTION_LABELS: Record<IaaaAdminSection, string> = {
  summary: "Summary",
  "service-user": "Service user",
  "service-tokens": "Service tokens",
  "role-grants": "Role grants",
  "bootstrap-proposals": "Bootstrap proposals",
  "logged-in-users": "Logged-in users",
  deactivate: "Deactivate",
  "access-requests": "Access requests",
  "audit-events": "Audit events",
  "identity-profile": "Identity profile",
};

export function isIaaaAdminSection(value: unknown): value is IaaaAdminSection {
  return (
    typeof value === "string" &&
    (IAAA_ADMIN_SECTIONS as readonly string[]).includes(value)
  );
}

/**
 * Canonicalize a raw `?iaaaSection=` value: an unknown or missing
 * section falls back to `summary`. Never throws, never returns an
 * invalid section.
 */
export function normalizeIaaaAdminSection(value: unknown): IaaaAdminSection {
  if (isIaaaAdminSection(value)) return value;
  return "summary";
}

export interface IaaaAdminSectionDeepLink {
  section: IaaaAdminSection;
}

/** Parse the Overview's section deep link out of a query string. */
export function parseIaaaAdminSectionDeepLink(search: string): IaaaAdminSectionDeepLink {
  const params = new URLSearchParams(search);
  return {
    section: normalizeIaaaAdminSection(params.get("iaaaSection")),
  };
}
