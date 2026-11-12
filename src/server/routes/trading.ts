/**
 * Trading & market branches for the Worker entry (src/server.ts).
 *
 * Slice 5 of Qunsultant/cfagent#2902 — moves only. Each handler below is a
 * verbatim block moved out of handleFetch, in its original position in the
 * dispatch chain; it returns null when no branch matches so handleFetch
 * falls through to the next delegation exactly as the inline chain did.
 * Branch lines keep their original indentation on purpose: re-indenting
 * would shift lines inside template literals and change response bytes.
 *
 * Handler signatures take the handleFetch locals the branches used
 * (request, env, url, path); shared auth comes from ../auth. The
 * WebSocket upgrade dispatch (dispatchWsUpgrade) stays inline in
 * server.ts between the schedules forward and the quotes branches:
 * it is not a route branch (no path condition) and its position is
 * part of the dispatch contract.
 */

import type { Env } from "../../types";
import { DEFAULT_SCHEDULES } from "../../schedule";
import { OPERATION_CATALOG } from "../../orchestrate";
import { SCHEDULE_SYSTEMS, WORKER_CRON_TRIGGERS_INVENTORY } from "../../services/scheduleSystems";
import { actorGateway } from "../../services/cloudflareActorGateway";
import {
  buildScheduleProvenance,
} from "../../services/consolidatedScheduling";
import { mergeLedgerRuns } from "../../services/unifiedLedger";
import { workerDutiesFromInventory } from "../../services/unifiedScheduleManagement";
import type { JobRunRecord } from "../../services/jobRunRecords";
import { requireAuth } from "../auth";
import { evaluateRoutePep } from "../../security/pepGateway";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { createKvPermissionDenialStore } from "../../security/iaaaPermissionDenialStore";
import { sessionStore } from "../../security/session";
import { confirmSlackLink, INBOUND_EMAIL_ORCHESTRATOR_INSTANCE, verifyApprovalLinkForPrincipal, DEFAULT_SAVED_PRESETS, getDynamicLiveFlowItems, getDynamicFlowSummary, summarizeFlowProvenance, fetchRealMarketNews, fetchRealSecInsiderFilings, fetchRealCongressDisclosures, MarketCapCategory, AssetClassCategory } from "../../trading";
import { handleMarketQuotesHttp } from "../../services/marketStream";
import { getQuoteSource, setQuoteSource, normalizeQuoteSource, type QuoteSourceStore } from "../../services/quoteSourceSetting";
import { levelsForQuoteSwitch, resolveQuoteExpiryMode, resolveQuoteHttpProviderMode } from "../../config/quoteModes";

/**
 * Slice 5 of Qunsultant/cfagent#2902 (Trading & market) — moves only.
 * The /api/schedule/* family of handleFetch, verbatim and in original
 * order: goals, operations, ticks, runs, systems (one combined block,
 * sub-branches by path/method). Returns null when no branch matches, so
 * handleFetch falls through to the next delegation exactly as the inline
 * chain did.
 */
