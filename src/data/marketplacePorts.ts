/**
 * src/data/marketplacePorts.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A/D-0): the marketplace ports — mas_categories,
 * mas_external_ads, mas_ads, mas_referrals — the ORM core's
 * only D1 residency.
 *
 * WHY D1 (step-3 audit §3): the four tables are fleet-global
 * reference data — seeded identically into every DO instance,
 * holding no per-instance execution state (no D-0 property
 * applies) — whose counters (clicks / impressions / signups /
 * earnings) silently DIVERGE per instance today: each
 * orchestrator instance counts only its own traffic.
 *
 * COUNTER-SEMANTICS CHANGE (disclosed on the PR): moving the
 * four tables to the shared D1 database makes the counters
 * FLEET-WIDE — a click recorded by any instance lands in the
 * one shared row every instance reads. That is the point of
 * the move (the per-instance divergence is the defect), and
 * it is a behaviour change, stated here and on the PR.
 *
 * The ports are ASYNC (D1 is async-only): the same repository
 * shape as repositoryPorts.ts, promise-returning, with the
 * same D-E rules (create = insert-or-throw; update returns
 * the re-read row or null; delete returns true only when a
 * row was removed). incrementCounter is the one addition:
 * an ATOMIC counter step (the routes' `clicks = clicks + 1`
 * form), returning the new value or null when the row is
 * absent — read-modify-write through update() would lose
 * increments across instances now that the table is shared.
 *
 * When AGENT_DB is unbound the composition root serves the
 * same ports from DO-SQLite adapters over the instance's own
 * tables (the pre-move behaviour, per-instance counters and
 * all) — see buildMarketplacePorts.ts.
 *
 * #CDO-mha7
 */
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  ReferralRecord,
  RevenueCoverageCut,
  RevenueCoverageKind,
  RevenueFamilyCut,
  RevenueSummary,
  TransactionRecord,
} from "../types";
import type { RepositoryPort, RepositoryQueryOptions } from "./repositoryPorts";
import type { UsageEventDetailRow } from "./canonicalReportStorePorts";

/** Async repository contract for the D1-resident tables. */
export interface AsyncRepositoryPort<T extends Record<string, any>> {
  readonly tableName: string;
  findMany(options?: RepositoryQueryOptions): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  findOne(where: Record<string, unknown>): Promise<T | null>;
  create(record: T): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T | null>;
  upsert(record: T): Promise<T>;
  delete(id: string): Promise<boolean>;
  count(where?: Record<string, unknown>): Promise<number>;
  /**
   * Atomically add `delta` to a numeric counter column and
   * return its new value; null when the row does not exist.
   */
  incrementCounter(
    id: string,
    counter: string,
    delta: number,
  ): Promise<number | null>;
}

export interface CategoryPort extends AsyncRepositoryPort<CategoryRecord> {}

export interface ExternalAdPort extends AsyncRepositoryPort<ExternalAdRecord> {
  /** Atomically add `delta` to earnings; new value or null. */
  incrementEarnings(id: string, delta: number): Promise<number | null>;
}

export interface AdPort extends AsyncRepositoryPort<AdRecord> {
  /** Atomically add `delta` to EVERY row's impressions (the /ads fetch bump). */
  incrementAllImpressions(delta: number): Promise<void>;
}

export interface ReferralPort extends AsyncRepositoryPort<ReferralRecord> {}

/** The marketplace aggregate served by the composition roots. */
export interface MarketplacePorts {
  categories: CategoryPort;
  externalAds: ExternalAdPort;
  ads: AdPort;
  referrals: ReferralPort;
}

/**
 * The canonical seed rows for the three seeded tables,
 * moved verbatim from DatabaseORM.initializeSchema (the
 * values every instance seeds today). `now` is the seeding
 * instant, exactly as the legacy code stamped it. Both the
 * DO facade's initializeSchema and the D1 adapter's
 * seed-if-empty consume this one definition.
 */
