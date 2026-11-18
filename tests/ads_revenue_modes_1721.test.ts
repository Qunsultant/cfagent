/**
 * #1721 (parent #1717, slice (a)): categories / referrals / external-ads
 * unification — NEVER EITHER/OR, ALWAYS CONFIGURABLE.
 *
 * One runtime switch per pair (CATEGORIES_MODE, REFERRALS_MODE,
 * EXTERNAL_ADS_MODE), each "route" | "mcp", built-in default "route"
 * (current public route behavior). Resolution order, owner directive
 * 2026-10-26: run > session > user > global env > built-in. An invalid
 * value at the winning level fails closed to "route" and is audited as
 * `<domain>.config_error` (it does NOT fall through to a lower level).
 *
 * Audit parity is NOT switched: both surfaces audit in both modes with
 * the route event names (the scan's MCP audit silence is closed, not
 * preserved as a mode). Transport envelopes stay per surface (REST HTTP
 * mapping vs MCP throws); the switched contract is the VALUE contract
 * (ids, defaults, slug rules, sort/order/limit, money defaults,
 * rounding, initial ledger, update field sets, missing-id semantics).
 *
 * Referral update: NEITHER surface has one, and this slice adds none —
 * the gap stands, recorded in the PR body and §15.
 * Sponsored /ads (mas_ads) is NOT part of this slice.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";
import {
  resolveAdsRevenueMode,
  type AdsRevenueScopedModes,
} from "../src/config/adsRevenueModes";

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

const toolCtx = (overrides: Record<string, any> = {}) => {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  const audit = vi.fn();
  return {
    sql,
    orm,
    audit,
    ctx: {
      env: {},
      orm,
      sessionId: "sess-1",
      audit,
      ...overrides,
    } as any,
  };
};

const runTool = (name: string, input: Record<string, unknown>, ctx: any) =>
  McpToolFactory.executeTool(name, input, ctx);

describe("resolver: run > session > user > env > builtin(route)", () => {
  it("defaults to route when every level is blank", () => {
    expect(resolveAdsRevenueMode({})).toEqual({
      mode: "route",
      invalid: false,
      raw: undefined,
      level: "builtin",
    });
  });

  it("is case-insensitive and trims", () => {
    expect(resolveAdsRevenueMode({ env: "  MCP " }).mode).toBe("mcp");
    expect(resolveAdsRevenueMode({ env: "Route" }).mode).toBe("route");
  });

  it("run beats session beats user beats env", () => {
    expect(
      resolveAdsRevenueMode({ run: "route", session: "mcp", user: "mcp", env: "mcp" }).mode
    ).toBe("route");
    expect(
      resolveAdsRevenueMode({ session: "route", user: "mcp", env: "mcp" }).mode
    ).toBe("route");
    expect(resolveAdsRevenueMode({ user: "route", env: "mcp" }).mode).toBe("route");
    expect(resolveAdsRevenueMode({ env: "mcp" }).mode).toBe("mcp");
  });

  it("blank levels fall through; an invalid winning value fails closed to route, not to a lower level", () => {
    expect(resolveAdsRevenueMode({ run: "", session: "mcp" }).mode).toBe("mcp");
    const bad = resolveAdsRevenueMode({ run: "bogus", session: "mcp", env: "mcp" });
    expect(bad.mode).toBe("route");
    expect(bad.invalid).toBe(true);
    expect(bad.raw).toBe("bogus");
    expect(bad.level).toBe("run");
    expect(resolveAdsRevenueMode({ env: 42 }).invalid).toBe(true);
  });
});

describe("categories command: both modes, audit parity", () => {
  it("default (route mode): route id scheme, route description, append sortOrder, audits", async () => {
    const { ctx, audit, orm } = toolCtx();
    const out = await runTool("manage_categories", { action: "create", name: "Dev Tools" }, ctx);
    expect(out.category.id).toMatch(/^cat_dev-tools_[0-9a-f]{4}$/);
    expect(out.category.slug).toBe("dev-tools");
    expect(out.category.description).toBe("Category for Dev Tools partner links");
    expect(out.category.sortOrder).toBe(1);
    expect(out.category.isActive).toBe(true);
    expect(audit).toHaveBeenCalledWith("category.created", "orchestrator", expect.objectContaining({ id: out.category.id }));
    expect(orm.categories.findById(out.category.id)).not.toBeNull();
  });

  it("mcp mode: deterministic id, mcp description, fixed sortOrder 10, still audits", async () => {
    const { ctx, audit } = toolCtx({ env: { CATEGORIES_MODE: "mcp" } });
    const out = await runTool("manage_categories", { action: "create", name: "Dev Tools" }, ctx);
    expect(out.category.id).toBe("cat_dev_tools");
    expect(out.category.description).toBe("Dev Tools category tools and services");
    expect(out.category.sortOrder).toBe(10);
    expect(out.category.isActive).toBe(true);
    expect(audit).toHaveBeenCalledWith("category.created", "orchestrator", expect.anything());
  });

  it("mcp mode honors a caller-supplied id; route mode generates its own", async () => {
    const mcp = toolCtx({ env: { CATEGORIES_MODE: "mcp" } });
    const a = await runTool("manage_categories", { action: "create", id: "cat_custom", name: "X" }, mcp.ctx);
    expect(a.category.id).toBe("cat_custom");
    const route = toolCtx();
    const b = await runTool("manage_categories", { action: "create", id: "cat_custom", name: "X" }, route.ctx);
    expect(b.category.id).not.toBe("cat_custom");
    expect(b.category.id).toMatch(/^cat_x_[0-9a-f]{4}$/);
  });

  it("run mode beats env; session carrier beats env; invalid env fails closed with config_error audit", async () => {
    const run = toolCtx({ env: { CATEGORIES_MODE: "mcp" } });
    const out = await runTool("manage_categories", { action: "create", name: "Y", mode: "route" }, run.ctx);
    expect(out.category.id).toMatch(/^cat_y_[0-9a-f]{4}$/);

    const scoped: AdsRevenueScopedModes = { categories: { session: "mcp" } };
    const sess = toolCtx({ env: { CATEGORIES_MODE: "route" }, scopedModes: scoped });
    const out2 = await runTool("manage_categories", { action: "create", name: "Z" }, sess.ctx);
    expect(out2.category.id).toBe("cat_z");

    const bad = toolCtx({ env: { CATEGORIES_MODE: "bogus" } });
    const out3 = await runTool("manage_categories", { action: "create", name: "W" }, bad.ctx);
    expect(out3.category.id).toMatch(/^cat_w_[0-9a-f]{4}$/);
    expect(bad.audit).toHaveBeenCalledWith(
      "category.config_error",
      "orchestrator",
      expect.objectContaining({ setting: "CATEGORIES_MODE", resolved: "route" })
    );
  });

  it("update: route mode recomputes slug and honors isActive; mcp mode never touches slug/isActive", async () => {
    const { ctx } = toolCtx();
    const created = await runTool("manage_categories", { action: "create", name: "Alpha" }, ctx);
    const id = created.category.id;
    const updRoute = await runTool(
      "manage_categories",
      { action: "update", id, name: "Beta Gamma", isActive: false },
      ctx
    );
    expect(updRoute.category.slug).toBe("beta-gamma");
    expect(updRoute.category.isActive).toBe(false);

    const mcp = toolCtx({ env: { CATEGORIES_MODE: "mcp" } });
    const created2 = await runTool("manage_categories", { action: "create", name: "Alpha" }, mcp.ctx);
    const updMcp = await runTool(
      "manage_categories",
      { action: "update", id: created2.category.id, name: "Beta Gamma", isActive: false } as any,
      mcp.ctx
    );
    expect(updMcp.category.slug).toBe("alpha");
    expect(updMcp.category.isActive).toBe(true);
  });

  it("delete: route mode is silent without an id; mcp mode throws without an id", async () => {
    const route = toolCtx();
    await expect(
      runTool("manage_categories", { action: "delete" }, route.ctx)
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    const mcp = toolCtx({ env: { CATEGORIES_MODE: "mcp" } });
    await expect(runTool("manage_categories", { action: "delete" }, mcp.ctx)).rejects.toThrow(
      "Category id is required"
    );
  });
});

describe("referrals command: both modes", () => {
  it("default: route category/reward defaults; mcp mode: mcp defaults; both audit create", async () => {
    const route = toolCtx();
    const a = await runTool("manage_referrals", { action: "create", title: "T", url: "https://x.example" }, route.ctx);
    expect(a.referral.category).toBe("AI & Dev Tools");
    expect(a.referral.rewardText).toBe("Community referral reward");
    expect(route.audit).toHaveBeenCalledWith("referral.created", "orchestrator", expect.anything());

    const mcp = toolCtx({ env: { REFERRALS_MODE: "mcp" } });
    const b = await runTool("manage_referrals", { action: "create", title: "T", url: "https://x.example" }, mcp.ctx);
    expect(b.referral.category).toBe("AI Tools");
    expect(b.referral.rewardText).toBe("$10 Free Credits");
    expect(mcp.audit).toHaveBeenCalledWith("referral.created", "orchestrator", expect.anything());
  });

  it("list: route mode is created_at DESC capped at 100; mcp mode is clicks DESC uncapped", async () => {
    // Order contract pinned at the builder level (created_at ties at
    // millisecond resolution would make a live-list order assertion
    // flaky); the live list pins the mcp clicks order, which is
    // deterministic, and the route cap.
    const { referralListOptions } = await import("../src/config/adsRevenueModes");
    expect(referralListOptions("route")).toEqual({ orderBy: "created_at DESC", limit: 100 });
    expect(referralListOptions("mcp")).toEqual({ orderBy: "clicks DESC" });

    const { ctx } = toolCtx();
    await runTool("manage_referrals", { action: "create", title: "Low", url: "https://l.example" }, ctx);
    const high = await runTool("manage_referrals", { action: "create", title: "High", url: "https://h.example" }, ctx);
    await runTool("manage_referrals", { action: "track_click", id: high.referral.id, mode: "mcp" }, ctx);
    const routeList = await runTool("manage_referrals", { action: "list" }, ctx);
    expect(routeList.referrals.map((r: any) => r.title).sort()).toEqual(["High", "Low"]);
    expect(routeList.referrals.length).toBeLessThanOrEqual(100);
    const mcpList = await runTool("manage_referrals", { action: "list", mode: "mcp" }, ctx);
    expect(mcpList.referrals[0].title).toBe("High");
  });

  it("click: route mode is silent-success without id and returns no count; mcp mode throws and returns the count", async () => {
    const { ctx } = toolCtx();
    await expect(runTool("manage_referrals", { action: "track_click" }, ctx)).resolves.toEqual({
      success: true,
    });
    await expect(runTool("manage_referrals", { action: "track_click", id: "ref_missing" }, ctx)).resolves.toEqual({
      success: true,
    });
    const created = await runTool("manage_referrals", { action: "create", title: "T", url: "https://x.example" }, ctx);
    const clicked = await runTool(
      "manage_referrals",
      { action: "track_click", id: created.referral.id, mode: "mcp" },
      ctx
    );
    expect(clicked).toEqual({ success: true, clicks: 1 });
    await expect(
      runTool("manage_referrals", { action: "track_click", id: "ref_missing", mode: "mcp" }, ctx)
    ).rejects.toThrow("not found");
  });

  it("delete: route mode silent without id; mcp mode throws without id", async () => {
    const { ctx } = toolCtx();
    await expect(runTool("manage_referrals", { action: "delete" }, ctx)).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    await expect(runTool("manage_referrals", { action: "delete", mode: "mcp" }, ctx)).rejects.toThrow(
      "Referral id is required"
    );
  });
});

describe("external ads command: both modes (money)", () => {
  it("default: route money, route id, initial impression + earnings; mcp mode: mcp money, 0/0, audits in both", async () => {
    const route = toolCtx();
    const a = await runTool(
      "manage_external_ads",
      { action: "create", title: "Camp", targetUrl: "https://a.example", network: "direct" },
      route.ctx
    );
    expect(a.ad.id).toMatch(/^ext_direct_[0-9a-f]{6}$/);
    expect(a.ad.cpmRate).toBe(15.0);
    expect(a.ad.cpcRate).toBe(1.25);
    expect(a.ad.impressions).toBe(1);
    expect(a.ad.earnings).toBeCloseTo(0.015);
    expect(a.ad.network).toBe("direct");
    expect(a.ad.placement).toBe("header_leaderboard");
    expect(a.ad.ctaText).toBe("Learn More →");
    expect(route.audit).toHaveBeenCalledWith("external_ad.created", "orchestrator", expect.anything());

    const mcp = toolCtx({ env: { EXTERNAL_ADS_MODE: "mcp" } });
    const b = await runTool(
      "manage_external_ads",
      { action: "create", title: "Camp", targetUrl: "https://a.example" },
      mcp.ctx
    );
    expect(b.ad.id).toMatch(/^ext_ad_[0-9a-f]{8}$/);
    expect(b.ad.cpmRate).toBe(2.5);
    expect(b.ad.cpcRate).toBe(0.45);
    expect(b.ad.impressions).toBe(0);
    expect(b.ad.earnings).toBe(0);
    expect(b.ad.network).toBe("ethicalads");
    expect(b.ad.placement).toBe("in_stream");
    expect(b.ad.tagline).toBe("Verified developer partner: Camp");
    expect(mcp.audit).toHaveBeenCalledWith("external_ad.created", "orchestrator", expect.anything());
  });

  it("rounding: route impression 3dp / click 2dp; mcp impression and click 4dp", async () => {
    const route = toolCtx();
    const a = await runTool(
      "manage_external_ads",
      { action: "create", title: "Camp", targetUrl: "https://a.example", network: "direct" },
      route.ctx
    );
    const imp = await runTool("manage_external_ads", { action: "impression", id: a.ad.id }, route.ctx);
    expect(imp.earnings).toBe(0.03); // 0.015 + 0.015, 3dp
    const clk = await runTool("manage_external_ads", { action: "click", id: a.ad.id }, route.ctx);
    expect(clk.earnings).toBe(1.28); // 0.03 + 1.25, 2dp
    expect(route.audit).toHaveBeenCalledWith("external_ad.clicked", "orchestrator", expect.anything());

    const mcp = toolCtx({ env: { EXTERNAL_ADS_MODE: "mcp" } });
    const b = await runTool(
      "manage_external_ads",
      { action: "create", title: "Camp", targetUrl: "https://a.example" },
      mcp.ctx
    );
    const imp2 = await runTool("manage_external_ads", { action: "impression", id: b.ad.id }, mcp.ctx);
    expect(imp2.earnings).toBe(0.0025);
    const clk2 = await runTool("manage_external_ads", { action: "click", id: b.ad.id }, mcp.ctx);
    expect(clk2.earnings).toBe(0.4525);
  });

  it("missing ad: route mode returns success:false; mcp mode throws", async () => {
    const { ctx } = toolCtx();
    await expect(runTool("manage_external_ads", { action: "impression", id: "ext_missing" }, ctx)).resolves.toEqual({
      success: false,
    });
    await expect(
      runTool("manage_external_ads", { action: "click", id: "ext_missing", mode: "mcp" }, ctx)
    ).rejects.toThrow("not found");
  });

  it("update: route mode updates the route field set; mcp mode throws Unsupported (legacy MCP had no update)", async () => {
    const { ctx } = toolCtx();
    const a = await runTool(
      "manage_external_ads",
      { action: "create", title: "Camp", targetUrl: "https://a.example", network: "direct" },
      ctx
    );
    const upd = await runTool(
      "manage_external_ads",
      { action: "update", id: a.ad.id, title: "Camp 2", isActive: false, cpmRate: 20 },
      ctx
    );
    expect(upd.ad.title).toBe("Camp 2");
    expect(upd.ad.isActive).toBe(false);
    expect(upd.ad.cpmRate).toBe(20);
    await expect(
      runTool("manage_external_ads", { action: "update", id: a.ad.id, title: "Nope", mode: "mcp" }, ctx)
    ).rejects.toThrow("Unsupported action: update");
  });
});

/** In-memory ReferralPort fake for the referrals routes (#2345: the
 * routes serve referrals through the port, not raw SQL). Rows are
 * port records; findMany honours the orderBy/limit options the
 * route passes, mirroring the retired SQL fake's semantics. */