export async function handleTradingScheduleRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // Issue #3121 Phase 2 (#3123) — the one merged ledger read.
    // Session-gated like every /api/schedule/* route below:
    // unauthenticated → 401, before any DO stub. Fans out to the
    // per-login orchestrator (/api/schedules/runs, the DO-SQLite
    // half) and the ScheduledAgent (listJobRuns, the KV half) and
    // merges newest-first with dedup on jobId+started+operation; a
    // failed half answers partial:true with the half that
    // succeeded, never a bare failure. A jobId filter applies to
    // the merged list (both halves carry it as jobId).
    if (path === "/api/ledger/runs" && request.method === "GET") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const params = new URL(request.url).searchParams;
      const jobId = params.get("jobId") || undefined;
      const limit = Number(params.get("limit") || 50);
      const userLogin = session.githubLogin;
      let orchRuns: JobRunRecord[] = [];
      let goalRuns: JobRunRecord[] = [];
      let partial = false;
      try {
        const targetUrl = new URL(
          `/schedules/runs?limit=${limit}${jobId ? `&scheduleId=${encodeURIComponent(jobId)}` : ""}`,
          "https://agent.internal",
        );
        const forwardReq = new Request(targetUrl, request);
        forwardReq.headers.set("x-user-login", userLogin);
        const res = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
        const data = (await res.json().catch(() => null)) as { ok?: unknown; runs?: unknown } | null;
        if (res.ok && data && Array.isArray(data.runs)) {
          orchRuns = data.runs as JobRunRecord[];
        } else {
          partial = true;
        }
      } catch {
        partial = true;
      }
      try {
        const sched = actorGateway.stub<{
          listJobRuns(jobId?: string, limit?: number): Promise<unknown[]>;
        }>((env as any).SCHEDULED_AGENT, "default");
        goalRuns = (await sched.listJobRuns(jobId, limit)) as JobRunRecord[];
      } catch {
        partial = true;
      }
      let runs = mergeLedgerRuns(orchRuns, goalRuns);
      if (jobId) runs = runs.filter((run) => run.jobId === jobId);
      return Response.json({ ok: true, runs: runs.slice(0, limit), partial });
    }

    // Issue #159 — ScheduledAgent dashboard API.
    // Issue #1156: session-gated, like the social brief/approval routes
    // below — unauthenticated → 401. Any signed-in user may use the
    // dashboard; no admin gate is invented here. The gate sits before
    // the DO stub so an unauthenticated call never reaches the
    // ScheduledAgent.
    if (path.startsWith("/api/schedule/")) {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const sched = actorGateway.stub<{
        listGoals(): Promise<unknown[]>;
        getTickHistory(limit?: number): Promise<unknown[]>;
        addGoal(goal: Record<string, unknown>): Promise<unknown>;
        removeGoal(id: string, actor?: string | null): Promise<boolean>;
        setGoalEnabled(id: string, enabled: boolean, actor?: string | null): Promise<boolean>;
        triggerGoal(id: string, env?: unknown, actor?: string | null): Promise<unknown>;
        listJobRuns(jobId?: string, limit?: number): Promise<unknown[]>;
        // Issue #3122 — pending goal-approval decisions (the DO
        // methods enforce the state machine and arm under the
        // original requester's principal).
        listPendingGoalApprovals(): Promise<unknown[]>;
        approvePendingGoalApproval(id: string, decidedBy: string): Promise<unknown>;
        rejectPendingGoalApproval(id: string, decidedBy: string): Promise<unknown>;
      }>((env as any).SCHEDULED_AGENT, "default");

      // Issue #3121 S3 (#3312) — goal lifecycle audit: the four
      // `schedule.goal.*` events are emitted by the ScheduledAgent
      // mutation methods themselves (the DO-side sink, the one
      // funnel every entry path flows through). The S1 route funnel
      // that posted them here is retired: this route threads the
      // session actor into the methods instead, so each mutation
      // still emits exactly one event — same event, same payload,
      // same actor — and the A2A path (which bypassed this funnel)
      // is audited too. Best-effort inside the methods: an audit
      // failure never fails the mutation (the `this.audit` swallow
      // rule).

      if (path === "/api/schedule/goals" && request.method === "GET") {
        return Response.json({ ok: true, goals: await sched.listGoals() });
      }
      // Issue #1922 — operation catalog for the goals UI dropdown.
      // Session-gated like every other /api/schedule/* route above
      // (unauthenticated → 401); the list is derived from the server
      // catalog at request time, never hardcoded in the client, so
      // the dropdown tracks OPERATION_CATALOG exactly.
      if (path === "/api/schedule/operations" && request.method === "GET") {
        const operations = OPERATION_CATALOG.flatMap((entry) =>
          entry.operations.map((operation) => ({
            operation,
            agent: entry.agent,
            blurb: entry.blurb,
          })),
        );
        return Response.json({ ok: true, operations });
      }
      // Issue #3996 — built-in goals for the goals UI dropdown +
      // seed-all button. Session-gated like every other
      // /api/schedule/* route above (unauthenticated → 401); the
      // list is read from DEFAULT_SCHEDULES at request time, never
      // hardcoded in the client, so the UI tracks src/schedule.ts
      // exactly.
      if (path === "/api/schedule/builtin-goals" && request.method === "GET") {
        return Response.json({ ok: true, goals: DEFAULT_SCHEDULES });
      }
      if (path === "/api/schedule/goals" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return Response.json({ error: "JSON body required." }, { status: 400 });
        try {
          const goal = (await sched.addGoal({
            ...body,
            // Issue #3121 S1 — creation provenance travels with the
            // goal: origin user, the session login, creation time.
            // The server stamp wins over any caller-supplied value.
            provenance: buildScheduleProvenance({
              origin: "user",
              createdBy: session.githubLogin,
            }),
            // Issue #3121 S3 (#3312) — the session login is the
            // lifecycle-audit actor; the DO method emits the
            // `schedule.goal.added` event with it.
            actor: session.githubLogin,
          })) as { id?: unknown; operation?: unknown };
          return Response.json({ ok: true, goal });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not add goal." },
            { status: 400 }
          );
        }
      }
      if (path === "/api/schedule/ticks" && request.method === "GET") {
        const limit = Number(new URL(request.url).searchParams.get("limit") || 20);
        return Response.json({ ok: true, ticks: await sched.getTickHistory(limit) });
      }
      // Issue #2964 — per-run result records for ScheduledAgent goals
      // (newest first; jobId filters to one goal). The aggregate tick
      // history above stays as the aggregate view; this is the
      // per-run view the unified Jobs UI reads.
      if (path === "/api/schedule/runs" && request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const jobId = params.get("jobId") || undefined;
        const limit = Number(params.get("limit") || 50);
        return Response.json({ ok: true, runs: await sched.listJobRuns(jobId, limit) });
      }
      // Issue #2964 — the schedule-systems inventory for the unified
      // Jobs UI: the three systems plus the Worker cron triggers,
      // read from the inventory (never duplicated client-side), so
      // the read-only cron list cannot drift from wrangler.jsonc.
      if (path === "/api/schedule/systems" && request.method === "GET") {
        return Response.json({
          ok: true,
          systems: SCHEDULE_SYSTEMS,
          cronTriggers: WORKER_CRON_TRIGGERS_INVENTORY,
          // Issue #3121 Phase 2 (#3123) — worker duties as unified
          // records (kind worker-duty, state disabled): the same
          // inventory, in the same shape as every other schedule.
          workerDuties: workerDutiesFromInventory(new Date().toISOString()),
        });
      }
      // Issue #3122 — pending-approval decisions for agent-created
      // goals. GET lists the pending queue (the approval UI, #4142);
      // POST approve/reject decides one. The approver is PDP-checked
      // here for action:approve in the resolved tenant (Worker-side
      // PEP, the auth.ts pattern); the DO method enforces the state
      // machine and arms the recorded definition under the ORIGINAL
      // requester's principal. A failed arming leaves the approval
      // pending for retry.
      if (path === "/api/schedule/goals/approvals" && request.method === "GET") {
        return Response.json({ ok: true, approvals: await sched.listPendingGoalApprovals() });
      }
      const approvalMatch = path.match(/^\/api\/schedule\/goals\/approvals\/([^/]+)\/(approve|reject)$/);
      if (approvalMatch && request.method === "POST") {
        const [, id, decision] = approvalMatch;
        const pep = await evaluateRoutePep({
          env,
          session,
          tenantId: resolveIaaaTenant(env),
          permission: "action:approve",
          membershipStore: createKvMembershipStore(sessionStore(env)),
          permissionDenialStore: createKvPermissionDenialStore(sessionStore(env)),
          nowMs: Date.now(),
        });
        if (pep.enforced && !pep.allowed) {
          if (pep.graceExpired) {
            return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
          }
          return Response.json({ error: "Authorization denied: action:approve permission required." }, { status: 403 });
        }
        try {
          if (decision === "approve") {
            const result = (await sched.approvePendingGoalApproval(id, session.githubLogin)) as { approval: unknown; scheduleId?: unknown };
            return Response.json({ ok: true, ...result });
          }
          const approval = await sched.rejectPendingGoalApproval(id, session.githubLogin);
          return Response.json({ ok: true, approval });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Could not decide the approval." }, { status: 400 });
        }
      }
      const goalMatch = path.match(/^\/api\/schedule\/goals\/([^/]+)\/(enabled|trigger)$/);
      if (goalMatch && request.method === "POST") {
        const [, id, action] = goalMatch;
        if (action === "enabled") {
          const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
          const enabled = body?.enabled === true;
          const updated = await sched.setGoalEnabled(id, enabled, session.githubLogin);
          if (!updated) return Response.json({ error: "Goal not found." }, { status: 404 });
          return Response.json({ ok: true });
        }
        const tick = (await sched.triggerGoal(id, undefined, session.githubLogin)) as { goalsEvaluated?: unknown };
        return Response.json({ ok: true, tick });
      }
      const deleteMatch = path.match(/^\/api\/schedule\/goals\/([^/]+)$/);
      if (deleteMatch && request.method === "DELETE") {
        const removed = await sched.removeGoal(deleteMatch[1], session.githubLogin);
        if (!removed) return Response.json({ error: "Goal not found." }, { status: 404 });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Unknown schedule endpoint." }, { status: 404 });
    }

  return null;
}