export function marketplaceSeedData(now: string): {
  categories: CategoryRecord[];
  externalAds: ExternalAdRecord[];
  ads: AdRecord[];
} {
  return {
    categories: [
      {
        id: "cat_ai_dev",
        name: "AI & Dev Tools",
        slug: "ai-dev-tools",
        description: "LLM frameworks, vector databases, and autonomous agent tools.",
        icon: "🤖",
        isActive: true,
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_cloud_host",
        name: "Cloud & Hosting",
        slug: "cloud-hosting",
        description: "Edge workers, serverless compute, and distributed storage.",
        icon: "☁️",
        isActive: true,
        sortOrder: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_db_store",
        name: "Database & Storage",
        slug: "database-storage",
        description: "Transactional SQLite, Vectorize, and edge key-value databases.",
        icon: "🗄️",
        isActive: true,
        sortOrder: 3,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_sec_auth",
        name: "Security & Auth",
        slug: "security-auth",
        description: "OAuth 2.0, Agent Decentralized Identifiers (DIDs), and compliance.",
        icon: "🛡️",
        isActive: true,
        sortOrder: 4,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_saas_prod",
        name: "SaaS & Productivity",
        slug: "saas-productivity",
        description: "Developer workstations, IDE assistants, and automation pipelines.",
        icon: "⚡",
        isActive: true,
        sortOrder: 5,
        createdAt: now,
        updatedAt: now,
      },
    ],
    externalAds: [
      {
        id: "ext_ethicalads_dev",
        name: "EthicalAds Developer Network",
        network: "ethicalads",
        placement: "header_leaderboard",
        title: "EthicalAds for AI Engineers",
        tagline: "Privacy-first advertising that funds open-source AI tooling.",
        ctaText: "Advertise on Network →",
        targetUrl: "https://www.ethicalads.io/",
        bannerImageUrl: "",
        cpmRate: 18.5,
        cpcRate: 1.45,
        impressions: 48,
        clicks: 3,
        earnings: 5.24,
        isActive: true,
        createdAt: now,
      },
      {
        id: "ext_carbon_infra",
        name: "Carbon Ads Infra Spot",
        network: "carbon",
        placement: "in_stream",
        title: "Cloudflare Workers AI Serverless GPUs",
        tagline: "Deploy Meta Llama 3.3 and DeepSeek R1 globally in under 60 seconds.",
        ctaText: "Start Free Tier →",
        targetUrl: "https://developers.cloudflare.com/workers-ai/",
        bannerImageUrl: "",
        cpmRate: 22.0,
        cpcRate: 1.8,
        impressions: 112,
        clicks: 8,
        earnings: 16.86,
        isActive: true,
        createdAt: now,
      },
      {
        id: "ext_direct_openaimp",
        name: "OpenAIMP Partner Direct",
        network: "direct",
        placement: "footer_deck",
        title: "Autonomous Agent Orchestration Suite",
        tagline: "Empower your business with multi-agent multi-turn LLM reasoning workflows.",
        ctaText: "Explore Platform →",
        targetUrl: "https://agent.openaimp.com",
        bannerImageUrl: "",
        cpmRate: 25.0,
        cpcRate: 2.0,
        impressions: 85,
        clicks: 6,
        earnings: 14.13,
        isActive: true,
        createdAt: now,
      },
      {
        id: "ext_google_cloud_ai",
        name: "Google Cloud Vertex AI & TPUs",
        network: "google",
        placement: "header_leaderboard",
        title: "Google Cloud Vertex AI & TPU v5e Accelerators",
        tagline: "Build, deploy, and scale enterprise AI models globally with ultra-low latency.",
        ctaText: "Start with $300 Credits →",
        targetUrl: "https://cloud.google.com/vertex-ai",
        bannerImageUrl: "",
        cpmRate: 24.5,
        cpcRate: 2.1,
        impressions: 142,
        clicks: 11,
        earnings: 26.58,
        isActive: true,
        createdAt: now,
      },
    ],
    ads: [
      {
        id: "ad_workers_ai",
        title: "Workers AI Edge GPUs",
        tagline: "Run DeepSeek R1 & Llama 3.3 serverless models globally at the edge.",
        sponsor: "Cloudflare",
        badge: "Featured Partner",
        url: "https://developers.cloudflare.com/workers-ai/",
        ctaText: "Build Free",
        accentColor: "#f38020",
        impressions: 420,
        clicks: 34,
        createdAt: now,
      },
      {
        id: "ad_stripe_payments",
        title: "Autonomous Agent Checkout",
        tagline: "Accept payments with Stripe, PayPal, and DID signature verification.",
        sponsor: "Stripe Connect",
        badge: "Verified Gateway",
        url: "https://stripe.com",
        ctaText: "Integrate Now",
        accentColor: "#635bff",
        impressions: 215,
        clicks: 18,
        createdAt: now,
      },
    ],
  };
}

