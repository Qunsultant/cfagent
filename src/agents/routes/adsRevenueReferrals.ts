/**
 * Issue #359-03: ads / revenue / referrals routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move —
 * no behavior change.
 *
 * The domain's original inline blocks are NOT contiguous in routeRequest:
 *   - the inventory group (/categories, /revenue, /external-ads,
 *     /external-ads/impression, /external-ads/click) sits between the
 *     /schema/query block and the /audit block;
 *   - the community group (/referrals, /referrals/click, /ads,
 *     /ads/banner-config, /ads/click)
 *     sits between the /memory block and the payments block.
 * This module therefore exports TWO handlers, each invoked from
 * routeRequest at the EXACT position its original blocks occupied in the
 * sequential path.endsWith matching sequence. Each returns a Response on
 * match or null when none of its paths matches (the orchestrator then
 * continues its sequential matching) — matching order relative to every
 * other handler is preserved by the two call sites.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them
 * via the explicit AdsRevenueReferralsRouteContext parameter; there are no
 * new globals and no back-references into the class.
 */

import type { AdRecord, AgentName, CategoryRecord, ExternalAdRecord } from "../../types";
import type { MarketplacePorts } from "../../data/marketplacePorts";
import type { DatabaseORM, SqlStorage } from "../../orm";
import { runRestTool } from "./restToolBridge";
import { resolveAdsTier, resolveServerAdsConfig } from "../../services/adsTier";
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { resolveEffectiveTier } from "../../data/subscriptionPorts";
import {
  ADS_REVENUE_SWITCHES,
  adsRevenueConfigErrorEvent,
  categoryCreateId,
  categoryCreateSlug,
  categoryCreateValues,
  categoryListOptions,
  categoryUpdatePatch,
  externalAdClickEarnings,
  externalAdCreateId,
  externalAdCreateValues,
  externalAdImpressionEarnings,
  externalAdListOptions,
  externalAdUpdatePatch,
  levelsForDomain,
  referralCreateValues,
  referralListOptions,
  resolveAdsRevenueMode,
  type AdsRevenueDomain,
  type AdsRevenueMode,
  type AdsRevenueScopedModes,
} from "../../config/adsRevenueModes";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/adsRevenueReferrals",
});

/** The subset of OrchestratorAgent surface the ads/revenue/referrals handlers need. */
export interface AdsRevenueReferralsRouteContext {
  getOrm(): DatabaseORM;
  ensureTables(): SqlStorage;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /**
   * Issue #2022: the caller's VERIFIED tier attribute, when the
   * account store (#2020/#2015) populates it. Absent today — every
   * caller resolves to Free and serving is unchanged. NEVER read
   * from a header: tier is a user attribute, not a header claim
   * (#1076 enforcement sketch). Only the exact value "Subscribed"
   * suppresses ads; anything else serves.
   */
  viewerTier?: string;
  /**
   * #1721: global-env fallback for the three switches (passed from the
   * orchestrator's Worker env). Optional so existing test literals
   * keep typechecking; unset env falls through to the built-in
   * "route" default.
   */
  env?: {
    CATEGORIES_MODE?: unknown;
    REFERRALS_MODE?: unknown;
    EXTERNAL_ADS_MODE?: unknown;
  };
  /**
   * #1721: session/user carriers for the three switches, populated by
   * the execution-context owner. Unset carriers fall through to env.
   */
  scopedModes?: AdsRevenueScopedModes;
}

/**
 * #1721: resolves one switch for a REST request in run > session >
 * user > env > builtin order. Run = body `mode`, else `?mode=`.
 * An invalid winning value fails closed to "route" and is logged +
 * audited as `<domain>.config_error` before the request proceeds.
 */