const makeReferralPorts = () => {
  const rows: any[] = [];
  const referrals = {
    rows,
    findMany: vi.fn(async (options: any = {}) => {
      let out = [...rows];
      const orderBy = String(options.orderBy ?? "");
      if (orderBy.includes("created_at")) out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (orderBy.includes("clicks")) out.sort((a, b) => b.clicks - a.clicks);
      if (typeof options.limit === "number") out = out.slice(0, options.limit);
      return out;
    }),
    findById: vi.fn(async (id: string) => rows.find((x) => x.id === id) ?? null),
    create: vi.fn(async (rec: any) => { rows.push(rec); return rec; }),
    update: vi.fn(async (id: string, patch: any) => {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, patch);
      return r;
    }),
    delete: vi.fn(async (id: string) => {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    }),
    count: vi.fn(async () => rows.length),
    incrementCounter: vi.fn(async (id: string, counter: string, delta: number) => {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      r[counter] += delta;
      return r[counter];
    }),
  };
  return referrals;
};

const routeCtx = (overrides: Record<string, any> = {}, sql?: any) => {
  const audit = vi.fn();
  const categories = {
    findMany: vi.fn(() => []),
    findById: vi.fn(() => null),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
    delete: vi.fn(),
    count: vi.fn(() => 3),
  };
  const externalAds = {
    findMany: vi.fn(() => []),
    findById: vi.fn(() => null),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
  };
  const referrals = makeReferralPorts();
  const ads: any = {
    findMany: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    create: vi.fn(async (rec: any) => rec),
    update: vi.fn(async (id: string, patch: any) => ({ id, ...patch })),
    delete: vi.fn(async () => false),
    count: vi.fn(async () => 0),
    incrementCounter: vi.fn(async () => null),
    incrementAllImpressions: vi.fn(async () => undefined),
  };
  const orm: any = {
    categories,
    externalAds,
    transactions: { findMany: vi.fn(() => []) },
    getRevenueSummary: vi.fn(() => ({ total: 0 })),
    // #2345: the routes resolve the marketplace ports through
    // the facade's builder; the stub serves the same stub
    // repositories as the ports.
    marketplacePorts: vi.fn(async () => ({ categories, externalAds, ads, referrals })),
  };
  const ctx = {
    getOrm: () => orm,
    ensureTables: () => sql ?? ({ exec: vi.fn(() => []) } as any),
    audit,
    ...overrides,
  } as AdsRevenueReferralsRouteContext;
  return { ctx, audit, orm, sql, referrals };
};

