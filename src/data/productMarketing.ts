/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
 *
 * Pure derivation over caller-supplied data. No store reads, no new
 * table/flag/cron/queue, no sends, no publishes. Every price shown
 * comes from an approved source (the catalog entry, whose price is
 * approved-only by construction in productCatalogue.ts); nothing
 * here invents a price, a candidate, a citation, or a link.
 *
 * Boundaries (see PHASE4-INVENTORY.md):
 * - Teaser candidates come from pipeline/gate output supplied by
 *   the caller. This module runs no pipeline and never presents
 *   an unqualified candidate as qualified.
 * - Subscription / referral-credit / full-report links are INPUTS.
 *   A link that is not supplied is omitted with a recorded
 *   reason — never promised. (Subscription checkout is #2656 in
 *   flight; referral credits are #2657, unlanded.)
 * - Ads enforcement is #2658's verification slice; this module
 *   contains no ad code and the catalog panel serves no ads.
 * - Marketing drafts are composition + validation only. Nothing
 *   here publishes: publishDraft refuses (socialAgent.ts, Phase 5),
 *   and no draft leaves this module toward a transport.
 * - Lifecycle triggers/sends are #2659's; the teaser email
 *   builder below produces CONTENT only.
 */
import { formatDraftText } from "../agents/social/draft";
import type { ProductAccess } from "./productAccess";
import type {
  ProductAvailability,
  ProductEntry,
  ProductTier,
} from "./productCatalogue";
import type { PriceFamily } from "./priceCataloguePorts";

/* ------------------------------------------------------------------ */
/* Teaser policy (#1076 B1)                                            */
/* ------------------------------------------------------------------ */

/**
 * Teaser cap, following the slice-3 digest-cap precedent
 * (LIMITED_DIGEST_ITEM_CAP = 3 in lifecycleEmail.ts). A display
 * cap, not a price or policy default: it is a named constant,
 * surfaced in the §15 as a Phase 4 choice for owner review.
 */
export const TEASER_CANDIDATE_CAP = 3;

export interface TeaserCandidateInput {
  label: string;
  rank: number;
  /** Empty = unqualified: the candidate MUST NOT be shown as qualified. */
  falsificationCriteria: string[];
  gatePassed: boolean;
}

export interface TeaserEntry {
  label: string;
  rank: number;
  falsificationCriteria: string[];
  teaser: true;
}

export interface TeaserResult {
  entries: TeaserEntry[];
  cap: number;
  totalSupplied: number;
  excludedUnqualified: number;
  excludedGateFailed: number;
  rankingCriteria: string;
}

/**
 * Build a limited teaser from pipeline/gate output. Sorts by rank,
 * drops gate-failed candidates, drops unqualified candidates
 * (no falsification criteria), and caps the remainder. The caller
 * MUST state the ranking criteria — a teaser without stated
 * criteria is refused rather than silently ranked.
 */
export function buildTeaser(
  candidates: TeaserCandidateInput[],
  rankingCriteria: string,
  cap: number = TEASER_CANDIDATE_CAP,
): TeaserResult {
  if (rankingCriteria.trim() === "") {
    throw new Error("teaser ranking criteria must be stated");
  }
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => a.c.rank - b.c.rank || a.i - b.i);
  let excludedGateFailed = 0;
  let excludedUnqualified = 0;
  const qualified: TeaserCandidateInput[] = [];
  for (const { c } of indexed) {
    if (!c.gatePassed) {
      excludedGateFailed += 1;
    } else if (c.falsificationCriteria.length === 0) {
      excludedUnqualified += 1;
    } else {
      qualified.push(c);
    }
  }
  const entries: TeaserEntry[] = qualified.slice(0, cap).map((c) => ({
    label: c.label,
    rank: c.rank,
    falsificationCriteria: [...c.falsificationCriteria],
    teaser: true as const,
  }));
  return {
    entries,
    cap,
    totalSupplied: candidates.length,
    excludedUnqualified,
    excludedGateFailed,
    rankingCriteria,
  };
}

export interface TeaserEmailLinks {
  fullReportUrl?: string | null;
  subscriptionUrl?: string | null;
  referralCreditUrl?: string | null;
}

export interface TeaserEmail {
  subject: string;
  body: string;
  omittedLinks: { link: string; reason: string }[];
}