/**
 * The revenue summary computation, as a pure function over the
 * four input row sets — the SINGLE implementation shared by the
 * facade's synchronous getRevenueSummary() (over its DO ports)
 * and computeMarketplaceRevenueSummary below (over whichever
 * residency the marketplace ports resolve to). Rates as found:
 * marketplace revenue = $20 per sponsored ad + $0.50 per click;
 * payment platform fee = 2.5% of settled (completed|authorized)
 * charge volume; referral payouts = $10 per signup; averageRPM
 * defaults to 18.5 with zero impressions.
 *
 * Issue #5235 (slice 2.30) adds the subscription + pay-per-run
 * cuts, aggregated from the same ledger of record
 * (mas_transactions) plus the metering store of record
 * (usage_events, optional input — absent means zero meter rows,
 * never an error). The old lines' formulas are UNCHANGED; the
 * new lines are additive and are NOT folded into gross/net.
 */
export function computeRevenueSummaryFromRows(
  rows: {
    externalAds: ExternalAdRecord[];
    ads: AdRecord[];
    transactions: TransactionRecord[];
    referrals: ReferralRecord[];
    /** Meter rows for the coverage cut; omit/empty = no served-run data. */
    usageEvents?: UsageEventDetailRow[];
  },
  /**
   * Issue #3185 (bridge slice) — optional tenant scope. It
   * scopes ONLY the meter coverage cut (runRevenueByCoverage):
   * rows whose stamped tenantId matches, NULL-tenant rows
   * excluded (unattributed is no tenant's). Every other cut
   * stays platform-wide BY DESIGN: the subscription /
   * pay-per-run cuts read mas_transactions, whose tenant
   * stamping is partial by #3182 design (x402 wallet receipts
   * and drafts stamp NULL), so scoping them would silently
   * drop paid revenue; the ad / referral cuts carry no tenant
   * column at all. A full tenant revenue summary is a
   * follow-up once transaction tenant stamping covers the paid
   * paths. Omit tenantId for the platform-wide summary.
   */
  opts?: { tenantId?: string },
): RevenueSummary {
  const extAds = rows.externalAds;
  const adNetworkRevenue = extAds.reduce((sum, ad) => sum + (ad.earnings || 0), 0);
  const totalImpressions = extAds.reduce((sum, ad) => sum + (ad.impressions || 0), 0);
  const totalAdClicks = extAds.reduce((sum, ad) => sum + (ad.clicks || 0), 0);

  const marketplaceAds = rows.ads;
  const marketplaceRevenue =
    marketplaceAds.length * 20.0 + marketplaceAds.reduce((sum, a) => sum + a.clicks * 0.5, 0);

  const txs = rows.transactions;
  const settledGross = txs
    .filter((t) => t.status === "completed" || t.status === "authorized")
    .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : 0), 0);
  const paymentPlatformFees = settledGross * 0.025;

  const referrals = rows.referrals;
  const referralPayouts = referrals.reduce((sum, r) => sum + (r.signups || 0) * 10.0, 0);

  const grossRevenue = adNetworkRevenue + marketplaceRevenue + paymentPlatformFees;
  const netRevenue = Math.max(0, grossRevenue - referralPayouts);
  const averageRPM = totalImpressions > 0 ? (adNetworkRevenue / totalImpressions) * 1000 : 18.5;

  const { subscriptionRevenue, subscriptionCount } = summarizeSubscriptionRevenue(txs);
  const { payPerRunRevenue, payPerRunByFamily } = summarizePayPerRunRevenue(txs);
  const coverageEvents =
    opts?.tenantId != null
      ? (rows.usageEvents ?? []).filter((e) => e.tenantId === opts.tenantId)
      : (rows.usageEvents ?? []);
  const runRevenueByCoverage = summarizeCoverage(coverageEvents);

  return {
    grossRevenue,
    adNetworkRevenue,
    marketplaceRevenue,
    paymentPlatformFees,
    referralPayouts,
    netRevenue,
    totalImpressions,
    totalAdClicks,
    averageRPM,
    subscriptionRevenue,
    subscriptionCount,
    payPerRunRevenue,
    payPerRunByFamily,
    runRevenueByCoverage,
    // Issue #5235: measured provider cost per run is NOT recorded
    // anywhere (rolloutBudget holds only caller-supplied
    // budget/actual) — null means unavailable, never an estimate.
    costPerRun: null,
  };
}