function resolveRouteMode(
  ctx: AdsRevenueReferralsRouteContext,
  domain: AdsRevenueDomain,
  run: unknown
): AdsRevenueMode {
  const switchName = ADS_REVENUE_SWITCHES[domain];
  const resolved = resolveAdsRevenueMode(
    levelsForDomain(ctx.scopedModes, domain, run, ctx.env?.[switchName])
  );
  if (resolved.invalid) {
    structuredLog.error("adsRevenueReferrals.ads_revenue_mode_config_invalid", {
      message: `[ads-revenue] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "route"`,
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: "route",
    });
    ctx.audit(adsRevenueConfigErrorEvent(domain), "orchestrator", {
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: "route",
    });
  }
  return resolved.mode;
}

/** Run override for a request: POST body `mode`, else `?mode=`. */
function runModeOf(body: unknown, url: URL): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const mode = (body as Record<string, unknown>).mode;
    if (mode !== undefined) return mode;
  }
  return url.searchParams.get("mode") ?? undefined;
}

/**
 * Handles the inventory/monetization group: referral-category ORM CRUD, the
 * revenue summary, and external ad placements (+ impression/click tracking).
 * Invoked from routeRequest at the position between the /schema/query block
 * and the /audit block.
 */
/**
 * Issue #2022 (reconciled #2118 + #2121): resolve the ads viewer
 * from the account store layered over #2118's verified tier
 * attribute.
 *
 * - tier: the store record's tier when one exists for the verified
 *   login (the store is the record; ctx is a claim, so the store
 *   wins on disagreement), otherwise ctx.viewerTier via
 *   resolveAdsTier. Only the exact value "Subscribed" suppresses.
 * - tenantAdsEnabled: the tenant's system-wide ads flag (tenant off
 *   beats tier — no ads for anyone in that tenant). Absent = true.
 *
 * Fail direction is SERVE: no verified login, no env, or any store
 * failure returns the ctx tier + enabled (the server lists are the
 * enforcement boundary, and a store blip must not blank ads for
 * every Free user — nor invent a tier nobody holds). A populated
 * Subscribed ctx tier still suppresses on store failure, since
 * that claim comes from trusted server code, not the caller.
 * Ads reads never ensure the schema.
 *
 * Subscription overlay (#2020/#2127): the tier above is the
 * EFFECTIVE tier, not the stored baseline. An unexpired
 * subscription confers Subscribed even when the stored tier says
 * otherwise, and a lapsed subscription stops conferring it
 * (see resolveEffectiveTier). A subscription-read failure
 * degrades to the stored tier via the helper — which yields
 * Free for a subscription-granted tier with no live rows, so a
 * blip never revives a lapsed grant and never blanks a Free
 * user's ads.
 */
async function resolveAdsViewer(
  request: Request,
  ctx: AdsRevenueReferralsRouteContext,
): Promise<{ tier: "Free" | "Subscribed"; tenantAdsEnabled: boolean }> {
  const ctxTier = resolveAdsTier(ctx.viewerTier);
  const serve = { tier: ctxTier, tenantAdsEnabled: true };
  const login = (request.headers.get("x-user-login") ?? "").trim() || null;
  // The ctx env type is narrowed for #1721, but the orchestrator
  // passes the full Worker env at runtime — the cast recovers it.
  // D1 is shared across instances, so the handler reads it
  // directly: no canonical-instance hop.
  const env = ctx.env as unknown as { AGENT_DB?: unknown } | undefined;
  if (!login || !env) {
    return serve;
  }
  const adapter = createCommercialAdapter(env);
  if (!adapter) {
    return serve;
  }
  try {
    const account = await adapter.getAccount(login);
    let subscriptions: Array<{ periodEndMs: number }> = [];
    const subsAdapter = createSubscriptionAdapter(env);
    if (subsAdapter) {
      try {
        subscriptions = await subsAdapter.listSubscriptions(login);
      } catch {
        subscriptions = [];
      }
    }
    const effective = resolveEffectiveTier(account, subscriptions, Date.now());
    const tier = account || subscriptions.length > 0 ? resolveAdsTier(effective) : ctxTier;
    const tenantAdsEnabled = account?.tenantId
      ? await adapter.getTenantAdsEnabled(account.tenantId)
      : true;
    return { tier, tenantAdsEnabled };
  } catch {
    return serve;
  }
}

