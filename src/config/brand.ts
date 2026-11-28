/**
 * Brand manifest reader + BrandPort (issue #6709).
 *
 * The SupraLab/SupraHub brand lives in `config/brand.json` — the single
 * source of truth for the company, platform, and thirteen capabilities.
 * App code reads it ONLY through the `BrandPort` interface below; the
 * default adapter reads the JSON file. A D1 adapter can replace the JSON
 * adapter later with zero app change (the port contract is fixed here).
 *
 * This module follows the `src/config/vocabulary.ts` pattern: import the
 * JSON, validate on every read, and expose a `setBrandManifest` override
 * seam for tests (rename-drill fixtures).
 *
 * Deliberately NOT migrated in this slice: `branding.ts`, `tokens.css`,
 * `index.html` title, the email footer, and referral/social copy reads —
 * those stay hardcoded for now and remain in #6709 for later slices.
 */

import brandJson from "../../config/brand.json";

/** Supports-today status of a capability (supralab.md §4). */
export type BrandCapabilityStatus = "available" | "partial" | "not-available";

/** One app surface a capability maps to (label verbatim from nav-config.json). */
export interface BrandSurfaceLink {
  /** Surface label, copied verbatim from `src/client/nav-config.json`. */
  label: string;
  /** Tab id the surface lives on. */
  tab: string;
  /** Optional `?view=` value when the surface is a view inside the tab. */
  view?: string;
}

/** A capability's primary app address (tab + optional view), or null when map-only. */
export interface BrandRoute {
  tab: string;
  view?: string;
}

/** One of the thirteen SupraHub capabilities. */
export interface BrandCapability {
  /** Stable key, lowercase, e.g. `supraflo`. Never renamed. */
  key: string;
  /** Display name, e.g. `SupraFlo`. */
  displayName: string;
  /** Short name, e.g. `SupraFlo`. */
  shortName: string;
  /** One-line tagline (mechanical split of the description before the em-dash). */
  tagline: string;
  /** One-line definition, from the #6709 capability-map draft. */
  description: string;
  /** Group from the draft: Orchestration Core, Data, Research, RSI, Live, Safety. */
  group: string;
  /** Icon name from the nav-config icon set (judgment call; data for now). */
  icon: string;
  /** Primary app address, or null when the capability has no user surface. */
  route: BrandRoute | null;
  /** Supports-today status, per docs/architecture/enterprise/supralab.md §4. */
  status: BrandCapabilityStatus;
  /** App surfaces, in display order; empty when map-only by design. */
  surfaces: BrandSurfaceLink[];
}

export interface BrandCompany {
  name: string;
  shortName: string;
  description: string;
}

export interface BrandPlatform {
  name: string;
  shortName: string;
  /** Current platform tagline (tokens.css `--brand-tagline` value). */
  tagline: string;
  /** Current platform badge (tokens.css `--brand-badge` value). */
  badge: string;
  description: string;
}

export interface BrandSocialHandle {
  platform: string;
  url: string;
}

/** The brand manifest shape. */
export interface BrandManifest {
  version: 1;
  company: BrandCompany;
  platform: BrandPlatform;
  /** Capability keys in pipeline order (supralab.md §3). */
  pipeline: string[];
  /** Pipeline caption, from the #6709 capability-map draft. */
  pipelineCaption: string;
  /** Pipeline notes, from the #6709 capability-map draft. */
  pipelineNote: string;
  capabilities: BrandCapability[];
  /**
   * Email footer, CURRENT text (the proposed Supra wording is an undecided
   * owner decision and is never defaulted here).
   */
  emailFooter: string;
  socialHandles: BrandSocialHandle[];
  /** Logo asset ref; null — no logo asset exists in `public/` yet. */
  logo: string | null;
}

/**
 * BrandPort — the only way app code reads brand data. A D1 adapter must
 * implement the same contract (assembling the same manifest shape from
 * `brand_manifest` / `brand_overrides` / `agent_tenant_settings` tables).
 */
export interface BrandPort {
  /** The whole manifest (company, platform, pipeline, capabilities, footer, handles, logo). */
  getBrand(): BrandManifest;
  /** One capability by stable key, or undefined when unknown. */
  getCapability(key: string): BrandCapability | undefined;
  /** All capabilities, in manifest order. */
  getAllCapabilities(): BrandCapability[];
}

const CAPABILITY_STATUSES: readonly BrandCapabilityStatus[] = [
  "available",
  "partial",
  "not-available",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`brand manifest: ${field} must be a non-empty string`);
  }
  return value;
}

function validateRoute(value: unknown, field: string): BrandRoute | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`brand manifest: ${field} must be an object or null`);
  const tab = requireString(value, "tab");
  const view = value.view;
  if (view !== undefined && (typeof view !== "string" || view.trim().length === 0)) {
    throw new Error(`brand manifest: ${field}.view must be a non-empty string when present`);
  }
  return view === undefined ? { tab } : { tab, view };
}

