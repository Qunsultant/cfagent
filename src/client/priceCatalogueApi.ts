/**
 * Issue #5230 — price catalogue management client over the EXISTING
 * prices route only (GET/POST /payments/agentic/commercial/prices,
 * operator-only, #2185/#2547/#2739). No new server route.
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header and NEVER
 * reads tier or tenant from a header or localStorage claim — identity
 * is the session, and the server is the authority on prices and on
 * whether the viewer is a store operator.
 *
 * Price discipline (server-enforced, #2547): a price write lands
 * PROPOSED (setPrice clears any prior approval); only an APPROVED
 * price may be charged. Approval is a separate, explicit operator
 * action on this same route — the approver is the verified operator
 * login, never a body field. After every save the section re-reads
 * the entries and renders ONLY the fresh read, never the POST answer
 * and never an optimistic assertion. Failures surface as
 * PriceCatalogueApiError carrying the HTTP status; callers map
 * statuses to FIXED caller-facing strings; server error bodies are
 * never rendered.
 */
import { withCsrfInit } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export type PriceFamily = "stock" | "goal" | "options" | "strategy" | "options-scan" | "market-research" | "stock-signals";
export type PriceApprovalStatus = "proposed" | "approved";

export interface PriceEntryView {
  id: string;
  family: PriceFamily;
  priceUSD: number;
  updatedAtMs: number;
  approvalStatus: PriceApprovalStatus;
  approvedBy: string | null;
  approvedAtMs: number | null;
  productId: string;
  segment: string;
  version: number;
  effectiveFromMs: number;
}

export interface PriceEntriesResponse {
  entries: PriceEntryView[];
}

export class PriceCatalogueApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`price catalogue request failed: ${status}`);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callJson(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await globalThis.fetch(path, withCsrfInit(init));
  } catch {
    throw new PriceCatalogueApiError(0);
  }
  if (!res.ok) throw new PriceCatalogueApiError(res.status);
  return (await res.json().catch(() => ({}))) as unknown;
}

function isPriceFamily(value: unknown): value is PriceFamily {
  return (
    value === "stock" ||
    value === "goal" ||
    value === "options" ||
    value === "strategy" ||
    value === "options-scan" ||
    value === "market-research" ||
    value === "stock-signals"
  );
}

/**
 * #5609 (G-7): premium families are priced per call, not per run —
 * the section labels them accordingly. The server is the authority
 * on the families; this only guards the render.
 */
export function isPremiumPriceFamily(value: unknown): value is PriceFamily {
  return value === "options-scan" || value === "market-research" || value === "stock-signals";
}

/** Validate one catalogue entry from a prices read (the server assert is authoritative; this only guards the render against a half-shaped body). */
export function assertPriceEntryView(value: unknown): PriceEntryView {
  if (!isRecord(value)) throw new PriceCatalogueApiError(500);
  if (
    typeof value.id !== "string" ||
    !isPriceFamily(value.family) ||
    typeof value.priceUSD !== "number" ||
    typeof value.updatedAtMs !== "number" ||
    (value.approvalStatus !== "proposed" && value.approvalStatus !== "approved") ||
    (value.approvedBy !== null && typeof value.approvedBy !== "string") ||
    (value.approvedAtMs !== null && typeof value.approvedAtMs !== "number") ||
    typeof value.productId !== "string" ||
    typeof value.segment !== "string" ||
    typeof value.version !== "number" ||
    typeof value.effectiveFromMs !== "number"
  ) {
    throw new PriceCatalogueApiError(500);
  }
  return {
    id: value.id,
    family: value.family,
    priceUSD: value.priceUSD,
    updatedAtMs: value.updatedAtMs,
    approvalStatus: value.approvalStatus,
    approvedBy: value.approvedBy,
    approvedAtMs: value.approvedAtMs,
    productId: value.productId,
    segment: value.segment,
    version: value.version,
    effectiveFromMs: value.effectiveFromMs,
  };
}

/**
 * GET prices — operator-only. Returns the effective catalogue entries
 * (one per family/segment, with approval state). Callers MUST NOT
 * render the POST answer as the new state: re-read after every save
 * and render only the fresh read.
 */
export async function getPriceEntries(): Promise<PriceEntriesResponse> {
  const data = await callJson(`${BASE}/prices`);
  if (!isRecord(data) || !Array.isArray(data.entries)) throw new PriceCatalogueApiError(500);
  return { entries: data.entries.map(assertPriceEntryView) };
}

/**
 * POST prices with a new price — operator-only, audited server-side.
 * The write lands PROPOSED and clears any prior approval; approval
 * is the separate approvePrice call. Returns the entry from the POST
 * answer, which callers MUST NOT render as the new state: the section
 * re-reads the entries after every save.
 */
export async function setPrice(
  family: PriceFamily,
  priceUSD: number,
): Promise<PriceEntryView> {
  const data = await callJson(`${BASE}/prices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ family, priceUSD }),
  });
  if (!isRecord(data)) throw new PriceCatalogueApiError(500);
  return assertPriceEntryView(data.entry);
}

/**
 * POST prices with approvalStatus "approved" — operator-only, audited
 * server-side. Records THIS verified operator login as the approver;
 * the body cannot name a different approver. Returns the entry from
 * the POST answer, which callers MUST NOT render as the new state:
 * the section re-reads the entries after every save.
 */
export async function approvePrice(family: PriceFamily): Promise<PriceEntryView> {
  const data = await callJson(`${BASE}/prices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ family, approvalStatus: "approved" }),
  });
  if (!isRecord(data)) throw new PriceCatalogueApiError(500);
  return assertPriceEntryView(data.entry);
}