/** Round money to the cent; anything finer is a caller bug. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Issue #5235: screener families. The paid services catalogue
 * (TRADING_PAID_SERVICES) is the source of truth for service
 * ids, resources, and prices — this map only translates them
 * to the #2022 family vocabulary: stock_signals ($0.02) is the
 * stock family, options_screener ($0.05) the options family,
 * market_research ($0.10) the goal family (the native gate's
 * default family is "goal"). `strategy` has no paid service, so
 * it stays zero until one exists. A row whose family cannot be
 * resolved lands in `unknown` — counted, never dropped. If a new
 * paid service is added without updating this map, its rows land
 * in `unknown` (fail-safe), never silently in a wrong family.
 */
const SERVICE_ID_TO_FAMILY: Record<string, string> = {
  stock_signals: "stock",
  options_screener: "options",
  market_research: "goal",
};
const RESOURCE_TO_FAMILY: Record<string, string> = {
  "/api/premium/stock-signals": "stock",
  "/api/premium/options-scan": "options",
  "/api/premium/market-research": "goal",
};
const KNOWN_FAMILIES = ["stock", "options", "goal", "strategy"] as const;

function normalizeFamily(raw: unknown): string {
  const f = String(raw ?? "").trim();
  return (KNOWN_FAMILIES as readonly string[]).includes(f) ? f : "unknown";
}

function isSettled(tx: TransactionRecord): boolean {
  return tx.status === "completed" || tx.status === "authorized";
}

/**
 * Issue #5235: the family of one settled pay-per-run payment,
 * or null when the row is not a run payment at all.
 * - cfpay charge rows carry the family in the code-owned note
 *   (`<family> run <runId> via cfpay checkout`, built by
 *   buildCfpayChargeTransaction) and the `screener-payment:`
 *   session prefix (CFPAY_LEDGER_SESSION_PREFIX in
 *   services/cfpayLedger.ts — the literal is repeated here so
 *   this pure function stays free of the services layer; the
 *   #5235 test builds rows through the real builder, so a
 *   prefix change goes red here first).
 * - x402/mpp inbound receipt rows carry the service resource
 *   in checkoutUrl; the resource maps to the family.
 * Everything else (simulated, drafts, outbound micropayments,
 * agent-to-agent rows, bundle/channel receipts, generic
 * charges) returns null.
 */
function payPerRunFamily(tx: TransactionRecord): string | null {
  if (!isSettled(tx)) return null;
  if (tx.action === "charge" && String(tx.sessionId ?? "").startsWith("screener-payment:")) {
    const m = /^(\S+) run \S+ via cfpay checkout/.exec(String(tx.note ?? ""));
    return m ? normalizeFamily(m[1]) : "unknown";
  }
  if (tx.action === "agentic_payment" && (tx.gateway === "x402" || tx.gateway === "mpp")) {
    const url = String(tx.checkoutUrl ?? "");
    for (const [resource, family] of Object.entries(RESOURCE_TO_FAMILY)) {
      if (url === resource || url.endsWith(resource)) return family;
    }
    return "unknown";
  }
  return null;
}

function summarizePayPerRunRevenue(txs: TransactionRecord[]): {
  payPerRunRevenue: number;
  payPerRunByFamily: RevenueFamilyCut[];
} {
  const byFamily = new Map<string, { revenue: number; runs: number }>();
  for (const f of KNOWN_FAMILIES) byFamily.set(f, { revenue: 0, runs: 0 });
  let total = 0;
  for (const tx of txs) {
    const family = payPerRunFamily(tx);
    if (family === null) continue;
    const amount = Number(tx.amount) || 0;
    total += amount;
    const bucket = byFamily.get(family) ?? { revenue: 0, runs: 0 };
    bucket.revenue += amount;
    bucket.runs += 1;
    byFamily.set(family, bucket);
  }
  const payPerRunByFamily: RevenueFamilyCut[] = [...KNOWN_FAMILIES].map((family) => ({
    family,
    revenue: round2(byFamily.get(family)?.revenue ?? 0),
    runs: byFamily.get(family)?.runs ?? 0,
  }));
  const unknown = byFamily.get("unknown");
  if (unknown && unknown.runs > 0) {
    payPerRunByFamily.push({ family: "unknown", revenue: round2(unknown.revenue), runs: unknown.runs });
  }
  return { payPerRunRevenue: round2(total), payPerRunByFamily };
}

/**
 * Issue #5235: settled subscription-purchase cash. A subscription
 * receipt row is written best-effort by billing-purchase (bundle
 * precedent): action agentic_payment, gateway stripe, id
 * `tx_bill-<checkoutRequestId>`, note `Subscription purchase
 * plan <planId> …`. Both the id prefix and the note prefix are
 * required, so a bundle receipt (`tx_bbnd-…`) or a channel
 * receipt (gateway cfpay-channel) can never count here.
 * Pre-slice purchases have no row and are invisible to this
 * line; renewals are not recorded in the ledger (no webhook
 * ledger write) — both documented, not estimated.
 */