function validateCapability(value: unknown, index: number): BrandCapability {
  const field = `capabilities[${index}]`;
  if (!isRecord(value)) throw new Error(`brand manifest: ${field} must be an object`);
  const status = value.status;
  if (typeof status !== "string" || !CAPABILITY_STATUSES.includes(status as BrandCapabilityStatus)) {
    throw new Error(`brand manifest: ${field}.status must be one of ${CAPABILITY_STATUSES.join(", ")}`);
  }
  const surfaces = value.surfaces;
  if (!Array.isArray(surfaces)) throw new Error(`brand manifest: ${field}.surfaces must be an array`);
  const parsedSurfaces: BrandSurfaceLink[] = surfaces.map((entry, surfaceIndex) => {
    const surfaceField = `${field}.surfaces[${surfaceIndex}]`;
    if (!isRecord(entry)) throw new Error(`brand manifest: ${surfaceField} must be an object`);
    const label = requireString(entry, "label");
    const tab = requireString(entry, "tab");
    const view = entry.view;
    if (view !== undefined && (typeof view !== "string" || view.trim().length === 0)) {
      throw new Error(`brand manifest: ${surfaceField}.view must be a non-empty string when present`);
    }
    return view === undefined ? { label, tab } : { label, tab, view };
  });
  return {
    key: requireString(value, "key"),
    displayName: requireString(value, "displayName"),
    shortName: requireString(value, "shortName"),
    tagline: requireString(value, "tagline"),
    description: requireString(value, "description"),
    group: requireString(value, "group"),
    icon: requireString(value, "icon"),
    route: validateRoute(value.route, `${field}.route`),
    status: status as BrandCapabilityStatus,
    surfaces: parsedSurfaces,
  };
}

/** Validate an unknown value as a BrandManifest; throws on the first defect. */
export function validateBrandManifest(value: unknown): BrandManifest {
  if (!isRecord(value)) throw new Error("brand manifest: must be an object");
  if (value.version !== 1) throw new Error("brand manifest: version must be 1");
  const company = value.company;
  if (!isRecord(company)) throw new Error("brand manifest: company must be an object");
  const platform = value.platform;
  if (!isRecord(platform)) throw new Error("brand manifest: platform must be an object");
  const pipeline = value.pipeline;
  if (!Array.isArray(pipeline) || pipeline.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new Error("brand manifest: pipeline must be an array of capability keys");
  }
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error("brand manifest: capabilities must be a non-empty array");
  }
  const parsedCapabilities = capabilities.map(validateCapability);
  const keys = new Set(parsedCapabilities.map((capability) => capability.key));
  if (keys.size !== parsedCapabilities.length) {
    throw new Error("brand manifest: capability keys must be unique");
  }
  for (const key of pipeline) {
    if (!keys.has(key)) throw new Error(`brand manifest: pipeline key ${key} is not a capability`);
  }
  const socialHandles = value.socialHandles;
  if (!Array.isArray(socialHandles)) {
    throw new Error("brand manifest: socialHandles must be an array");
  }
  const parsedHandles: BrandSocialHandle[] = socialHandles.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`brand manifest: socialHandles[${index}] must be an object`);
    return { platform: requireString(entry, "platform"), url: requireString(entry, "url") };
  });
  const logo = value.logo;
  if (logo !== null && typeof logo !== "string") {
    throw new Error("brand manifest: logo must be a string or null");
  }
  return {
    version: 1,
    company: {
      name: requireString(company, "name"),
      shortName: requireString(company, "shortName"),
      description: requireString(company, "description"),
    },
    platform: {
      name: requireString(platform, "name"),
      shortName: requireString(platform, "shortName"),
      tagline: requireString(platform, "tagline"),
      badge: requireString(platform, "badge"),
      description: requireString(platform, "description"),
    },
    pipeline: [...pipeline] as string[],
    pipelineCaption: requireString(value, "pipelineCaption"),
    pipelineNote: requireString(value, "pipelineNote"),
    capabilities: parsedCapabilities,
    emailFooter: requireString(value, "emailFooter"),
    socialHandles: parsedHandles,
    logo,
  };
}

let currentManifest: BrandManifest = validateBrandManifest(brandJson);

/** The manifest, validated on every read. */
export function getBrandManifest(): BrandManifest {
  return currentManifest;
}

/**
 * Override seam for tests (rename-drill fixtures). Validates before
 * replacing, so a bad fixture never clobbers the live manifest.
 */
export function setBrandManifest(manifest: unknown): void {
  currentManifest = validateBrandManifest(manifest);
}

/** JSON-backed BrandPort — the default adapter. */
export class JsonBrandAdapter implements BrandPort {
  getBrand(): BrandManifest {
    return getBrandManifest();
  }

  getCapability(key: string): BrandCapability | undefined {
    return getBrandManifest().capabilities.find((capability) => capability.key === key);
  }

  getAllCapabilities(): BrandCapability[] {
    return getBrandManifest().capabilities;
  }
}

/** The port app code reads through. Swap the adapter here when the D1 adapter lands. */
export function getBrandPort(): BrandPort {
  return new JsonBrandAdapter();
}