/**
 * Teaser email CONTENT only — no send, no trigger, no scheduler
 * (those are #2659's). Links that are not supplied are omitted
 * from the body entirely and recorded in omittedLinks; the body
 * never promises a link that does not exist. Greeting and
 * personalization are the caller's job; this builder returns
 * subject + body starting at the teaser label.
 */
export function buildTeaserEmail(
  productName: string,
  teaser: TeaserResult,
  links: TeaserEmailLinks,
  options?: { unsubscribeUrl?: string | null },
): TeaserEmail {
  const qualifiedTotal =
    teaser.totalSupplied -
    teaser.excludedUnqualified -
    teaser.excludedGateFailed;
  const lines: string[] = [
    "This is a limited teaser from the same screening pipeline and gates — not a recommendation.",
    "",
    `Ranking criteria: ${teaser.rankingCriteria}`,
    "",
    "Candidates:",
    ...teaser.entries.map(
      (e) => `- ${e.label} (rank ${e.rank}) — falsified if: ${e.falsificationCriteria.join("; ")}`,
    ),
  ];
  if (teaser.entries.length < qualifiedTotal) {
    lines.push(
      "",
      `Showing ${teaser.entries.length} of ${qualifiedTotal} qualified candidates.`,
    );
  }
  const omittedLinks: TeaserEmail["omittedLinks"] = [];
  if (links.fullReportUrl) {
    lines.push("", `Full report: ${links.fullReportUrl}`);
  } else {
    omittedLinks.push({
      link: "full-report",
      reason: "no full-report URL supplied by the caller",
    });
  }
  if (links.subscriptionUrl) {
    lines.push("", `Subscribe for the full list: ${links.subscriptionUrl}`);
  } else {
    omittedLinks.push({
      link: "subscription",
      reason: "subscription checkout path not supplied (#2656 in flight)",
    });
  }
  if (links.referralCreditUrl) {
    lines.push("", `Earn referral credit: ${links.referralCreditUrl}`);
  } else {
    omittedLinks.push({
      link: "referral-credit",
      reason: "referral-credit path not supplied (#2657 unlanded)",
    });
  }
  if (options?.unsubscribeUrl) {
    lines.push(
      "",
      `To stop digest mail only, use this link: ${options.unsubscribeUrl}`,
      "Security mail about your account is unaffected by that link.",
    );
  }
  return {
    subject: `Teaser: ${productName} — limited candidates`,
    body: lines.join("\n"),
    omittedLinks,
  };
}

/* ------------------------------------------------------------------ */
/* Catalog display derivation (Phase 2 catalog + Phase 3 access)       */
/* ------------------------------------------------------------------ */

export interface PurchasePath {
  label: string;
  route: string;
  note: string;
}

export interface CatalogDisplayEntry {
  id: string;
  family: PriceFamily;
  tier: ProductTier;
  canonicalName: string;
  servingAgent: string | null;
  priceUSD: number | null;
  priceSource: "gate" | "catalogue-approved" | null;
  priceLabel: string | null;
  availability: ProductAvailability;
  listed: boolean;
  unlistedReasons: string[];
  parityVerdict: "parity" | "divergent" | "not-routable" | null;
  parityNotes: string[];
  purchasePath: PurchasePath | null;
  purchasePathReason: string | null;
  realVsSimulated: string | null;
}

/**
 * Derive the catalog panel's rows from catalog entries + access
 * records. Prices are NEVER re-derived here: the entry's price is
 * approved-only by construction, and an unpriced entry renders
 * with no price and no purchase path. Parity is shown exactly as
 * Phase 3 recorded it — divergent stays divergent. A missing
 * access record renders as unknown parity, never assumed.
 */