function summarizeSubscriptionRevenue(txs: TransactionRecord[]): {
  subscriptionRevenue: number;
  subscriptionCount: number;
} {
  let revenue = 0;
  let count = 0;
  for (const tx of txs) {
    if (
      isSettled(tx) &&
      tx.action === "agentic_payment" &&
      tx.gateway === "stripe" &&
      String(tx.id ?? "").startsWith("tx_bill-") &&
      String(tx.note ?? "").startsWith("Subscription purchase")
    ) {
      revenue += Number(tx.amount) || 0;
      count += 1;
    }
  }
  return { subscriptionRevenue: round2(revenue), subscriptionCount: count };
}

/**
 * Issue #5235: served runs by coverage type, from the meter rows.
 * The detail JSON is the record: paidVia `subscription_included`
 * / `credits` names the coverage; a protocol field with no
 * paidVia is a paid run; anything else (malformed JSON, missing
 * detail, an unrecognised paidVia) is `unknown` — counted, never
 * dropped, never blocking the summary. `revenue` is the
 * list-price value of paid runs; settled cash is
 * payPerRunRevenue (a part-converted run's cash remainder is
 * lower than its list price). Credits-covered runs have no
 * per-run row today (conversion is account-level), so the
 * credits bucket is 0 until such rows exist.
 */
function summarizeCoverage(events: UsageEventDetailRow[]): RevenueCoverageCut[] {
  const buckets = new Map<RevenueCoverageKind, { runs: number; revenue: number; listValue: number }>();
  for (const c of ["paid", "subscription_included", "credits"] as const) {
    buckets.set(c, { runs: 0, revenue: 0, listValue: 0 });
  }
  for (const row of events) {
    let detail: Record<string, unknown> | null = null;
    try {
      detail = row.detailJson ? (JSON.parse(row.detailJson) as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    const priceRaw = Number(detail?.priceUSD);
    const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : 0;
    const paidVia = typeof detail?.paidVia === "string" ? detail.paidVia : "";
    let coverage: RevenueCoverageKind;
    if (paidVia === "subscription_included" || paidVia === "credits") {
      coverage = paidVia;
    } else if (paidVia) {
      coverage = "unknown";
    } else if (typeof detail?.protocol === "string" && detail.protocol) {
      coverage = "paid";
    } else {
      coverage = "unknown";
    }
    const bucket = buckets.get(coverage) ?? { runs: 0, revenue: 0, listValue: 0 };
    bucket.runs += 1;
    bucket.listValue += price;
    if (coverage === "paid") bucket.revenue += price;
    buckets.set(coverage, bucket);
  }
  const cuts: RevenueCoverageCut[] = (["paid", "subscription_included", "credits"] as const).map((coverage) => ({
    coverage,
    runs: buckets.get(coverage)?.runs ?? 0,
    revenue: round2(buckets.get(coverage)?.revenue ?? 0),
    listValue: round2(buckets.get(coverage)?.listValue ?? 0),
  }));
  const unknown = buckets.get("unknown");
  if (unknown && unknown.runs > 0) {
    cuts.push({ coverage: "unknown", runs: unknown.runs, revenue: round2(unknown.revenue), listValue: round2(unknown.listValue) });
  }
  return cuts;
}

export async function computeMarketplaceRevenueSummary(
  marketplace: MarketplacePorts,
  transactions: RepositoryPort<TransactionRecord>,
  /**
   * Issue #5235: meter rows for the coverage cut. Callers that
   * cannot supply them (older call sites) get zero meter rows —
   * the coverage buckets read empty, never an error.
   */
  usageEvents: UsageEventDetailRow[] = [],
  /**
   * Issue #3185 (bridge slice): scopes the meter coverage cut
   * to one tenant (see computeRevenueSummaryFromRows); all
   * other cuts stay platform-wide.
   */
  opts?: { tenantId?: string },
): Promise<RevenueSummary> {
  const [externalAds, ads, referrals] = await Promise.all([
    marketplace.externalAds.findMany(),
    marketplace.ads.findMany(),
    marketplace.referrals.findMany(),
  ]);
  return computeRevenueSummaryFromRows(
    {
      externalAds,
      ads,
      transactions: transactions.findMany(),
      referrals,
      usageEvents,
    },
    opts,
  );
}