async function isAdsSuppressed(
  request: Request,
  ctx: AdsRevenueReferralsRouteContext,
): Promise<boolean> {
  const viewer = await resolveAdsViewer(request, ctx);
  return !viewer.tenantAdsEnabled || viewer.tier === "Subscribed";
}

export async function handleAdsRevenueReferralsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AdsRevenueReferralsRouteContext
): Promise<Response | null> {
  // Referral Categories ORM Management API
  // #1721: value contract switched by CATEGORIES_MODE (default route);
  // list ordering is identical in both modes (sort_order ASC).
  if (path.endsWith("/categories")) {
    const orm = ctx.getOrm();
    // #2345: categories serve through the marketplace ports
    // (D1 fleet table when AGENT_DB is bound; the instance's
    // own table when not).
    const mp = await orm.marketplacePorts((ctx.env ?? {}) as unknown as { AGENT_DB?: unknown });

    if (request.method === "GET") {
      try {
        const categories = await mp.categories.findMany(categoryListOptions());
        return Response.json({ count: categories.length, categories });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch categories" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as Partial<CategoryRecord> & { id?: string; mode?: unknown };
        const mode = resolveRouteMode(ctx, "categories", runModeOf(body, url));
        const name = (body.name || "").trim();
        if (!name) {
          return Response.json({ error: "Category name is required" }, { status: 400 });
        }

        const now = new Date().toISOString();
        let category: CategoryRecord;

        if (body.id) {
          const existing = await mp.categories.findById(body.id);
          if (!existing) {
            return Response.json({ error: "Category not found" }, { status: 404 });
          }
          const updated = await mp.categories.update(body.id, {
            ...categoryUpdatePatch(existing, body, mode),
            updatedAt: now,
          });
          category = updated || existing;
          ctx.audit("category.updated", "orchestrator", { id: category.id, name: category.name });
        } else {
          const slug = categoryCreateSlug(name, body.slug, mode);
          const id = categoryCreateId(slug, name, undefined, mode);
          const values = categoryCreateValues(name, body, mode, await mp.categories.count());
          category = await mp.categories.create({
            id,
            name,
            slug,
            ...values,
            createdAt: now,
            updatedAt: now,
          });
          ctx.audit("category.created", "orchestrator", { id, name });
        }

        return Response.json({ success: true, category });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save category" }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      try {
        const mode = resolveRouteMode(ctx, "categories", runModeOf(null, url));
        const id = url.searchParams.get("id");
        if (!id) {
          return Response.json({ error: "Category id is required" }, { status: 400 });
        }
        await mp.categories.delete(id);
        ctx.audit("category.deleted", "orchestrator", { id });
        // #1721: mcp-mode envelope mirrors the command (deleted flag +
        // id); route mode keeps the bare {success: true}.
        return mode === "mcp"
          ? Response.json({ success: true, deleted: true, id })
          : Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete category" }, { status: 500 });
      }
    }
  }

  // Revenue Management Summary API
  // #1644: executed through the get_revenue_summary command — the route
  // keeps only its response passthrough and error mapping.
  if (path.endsWith("/revenue") && request.method === "GET") {
    try {
      const summary = await runRestTool("get_revenue_summary", {}, {
        orm: ctx.getOrm(),
        sessionId,
        env: ctx.env,
        audit: (type, agent, payload) => ctx.audit(type, agent, payload),
      });
      return Response.json(summary);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to calculate revenue" }, { status: 500 });
    }
  }

  // External Ad Network Placements & Monetization API
  // #1721: value contract switched by EXTERNAL_ADS_MODE (default
  // route: cpm 15.0 / cpc 1.25, initial impression, 3dp/2dp rounding).
  if (path.endsWith("/external-ads")) {
    const orm = ctx.getOrm();
    const mp = await orm.marketplacePorts((ctx.env ?? {}) as unknown as { AGENT_DB?: unknown });

    if (request.method === "GET") {
      // Issue #2022: a Subscribed caller is served nothing — the
      // list is the enforcement boundary, so no read and no count
      // happens for that caller. Free callers are unaffected.
      if (await isAdsSuppressed(request, ctx)) {
        return Response.json({ count: 0, ads: [] });
      }
      try {
        const mode = resolveRouteMode(ctx, "externalAds", runModeOf(null, url));
        const ads = await mp.externalAds.findMany(externalAdListOptions(mode));
        return Response.json({ count: ads.length, ads });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch external ads" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as Partial<ExternalAdRecord> & { id?: string; mode?: unknown };
        const mode = resolveRouteMode(ctx, "externalAds", runModeOf(body, url));
        const title = (body.title || "").trim();
        const targetUrl = (body.targetUrl || "").trim();
        if (!title || !targetUrl) {
          return Response.json({ error: "Title and targetUrl are required" }, { status: 400 });
        }

        const now = new Date().toISOString();
        let ad: ExternalAdRecord;

        if (body.id) {
          // #1721: legacy MCP has no update action, so in mcp mode a
          // route update is refused (the HTTP mapping of the MCP
          // `Unsupported action: update` throw) instead of writing.
          if (mode === "mcp") {
            return Response.json({ error: "External ad update is not supported in mcp mode" }, { status: 400 });
          }
          const existing = await mp.externalAds.findById(body.id);
          if (!existing) {
            return Response.json({ error: "Ad not found" }, { status: 404 });
          }
          const updated = await mp.externalAds.update(body.id, externalAdUpdatePatch(existing, body));
          ad = updated || existing;
          ctx.audit("external_ad.updated", "orchestrator", { id: ad.id, title: ad.title });
        } else {
          const id = externalAdCreateId(body.network, mode);
          const values = externalAdCreateValues(title, body, mode);
          ad = await mp.externalAds.create({
            id,
            title,
            targetUrl,
            ...values,
            createdAt: now,
          });
          ctx.audit("external_ad.created", "orchestrator", { id, title });
        }

        return Response.json({ success: true, ad });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save external ad" }, { status: 500 });
      }
    }
  }

  if (path.endsWith("/external-ads/impression") && request.method === "POST") {
    // Issue #2022: no impression is ever recorded for a Subscribed
    // caller — nothing was served to them, so nothing counts.
    if (await isAdsSuppressed(request, ctx)) {
      return Response.json({ success: false });
    }
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string; mode?: unknown };
      const mode = resolveRouteMode(ctx, "externalAds", runModeOf(body, url));
      const id = body.id;
      if (id) {
        const mp = await ctx.getOrm().marketplacePorts((ctx.env ?? {}) as unknown as { AGENT_DB?: unknown });
        const ad = await mp.externalAds.findById(id);
        if (ad) {
          const newImpressions = ad.impressions + 1;
          const newEarnings = externalAdImpressionEarnings(ad.earnings, ad.cpmRate, mode);
          await mp.externalAds.update(id, {
            impressions: newImpressions,
            earnings: newEarnings,
          });
          return Response.json({ success: true, impressions: newImpressions, earnings: newEarnings });
        }
        // #1721: mcp mode maps the command's not-found throw to 404.
        if (mode === "mcp") {
          return Response.json({ error: `Ad ${id} not found` }, { status: 404 });
        }
      } else if (mode === "mcp") {
        return Response.json({ error: "Ad id is required for impression recording" }, { status: 400 });
      }
      return Response.json({ success: false });
    } catch {
      return Response.json({ success: false });
    }
  }

  if (path.endsWith("/external-ads/click") && request.method === "POST") {
    // Issue #2022: no click is ever recorded for a Subscribed caller.
    if (await isAdsSuppressed(request, ctx)) {
      return Response.json({ success: false });
    }
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string; mode?: unknown };
      const mode = resolveRouteMode(ctx, "externalAds", runModeOf(body, url));
      const id = body.id;
      if (id) {
        const mp = await ctx.getOrm().marketplacePorts((ctx.env ?? {}) as unknown as { AGENT_DB?: unknown });
        const ad = await mp.externalAds.findById(id);
        if (ad) {
          const newClicks = ad.clicks + 1;
          const newEarnings = externalAdClickEarnings(ad.earnings, ad.cpcRate, mode);
          await mp.externalAds.update(id, {
            clicks: newClicks,
            earnings: newEarnings,
          });
          ctx.audit("external_ad.clicked", "orchestrator", { id, clicks: newClicks, earnings: newEarnings });
          return Response.json({ success: true, clicks: newClicks, earnings: newEarnings });
        }
        if (mode === "mcp") {
          return Response.json({ error: `Ad ${id} not found` }, { status: 404 });
        }
      } else if (mode === "mcp") {
        return Response.json({ error: "Ad id is required for click recording" }, { status: 400 });
      }
      return Response.json({ success: false });
    } catch {
      return Response.json({ success: false });
    }
  }

  return null;
}