export function buildCatalogDisplay(
  entries: ProductEntry[],
  accessRecords: ProductAccess[],
): CatalogDisplayEntry[] {
  const accessById = new Map(accessRecords.map((a) => [a.id, a]));
  return entries.map((entry) => {
    const priceLabel =
      entry.priceUSD === null
        ? null
        : entry.priceSource === "gate"
          ? `$${entry.priceUSD.toFixed(2)} per call — real (testnet) x402 gate`
          : `$${entry.priceUSD.toFixed(2)} — approved catalogue price`;
    const realVsSimulated =
      entry.priceSource === "gate"
        ? "real (testnet)"
        : entry.priceSource === "catalogue-approved"
          ? "operator catalogue price"
          : null;
    let purchasePath: PurchasePath | null = null;
    let purchasePathReason: string | null = null;
    if (entry.listed && entry.availability === "purchasable") {
      if (entry.gateEndpoint !== null) {
        purchasePath = {
          label: "Pay per call",
          route: entry.gateEndpoint,
          note: "Pay at the gate endpoint; price shown is the approved gate price.",
        };
      } else {
        purchasePathReason =
          "listed product has no gate endpoint — refusing rather than inventing one";
      }
    } else if (entry.availability === "entitlement-pending") {
      purchasePath = {
        label: "View plans",
        route: "/payments/agentic/commercial/plans",
        note: "Subscription checkout is a separate slice (#2656); this points at the existing plans surface, not a checkout flow.",
      };
    } else {
      purchasePathReason =
        entry.unlistedReasons.join("; ") || "not purchasable";
    }
    const access = accessById.get(entry.id);
    return {
      id: entry.id,
      family: entry.family,
      tier: entry.tier,
      canonicalName: entry.canonicalName,
      servingAgent: entry.servingAgent,
      priceUSD: entry.priceUSD,
      priceSource: entry.priceSource,
      priceLabel,
      availability: entry.availability,
      listed: entry.listed,
      unlistedReasons: [...entry.unlistedReasons],
      parityVerdict: access ? access.parity.verdict : null,
      parityNotes: access
        ? [...access.parity.notes]
        : ["no access record — parity unknown, never assumed"],
      purchasePath,
      purchasePathReason,
      realVsSimulated,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Marketing draft composition + copy validation                       */
/* ------------------------------------------------------------------ */

export type MarketingChannel = "facebook" | "instagram" | "threads" | "slack";

export interface OutcomeCitationInput {
  text: string;
  verified: boolean;
  source: string;
}

export interface MarketingDraft {
  channel: MarketingChannel;
  text: string;
  productId: string;
  productName: string;
  citation: { text: string; source: string } | null;
  citationOmittedReason: string | null;
  /** Every draft requires owner approval before any publish step. */
  requiresApproval: true;
  /** Nothing composed here is publishable: publishing is Phase 5. */
  publishable: false;
  truncated: boolean;
}

/**
 * What draft composition actually reads: identity, an approved
 * price, and listed state. A full ProductEntry satisfies this
 * structurally; a display row does too, so the catalog panel can
 * preview drafts without fabricating catalog fields it does not
 * have (gate endpoint, requirements).
 */
export interface MarketableProduct {
  id: string;
  canonicalName: string;
  priceUSD: number | null;
  listed: boolean;
  unlistedReasons: string[];
}
/**
 * Guaranteed-profit claims: rejected wherever they appear (message
 * or citation), even when the citation is track-record verified —
 * verification of an outcome never licenses hype about the future.
 */
const BANNED_CLAIMS: string[] = [
  "guaranteed profit",
  "guaranteed profits",
  "guaranteed return",
  "guaranteed returns",
  "guaranteed income",
  "guaranteed to profit",
  "risk-free profit",
  "risk free profit",
  "will make you money",
  "can't lose",
  "cannot lose",
];

/**
 * Dark patterns this composer cannot verify, so it refuses them
 * outright: invented scarcity and invented urgency. A caller with
 * a real, verified scarcity claim must not use this composer.
 */
const DARK_PATTERNS: RegExp[] = [
  /only \d+ (left|remaining|spots)/i,
  /act now or (lose|miss)/i,
  /offer expires in \d+ (minutes|seconds|hours)/i,
];

export function validateMarketingCopy(text: string): {
  ok: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const lower = text.toLowerCase();
  for (const claim of BANNED_CLAIMS) {
    if (lower.includes(claim)) {
      violations.push(`banned guaranteed-profit claim: "${claim}"`);
    }
  }
  for (const pattern of DARK_PATTERNS) {
    if (pattern.test(text)) {
      violations.push(`dark pattern: matches ${pattern}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Compose a marketing draft from a LISTED catalog product. Fails
 * closed: unlisted products are refused (never advertise what is
 * not available), and any copy violation in the message, the
 * citation, or the composed text throws with the violations named.
 * Citations are included ONLY when verified; anything else is
 * dropped with a reason. Channel limits reuse CHANNEL_LIMITS for
 * facebook/instagram/threads; Slack drafts are composed text only
 * (no Slack transport exists in the social publisher) and are
 * never truncated by this module. The returned draft is NOT
 * postable and requires owner approval before any publish step.
 */
export function composeMarketingDraft(
  entry: MarketableProduct,
  channel: MarketingChannel,
  options?: {
    message?: string;
    citation?: OutcomeCitationInput | null;
  },
): MarketingDraft {
  if (!entry.listed) {
    throw new Error(
      `cannot compose marketing for unlisted product ${entry.id}: ${entry.unlistedReasons.join("; ")}`,
    );
  }
  const priceLine =
    entry.priceUSD !== null
      ? `$${entry.priceUSD.toFixed(2)} per call`
      : "see catalog for pricing";
  let citation: MarketingDraft["citation"] = null;
  let citationOmittedReason: string | null = null;
  const supplied = options?.citation ?? null;
  if (supplied === null) {
    citationOmittedReason = "no citation supplied";
  } else if (!supplied.verified) {
    citationOmittedReason = "outcome unverified — citation omitted";
  } else if (supplied.source.trim() === "") {
    citationOmittedReason = "citation source missing — citation omitted";
  } else {
    citation = { text: supplied.text, source: supplied.source };
  }
  const parts = [`${entry.canonicalName} — ${priceLine}`];
  if (options?.message) parts.push(options.message);
  if (citation) parts.push(`Outcome (track record, ${citation.source}): ${citation.text}`);
  const composed = parts.join("\n");
  const check = validateMarketingCopy(composed);
  if (!check.ok) {
    throw new Error(`marketing copy rejected: ${check.violations.join("; ")}`);
  }
  let text = composed;
  let truncated = false;
  if (channel !== "slack") {
    const formatted = formatDraftText(channel, composed);
    if (!formatted.ok) {
      throw new Error(`cannot format draft for channel ${channel}`);
    }
    text = formatted.text;
    truncated = formatted.truncated;
  }
  return {
    channel,
    text,
    productId: entry.id,
    productName: entry.canonicalName,
    citation,
    citationOmittedReason,
    requiresApproval: true,
    publishable: false,
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/* Funnel events, success metrics, observation loop                    */
/* ------------------------------------------------------------------ */

export const FUNNEL_STAGES = [
  "discover",
  "teaser",
  "first-run",
  "purchase",
  "activation",
  "retained",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelEvent {
  stage: FunnelStage;
  productId: string;
  referralCode?: string | null;
  occurredAtMs?: number | null;
}

/** Record a funnel event. Unknown stages are refused, never stored. */
export function buildFunnelEvent(
  stage: string,
  productId: string,
  options?: { referralCode?: string | null; occurredAtMs?: number | null },
): FunnelEvent {
  if (!(FUNNEL_STAGES as readonly string[]).includes(stage)) {
    throw new Error(`unknown funnel stage: ${stage}`);
  }
  return {
    stage: stage as FunnelStage,
    productId,
    referralCode: options?.referralCode ?? null,
    occurredAtMs: options?.occurredAtMs ?? null,
  };
}

export interface ProductSuccessMetrics {
  productId: string;
  discover: number;
  teaser: number;
  firstRun: number;
  purchase: number;
  activation: number;
  retained: number;
  /** Null on an empty denominator — never 0/0, never invented. */
  teaserToFirstRun: number | null;
  purchaseToActivation: number | null;
}

/** Compute per-product funnel metrics from recorded events. */
export function buildProductSuccessMetrics(
  productId: string,
  events: FunnelEvent[],
): ProductSuccessMetrics {
  const mine = events.filter((e) => e.productId === productId);
  const count = (stage: FunnelStage) =>
    mine.filter((e) => e.stage === stage).length;
  const discover = count("discover");
  const teaser = count("teaser");
  const firstRun = count("first-run");
  const purchase = count("purchase");
  const activation = count("activation");
  const retained = count("retained");
  return {
    productId,
    discover,
    teaser,
    firstRun,
    purchase,
    activation,
    retained,
    teaserToFirstRun: teaser === 0 ? null : firstRun / teaser,
    purchaseToActivation: purchase === 0 ? null : activation / purchase,
  };
}

export interface LoopRecord {
  productId: string;
  observation: string;
  metric: string;
  /** Proposals only — this record never triggers an action itself. */
  proposedNextAction: string;
}

/** Record an outcomes→iteration observation. Empty proposals are refused. */
export function recordObservation(
  productId: string,
  observation: string,
  metric: string,
  proposedNextAction: string,
): LoopRecord {
  if (observation.trim() === "" || proposedNextAction.trim() === "") {
    throw new Error("observation and proposed next action must be stated");
  }
  return { productId, observation, metric, proposedNextAction };
}