describe("routes: mode resolution on the REST surface", () => {
  it("POST /categories default is route behavior; body mode=mcp selects mcp behavior", async () => {
    const { ctx, orm } = routeCtx();
    const res = await handleAdsRevenueReferralsRoutes(
      req("POST", "/categories", { name: "Dev Tools" }),
      urlOf("/categories"),
      "/categories",
      "sess-1",
      ctx
    );
    const body = await res!.json();
    expect(body.category.id).toMatch(/^cat_dev-tools_[0-9a-f]{4}$/);
    expect(body.category.description).toBe("Category for Dev Tools partner links");
    expect(body.category.sortOrder).toBe(4); // count() 3 + 1
    expect(orm.categories.create).toHaveBeenCalled();

    const mcp = routeCtx();
    const res2 = await handleAdsRevenueReferralsRoutes(
      req("POST", "/categories", { name: "Dev Tools", mode: "mcp" }),
      urlOf("/categories"),
      "/categories",
      "sess-1",
      mcp.ctx
    );
    const body2 = await res2!.json();
    expect(body2.category.id).toBe("cat_dev_tools");
    expect(body2.category.description).toBe("Dev Tools category tools and services");
    expect(body2.category.sortOrder).toBe(10);
  });

  it("route env CATEGORIES_MODE=mcp selects mcp; invalid env fails closed to route with config_error", async () => {
    const envCtx = routeCtx({ env: { CATEGORIES_MODE: "mcp" } });
    const res = await handleAdsRevenueReferralsRoutes(
      req("POST", "/categories", { name: "Alpha" }),
      urlOf("/categories"),
      "/categories",
      "sess-1",
      envCtx.ctx
    );
    expect((await res!.json()).category.id).toBe("cat_alpha");

    const bad = routeCtx({ env: { CATEGORIES_MODE: "bogus" } });
    const res2 = await handleAdsRevenueReferralsRoutes(
      req("POST", "/categories", { name: "Beta" }),
      urlOf("/categories"),
      "/categories",
      "sess-1",
      bad.ctx
    );
    expect((await res2!.json()).category.id).toMatch(/^cat_beta_[0-9a-f]{4}$/);
    expect(bad.audit).toHaveBeenCalledWith(
      "category.config_error",
      "orchestrator",
      expect.objectContaining({ setting: "CATEGORIES_MODE", resolved: "route" })
    );
  });

  it("POST /external-ads route update in mcp mode is refused (legacy MCP had no update); route mode updates", async () => {
    const { ctx, orm } = routeCtx();
    orm.externalAds.findById.mockReturnValue({ id: "ext_direct_abcdef", title: "Old", cpmRate: 15 });
    const ok = await handleAdsRevenueReferralsRoutes(
      req("POST", "/external-ads", { id: "ext_direct_abcdef", title: "New", targetUrl: "https://a.example" }),
      urlOf("/external-ads"),
      "/external-ads",
      "sess-1",
      ctx
    );
    expect(ok!.status).toBe(200);
    expect(orm.externalAds.update).toHaveBeenCalled();

    const mcp = routeCtx();
    mcp.orm.externalAds.findById.mockReturnValue({ id: "ext_direct_abcdef", title: "Old", cpmRate: 15 });
    const refused = await handleAdsRevenueReferralsRoutes(
      req("POST", "/external-ads", { id: "ext_direct_abcdef", title: "New", targetUrl: "https://a.example", mode: "mcp" }),
      urlOf("/external-ads"),
      "/external-ads",
      "sess-1",
      mcp.ctx
    );
    expect(refused!.status).toBe(400);
    expect(mcp.orm.externalAds.update).not.toHaveBeenCalled();
  });

  it("POST /external-ads default money is route money; mcp mode money via body mode", async () => {
    const { ctx } = routeCtx();
    const res = await handleAdsRevenueReferralsRoutes(
      req("POST", "/external-ads", { title: "Camp", targetUrl: "https://a.example", network: "direct" }),
      urlOf("/external-ads"),
      "/external-ads",
      "sess-1",
      ctx
    );
    const body = await res!.json();
    expect(body.ad.cpmRate).toBe(15.0);
    expect(body.ad.impressions).toBe(1);

    const mcp = routeCtx();
    const res2 = await handleAdsRevenueReferralsRoutes(
      req("POST", "/external-ads", { title: "Camp", targetUrl: "https://a.example", mode: "mcp" }),
      urlOf("/external-ads"),
      "/external-ads",
      "sess-1",
      mcp.ctx
    );
    const body2 = await res2!.json();
    expect(body2.ad.cpmRate).toBe(2.5);
    expect(body2.ad.impressions).toBe(0);
  });

  it("referrals routes: default list is created_at DESC capped; mcp mode list is clicks DESC; click silent vs count", async () => {
    const { ctx, referrals } = routeCtx();
    // Seed with distinct createdAt values so the created_at DESC
    // order is deterministic (live creates share a millisecond).
    referrals.rows.push(
      { id: "ref_low", userLogin: "sess-1", title: "Low", url: "https://l.example", category: "AI & Dev Tools", rewardText: "Community referral reward", clicks: 0, signups: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "ref_high", userLogin: "sess-1", title: "High", url: "https://h.example", category: "AI & Dev Tools", rewardText: "Community referral reward", clicks: 5, signups: 0, createdAt: "2026-01-02T00:00:00.000Z" }
    );
    const created = await handleReferralsAdsRoutes(
      req("POST", "/referrals", { title: "New", url: "https://n.example" }),
      urlOf("/referrals"),
      "/referrals",
      "sess-1",
      ctx
    );
    expect((await created!.json()).referral.category).toBe("AI & Dev Tools");
    const list = await handleReferralsAdsRoutes(
      req("GET", "/referrals"),
      urlOf("/referrals"),
      "/referrals",
      "sess-1",
      ctx
    );
    const listBody = await list!.json();
    expect(listBody.referrals.map((r: any) => r.title)).toEqual(["New", "High", "Low"]);
    expect(listBody.referrals[0].category).toBe("AI & Dev Tools");
    // MCP-mode list is clicks DESC: High (5) first.
    const mcpList = await handleReferralsAdsRoutes(
      req("GET", "/referrals?mode=mcp"),
      urlOf("/referrals?mode=mcp"),
      "/referrals",
      "sess-1",
      ctx
    );
    expect((await mcpList!.json()).referrals[0].title).toBe("High");
    // Route click in mcp mode: missing id maps to 400 (transport mapping of the MCP throw).
    const badClick = await handleReferralsAdsRoutes(
      req("POST", "/referrals/click", { mode: "mcp" }),
      urlOf("/referrals/click"),
      "/referrals/click",
      "sess-1",
      ctx
    );
    expect(badClick!.status).toBe(400);
  });

  it("GET /revenue still passes the single summary through unchanged (C-4 pin)", async () => {
    // #2345 adaptation: the summary's DEFINITION moved from the
    // facade's getRevenueSummary() to the shared
    // computeMarketplaceRevenueSummary over the ports (the
    // stub's fake { total: 0 } was never a real summary shape);
    // the pin still asserts the route passes the one computed
    // summary object through unmolested — here, the all-zero
    // summary of the empty stub ports. #5235: the shape grew
    // by the subscription + pay-per-run cuts (zero-filled) and
    // costPerRun null.
    const { ctx } = routeCtx();
    const res = await handleAdsRevenueReferralsRoutes(
      req("GET", "/revenue"),
      urlOf("/revenue"),
      "/revenue",
      "sess-1",
      ctx
    );
    expect(await res!.json()).toEqual({
      grossRevenue: 0,
      adNetworkRevenue: 0,
      marketplaceRevenue: 0,
      paymentPlatformFees: 0,
      referralPayouts: 0,
      netRevenue: 0,
      totalImpressions: 0,
      totalAdClicks: 0,
      averageRPM: 18.5,
      subscriptionRevenue: 0,
      subscriptionCount: 0,
      payPerRunRevenue: 0,
      payPerRunByFamily: [
        { family: "stock", revenue: 0, runs: 0 },
        { family: "options", revenue: 0, runs: 0 },
        { family: "goal", revenue: 0, runs: 0 },
        { family: "strategy", revenue: 0, runs: 0 },
      ],
      runRevenueByCoverage: [
        { coverage: "paid", runs: 0, revenue: 0, listValue: 0 },
        { coverage: "subscription_included", runs: 0, revenue: 0, listValue: 0 },
        { coverage: "credits", runs: 0, revenue: 0, listValue: 0 },
      ],
      costPerRun: null,
    });
  });
});