/**
 * Handles the community group: referral links (+ click tracking) and
 * sponsored ads (+ click tracking). Invoked from routeRequest at the
 * position between the /memory block and the payments block.
 */
export async function handleReferralsAdsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AdsRevenueReferralsRouteContext
): Promise<Response | null> {
  // Referrals & Affiliate Links endpoint
  // #1721: value contract switched by REFERRALS_MODE (default route:
  // "AI & Dev Tools" / "Community referral reward", created_at DESC
  // LIMIT 100). No referral update path exists on either surface and
  // this slice adds none — a POST body id is ignored, as before.
  ctx.ensureTables();
  // #2345: referrals + sponsored ads serve through the
  // marketplace ports — the raw statements over the
  // ensureTables() handle that used to live in this handler
  // (SELECT/INSERT/DELETE/UPDATE on mas_referrals + mas_ads)
  // are retired; the ports resolve to D1 when AGENT_DB is
  // bound and to this instance's tables when it is not.
  // Composed lazily per block so paths that never touch the
  // marketplace tables (banner-config) keep not touching the
  // ORM at all, exactly as before.
  const marketplace = () =>
    ctx.getOrm().marketplacePorts((ctx.env ?? {}) as unknown as { AGENT_DB?: unknown });

  if (path.endsWith("/referrals")) {
    const mp = await marketplace();
    if (request.method === "GET") {
      try {
        const mode = resolveRouteMode(ctx, "referrals", runModeOf(null, url));
        const options = referralListOptions(mode);
        const referrals = await mp.referrals.findMany({
          orderBy: options.orderBy,
          limit: options.limit,
        });
        return Response.json({ count: referrals.length, referrals });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch referrals" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          title?: string;
          url?: string;
          category?: string;
          rewardText?: string;
          mode?: unknown;
        };
        const mode = resolveRouteMode(ctx, "referrals", runModeOf(body, url));
        const title = (body.title || "").trim();
        const targetUrl = (body.url || "").trim();
        const { category, rewardText } = referralCreateValues(body, mode);

        if (!title || !targetUrl) {
          return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
        }

        const id = `ref_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        await mp.referrals.create({
          id,
          userLogin: sessionId,
          title,
          url: targetUrl,
          category,
          rewardText,
          clicks: 0,
          signups: 0,
          createdAt: now,
        });
        ctx.audit("referral.created", "orchestrator", { id, title, targetUrl });
        return Response.json({
          success: true,
          referral: { id, userLogin: sessionId, title, url: targetUrl, category, rewardText, clicks: 0, signups: 0, createdAt: now },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save referral link" }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      try {
        const mode = resolveRouteMode(ctx, "referrals", runModeOf(null, url));
        const id = url.searchParams.get("id");
        // #1721: mcp mode maps the command's missing-id throw to 400.
        if (mode === "mcp" && !id) {
          return Response.json({ error: "Referral id is required for delete" }, { status: 400 });
        }
        if (id) {
          await mp.referrals.delete(id);
          ctx.audit("referral.deleted", "orchestrator", { id });
        }
        // #1721: mcp-mode envelope echoes the id like the command;
        // no `deleted` flag is claimed in this envelope (unlike
        // the command path) — the response contract is unchanged
        // by the #2345 port move underneath it.
        return mode === "mcp" && id
          ? Response.json({ success: true, id })
          : Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete referral" }, { status: 500 });
      }
    }
  }

  if (path.endsWith("/referrals/click") && request.method === "POST") {
    const mp = await marketplace();
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string; mode?: unknown };
      const mode = resolveRouteMode(ctx, "referrals", runModeOf(body, url));
      if (mode === "mcp") {
        // MCP missing-id / not-found semantics, HTTP-mapped.
        if (!body.id) {
          return Response.json({ error: "Referral id is required for track_click" }, { status: 400 });
        }
        const existing = await mp.referrals.findById(body.id);
        if (!existing) {
          return Response.json({ error: `Referral ${body.id} not found` }, { status: 404 });
        }
        const clicks = await mp.referrals.incrementCounter(body.id, "clicks", 1);
        return Response.json({ success: true, clicks: clicks ?? 0 });
      }
      if (body.id) {
        await mp.referrals.incrementCounter(body.id, "clicks", 1);
      }
      return Response.json({ success: true });
    } catch {
      return Response.json({ success: false });
    }
  }

  // Sponsored Ads & Marketplace endpoint
  // Seed default sponsor offers when the table is empty (the orchestrator's
  // table-creation seed only runs on first creation — an existing-but-empty
  // table never gets seeded).
  async function ensureAdsSeeded(ads: MarketplacePorts["ads"]): Promise<void> {
    try {
      if ((await ads.count()) > 0) return;
      const now = new Date().toISOString();
      // #2345: the route's supplementary seed set, unchanged —
      // it fires only when the serving table is completely
      // empty (in D1 composition the canonical seed in
      // ensureD1Marketplace lands first, so this stays the
      // unbound-composition seed, as the PR discloses).
      const seedAds: AdRecord[] = [
        {
          id: "ad_workers_ai",
          title: "Cloudflare Workers AI",
          tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
          sponsor: "Cloudflare",
          badge: "FLAGSHIP PARTNER",
          url: "https://developers.cloudflare.com/workers-ai/",
          ctaText: "Deploy in 60s →",
          accentColor: "#f38020",
          impressions: 0,
          clicks: 0,
          createdAt: now,
        },
        {
          id: "ad_ai_search",
          title: "Cloudflare AI Search",
          tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
          sponsor: "Cloudflare AI",
          badge: "FEATURED TOOL",
          url: "https://developers.cloudflare.com/ai-search/",
          ctaText: "Explore Docs →",
          accentColor: "#38bdf8",
          impressions: 0,
          clicks: 0,
          createdAt: now,
        },
        {
          id: "ad_durable_objects",
          title: "Durable Objects SQLite",
          tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
          sponsor: "Cloudflare Platform",
          badge: "INFRASTRUCTURE",
          url: "https://developers.cloudflare.com/durable-objects/",
          ctaText: "Learn More →",
          accentColor: "#a855f7",
          impressions: 0,
          clicks: 0,
          createdAt: now,
        },
        {
          id: "ad_openaimp",
          title: "OpenAIMP Agent Studio",
          tagline: "Scale autonomous multi-agent workflows with real-time LLM Judge routing and persistent memory.",
          sponsor: "OpenAIMP",
          badge: "SPONSOR",
          url: "https://agent.openaimp.com",
          ctaText: "Join Program →",
          accentColor: "#10b981",
          impressions: 0,
          clicks: 0,
          createdAt: now,
        },
      ];
      for (const ad of seedAds) {
        await ads.create(ad);
      }
    } catch {
      // Ignore if seeding fails
    }
  }

  // Issue #2022: server-resolved ad config for the client display
  // override. Free allows everything (local preference governs);
  // Subscribed allows nothing. The client ANDs this with local
  // preference; the server lists remain the enforcement boundary.
  if (path.endsWith("/ads/banner-config") && request.method === "GET") {
    const viewer = await resolveAdsViewer(request, ctx);
    const config = resolveServerAdsConfig(viewer.tier);
    return Response.json({
      ...config,
      adsAllowed: config.adsAllowed && viewer.tenantAdsEnabled,
      googleUnitsAllowed: config.googleUnitsAllowed && viewer.tenantAdsEnabled,
      sponsorSpotlightAllowed: config.sponsorSpotlightAllowed && viewer.tenantAdsEnabled,
      adNetworkStripAllowed: config.adNetworkStripAllowed && viewer.tenantAdsEnabled,
    });
  }

  if (path.endsWith("/ads")) {
    const mp = await marketplace();
    if (request.method === "GET") {
      // Issue #2022: a Subscribed caller is served nothing — before
      // seeding and before the fetch impression increment, so no
      // write and no count happens for that caller.
      if (await isAdsSuppressed(request, ctx)) {
        return Response.json({ count: 0, ads: [] });
      }
      try {
        await ensureAdsSeeded(mp.ads);
        // Increment impressions on fetch
        await mp.ads.incrementAllImpressions(1);
        const records = await mp.ads.findMany({
          orderBy: "clicks DESC, impressions ASC",
          limit: 20,
        });
        const ads = records.map((a) => ({
          id: String(a.id),
          title: String(a.title),
          tagline: String(a.tagline),
          sponsor: String(a.sponsor),
          badge: String(a.badge),
          url: String(a.url),
          ctaText: String(a.ctaText),
          accentColor: String(a.accentColor || "#6366f1"),
          impressions: Number(a.impressions || 0),
          clicks: Number(a.clicks || 0),
          createdAt: String(a.createdAt),
        }));
        return Response.json({ count: ads.length, ads });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch ads" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          title?: string;
          tagline?: string;
          sponsor?: string;
          badge?: string;
          url?: string;
          ctaText?: string;
          accentColor?: string;
        };
        const title = (body.title || "").trim();
        const tagline = (body.tagline || "").trim();
        const sponsor = (body.sponsor || "Community Partner").trim();
        const badge = (body.badge || "PROMOTED").trim();
        const targetUrl = (body.url || "").trim();
        const ctaText = (body.ctaText || "Claim Deal →").trim();
        const accentColor = (body.accentColor || "#38bdf8").trim();

        if (!title || !targetUrl) {
          return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
        }

        const id = `ad_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        await mp.ads.create({
          id,
          title,
          tagline,
          sponsor,
          badge,
          url: targetUrl,
          ctaText,
          accentColor,
          impressions: 1,
          clicks: 0,
          createdAt: now,
        });
        ctx.audit("ad.submitted", "orchestrator", { id, title, sponsor });
        return Response.json({
          success: true,
          ad: { id, title, tagline, sponsor, badge, url: targetUrl, ctaText, accentColor, impressions: 1, clicks: 0, createdAt: now },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to submit ad" }, { status: 500 });
      }
    }
  }

  if (path.endsWith("/ads/click") && request.method === "POST") {
    // Issue #2022: no click is ever recorded for a Subscribed caller.
    if (await isAdsSuppressed(request, ctx)) {
      return Response.json({ success: false });
    }
    const mp = await marketplace();
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      if (body.id) {
        await mp.ads.incrementCounter(body.id, "clicks", 1);
        ctx.audit("ad.clicked", "orchestrator", { id: body.id });
      }
      return Response.json({ success: true });
    } catch {
      return Response.json({ success: false });
    }
  }

  return null;
}