/**
 * Slice 5 of Qunsultant/cfagent#2902 (Trading & market) — moves only.
 * The omnichannel trading family of handleFetch, verbatim and in original
 * order: /api/trading/email/inbound, /api/trading/email/approve,
 * /api/trading/slack/test, /api/trading/slack/link,
 * /api/trading/voice/turn, /api/trading/voice/test,
 * /api/trading/voice/greeting, /api/trading/options/*,
 * /trading/options/*, /api/schedules (forward). Returns null when no
 * branch matches, so handleFetch falls through to the next delegation
 * exactly as the inline chain did. The WebSocket upgrade dispatch
 * (dispatchWsUpgrade) between the schedules forward and the quotes
 * branches is NOT a route branch and stays inline in server.ts, in its
 * original position.
 */
export async function handleTradingOmniRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Omnichannel Trading Agent: Inbound Email Webhook & Simulator ---
    // Issue #154: a session is REQUIRED for the omnichannel test/simulator
    // routes (this one and the Slack/voice siblings below). They forward
    // into the caller's agent, whose handlers process trade commands
    // (inbound-email APPROVE, Slack events, voice turns) — previously a
    // null session silently proceeded under a shared hard-coded fallback
    // identity, so an UNAUTHENTICATED caller could drive them. The
    // fallback identities are removed (the #149 pattern); the in-app
    // callers (ETradeTradingHub, ResearchReportActions) are signed in
    // and unaffected.
    if (path === "/api/trading/email/inbound" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const targetUrl = new URL("/trading/email/inbound", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }

    // --- Omnichannel Trading Agent: Signed Email Approval Link Click ---
    // Issue #1262 Phase 5: a link click is NOT session-authenticated —
    // the signed token is the authorization (HMAC + expiry + login
    // binding, #149 pattern). The worker verifies the token's shape
    // fast (fail-closed HTML page, no DO round-trip for junk), then
    // forwards to the Orchestrator DO /trading/email/approve-link,
    // which verifies again (signature + expiry + principal-map
    // re-check) and executes through the shared engine. The DO
    // instance is the inbound-email instance constant (imported, not
    // copied — its value is #1289's scope; a rebase onto post-#1289
    // main picks up the new value automatically).
    if (path === "/api/trading/email/approve" && request.method === "GET") {
      const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const renderPage = (title: string, body: string) =>
        new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
            `<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">` +
            `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      const token = url.searchParams.get("token") || "";
      const fastCheck = await verifyApprovalLinkForPrincipal(env, token, undefined);
      if (!fastCheck.ok) {
        return renderPage("Approval link invalid", fastCheck.error);
      }
      const targetUrl = new URL("/trading/email/approve-link", "https://agent.internal");
      const forwardRes = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, INBOUND_EMAIL_ORCHESTRATOR_INSTANCE,
        new Request(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
      );
      const result = (await forwardRes.json().catch(() => ({}))) as any;
      if (result.success) {
        return renderPage(
          "Order executed",
          `Order ${result.orderId ?? ""} executed on E*TRADE${result.execId ? ` (reference ${result.execId})` : ""}.`
        );
      }
      return renderPage(
        "Approval not completed",
        result.message || "The approval link could not be completed. The order was not executed."
      );
    }

    // --- Omnichannel Trading Agent: Slack Test Simulator ---
    if (path === "/api/trading/slack/test" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const targetUrl = new URL("/trading/slack/event", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Principal Link Confirm ---
    // Issue #1262 Phase 1: a signed-in user confirms the connect code
    // the bot issued in a Slack DM (`link`). The code names the Slack
    // user (team_id + user_id); the SESSION names the account — the
    // binding written is slack user → session.githubLogin at tier
    // "trade". Self-binding only: no request field can name the login.
    if (path === "/api/trading/slack/link" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const body = (await request.json().catch(() => ({}))) as any;
      const result = await confirmSlackLink(
        env,
        typeof body.code === "string" ? body.code : "",
        session.githubLogin
      );
      if (!result.ok) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }
      return Response.json({
        ok: true,
        teamId: result.teamId,
        slackUserId: result.userId,
        login: result.login,
        tier: result.tier,
      });
    }

    // --- Omnichannel Trading Agent: Voice Trading Turn Simulator & API ---
    if ((path === "/api/trading/voice/turn" || path === "/api/trading/voice/test") && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const targetUrl = new URL("/trading/voice/turn", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }

    // --- Omnichannel Trading Agent: Voice Welcome Greeting ---
    if (path === "/api/trading/voice/greeting" && request.method === "GET") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const targetUrl = new URL("/trading/voice/greeting", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }

    // --- Omnichannel Options Intelligence: Forwarder for Options Endpoints (Catalog, Strategies, Screen, Unified, Config) ---
    if ((path.startsWith("/api/trading/options/") || path.startsWith("/trading/options/")) && (request.method === "POST" || request.method === "GET")) {
      // Issue #154: session required, identity is the SESSION login only.
      // Previously a null session fell back to the caller-supplied
      // x-user-login header (or a shared synthetic identity), letting an
      // unauthenticated caller select ANY user's agent instance. This
      // matches the session-required catch-all /api/ forwarder below;
      // in-app callers send their session cookie and are unaffected.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }

    // --- Cloudflare Agents Task Scheduling Management APIs ---
    if (path.startsWith("/api/schedules") || path === "/api/schedules") {
      // Issue #154: session required, identity is the SESSION login only
      // (schedules are per-user state: create/cancel/trigger). Previously
      // a null session fell back to the caller-supplied x-user-login
      // header or a shared synthetic identity.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }
  return null;
}

/**
 * Slice 5 of Qunsultant/cfagent#2902 (Trading & market) — moves only.
 * The market-quotes family of handleFetch, verbatim and in original
 * order: /api/market-data/quotes, /api/market/quotes, /api/foss/quotes
 * (batch, GET) and /api/market/quotes/source (GET|POST). Returns null
 * when no branch matches, so handleFetch falls through to the next
 * delegation exactly as the inline chain did.
 */
export async function handleTradingQuotesRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Batch Market Quotes HTTP Endpoint (Fallback for non-WebSocket clients) ---
    if ((path === "/api/market-data/quotes" || path === "/api/market/quotes" || path === "/api/foss/quotes") && request.method === "GET") {
      const symbolsParam = url.searchParams.get("symbols") || "";
      const symbols = symbolsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // #1725 (M2b): QUOTE_HTTP_PROVIDER_MODE, default "yahoo-only"
      // (the verified call-site fact — this branch previously passed
      // no env at all). Run carriers: x-quote-http-provider-mode
      // header, ?httpProviderMode= query param. Under "env" the
      // Worker env is passed through and HTTP refreshes can use
      // Alpaca when configured; under "yahoo-only" (and on any
      // invalid value, which fails closed with a console warning)
      // env is withheld. The handler still receives env for MODE
      // resolution via envForModes, so the QUOTE_EXPIRY_MODE env
      // level is not lost when the fetch env is withheld. No auth
      // and no audit on this surface, in every mode (M10 stands);
      // the response stays 200 with unavailable[] even when every
      // symbol is unavailable.
      const httpProviderMode = resolveQuoteHttpProviderMode(
        levelsForQuoteSwitch(
          undefined,
          request.headers.get("x-quote-http-provider-mode") ?? url.searchParams.get("httpProviderMode") ?? undefined,
          env.QUOTE_HTTP_PROVIDER_MODE
        ),
        "yahoo-only"
      ).mode;
      const expiryMode = resolveQuoteExpiryMode(
        levelsForQuoteSwitch(
          undefined,
          request.headers.get("x-quote-expiry-mode") ?? url.searchParams.get("expiryMode") ?? undefined,
          env.QUOTE_EXPIRY_MODE
        ),
        "honour"
      ).mode;
      return await handleMarketQuotesHttp(
        symbols.length > 0
          ? symbols
          : ["NVDA", "AAPL", "MSFT", "TSLA", "SPY", "QQQ", "BTC/USD", "ETH/USD", "SOL/USD"],
        httpProviderMode === "env" ? env : undefined,
        { expiryMode, envForModes: env }
      );
    }

    // --- Quote source setting (Issue #2108) ---
    // Deployment-wide pick (the WS + HTTP surfaces share one
    // Worker-level cache, so the setting is not per-user). Auth-gated
    // both ways; unbound AgentDB fails closed with 503.
    if (path === "/api/market/quotes/source" && (request.method === "GET" || request.method === "POST")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const db = (env as any).AGENT_DB as QuoteSourceStore | undefined;
      if (!db) return new Response("Quote source store unavailable", { status: 503 });
      if (request.method === "GET") {
        return Response.json({ source: await getQuoteSource(db) });
      }
      const body = (await request.json().catch(() => ({}))) as { source?: unknown };
      if (body.source !== "auto" && body.source !== "alpaca" && body.source !== "yahoo") {
        return Response.json({ error: "invalid source" }, { status: 400 });
      }
      return Response.json({ source: await setQuoteSource(db, normalizeQuoteSource(body.source)) });
    }
  return null;
}

/**
 * Slice 5 of Qunsultant/cfagent#2902 (Trading & market) — moves only.
 * The approval / reset / options-flows family of handleFetch, verbatim
 * and in original order: /trade/approve, /clear, /reset, /api/clear,
 * /api/reset, /api/options/flows/* (forward, sub-branches live,
 * historical, news, insider, congress, summary, presets). No options
 * behaviour change: the flows block moves as a whole, exactly as it
 * ran inline. Returns null when no branch matches, so handleFetch falls
 * through to the next delegation exactly as the inline chain did.
 */
export async function handleTradingApproveRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Session-Authenticated HITL Trade Approval Shortcut ---
    // Issue #149: no signed/bearer approval links exist in this product —
    // nothing mints signature-carrying approval links for this route (the copy that
    // claimed HMAC-signed links with a 300s expiry was fiction and has been
    // corrected). Approval requires the caller's own app session, exactly
    // like the in-app approval buttons: this route forwards the decision
    // to the session user's agent, whose /etrade/order/execute handler
    // re-checks the HITL gate, that the draft exists and is still
    // "previewed" (drafts expire unexecuted via expireStaleOrderDraft),
    // and that execution parameters match the preview. Previously this
    // route proceeded under a hard-coded fallback identity when no session
    // existed, letting an UNAUTHENTICATED request attempt execution under
    // an assumed identity — that fallback is removed.
    if (path === "/trade/approve") {
      const orderId = url.searchParams.get("orderId");
      if (!orderId) {
        return new Response("Missing orderId parameter", { status: 400 });
      }
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response("Unauthorized: sign in to approve a trade.", { status: 401 });
      }
      const userLogin = session.githubLogin;
      const targetUrl = new URL("/etrade/order/execute", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": userLogin },
        body: JSON.stringify({ orderId, decision: "approved" }),
      });
      const res = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
      const json = (await res.json().catch(() => ({}))) as any;

      if (json.success) {
        return Response.redirect(`/?tab=trading&executedOrder=${encodeURIComponent(orderId)}&brokerRef=${encodeURIComponent(json.brokerOrderRef || json.executionId || "")}`, 302);
      } else {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(json.error || "Execution failed")}`, 302);
      }
    }

    // --- Direct Clear & Reset Session Endpoints (Always Synchronous) ---
    if (path === "/clear" || path === "/reset" || path === "/api/clear" || path === "/api/reset") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const targetUrl = new URL(`/clear${url.search}`, "https://agent.internal");

      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", session.githubLogin);
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, session.githubLogin, forwardReq);
    }

    // --- Options Flows Endpoints (Live, Historical, News, Insider, Congress, Summary, Presets) ---
    // #1754 gate-coverage audit: this family was reachable with NO
    // authentication (the endpoint catalog listed it as public with
    // intent unasserted). Its only in-app caller (OptionsFlowsHub, in
    // the signed-in dashboard) already sends the session cookie
    // same-origin, so a session gate closes the family without
    // changing any legitimate call path. Public market quotes stay
    // ungated by the recorded #1725 M10 decision — flows are not
    // quotes: they serve modelled flow items, news, and filings
    // through the app's data path, not the public quote surface.
    if (path.startsWith("/api/options/flows/")) {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const sub = path.replace("/api/options/flows/", "").split("?")[0];
      const tickerParam = url.searchParams.get("tickers");
      const tickers = tickerParam ? tickerParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const minPrem = Number(url.searchParams.get("minPremium") || 0);
      const marketCapsParam = url.searchParams.get("marketCaps");
      const marketCaps = marketCapsParam ? (marketCapsParam.split(",").map((c) => c.trim()).filter(Boolean) as MarketCapCategory[]) : undefined;
      const assetTypesParam = url.searchParams.get("assetTypes");
      const assetTypes = assetTypesParam ? (assetTypesParam.split(",").map((c) => c.trim()).filter(Boolean) as AssetClassCategory[]) : undefined;
      // Issue #925: the generated sample universe is demo-regime only —
      // it takes an explicit dataMode=demo request on top of the #65 demo
      // gate; a live request never receives generated items as fallback.
      const dataMode = url.searchParams.get("dataMode") === "demo" ? "demo" : "live";
      // Issue #925: when no chain data is available, the envelope says so
      // explicitly instead of silently carrying substitute numbers.
      const flowDataUnavailableReason =
        "No live option-chain data is available; generated sample data is not served outside demo mode.";

      if (sub === "live" || sub === "historical") {
        const flows = await getDynamicLiveFlowItems(env, { tickers, minPremium: minPrem, marketCaps, assetTypes }, { dataMode });
        return Response.json({
          success: true,
          count: flows.length,
          total: flows.length,
          flows,
          // Issue #119: there is no trade tape — disclose the modelled
          // basis of every item at the envelope level too.
          provenance: summarizeFlowProvenance(flows),
          ...(flows.length === 0
            ? { dataUnavailable: true, unavailableReason: flowDataUnavailableReason }
            : {}),
          ...(sub === "historical"
            ? {
              note: "No historical options trade tape is available in this product; this returns the current modelled flow estimates, not archived prints.",
            }
            : {}),
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "news") {
        const liveNews = await fetchRealMarketNews(tickers, env);
        return Response.json({
          success: true,
          count: liveNews.length,
          total: liveNews.length,
          news: liveNews,
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "insider") {
        const liveInsiders = await fetchRealSecInsiderFilings({ tickers, minPremium: minPrem });
        return Response.json({
          success: true,
          count: liveInsiders.length,
          total: liveInsiders.length,
          insiders: liveInsiders,
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "congress") {
        const chamber = url.searchParams.get("chamber") || undefined;
        const party = url.searchParams.get("party") || undefined;
        const liveCongress = await fetchRealCongressDisclosures({ tickers, chamber, party });
        return Response.json({
          success: true,
          count: liveCongress.length,
          total: liveCongress.length,
          congress: liveCongress,
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "summary") {
        const summary = await getDynamicFlowSummary(env, { tickers, minPremium: minPrem, marketCaps, assetTypes }, { dataMode });
        return Response.json({
          success: true,
          summary,
          ...(summary.totalTrades === 0
            ? { dataUnavailable: true, unavailableReason: flowDataUnavailableReason }
            : {}),
          isDynamic: true,
        });
      }
      if (sub === "presets") {
        return Response.json({
          success: true,
          presets: DEFAULT_SAVED_PRESETS,
        });
      }
    }
  return null;
}
