/**
 * #5230 — commercial externalization census pin (seeded-baseline form).
 *
 * The rule (owner, 2026-11-17, standing): every variable/default of the
 * entire system must be externalized, configurable, AND manageable
 * through UX. No value lives only in code, and no value lives only in a
 * config row with no management surface.
 *
 * This pin enforces the rule over the commercial + operational surfaces
 * audited in #5230 (see ~/workspace/cfagent-2012-notes/5230-AUDIT.md):
 * billing, subscriptions, plans, prices, referral credits, lifecycle
 * email/digest, ads, quotas, limits, windows, expiries, thresholds.
 *
 * Form (same discipline as tests/schema_component_grep_pin.test.ts):
 * the pin scans a fixed file list with named regex patterns and asserts
 * the counted hits per pattern equal the baseline in
 * ./commercial_externalization_baseline_5230.json EXACTLY. Any new
 * hardcoded commercial value trips it. Externalizing a listed value
 * updates the baseline in that PR — reviewed in the diff, never
 * silent. Seed constants are the allowed set: a second occurrence of
 * any seed value trips the pin, so a value may live in exactly one
 * named seed (or in config/*.json / operator D1 data), never as a
 * second literal.
 *
 * Scope: src/ files listed in PATTERNS only. config/*.json is the
 * allowed home, so config files are never scanned. tests/ fixtures,
 * research data (e.g. marketCap fixtures), and trading-domain
 * constants (eventWindowDays, targetDteDays) are outside this pin's
 * scope by design — recorded in the audit, not silently skipped.
 *
 * Red→green proof for the pin itself: on the pre-slice tree the four
 * externalized patterns (digestItemCap, digestHighlightMax, teaserCap,
 * adsListLimit) each count 1 against a baseline of 0, so this test
 * FAILS before the slice and PASSES after it. Re-introducing any one
 * literal fails it again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "commercial_externalization_baseline_5230.json",
);

interface PatternDef {
  /** Files scanned for this pattern (repo-relative). */
  files: string[];
  /** One match per matching line (a line matches at most once). */
  regex: RegExp;
  /** Why the baseline count is what it is. */
  note: string;
}

/**
 * Named patterns. Counts in the baseline are the post-#5230 counts as
 * updated by #5609: the premium prices (tradingPrice) and the x402/MPP
 * challenge default params are externalized (0); the remaining
 * follow-up items are the wallet starting credit, referral seeds,
 * the rate limits (kept in the descriptor by #5609 decision), and
 * the single generic client challenge fallback. Seed constants are
 * the allowed set (one occurrence each): the PROPOSED_SEED_PRICES
 * object now holds seven rows (four per-run + three premium).
 */
const PATTERNS: Record<string, PatternDef> = {
  // Externalized by #5230 — baseline 0.
  digestItemCap: {
    files: ["src/services/lifecycleEmail.ts"],
    regex: /LIMITED_DIGEST_ITEM_CAP\s*=\s*\d+/,
    note: "Free-tier digest item cap — lives in config/lifecycle-defaults.json (limitedDigestItemCap).",
  },
  digestHighlightMax: {
    files: ["src/services/digestContentProvider.ts"],
    regex: /DIGEST_HIGHLIGHT_SUMMARY_MAX\s*=\s*\d+/,
    note: "Digest highlight truncation — lives in config/lifecycle-defaults.json (digestHighlightSummaryMax).",
  },
  teaserCap: {
    files: ["src/data/productMarketing.ts"],
    regex: /TEASER_CANDIDATE_CAP\s*=\s*\d+/,
    note: "Catalog teaser candidate cap — lives in config/lifecycle-defaults.json (teaserCandidateCap).",
  },
  adsListLimit: {
    files: ["src/agents/routes/adsRevenueReferrals.ts"],
    regex: /limit:\s*20\b/,
    note: "Marketplace ads list page size — lives in config/commercial-defaults.json (adsListLimit).",
  },
  // Follow-up: files touched by in-flight slices 2.26 (#5222).
  // #5609 (G-7): the premium prices are externalized — the
  // descriptor carries no price and the challenge price params are
  // required. Rate limits stay in the descriptor by decision
  // (service metadata, not prices); the one challengeCall hit is
  // the generic client fallback, not a premium price.
  tradingPrice: {
    files: ["src/services/agenticPayments.ts"],
    regex: /priceUSD:\s*0\.(02|05|10)\b/,
    note: "Externalized by #5609: TRADING_PAID_SERVICES carries no price — premium prices live in the price catalogue (getApprovedPrice).",
  },
  tradingRateLimit: {
    files: ["src/services/agenticPayments.ts"],
    regex: /rateLimitPerMin:\s*\d+/,
    note: "#5609 decision: rate limits stay in the price-less premium service descriptor (service metadata, not prices).",
  },
  walletStartingCredit: {
    files: ["src/services/agenticPayments.ts"],
    regex: /AGENTIC_WALLET_STARTING_CREDIT_USD\s*=\s*[\d.]+/,
    note: "FOLLOW-UP (2.26's file): simulated wallet starting credit — belongs in config/commercial-defaults.json.",
  },
  challengeDefaultParam: {
    files: ["src/services/agenticPayments.ts"],
    regex: /priceUSD[^=]*=\s*0\.05/,
    note: "Externalized by #5609: x402/MPP challenge price params are required — no default price exists.",
  },
  challengeCall: {
    files: ["src/services/agenticPayments.ts"],
    regex: /createX402Challenge\([^,]+,\s*0\.05/,
    note: "#5609: the one remaining hit is the generic client-side fallback in requestWithAgenticPayment (a header-less 402 for an arbitrary URL), not a premium price.",
  },
  autoApproveFallback: {
    files: ["src/services/agenticPayments.ts"],
    regex: /X402_AUTO_APPROVE_LIMIT \|\| 0\.05/,
    note: "FOLLOW-UP (2.26's file): env fallback default for the x402 auto-approve limit.",
  },
  // Follow-up: referral seeds (2.26 #5226 touches lifecyclePorts.ts; 2.28 #5228 / 2.31 #5229 touch the referral path).
  referralEarnSeed: {
    files: ["src/data/inMemoryLifecycleAdapter.ts"],
    regex: /earnAmountUSD:\s*[\d.]+/,
    note: "FOLLOW-UP: in-memory adapter duplicates the migration 0015 seed ($0.50) — needs one shared seed constant.",
  },
  referralVestingSeed: {
    files: ["src/data/inMemoryLifecycleAdapter.ts"],
    regex: /vestingDelayMs:\s*\d+/,
    note: "FOLLOW-UP: in-memory adapter duplicates the migration 0015 seed (7d = 604800000ms) — needs one shared seed constant.",
  },
  // Named seed constants — the allowed set (exactly one occurrence each).
  refundSeedWindow: {
    files: ["src/data/refundPorts.ts"],
    regex: /windowDays:\s*\d+/,
    note: "Allowed: the single PROPOSED_SEED_POLICY window (30d). A second windowDays literal trips the pin.",
  },
  billingTopUpMinSeed: {
    files: ["src/data/billingPolicyPorts.ts"],
    regex: /topUpMinUSD:\s*\d+/,
    note: "Allowed: the single PROPOSED_SEED_BILLING_POLICY top-up min ($1).",
  },
  billingTopUpMaxSeed: {
    files: ["src/data/billingPolicyPorts.ts"],
    regex: /topUpMaxUSD:\s*\d+/,
    note: "Allowed: the single PROPOSED_SEED_BILLING_POLICY top-up max ($500).",
  },
  seedPrices: {
    files: ["src/data/priceCataloguePorts.ts"],
    regex: /^\s*"?(stock|goal|options|strategy|options-scan|market-research|stock-signals)"?:\s*[\d.]+/,
    note: "Allowed: the single PROPOSED_SEED_PRICES object (stock 0.02, goal 0.10, options 0.05, strategy 0.10; options-scan 5, market-research 10, stock-signals 2 — #5609).",
  },
  offerCooldownSeed: {
    files: ["src/data/billingPolicyPorts.ts"],
    regex: /dismissCooldownDays:\s*\d+/,
    note: "Allowed: the single PROPOSED_SEED_OFFER_RULES cooldown (7d).",
  },
  gracePeriodSeed: {
    files: ["src/data/billingPolicyPorts.ts"],
    regex: /gracePeriodDays:\s*\d+/,
    note: "Allowed: the single PROPOSED_SEED_BILLING_POLICY grace period (7d).",
  },
  dunningSeed: {
    files: ["src/data/billingPolicyPorts.ts"],
    regex: /dunningRetryDelayDays:\s*\[[0-9, ]+\]/,
    note: "Allowed: the single PROPOSED_SEED_BILLING_POLICY dunning schedule ([1, 3, 7]).",
  },
  annualDiscountSeed: {
    files: ["src/data/billingPolicyPorts.ts"],
    regex: /annualDiscountPct:\s*\d+/,
    note: "Allowed: the single PROPOSED_SEED_BILLING_POLICY annual discount (15%).",
  },
};

interface Baseline {
  generatedFrom: string;
  counts: Record<string, number>;
}

function countMatches(def: PatternDef): { total: number; hits: string[] } {
  let total = 0;
  const hits: string[] = [];
  for (const rel of def.files) {
    const lines = readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (def.regex.test(line)) {
        total += 1;
        hits.push(`${rel}:${idx + 1}`);
      }
    });
  }
  return { total, hits };
}

describe("commercial externalization census (#5230)", () => {
  it("hardcoded commercial values equal the seeded baseline exactly", () => {
    const baseline: Baseline = JSON.parse(
      readFileSync(BASELINE_PATH, "utf8"),
    ) as Baseline;
    const mismatches: string[] = [];
    for (const [name, def] of Object.entries(PATTERNS)) {
      const { total, hits } = countMatches(def);
      const expected = baseline.counts[name];
      if (expected === undefined) {
        mismatches.push(
          `${name}: no baseline count recorded (found ${total} at ${hits.join(", ") || "—"})`,
        );
      } else if (total !== expected) {
        mismatches.push(
          `${name}: found ${total}, baseline ${expected} (${def.note}) at ${hits.join(", ") || "—"}`,
        );
      }
    }
    const extra = Object.keys(baseline.counts).filter(
      (name) => !(name in PATTERNS),
    );
    for (const name of extra) {
      mismatches.push(`${name}: baseline entry with no pattern in this test`);
    }
    expect(mismatches).toEqual([]);
  });

  it("the four #5230 values are read from config, not literals", () => {
    const lifecycleEmail = readFileSync(
      path.join(REPO_ROOT, "src/services/lifecycleEmail.ts"),
      "utf8",
    );
    expect(lifecycleEmail).toContain("LIFECYCLE_DEFAULTS");
    expect(lifecycleEmail).not.toMatch(/LIMITED_DIGEST_ITEM_CAP\s*=/);

    const digestProvider = readFileSync(
      path.join(REPO_ROOT, "src/services/digestContentProvider.ts"),
      "utf8",
    );
    expect(digestProvider).toContain("LIFECYCLE_DEFAULTS");
    expect(digestProvider).not.toMatch(/DIGEST_HIGHLIGHT_SUMMARY_MAX\s*=/);

    const marketing = readFileSync(
      path.join(REPO_ROOT, "src/data/productMarketing.ts"),
      "utf8",
    );
    expect(marketing).toContain("LIFECYCLE_DEFAULTS");
    expect(marketing).not.toMatch(/TEASER_CANDIDATE_CAP\s*=/);

    const adsRoute = readFileSync(
      path.join(REPO_ROOT, "src/agents/routes/adsRevenueReferrals.ts"),
      "utf8",
    );
    expect(adsRoute).toContain("COMMERCIAL_DEFAULTS");
    expect(adsRoute).not.toMatch(/limit:\s*20\b/);
  });

  it("the lifecycle defaults loader pins the externalized values", () => {
    // Values unchanged — only their home moved (3, 280, 3).
    const raw = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "config/lifecycle-defaults.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(raw.limitedDigestItemCap).toBe(3);
    expect(raw.digestHighlightSummaryMax).toBe(280);
    expect(raw.teaserCandidateCap).toBe(3);
  });
});
