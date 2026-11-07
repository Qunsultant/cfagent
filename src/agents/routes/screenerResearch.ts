/**
 * Issue #359-15: screener + autonomous research routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous screener and research block (invoked at the EXACT
 * original position in routeRequest's sequential matching sequence, after
 * the market-data compare/screen delegation and before the task schedules block):
 *   GET         /screener/latest                    (issue #212/#261)
 *   GET         /screener/report.pdf                (issue #269)
 *   POST        /screener/report/regenerate         (issue #1278, #1173 R5)
 *   GET         /screener/report.xlsx               (issue #953)
 *   GET         /screener/report.csv                (issue #1346)
 *   GET         /options/report.pdf                 (issue #361)
 *   POST        /research/run                       (issue #319, manual)
 *   POST        /research/scheduled-tick            (issue #319/#354, daily)
 *   GET         /research/latest
 *   GET         /research/history
 *   GET         /research/settings
 *   POST        /research/settings
 *   POST        /research/evaluate
 *   GET         /screening/activity                 (issue #1162, epic #1096 Phase 6)
 *   GET|POST    /screening/controls                 (issue #1162)
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * ScreenerResearchRouteContext parameter; there are no new globals and no
 * back-references into the class. The #308 canonical-report seam is
 * untouched: these blocks never called the store seam directly - the
 * runResearchAndPublish pipeline stays orchestrator-owned and arrives via
 * the context; the scheduled-tick guard keeps its write-after-success
 * mas_settings semantics via ctx.writeSetting.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { codedMessage, resolveOutcome } from "../../outcomes/outcomeAspects";
import {
  triggerManualResearch,
  triggerScheduledResearch,
} from "../../services/researchTriggers";
import {
  shouldFireResearchTick,
  RESEARCH_SCHEDULED_LAST_RUN_KEY,
} from "../../services/researchScheduleGuard";
import { resolveScheduledJobAlertThreshold } from "../../config/scheduledJobAlert";
import {
  recordScheduledJobOutcome,
  scheduledJobOutcomeStoreFromOrmEvents,
  type ScheduledJobId,
  type ScheduledJobOutcomeInput,
} from "../../observability/scheduledJobOutcomes";
import { postSlackText, resourceSlackPost } from "../resourceGoals";
import type { SlackDeliveryEnv } from "../social/delivery";
import type { ScreenerAgent } from "../screener-agent";
import type { ResearchAgent } from "../research-agent";
import type { DatabaseORM } from "../../orm";

/** Structural mirror of OrchestratorAgent's private ScreenerExecutionContext
 * (src/agents/orchestrator.ts) - the module reads only `userLogin` from it. */
type ScreenerExecutionContext = { userLogin: string; environment?: "TEST" | "PROD" };

/** The subset of OrchestratorAgent surface the screener/research handlers need. */
export interface ScreenerResearchRouteContext {
  /** ScreenerAgent accessor (owner: OrchestratorAgent.getScreenerAgent - was `this.getScreenerAgent`). */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Execution-context accessor (owner: OrchestratorAgent.getScreenerExecutionContext - was `this.getScreenerExecutionContext`). */
  getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined>;
  /** ResearchAgent accessor (owner: OrchestratorAgent.getResearchAgent - was `this.getResearchAgent`). */
  getResearchAgent(userLogin?: string): ResearchAgent | null;
  /** Single-owner research run pipeline (owner: OrchestratorAgent.runResearchAndPublish - was `(t, u) => this.runResearchAndPublish(t, u)`); the #308 canonical store lives inside it. */
  runResearchAndPublish(
    trigger: "manual" | "scheduled",
    userLogin?: string
  ): Promise<{
    success: boolean;
    error?: string;
    reportId?: string | null;
    created?: boolean;
    emailed?: boolean;
    report?: unknown;
  }>;
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`); the #754 adaptation services take it as their SqlStorage (post-#887 the ORM satisfies that interface). */
  getOrm(): DatabaseORM;
  /**
   * Issue #1661: DO blob handle for full capture (mirrors the
   * getStorageSql idiom). Optional — mock ctxs without it degrade
   * to today's outcome-only contract via `ctx.getStorage?.()`.
   */
  getStorage?(): any;
  /** Worker environment (owner: OrchestratorAgent - `this.env`); the Phase 6 tick delivery builds its channel senders from it. */
  env: Record<string, any>;
  /** mas_settings raw read (owner: OrchestratorAgent.readSettingRaw - was `this.readSettingRaw`). */
  readSettingRaw(key: string): string | null;
  /** mas_settings write (owner: OrchestratorAgent.writeSetting - was `this.writeSetting`). */
  writeSetting(key: string, value: string): void;
  /**
   * Issue Qunsultant/cfagent#2037 — tick trace id carried from the
   * dispatch's traceparent (set by the OrchestratorAgent delegation
   * from the request headers; null when the dispatch carried none).
   */
  traceId?: string | null;
}

/**
 * Issue Qunsultant/cfagent#2037 — record one tick-job outcome in the
 * single mas_events sink (with streak/alert via the existing Slack
 * route). Never throws and never changes the handler's response:
 * the outcome row is observation, not the job. The ORM events port
 * is read lazily so a mock context without it degrades to a
 * recorded:false no-op instead of failing the tick.
 */
async function recordTickJobOutcome(
  ctx: ScreenerResearchRouteContext,
  sessionId: string,
  input: Omit<ScheduledJobOutcomeInput, "job"> & { job: ScheduledJobId },
): Promise<void> {
  try {
    await recordScheduledJobOutcome(
      {
        store: scheduledJobOutcomeStoreFromOrmEvents(() => {
          const orm = ctx.getOrm() as unknown as {
            events?: { create?: unknown; findMany?: unknown };
          };
          return orm?.events ?? null;
        }, sessionId),
        alert: async (text: string) => {
          await postSlackText({
            post: resourceSlackPost,
            env: ctx.env as unknown as SlackDeliveryEnv,
            text,
          });
        },
        threshold: resolveScheduledJobAlertThreshold(
          ctx.env as unknown as Record<string, unknown>,
        ),
      },
      input,
    );
  } catch {
    // Observation never fails the response.
  }
}

/**
 * Screener + autonomous research routes. Invoked from routeRequest at the
 * exact position the original blocks occupied (after the
 * handleMarketDataCompareScreenRoutes delegation, before the task schedules
 * block); returns a Response when one of the owned paths matches, or null
 * to continue sequential matching.
 */
export async function handleScreenerResearchRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: ScreenerResearchRouteContext
): Promise<Response | null> {
    // Issue #212/#261: latest screener runs (GET /api/screener/latest).
    // Served by ScreenerAgent — one agent owns all screening results.
    // Note: server.ts strips the /api prefix before forwarding, so the DO
    // sees /screener/latest.
    if (path.endsWith("/screener/latest") && request.method === "GET") {
      try {
        const context = await ctx.getScreenerExecutionContext();
        const ownerLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const latest = await agent.getLatest();
        const history = await agent.getHistory();
        return Response.json({
          count: history.length,
          runs: history,
          latest,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load screener runs", runs: [] }, { status: 500 });
      }
    }

    // Issue #269: downloadable PDF report of the latest screener run.
    if (path.endsWith("/screener/report.pdf") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const pdf = key
          ? await ctx.getScreenerAgent(ownerLogin).getPdfByKey(key)
          : await ctx.getScreenerAgent(ownerLogin).getLatestPdf();
        if (!pdf) {
          return Response.json({ error: "No screener report available yet" }, { status: 404 });
        }
        return new Response(pdf.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
            "Content-Length": String(pdf.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load report" }, { status: 500 });
      }
    }

    // Issue #1278 (#1173 R5): regenerate the latest run's PDF (the
    // recovery path for a run whose PDF generation failed). No
    // re-screen — the ScreenerAgent re-runs the report pipeline for
    // its stored latest run and records the outcome on it.
    if (path.endsWith("/screener/report/regenerate") && request.method === "POST") {
      try {
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const out = await agent.regenerateLatestReport();
        if (!out.timestamp) {
          return Response.json({ error: out.pdfError || "No screener run to regenerate" }, { status: 404 });
        }
        return Response.json({
          pdfStatus: out.pdfStatus,
          pdfKey: out.pdfKey,
          pdfError: out.pdfError,
          timestamp: out.timestamp,
          reportUrl: out.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(out.pdfKey)}` : undefined,
        }, { status: out.pdfStatus === "generated" ? 200 : 502 });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to regenerate report" }, { status: 500 });
      }
    }

    // Downloadable XLSX report of the screener run (multi-tab: Screened Stocks + Formulas & Methodology).
    if (path.endsWith("/screener/report.xlsx") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const xlsx = key ? await agent.getXlsxByKey(key) : await agent.getLatestXlsx();
        if (!xlsx) {
          return Response.json({ error: "No screener XLSX report available yet" }, { status: 404 });
        }
        return new Response(xlsx.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${xlsx.fileName}"`,
            "Content-Length": String(xlsx.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load XLSX report" }, { status: 500 });
      }
    }

    // Issue #1346: downloadable CSV report of the screener run
    // (mirrors the XLSX route; the key must be screener:csv: —
    // enforced in the agent getter — so this route cannot serve a
    // PDF/XLSX blob as CSV).
    if (path.endsWith("/screener/report.csv") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const csv = key ? await agent.getCsvByKey(key) : await agent.getLatestCsv();
        if (!csv) {
          return Response.json({ error: "No screener CSV report available yet" }, { status: 404 });
        }
        return new Response(csv.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="${csv.fileName}"`,
            "Content-Length": String(csv.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load CSV report" }, { status: 500 });
      }
    }

    // Issue #1335: goal-screen report artifacts (PDF + XLSX + CSV) —
    // served from the ScreenerAgent blob store. The key must be
    // goal_screen-namespaced (enforced again in the agent getter), so
    // a goal-screen link cannot read stock/options blobs.
    if (
      (path.endsWith("/screening/goal-screen/report.pdf") ||
        path.endsWith("/screening/goal-screen/report.xlsx") ||
        path.endsWith("/screening/goal-screen/report.csv")) &&
      request.method === "GET"
    ) {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        if (!key) {
          return Response.json({ error: "A report key is required" }, { status: 400 });
        }
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const artifact = await agent.getGoalScreenArtifactByKey(key);
        if (!artifact) {
          return Response.json({ error: "No goal-screen report found for that key" }, { status: 404 });
        }
        // NB: do NOT branch on path.endsWith here — the thin-router
        // inventory test extracts every such condition in this
        // handler, and these would duplicate the route's own entries.
        const ext = path.slice(path.lastIndexOf("."));
        const contentType =
          ext === ".pdf"
            ? "application/pdf"
            : ext === ".xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "text/csv";
        return new Response(artifact.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
            "Content-Length": String(artifact.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load goal-screen report" }, { status: 500 });
      }
    }

    // Issue #1195 (#1173 R3b): Options XLSX download endpoint (mirrors stock).
    if (path.endsWith("/options/report.xlsx") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const xlsx = key ? await agent.getOptionsXlsxByKey(key) : await agent.getLatestOptionsXlsx();
        if (!xlsx) {
          return Response.json({ error: "No options XLSX report available yet" }, { status: 404 });
        }
        return new Response(xlsx.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${xlsx.fileName}"`,
            "Content-Length": String(xlsx.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load XLSX report" }, { status: 500 });
      }
    }

    // Issue #1346: Options CSV download endpoint (mirrors options
    // XLSX; the key must be options:csv: — enforced in the agent
    // getter).
    if (path.endsWith("/options/report.csv") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const agent = ctx.getScreenerAgent(ownerLogin);
        const csv = key ? await agent.getOptionsCsvByKey(key) : await agent.getLatestOptionsCsv();
        if (!csv) {
          return Response.json({ error: "No options CSV report available yet" }, { status: 404 });
        }
        return new Response(csv.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="${csv.fileName}"`,
            "Content-Length": String(csv.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load CSV report" }, { status: 500 });
      }
    }

    // Issue #361: Options PDF download endpoint (mirrors stock).
    if (path.endsWith("/options/report.pdf") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") || url.searchParams.get("filename");
        const ownerLogin = request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!ownerLogin) return unauthenticatedResponse();
        const pdf = key
          ? await ctx.getScreenerAgent(ownerLogin).getOptionsPdfByKey(key)
          : await ctx.getScreenerAgent(ownerLogin).getLatestOptionsPdf();
        if (!pdf) {
          return Response.json({ error: "No options report available yet" }, { status: 404 });
        }
        return new Response(pdf.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
            "Content-Length": String(pdf.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load report" }, { status: 500 });
      }
    }

    // Issue #335: research-run PDF download (mirrors screener/options PDFs).
    if (path.endsWith("/research/report.pdf") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") || "latest";
        const userLogin =
          request.headers.get("x-user-login") ||
          (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!userLogin) return unauthenticatedResponse();
        const agent = ctx.getResearchAgent(userLogin);
        if (!agent) {
          return Response.json(
            { error: "ResearchAgent binding not configured." },
            { status: 503 }
          );
        }
        const pdf = await agent.getResearchPdfByKey(key);
        if (!pdf) {
          return Response.json(
            { error: "No research report PDF available yet" },
            { status: 404 }
          );
        }
        return new Response(pdf.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
            "Content-Length": String(pdf.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Failed to load research report" },
          { status: 500 }
        );
      }
    }

    // Issue #2167: research-run workbook and CSV downloads (mirror the PDF
    // route). Keys carry the report:xlsx:research: / report:csv:research:
    // families the run records; there is no "latest" pointer for these, so a
    // missing key is an explicit 404 rather than a guess.
    if (path.endsWith("/research/report.xlsx") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const userLogin =
          request.headers.get("x-user-login") ||
          (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!userLogin) return unauthenticatedResponse();
        const agent = ctx.getResearchAgent(userLogin);
        if (!agent) {
          return Response.json(
            { error: "ResearchAgent binding not configured." },
            { status: 503 }
          );
        }
        const xlsx = key ? await agent.getResearchXlsxByKey(key) : null;
        if (!xlsx) {
          return Response.json(
            { error: "No research report XLSX available yet" },
            { status: 404 }
          );
        }
        return new Response(xlsx.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${xlsx.fileName}"`,
            "Content-Length": String(xlsx.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Failed to load research report XLSX" },
          { status: 500 }
        );
      }
    }

    // Issue #2167: research-run CSV download (same contract as the workbook).
    if (path.endsWith("/research/report.csv") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const userLogin =
          request.headers.get("x-user-login") ||
          (await ctx.getScreenerExecutionContext())?.userLogin;
        if (!userLogin) return unauthenticatedResponse();
        const agent = ctx.getResearchAgent(userLogin);
        if (!agent) {
          return Response.json(
            { error: "ResearchAgent binding not configured." },
            { status: 503 }
          );
        }
        const csv = key ? await agent.getResearchCsvByKey(key) : null;
        if (!csv) {
          return Response.json(
            { error: "No research report CSV available yet" },
            { status: 404 }
          );
        }
        return new Response(csv.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="${csv.fileName}"`,
            "Content-Length": String(csv.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Failed to load research report CSV" },
          { status: 500 }
        );
      }
    }

    // ==========================================    // Issue #319: autonomous options research.
    // The manual route and the scheduled tick are thin triggers over the
    // single runResearchAndPublish entry (amendment 2) — only the trigger
    // source differs. Note: server.ts strips the /api prefix before
    // forwarding, so the DO sees /research/*.
    // ==========================================

    // Manual run (dashboard "Run now").
    if (path.endsWith("/research/run") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      try {
        const out = await triggerManualResearch(
          ctx.runResearchAndPublish,
          userLogin
        );
        return Response.json(out);
      } catch (err: any) {
        return Response.json(
          { success: false, error: err?.message || "Research run failed." },
          { status: 500 }
        );
      }
    }

    // Scheduled tick (server.ts folds the daily run into the */30 tick,
    // issue #354 — a dedicated 0 21 * * 1-5 cron cannot exist at the
    // Workers Free 5-trigger ceiling). Fires exactly once per weekday at
    // or after 21:00 UTC; the manual route above is never guarded.
    if (path.endsWith("/research/scheduled-tick") && request.method === "POST") {
      // Issue #2327 (Agent Mesh S3): the tick acts under the identity
      // server.ts asserts on the header — the configured service
      // identity, whose dispatch is skipped entirely when none is
      // configured (#1185). A header-less or synthetic-literal tick
      // is refused with the route family's unauthenticated response
      // rather than run under a fabricated default login.
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin || userLogin.trim().length === 0 || userLogin.trim() === "default") {
        return unauthenticatedResponse();
      }
      try {
        // Issue #354 — idempotency guard against double-fire across the
        // 21:00/21:30 ticks. The last-fired date lives in mas_settings
        // (durable across ticks AND isolates); it is written only after a
        // successful run so a failed 21:00 run retries at 21:30.
        const decision = shouldFireResearchTick(
          new Date(),
          ctx.readSettingRaw(RESEARCH_SCHEDULED_LAST_RUN_KEY)
        );
        if (!decision.fire) {
          // Issue Qunsultant/cfagent#2037 — a skip is an outcome, not
          // an absence: it leaves a mas_events row so a quiet tick is
          // distinguishable from a lost one. Response shape unchanged.
          await recordTickJobOutcome(ctx, sessionId, {
            job: "research",
            outcome: "skipped",
            traceId: ctx.traceId ?? null,
            reason: decision.reason,
          });
          return Response.json({
            success: true,
            skipped: true,
            reason: decision.reason,
            dateKey: decision.dateKey,
          });
        }
        // Issue #1162 (epic #1096 Phase 6): the screening pause flag is
        // read once per tick and gates every #1096 autonomous step
        // below (discovery, re-selection, weights-v2, tick delivery).
        // The #319 research run and its evaluations are NOT gated —
        // they predate the screening system and have their own
        // controls. A settings read failure reads as paused
        // (fail-closed, the #756 kill-switch idiom).
        const screeningFlags = await import("../../services/screeningFlags");
        const readScreeningSetting = (key: string) => ctx.readSettingRaw(key);
        const screeningPaused = screeningFlags.isScreeningScheduledPaused(readScreeningSetting);
        const out = await triggerScheduledResearch(
          ctx.runResearchAndPublish,
          userLogin
        );
        // #583 docx §9: after the scheduled run, evaluate runs due for
        // follow-up (older than 24h, no evaluation row). Best-effort: never
        // fails the tick.
        try {
          const agent = ctx.getResearchAgent(userLogin);
          if (agent) {
            const evalRes = await agent.evaluateDueRuns(userLogin);
            (out as Record<string, unknown>).evaluationsDue =
              evalRes.evaluated.length + evalRes.failed.length;
            (out as Record<string, unknown>).evaluationsDone =
              evalRes.evaluated;
          }
        } catch {
          // Evaluation is advisory; the research run already succeeded.
        }
        // Issue #1122 (epic #1096 Phase 3): discovery run type on the
        // same tick — guard-gated inside the agent (own durable
        // marker, #354 idiom, no new cron trigger). Best-effort:
        // discovery is advisory and never fails the tick. Portfolio
        // state is not supplied on this path, so portfolio discovery
        // triggers skip with the limitation recorded by the engine.
        // Issue #1162: the screening pause flag skips discovery too.
        try {
          const agent = ctx.getResearchAgent(userLogin);
          if (agent && screeningPaused) {
            (out as Record<string, unknown>).discoverySkipped = "screening_paused";
          } else if (agent) {
            const disc = await agent.runDiscoveryIfDue(new Date(), { userLogin });
            (out as Record<string, unknown>).discoveryFired = disc.fired;
            if (disc.fired) {
              (out as Record<string, unknown>).discoveryPersisted =
                disc.result?.persisted ?? 0;
            }
          }
        } catch {
          // Discovery is advisory; the research run already succeeded.
        }
        // Issue #1162 (epic #1096 Phase 6): the remaining #1096
        // autonomous steps get their production caller on this same
        // tick (no new cron trigger — the Workers ceiling): strategy-
        // bank re-selection (Phase 3, proposals only — promotion stays
        // behind Phase 5's gate) and the strategy-weights v2 job
        // (Phase 5; kill switch and budget are enforced inside the
        // job), plus channel delivery of a fired discovery when the
        // channels flag is on. All best-effort, recorded in the
        // screening activity log; none of it can fail the tick.
        try {
          const orm = ctx.getOrm();
          const { recordScreeningActivity } = await import("../../services/screeningActivity");
          if (screeningPaused) {
            (out as Record<string, unknown>).screeningPaused = true;
            recordScreeningActivity(orm, {
              userLogin,
              kind: "schedule_control",
              summary:
                "Scheduled screening steps skipped — screening is paused (screening.scheduledPaused=on). Discovery, re-selection, weights-v2, and tick delivery did not run.",
              actor: "scheduled-tick",
            });
          } else {
            const steps: Record<string, unknown> = {};
            const agent = ctx.getResearchAgent(userLogin);
            const track = agent ? await agent.getTrackRecord().catch(() => null) : null;
            const researchConfig = agent ? await agent.getResearchConfig().catch(() => null) : null;
            if (agent && track) {
              try {
                const {
                  shouldFireStrategyBankTick,
                  STRATEGY_BANK_LAST_RUN_KEY,
                  buildStrategyRegimeEvidence,
                  reselectStrategyBank,
                  recordReselectionProposal,
                } = await import("../../services/strategyBankReselection");
                // Consolidation C5 (#1361, #1257): reselection reads
                // v2 weights for the run's regime (proposal-only; the
                // informational weight field now carries the regime's
                // v2 value). Proposal shape unchanged.
                const { getStrategyWeightsV2ForRegime } = await import("../../services/strategyWeightsV2");
                const sbDecision = shouldFireStrategyBankTick(
                  new Date(),
                  ctx.readSettingRaw(STRATEGY_BANK_LAST_RUN_KEY)
                );
                if (sbDecision.fire) {
                  const evidence = buildStrategyRegimeEvidence(track.ideas);
                  const regimes = [...new Set(evidence.map((e) => e.regime))];
                  let proposals = 0;
                  for (const regime of regimes) {
                    const proposal = reselectStrategyBank({
                      evidence,
                      weights: getStrategyWeightsV2ForRegime(orm, regime),
                      regime,
                      overallWinRate: track.winRate,
                      now: new Date(),
                    });
                    recordReselectionProposal(orm, userLogin, proposal);
                    proposals++;
                  }
                  if (proposals > 0) {
                    ctx.writeSetting(STRATEGY_BANK_LAST_RUN_KEY, sbDecision.dateKey);
                  }
                  steps.reselection = { fired: true, proposals, regimes };
                } else {
                  steps.reselection = { fired: false, reason: sbDecision.reason };
                }
              } catch (err) {
                steps.reselection = {
                  fired: false,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
              try {
                const { buildWeightsV2Slices, runWeightsV2Adjustment } = await import("../../services/strategyWeightsV2");
                const { RESEARCH_CONFIG_DEFAULTS } = await import("../../services/researchConfig");
                const costs = {
                  feePerContract: researchConfig?.feePerContract ?? RESEARCH_CONFIG_DEFAULTS.feePerContract,
                  slippagePerContract: researchConfig?.slippagePerContract ?? RESEARCH_CONFIG_DEFAULTS.slippagePerContract,
                };
                const slices = buildWeightsV2Slices(
                  track.ideas.map((idea) => ({
                    structure: idea.structure,
                    regime: idea.regime,
                    contractsPerUnit: idea.contractsPerUnit,
                    evaluation: idea.evaluation
                      ? {
                          pnlEstimatePerUnit: idea.evaluation.pnlEstimatePerUnit,
                          rMultiple: idea.evaluation.rMultiple,
                          evaluatedAt: idea.evaluation.evaluatedAt,
                        }
                      : null,
                  })),
                  costs
                );
                const wres = runWeightsV2Adjustment(orm, slices, { now: new Date() });
                steps.weightsV2 = {
                  considered: wres.considered,
                  adjusted: wres.adjusted.length,
                  blocked: wres.blocked.length,
                  halted: wres.halted ?? false,
                };
                recordScreeningActivity(orm, {
                  userLogin,
                  kind: "weights_adjustment",
                  summary:
                    `Weights-v2 job on the scheduled tick: ${wres.considered} slice(s) considered, ` +
                    `${wres.adjusted.length} adjusted, ${wres.blocked.length} blocked` +
                    `${wres.halted ? " — halted by the adaptation kill switch" : ""}.`,
                  detail: steps.weightsV2,
                  actor: "scheduled-tick",
                });
              } catch (err) {
                steps.weightsV2 = {
                  error: err instanceof Error ? err.message : String(err),
                };
              }
              if ((out as Record<string, unknown>).discoveryFired) {
                recordScreeningActivity(orm, {
                  userLogin,
                  kind: "discovery_run",
                  summary: `Scheduled discovery run: ${(out as Record<string, unknown>).discoveryPersisted ?? 0} proposed goal(s) persisted (proposed-only; nothing activates without confirmation).`,
                  actor: "scheduled-tick",
                });
                if (screeningFlags.isScreeningChannelsEnabled(readScreeningSetting)) {
                  try {
                    const { deliverScreeningContent, createScreeningDeliverySenders } = await import("../../services/screeningDelivery");
                    const { resolveTenantChannelGate } = await import("../../services/tenantChannelGate");
                    const channels: Array<"slack" | "email" | "webhook"> = ["slack", "webhook"];
                    const emailTo = researchConfig?.autoEmail && researchConfig?.emailTo ? researchConfig.emailTo : undefined;
                    if (emailTo) channels.push("email");
                    const text =
                      `Goal/scenario discovery (scheduled): ${(out as Record<string, unknown>).discoveryPersisted ?? 0} new proposed goal(s) are waiting in the dashboard for review. ` +
                      `Proposals never activate or trade on their own.`;
                    // Issue #3169: the tenant channel gate, resolved
                    // best-effort (null = ungated, prior behavior).
                    const channelGate = await resolveTenantChannelGate(ctx.env, userLogin);
                    await deliverScreeningContent({
                      channels,
                      subject: "Screening discovery: new proposed goals",
                      text,
                      event: "screening.discovery",
                      data: { persisted: (out as Record<string, unknown>).discoveryPersisted ?? 0, dateKey: decision.dateKey },
                      emailTo,
                      senders: createScreeningDeliverySenders(ctx.env, orm, userLogin),
                      sql: orm,
                      userLogin,
                      actor: "scheduled-tick",
                      ...(channelGate ? { channelGate } : {}),
                    });
                    steps.delivery = true;
                  } catch (err) {
                    steps.delivery = {
                      error: err instanceof Error ? err.message : String(err),
                    };
                  }
                }
              }
            }
            (out as Record<string, unknown>).screeningSteps = steps;
          }
        } catch {
          // Phase 6 steps are best-effort; the research run already succeeded.
        }
        ctx.writeSetting(RESEARCH_SCHEDULED_LAST_RUN_KEY, decision.dateKey);
        // Issue Qunsultant/cfagent#2037 — the ran outcome, same sink
        // as the skip above. Recorded after the durable last-run
        // marker so a lost outcome row can never imply a run that
        // the guard would repeat.
        await recordTickJobOutcome(ctx, sessionId, {
          job: "research",
          outcome: "ran",
          traceId: ctx.traceId ?? null,
        });
        return Response.json(out);
      } catch (err: any) {
        // Issue Qunsultant/cfagent#2037 — a handler failure is a
        // failed outcome (code only), recorded before the 500 the
        // caller already receives. Response shape unchanged.
        await recordTickJobOutcome(ctx, sessionId, {
          job: "research",
          outcome: "failed",
          traceId: ctx.traceId ?? null,
          errorCode: (err as { code?: unknown } | null)?.code as string | undefined,
        });
        return Response.json(
          { success: false, error: err?.message || "Scheduled research run failed." },
          { status: 500 }
        );
      }
    }

    // Latest + history (trigger-labeled; one view serves both run types).
    if (path.endsWith("/research/latest") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) return Response.json({ latest: null });
      const latest = await agent.getLatest();
      return Response.json({ latest });
    }
    if (path.endsWith("/research/history") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) return Response.json({ history: [] });
      const history = await agent.getHistory();
      return Response.json({ history });
    }
    // Issue #340: track record — published ideas joined to evaluations.
    if (path.endsWith("/research/track-record") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const trackRecord = await agent.getTrackRecord();
      return Response.json({ trackRecord });
    }

    // Issue #654: calibration dashboard — direction accuracy over the
    // #340 track record, per thesis, per strategy, per regime, per
    // month. Measurement only: this reads the recorded evaluations,
    // never recomputes outcomes and never touches thresholds or
    // weights (those stay behind #17's reviewed-config rule).
    if (path.endsWith("/research/track-record/calibration") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { buildCalibrationFromTrackRecord } = await import("../../services/calibrationReport");
      const trackRecord = await agent.getTrackRecord();
      return Response.json({ calibration: buildCalibrationFromTrackRecord(trackRecord.ideas) });
    }

    // Issue #754: strategy weights — read path. Current weights plus the
    // policy evaluation (weighted vs unweighted win rate + proposals).
    // Measurement surface; reading weights here changes no ranking —
    // production consumption stays behind #17's reviewed-config rule.
    if (path.endsWith("/adaptation/weights") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { buildWeightPolicyEvaluation } = await import("../../services/strategyWeightsV2");
      const trackRecord = await agent.getTrackRecord();
      // Consolidation #1257 flip (C5's flag is retired): v2 always
      // (collapsed to plain strategy keys so the hub renders
      // unchanged, plus the full regime map for transparency); the
      // evaluation builder is the same, fed the collapsed map.
      const { getStrategyWeightsV2, getStrategyWeightsV2Collapsed } = await import("../../services/strategyWeightsV2");
      const weights = getStrategyWeightsV2Collapsed(ctx.getOrm());
      return Response.json({
        weights,
        weightsByRegime: getStrategyWeightsV2(ctx.getOrm()),
        weightsSource: "v2",
        evaluation: buildWeightPolicyEvaluation(trackRecord, weights),
      });
    }

    // Issue #754: run the calibration-driven weight adjustment job.
    // Fire/no-fire for the scheduled ride is decided inside the job
    // (ISO-week guard + the #756 kill switch); a manual call may pass
    // { force: true }. Every application is budget-checked and audited
    // via #755's seam.
    if (path.endsWith("/adaptation/weights/run") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const body = (await request.json().catch(() => null)) as { force?: boolean } | null;
      // Consolidation #1257 flip (C5's flag is retired): the v2
      // adjustment runs behind the SAME fire/no-fire semantics as
      // the old v1 job — ISO-week guard (same settings key, so one
      // adjustment per week regardless of engine) + kill switch
      // inside the v2 job. The v2 result carries regime per entry;
      // the v1-only skipped detail fields are absent (documented
      // C5 delta).
      const { buildWeightsV2Slices, runWeightsV2Adjustment } = await import("../../services/strategyWeightsV2");
      const { isoWeekKey, WEIGHTS_LAST_RUN_WEEK_KEY } = await import("../../services/strategyWeightsV2");
      const { RESEARCH_CONFIG_DEFAULTS } = await import("../../services/researchConfig");
      const trackRecord = await agent.getTrackRecord();
      const researchConfig = await agent.getResearchConfig().catch(() => null);
      const costs = {
        feePerContract: researchConfig?.feePerContract ?? RESEARCH_CONFIG_DEFAULTS.feePerContract,
        slippagePerContract: researchConfig?.slippagePerContract ?? RESEARCH_CONFIG_DEFAULTS.slippagePerContract,
      };
      const slices = buildWeightsV2Slices(
        trackRecord.ideas.map((idea: any) => ({
          structure: idea.structure,
          regime: idea.regime,
          contractsPerUnit: idea.contractsPerUnit,
          evaluation: idea.evaluation
            ? {
                pnlEstimatePerUnit: idea.evaluation.pnlEstimatePerUnit,
                rMultiple: idea.evaluation.rMultiple,
                evaluatedAt: idea.evaluation.evaluatedAt,
              }
            : null,
        })),
        costs
      );
      const now = new Date();
      if (body?.force !== true && ctx.readSettingRaw(WEIGHTS_LAST_RUN_WEEK_KEY) === isoWeekKey(now)) {
        // Issue Qunsultant/cfagent#2037 — the already-ran skip leaves
        // a mas_events row like every other job outcome. Response
        // shape unchanged.
        await recordTickJobOutcome(ctx, sessionId, {
          job: "adaptation",
          outcome: "skipped",
          traceId: ctx.traceId ?? null,
          reason: "already ran this week",
        });
        return Response.json({
          success: true,
          considered: slices.length,
          adjusted: [],
          blocked: [],
          skipped: "already ran this week",
          weightsSource: "v2",
          timestamp: now.toISOString(),
        });
      }
      const result = runWeightsV2Adjustment(ctx.getOrm(), slices, { now });
      if (!result.halted && body?.force !== true) {
        ctx.writeSetting(WEIGHTS_LAST_RUN_WEEK_KEY, isoWeekKey(now));
      }
      // Issue Qunsultant/cfagent#2037 — the ran outcome, recorded
      // after the durable week marker like the research ran above.
      // A throw inside the adjustment still propagates (no catch
      // added): the DO dispatch wrap emits the AE error event and
      // scheduled()'s observer records the failure — same sink.
      await recordTickJobOutcome(ctx, sessionId, {
        job: "adaptation",
        outcome: "ran",
        traceId: ctx.traceId ?? null,
      });
      return Response.json({ success: true, ...result, weightsSource: "v2", timestamp: now.toISOString() });
    }

    // Issue #757: improvement candidates — the Phase 5 queue. Listing is
    // read-only; generation converts track-record anomalies, reflection
    // findings (recovered from reflection learnings), and human
    // learnings into structured candidates. Generation applies
    // nothing — candidates reach production only via #758 → #759 → #760.
    // Consolidation #1257 (challenger re-point): the inbox lists
    // challengers, tenant-scoped. The envelope key stays "candidates"
    // so the panel changes only its item type; the items ARE
    // challengers (kind/title/regime/spec/status/evaluation).
    if (path.endsWith("/adaptation/candidates") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { listChallengers } = await import("../../services/championChallenger");
      const candidates = listChallengers(ctx.getOrm(), userLogin);
      return Response.json({ candidates });
    }
    // Consolidation #1257: generate creates challengers from the
    // latest re-selection proposals (deduped on sourceProposalId).
    // The old #757 generation has no production caller and is retired
    // with its store; proposals are the only generation source.
    if (path.endsWith("/adaptation/candidates/generate") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { generateChallengersFromProposals } = await import("../../services/proposalChallengerBridge");
      const result = generateChallengersFromProposals(ctx.getOrm(), userLogin);
      return Response.json({
        success: true,
        created: result.created,
        skipped: result.skipped,
        timestamp: new Date().toISOString(),
      });
    }

    // Consolidation #1257: evaluate runs the challenger's frozen-set
    // evaluation (walk-forward, holdout decides). The specs come
    // from the bridge mapping — champion = current state, challenger
    // differing only in what its kind changes — never invented here.
    // Gate runs the same evaluation and returns its verdict.
    async function evaluateChallengerRoute(candidateId: string, userLogin: string) {
      const { getChallenger, evaluateChallenger, getActiveStrategySet } = await import("../../services/championChallenger");
      const { getStrategyWeightsV2ForRegime } = await import("../../services/strategyWeightsV2");
      const { buildEvaluationSpecs } = await import("../../services/proposalChallengerBridge");
      const orm = ctx.getOrm();
      const challenger = getChallenger(orm, userLogin, candidateId);
      if (!challenger) {
        return Response.json({ error: `challenger ${candidateId} not found.` }, { status: 404 });
      }
      const activeSet = getActiveStrategySet(orm, userLogin);
      const specs = buildEvaluationSpecs(challenger, {
        weightsForRegime: challenger.regime
          ? getStrategyWeightsV2ForRegime(orm, challenger.regime)
          : {},
        activeSet: activeSet ? activeSet.strategies : null,
      });
      const evaluation = await evaluateChallenger(orm, userLogin, candidateId, {
        championSpec: specs.championSpec,
        challengerSpec: specs.challengerSpec,
      });
      return { evaluation };
    }
    if (path.endsWith("/adaptation/candidates/evaluate") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const out = await evaluateChallengerRoute(candidateId, userLogin);
      if (out instanceof Response) return out;
      return Response.json({ success: true, evaluation: out.evaluation, timestamp: new Date().toISOString() });
    }
    if (path.endsWith("/adaptation/candidates/evaluations") && request.method === "GET") {
      const candidateId = url.searchParams.get("candidateId") || "";
      if (!candidateId) {
        return Response.json({ error: "candidateId query parameter is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { getChallenger } = await import("../../services/championChallenger");
      const challenger = getChallenger(ctx.getOrm(), userLogin, candidateId);
      // Fail-soft read (the panel idiom): an unknown challenger has
      // no evaluations, not an error.
      return Response.json({ evaluations: challenger?.evaluation ? [challenger.evaluation] : [] });
    }

    // Consolidation C2 inbox reads, re-pointed to challenger records.
    // Reads are fail-soft (unknown challenger → empty); writes below
    // 404 on an unknown challenger.
    if (path.endsWith("/adaptation/candidates/approvals") && request.method === "GET") {
      const candidateId = url.searchParams.get("candidateId") || "";
      if (!candidateId) {
        return Response.json({ error: "candidateId query parameter is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { listChallengerApprovals } = await import("../../services/championChallenger");
      return Response.json({ approvals: listChallengerApprovals(ctx.getOrm(), userLogin, candidateId) });
    }
    if (path.endsWith("/adaptation/candidates/verdicts") && request.method === "GET") {
      const candidateId = url.searchParams.get("candidateId") || "";
      if (!candidateId) {
        return Response.json({ error: "candidateId query parameter is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { getChallenger } = await import("../../services/championChallenger");
      const { verdictReasons } = await import("../../services/proposalChallengerBridge");
      const challenger = getChallenger(ctx.getOrm(), userLogin, candidateId);
      if (!challenger?.evaluation) {
        return Response.json({ verdicts: [] });
      }
      return Response.json({
        verdicts: [{
          id: challenger.id,
          challengerId: challenger.id,
          passed: challenger.evaluation.verdict === "pass",
          reasons: verdictReasons(challenger.evaluation),
          evaluatedAt: challenger.evaluation.evaluatedAt,
        }],
      });
    }

    // Consolidation #1257: recording an approval IS the decision.
    // The old #759 request-then-decide two-step (and its pending
    // state) is retired with the panel rework: approve takes the
    // decision directly, and the challenger locks (non-creator,
    // non-system approver) still apply inside recordChallengerApproval.
    if (path.endsWith("/adaptation/candidates/approve") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      const decision = body?.decision;
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      if (decision !== "approved" && decision !== "rejected") {
        return Response.json({ error: "decision (approved|rejected) is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { getChallenger, recordChallengerApproval } = await import("../../services/championChallenger");
      if (!getChallenger(ctx.getOrm(), userLogin, candidateId)) {
        return Response.json({ error: `challenger ${candidateId} not found.` }, { status: 404 });
      }
      const result = recordChallengerApproval(ctx.getOrm(), userLogin, candidateId, {
        approver: userLogin,
        decision,
      });
      return Response.json({ success: result.ok, reason: result.reason ?? null, timestamp: new Date().toISOString() });
    }
    if (path.endsWith("/adaptation/candidates/gate") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { verdictReasons } = await import("../../services/proposalChallengerBridge");
      const out = await evaluateChallengerRoute(candidateId, userLogin);
      if (out instanceof Response) return out;
      return Response.json({
        success: true,
        verdict: {
          passed: out.evaluation.verdict === "pass",
          reasons: verdictReasons(out.evaluation),
        },
        timestamp: new Date().toISOString(),
      });
    }

    // #1257 post-hoc live check (owner go-ahead 2026-11-03). Landed AND
    // LEFT IN PLACE per the owner's 2026-11-03 direction ("don't remove
    // it"), which supersedes the draft's "never ship permanently" line:
    // the route stays until the owner directs removal. Read-only by
    // construction: SELECT only, no drain, no advance, no rollback, no
    // mutation of any kind. Same session auth as the surrounding
    // adaptation routes (x-user-login header or sessionId) — a standing
    // read path into the DO mas_promotions store for any authenticated
    // session, not operator-only.
    if (path.endsWith("/adaptation/promotions/active-check") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      if (!userLogin) return unauthenticatedResponse();
      try {
        const sql = ctx.getOrm().getSql();
        const inFlight = Array.from(
          sql.exec(
            `SELECT id, candidate_id, stage, stage_started_at, created_at
             FROM mas_promotions
             WHERE stage IN ('shadow', 'partial', 'full')
             ORDER BY created_at ASC`
          )
        ) as any[];
        const byStage = Array.from(
          sql.exec(`SELECT stage, COUNT(*) AS count FROM mas_promotions GROUP BY stage`)
        ) as any[];
        return Response.json({
          inFlight,
          inFlightCount: inFlight.length,
          byStage,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // AOP: the query failure is a coded outcome, never raw store
        // text to the client (outcome catalog + single resolver, #2381).
        const outcome = resolveOutcome("FAILURE_PROMOTIONS_ACTIVE_CHECK_QUERY");
        return Response.json(
          {
            code: outcome.code,
            error: codedMessage("FAILURE_PROMOTIONS_ACTIVE_CHECK_QUERY"),
          },
          { status: outcome.entry?.httpStatus ?? 500 }
        );
      }
    }
    if (path.endsWith("/adaptation/promotions") && request.method === "GET") {
      const candidateId = url.searchParams.get("candidateId") || "";
      if (!candidateId) {
        return Response.json({ error: "candidateId query parameter is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { listPromotionRecords } = await import("../../services/championChallenger");
      return Response.json({ promotions: listPromotionRecords(ctx.getOrm(), userLogin, candidateId) });
    }
    // Consolidation #1257: challenger promotion + rollback. The
    // promoter/actor must be the approver of record (enforced inside
    // promoteChallenger); a refusal names the lock that held.
    if (path.endsWith("/adaptation/promotions/promote") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { getChallenger, promoteChallenger } = await import("../../services/championChallenger");
      if (!getChallenger(ctx.getOrm(), userLogin, candidateId)) {
        return Response.json({ error: `challenger ${candidateId} not found.` }, { status: 404 });
      }
      // Issue #2346: the DO storage argument turns on the
      // transaction wrap for the promotion transition (the ctx
      // getStorage idiom, #1661); mock ctxs without it keep the
      // sequential legacy execution.
      const result = promoteChallenger(ctx.getOrm(), userLogin, candidateId, { actor: userLogin }, ctx.getStorage?.());
      return Response.json({ success: result.ok, reason: result.reason ?? null, timestamp: new Date().toISOString() });
    }
    if (path.endsWith("/adaptation/promotions/rollback") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { getChallenger, rollbackChallengerPromotion } = await import("../../services/championChallenger");
      if (!getChallenger(ctx.getOrm(), userLogin, candidateId)) {
        return Response.json({ error: `challenger ${candidateId} not found.` }, { status: 404 });
      }
      // Issue #2346: as the promote handler above — the storage
      // argument turns on the transaction wrap for the rollback.
      const result = rollbackChallengerPromotion(ctx.getOrm(), userLogin, candidateId, { actor: userLogin }, ctx.getStorage?.());
      return Response.json({ success: result.ok, reason: result.reason ?? null, timestamp: new Date().toISOString() });
    }

    // Typed filter/config API (amendment 1; mirrors the #277 settings pattern).
    if (path.endsWith("/research/settings") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const config = await agent.getResearchConfig();
      return Response.json({ config });
    }
    if (path.endsWith("/research/settings") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const patch = (await request.json().catch(() => null)) as Partial<import("../../services/researchConfig").ResearchConfig> | null;
      const out = await agent.saveConfig(patch ?? {});
      return Response.json(out);
    }

    // §9 evaluation pass over a published run.
    if (path.endsWith("/research/evaluate") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const body = (await request.json().catch(() => null)) as { runId?: string } | null;
      if (!body?.runId) {
        return Response.json({ error: "runId is required." }, { status: 400 });
      }
      const evaluation = await agent.evaluateRun(body.runId, userLogin);
      return Response.json({ evaluation });
    }

    // Issue #1162 (epic #1096 Phase 6): the screening activity log —
    // one tenant-scoped feed over the autonomous screening system's
    // own records (activity entries, Phase 3 re-selection proposals,
    // Phase 5 challenger promotions).
    if (path.endsWith("/screening/activity") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const limitParam = Number(url.searchParams.get("limit") || 50);
      const { buildScreeningActivityFeed } = await import("../../services/screeningActivity");
      const feed = buildScreeningActivityFeed(ctx.getOrm(), userLogin, limitParam);
      return Response.json({ count: feed.length, feed });
    }

    // Issue #1162: screening controls — the mas_settings flags behind
    // the rollout (stage, channels, NLQ fit discovery, v2-ranking,
    // scheduled pause). Reads report the effective values with their
    // fail-safes applied; writes are validated, and every change is
    // recorded in the activity log with the session as actor.
    if (path.endsWith("/screening/controls") && request.method === "GET") {
      const { readScreeningControls } = await import("../../services/screeningFlags");
      return Response.json(readScreeningControls((key) => ctx.readSettingRaw(key)));
    }
    if (path.endsWith("/screening/controls") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const body = (await request.json().catch(() => null)) as {
        rolloutStage?: string;
        channelsEnabled?: boolean;
        nlqFitDiscovery?: boolean;
        weightsV2Ranking?: boolean;
        scheduledPaused?: boolean;
      } | null;
      if (!body || typeof body !== "object") {
        return Response.json({ error: "A JSON body with at least one control is required." }, { status: 400 });
      }
      const flags = await import("../../services/screeningFlags");
      const { SCREENING_FLAG_KEYS, isScreeningRolloutStage, readScreeningControls } = flags;
      if (body.rolloutStage !== undefined && !isScreeningRolloutStage(body.rolloutStage)) {
        return Response.json(
          { error: `rolloutStage must be one of: internal, paper, broader.` },
          { status: 400 }
        );
      }
      const changes: string[] = [];
      // The change label derives from the flag key itself
      // ("screening.scheduledPaused" → "scheduledPaused") so the log
      // line can never drift from the key it describes.
      const applyBool = (value: boolean | undefined, key: string) => {
        if (typeof value === "boolean") {
          ctx.writeSetting(key, value ? "on" : "off");
          changes.push(`${key.replace(/^screening\./, "")}=${value ? "on" : "off"}`);
        }
      };
      if (body.rolloutStage !== undefined) {
        ctx.writeSetting(SCREENING_FLAG_KEYS.rolloutStage, body.rolloutStage);
        changes.push(`rolloutStage=${body.rolloutStage}`);
      }
      applyBool(body.channelsEnabled, SCREENING_FLAG_KEYS.channelsEnabled);
      applyBool(body.nlqFitDiscovery, SCREENING_FLAG_KEYS.nlqFitDiscovery);
      applyBool(body.weightsV2Ranking, SCREENING_FLAG_KEYS.weightsV2Ranking);
      applyBool(body.scheduledPaused, SCREENING_FLAG_KEYS.scheduledPaused);
      if (changes.length === 0) {
        return Response.json({ error: "No recognized control was supplied." }, { status: 400 });
      }
      const { recordScreeningActivity } = await import("../../services/screeningActivity");
      recordScreeningActivity(ctx.getOrm(), {
        userLogin,
        kind: "schedule_control",
        summary: `Screening controls updated: ${changes.join(", ")}.`,
        detail: { changes },
        actor: sessionId,
      });
      return Response.json({
        success: true,
        changes,
        ...readScreeningControls((key) => ctx.readSettingRaw(key)),
      });
    }

    // Consolidation C2 (issue #1246, epic #1151): the hub Review
    // inbox's goal-proposal reads + decision, over the Phase 0
    // goal/scenario store. Tenant-scoped exactly like the sibling
    // routes; a decision is the store's status transition only
    // (proposed → active on activate, proposed → archived on
    // dismiss) — nothing else about the goal moves, and only a
    // proposed goal can be decided (409 otherwise). The decision is
    // recorded in the screening activity log with the session as
    // actor.
    if (path.endsWith("/screening/goals") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const statusParam = url.searchParams.get("status") || undefined;
      const GOAL_STATUSES = ["proposed", "active", "paused", "completed", "archived"];
      if (statusParam !== undefined && !GOAL_STATUSES.includes(statusParam)) {
        return Response.json(
          { error: `status must be one of: ${GOAL_STATUSES.join(", ")}.` },
          { status: 400 }
        );
      }
      const store = await import("../../services/goalScenarioStore");
      const orm = ctx.getOrm() as any;
      store.ensureGoalScenarioTables(orm);
      const goals = store
        .listGoals(orm, userLogin, statusParam as any)
        .map((goal) => ({ ...goal, scenarios: store.listScenarios(orm, userLogin, goal.id) }));
      return Response.json({ goals });
    }
    if (path.endsWith("/screening/goals/decide") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const body = (await request.json().catch(() => null)) as {
        id?: string;
        decision?: string;
      } | null;
      if (!body?.id || (body.decision !== "activate" && body.decision !== "dismiss")) {
        return Response.json(
          { error: "id and decision (activate|dismiss) are required." },
          { status: 400 }
        );
      }
      const store = await import("../../services/goalScenarioStore");
      const orm = ctx.getOrm() as any;
      store.ensureGoalScenarioTables(orm);
      const goal = store.getGoal(orm, userLogin, body.id);
      if (!goal) {
        return Response.json({ error: `goal ${body.id} not found.` }, { status: 404 });
      }
      if (goal.status !== "proposed") {
        return Response.json(
          { error: `goal ${body.id} is ${goal.status}; only proposed goals can be decided.` },
          { status: 409 }
        );
      }
      const nextStatus = body.decision === "activate" ? "active" : "archived";
      if (!store.updateGoalStatus(orm, userLogin, body.id, nextStatus as any)) {
        return Response.json({ error: `goal ${body.id} could not be updated.` }, { status: 500 });
      }
      const { recordScreeningActivity } = await import("../../services/screeningActivity");
      recordScreeningActivity(orm, {
        userLogin,
        kind: "goal_decision",
        summary:
          `Goal proposal '${goal.title}' ${body.decision === "activate" ? "activated" : "dismissed (archived)"} ` +
          `from the hub Review inbox.`,
        detail: { goalId: goal.id, decision: body.decision, from: "proposed", to: nextStatus },
        refId: goal.id,
        actor: sessionId,
      });
      return Response.json({ success: true, goal: { ...goal, status: nextStatus } });
    }

    // Consolidation C2 (issue #1246): the Review inbox's read of the
    // Phase 3 re-selection transparency log. Read-only by design —
    // proposals carry governance proposal_only_not_promoted; the
    // promotion path is the champion/challenger gate, not this route.
    if (path.endsWith("/screening/reselection-proposals") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const limitParam = Number(url.searchParams.get("limit") || 20);
      const limit = Math.max(1, Math.min(Math.floor(limitParam) || 20, 100));
      const { listReselectionProposals } = await import("../../services/strategyBankReselection");
      const proposals = listReselectionProposals(ctx.getOrm(), userLogin, limit);
      return Response.json({ proposals });
    }

    // Consolidation C2 (issue #1246): the hub Track record tab's read
    // of the Phase 5 outcome ledger (listOutcomeTracking) — the
    // per-recommendation outcomes with their honest quality states
    // (pending / verified / unverified). Distinct from the #340
    // research track record above; the two stores are not merged.
    if (path.endsWith("/screening/outcomes") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const { listOutcomeTracking } = await import("../../services/outcomeTracking");
      const outcomes = listOutcomeTracking(ctx.getOrm(), userLogin);
      return Response.json({ outcomes });
    }

    // Consolidation C1 (issue #1201, epic #1151 R1): the goal-driven
    // screen's production entry — the #1096 unified stack (Phase 0
    // registry + Phase 3 goal-driven semantics) reachable from the
    // hub and this route. The run executes via ScreenerAgent and is
    // recorded on the canonical seams inside executeGoalScreenRun
    // (mas_reports + screening activity log + optional Phase 6
    // channel delivery). A stored scenario is resolved tenant-scoped
    // through the Phase 0 store; otherwise the scenario is built
    // from the goal kind (+ optional direction).
    if (path.endsWith("/screening/goal-screen") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const body = (await request.json().catch(() => null)) as {
        goalKind?: string;
        direction?: string;
        scenarioId?: string;
        symbols?: string[];
        assetClasses?: string[];
        environment?: string;
        deliver?: string[];
        emailTo?: string;
        async?: unknown;
        // Issue #2186 (slice 10): checkout contact for the paid path
        // only — caller-supplied like the submit route (no verified
        // email exists in the session). Required when monetization
        // is ON; ignored when it is OFF.
        email?: string;
      } | null;
      if (!body || typeof body !== "object") {
        return Response.json({ error: "A JSON body with goalKind or scenarioId is required." }, { status: 400 });
      }
      const { GOAL_KINDS, buildScenario } = await import("../../services/goalScenarioEngine");
      const runtime = await import("../../services/screeningRuntime");
      const orm = ctx.getOrm();
      let scenario: ReturnType<typeof buildScenario>;
      let scenarioSource: "built" | "stored";
      if (body.scenarioId) {
        const store = await import("../../services/goalScenarioStore");
        store.ensureGoalScenarioTables(orm as any);
        const record = store.getScenario(orm as any, userLogin, body.scenarioId);
        if (!record) {
          return Response.json(
            { error: `Stored scenario '${body.scenarioId}' was not found for this account.` },
            { status: 404 }
          );
        }
        const goal = store.getGoal(orm as any, userLogin, record.goalId);
        if (!goal) {
          return Response.json(
            { error: `The goal owning scenario '${body.scenarioId}' was not found for this account.` },
            { status: 404 }
          );
        }
        scenario = runtime.scenarioFromStoredRecord(goal, record);
        scenarioSource = "stored";
      } else {
        if (!body.goalKind || !(GOAL_KINDS as readonly string[]).includes(body.goalKind)) {
          return Response.json(
            { error: `goalKind must be one of: ${GOAL_KINDS.join(", ")}.` },
            { status: 400 }
          );
        }
        const outlooks = ["bullish", "bearish", "volatile", "range_bound", "unknown"];
        if (body.direction !== undefined && !outlooks.includes(body.direction)) {
          return Response.json(
            { error: `direction must be one of: ${outlooks.join(", ")}.` },
            { status: 400 }
          );
        }
        scenario = buildScenario({
          goalKind: body.goalKind as (typeof GOAL_KINDS)[number],
          portfolioRef: { kind: "hypothetical" },
          ...(body.direction
            ? { direction: body.direction as ReturnType<typeof buildScenario>["direction"] }
            : {}),
        });
        scenarioSource = "built";
      }
      if (
        body.symbols !== undefined &&
        (!Array.isArray(body.symbols) ||
          body.symbols.some((s) => typeof s !== "string" || !/^[A-Z0-9./-]{1,16}$/i.test(s)))
      ) {
        return Response.json({ error: "symbols must be an array of valid ticker strings." }, { status: 400 });
      }
      if (
        body.assetClasses !== undefined &&
        (!Array.isArray(body.assetClasses) ||
          body.assetClasses.some((c) => c !== "stocks" && c !== "options"))
      ) {
        return Response.json(
          { error: "assetClasses must be a subset of [\"stocks\", \"options\"]." },
          { status: 400 }
        );
      }
      const channels = ["slack", "email", "webhook", "voice"];
      if (
        body.deliver !== undefined &&
        (!Array.isArray(body.deliver) || body.deliver.some((c) => !channels.includes(c)))
      ) {
        return Response.json(
          { error: `deliver must be a subset of: ${channels.join(", ")}.` },
          { status: 400 }
        );
      }
      // Issue #1996 (#1972 slice 1): opt-in workflow
      // submission, mirroring the market routes' async
      // pattern. Every validation above already ran, so a
      // bad goalKind / symbols / assetClasses / deliver
      // 400s BEFORE any submission attempt. A successful
      // start answers 202 with the run handle; a null start
      // (no workflow binding, no projection store, start
      // error) falls through to the synchronous direct path
      // unchanged — the direct path stays byte-identical
      // when async is not requested, and is the fallback
      // when it is.
      // Issue #1997: the opt-in path above is flag-gated.
      // Flag OFF → the async request falls through to direct
      // unchanged (the #1996 fallback behavior is preserved
      // only behind the flag). Flag ON → the workflow is
      // REQUIRED: a failed start answers a coded 500, never a
      // silent fallback to direct.
      const goalWorkflowOn =
        body.async === true &&
        (await (
          await import("../../features/createFeatureFlagPort")
        ).createFeatureFlagPort(ctx.env).isEnabled("goal_workflow"));
      // Issue #2186 (slice 10): monetization ON never runs a free
      // screen. The workflow path below routes through PaymentWorkflow;
      // the synchronous direct path cannot carry a payment workflow, so
      // when the workflow path is inactive the run is refused with 402
      // instead of silently running free. Flag OFF → unchanged.
      const monetizationOn = await (
        await import("../../features/createFeatureFlagPort")
      ).createFeatureFlagPort(ctx.env).isEnabled("monetization");
      if (monetizationOn && !goalWorkflowOn) {
        return Response.json(
          {
            error: "monetization_enabled_workflow_required",
            detail:
              "Monetization is on: goal screens must go through the payment workflow via async workflow submission (async: true with the goal_workflow flag) or the paid submission route.",
          },
          { status: 402 },
        );
      }
      if (goalWorkflowOn) {
        const { buildGoalScreenCommand, startGoalScreenWorkflow } =
          await import("../../services/goalScreenWorkflowSubmission");
        const { workflowAcceptedResponse, workflowTenantId } =
          await import("../../workflows/screenerWorkflowRoutes");
        const { createObservabilitySink } =
          await import("../../observability/createObservabilityPorts");
        const { WorkflowError } =
          await import("../../workflows/workflowPorts");
        const idempotencyKey = `goal-screen:manual:${userLogin}:${scenario.goalKind}:${new Date().toISOString()}`;
        // Issue #2186 (slice 10): monetization ON routes the workflow
        // submission through PaymentWorkflow instead of starting the
        // screener workflow directly. The payment workflow gate-checks
        // (coverage first), consumes coverage, and starts the screener
        // itself when covered or paid — this branch never starts a
        // screener, and a payment-workflow start failure answers 503
        // with no run started. CROSS-LANE (CTO review): this branch
        // sits inside the CTO-owned goal-workflow submission path
        // (#1997); it adds a branch only and does not change the
        // free-path start, audit, or failure mapping below.
        if (monetizationOn) {
          const checkoutEmail = typeof body.email === "string" ? body.email.trim() : "";
          if (!checkoutEmail) {
            return Response.json(
              { error: "email (checkout contact) is required when monetization is on." },
              { status: 400 },
            );
          }
          try {
            const { createCommercialAdapter, ensureCommercialSchema } =
              await import("../../data/createCommercialPorts");
            const { createSubscriptionAdapter, ensureSubscriptionSchema } =
              await import("../../data/createSubscriptionPorts");
            const { resolvePaidScreenAccount, buildPaidScreenSubmission } =
              await import("../../services/paidScreenSubmission");
            const { startPaymentWorkflowViaBinding } =
              await import("../../services/paymentWorkflowSubmission");
            const commercial = createCommercialAdapter(ctx.env as { AGENT_DB?: unknown });
            const subscriptions = createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown });
            if (!commercial || !subscriptions) {
              return Response.json(
                { error: "Commercial account store is unavailable; no run started." },
                { status: 503 },
              );
            }
            await ensureCommercialSchema(commercial.db);
            await ensureSubscriptionSchema(subscriptions.db);
            const { account } = await resolvePaidScreenAccount(
              { commercial, subscriptions },
              { userId: userLogin, email: checkoutEmail, tenantId: workflowTenantId(ctx.env), nowMs: Date.now() },
            );
            const paidCommand = buildGoalScreenCommand({
              jobId: idempotencyKey,
              source: "manual",
              trigger: "manual",
              userLogin,
              tenantId: workflowTenantId(ctx.env),
              scenario,
              scenarioSource,
              ...(body.assetClasses
                ? { assetClasses: body.assetClasses as ("stocks" | "options")[] }
                : {}),
              ...(body.symbols ? { symbols: body.symbols } : {}),
              ...(body.deliver
                ? { deliverChannels: body.deliver as ("slack" | "email" | "webhook" | "voice")[] }
                : {}),
              ...(body.emailTo ? { emailTo: body.emailTo } : {}),
              ...(body.environment === "TEST" || body.environment === "PROD"
                ? { environment: body.environment }
                : {}),
            });
            const params = buildPaidScreenSubmission({
              runRequestId: idempotencyKey,
              family: "goal",
              trigger: "manual",
              tenantId: workflowTenantId(ctx.env),
              userId: userLogin,
              email: checkoutEmail,
              account,
              screenerCommand: paidCommand,
            });
            const started = await startPaymentWorkflowViaBinding(
              ctx.env.PAYMENT_WORKFLOW as unknown as
                | import("../../services/paymentWorkflowSubmission").PaymentWorkflowBinding
                | undefined,
              params,
            );
            try {
              orm.events.create({
                id: crypto.randomUUID(),
                sessionId: userLogin,
                type: "goal_screen.payment_started",
                agent: "orchestrator",
                payload: { principalKind: "session", jobId: idempotencyKey, trigger: "manual", workflowId: started.workflowId },
                createdAt: new Date().toISOString(),
              });
            } catch (auditErr) {
              console.warn(
                `[goal-screen-workflow] Audit insertion failed (type=goal_screen.payment_started, login=${userLogin}): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
              );
            }
            return Response.json(
              { runRequestId: idempotencyKey, workflowId: started.workflowId, status: "payment_started" },
              { status: 202 },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/Tenant mismatch/.test(message)) {
              return Response.json({ error: message }, { status: 403 });
            }
            console.warn(
              `[goal-screen-workflow] Paid start failed for job ${idempotencyKey}: ${message}`,
            );
            return Response.json(
              { error: "Payment workflow could not start; no screener started.", jobId: idempotencyKey },
              { status: 503 },
            );
          }
        }
        try {
          const handle = await startGoalScreenWorkflow(
            ctx.env,
            buildGoalScreenCommand({
              jobId: idempotencyKey,
              source: "manual",
              trigger: "manual",
              userLogin,
              tenantId: workflowTenantId(ctx.env),
              scenario,
              scenarioSource,
              ...(body.assetClasses
                ? { assetClasses: body.assetClasses as ("stocks" | "options")[] }
                : {}),
              ...(body.symbols ? { symbols: body.symbols } : {}),
              ...(body.deliver
                ? { deliverChannels: body.deliver as ("slack" | "email" | "webhook" | "voice")[] }
                : {}),
              ...(body.emailTo ? { emailTo: body.emailTo } : {}),
              ...(body.environment === "TEST" || body.environment === "PROD"
                ? { environment: body.environment }
                : {}),
            }),
            createObservabilitySink(ctx.env),
          );
          // Issue #1999 (D7): manual (route) submissions leave a
          // session-principal audit row, symmetric with the
          // scheduled path's system-principal rows. A lost row
          // warns and never fails the 202: the audit store is the
          // record, not the run.
          try {
            orm.events.create({
              id: crypto.randomUUID(),
              sessionId: userLogin,
              type: "goal_screen.workflow_submitted",
              agent: "orchestrator",
              // Issue #2989: the started workflow id, mirroring
              // the scheduled path (which already records it) —
              // the manual submit's job record at start time.
              payload: { principalKind: "session", jobId: idempotencyKey, trigger: "manual", workflowId: handle.workflowId },
              createdAt: new Date().toISOString(),
            });
          } catch (auditErr) {
            console.warn(
              `[goal-screen-workflow] Audit insertion failed (type=goal_screen.workflow_submitted, login=${userLogin}): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            );
          }
          return workflowAcceptedResponse(handle);
        } catch (err) {
          // Issue #2065 (remainder): the typed failure replaces the
          // null-swallow. The coded response keeps ddd019a9's reason
          // + generic detail and adds the failure code, so the failure
          // is diagnosable without worker-log access. The panel reads
          // only data.error; the raw message stays in the server log.
          const { workflowPortsUnavailableReason } = await import(
            "../../workflows/createWorkflowPorts"
          );
          const reason = workflowPortsUnavailableReason(ctx.env) ?? "start_failed";
          const code = err instanceof WorkflowError ? err.code : "start_failed";
          console.warn(
            `[goal-screen-workflow] Async start failed (${code}) for job ${idempotencyKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Issue #1999 (D7): the start failure leaves a
          // session-principal audit row, like the scheduled path's
          // run_failed rows. A lost row warns and never changes
          // the coded 500 below.
          try {
            orm.events.create({
              id: crypto.randomUUID(),
              sessionId: userLogin,
              type: "goal_screen.run_failed",
              agent: "orchestrator",
              payload: {
                principalKind: "session",
                jobId: idempotencyKey,
                code,
                reason,
                error: err instanceof Error ? err.message : String(err),
              },
              createdAt: new Date().toISOString(),
            });
          } catch (auditErr) {
            console.warn(
              `[goal-screen-workflow] Audit insertion failed (type=goal_screen.run_failed, login=${userLogin}): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            );
          }
          return Response.json(
            {
              error: "goal_workflow_start_failed",
              code,
              reason,
              detail: "Goal workflow could not be started in this environment.",
              jobId: idempotencyKey,
            },
            { status: 500 },
          );
        }
      }
      const out = await runtime.executeGoalScreenRun({
        agent: ctx.getScreenerAgent(userLogin),
        orm,
        env: ctx.env,
        userLogin,
        scenario,
        scenarioSource,
        trigger: "manual",
        idempotencyKey: `goal-screen:manual:${userLogin}:${scenario.goalKind}:${new Date().toISOString()}`,
        ...(body.environment === "TEST" || body.environment === "PROD"
          ? { environment: body.environment }
          : {}),
        ...(body.assetClasses
          ? { assetClasses: body.assetClasses as ("stocks" | "options")[] }
          : {}),
        ...(body.symbols ? { symbols: body.symbols } : {}),
        ...(body.deliver ? { deliver: body.deliver as ("slack" | "email" | "webhook" | "voice")[] } : {}),
        ...(body.emailTo ? { emailTo: body.emailTo } : {}),
        actor: sessionId,
      });
      const payload = {
        success: true,
        executed: out.executed,
        taskId: out.taskId,
        taskStatus: out.taskStatus,
        scenarioSource,
        ...(out.result ? { result: out.result } : {}),
        ...(out.delivery ? { delivery: out.delivery } : {}),
      };
      // A run that failed on every requested asset class is a failed
      // screen: the REST screen idiom answers 502, with the labeled
      // result in the body — never a bare error, never a fake success.
      return Response.json(payload, { status: out.result?.status === "failed" ? 502 : 200 });
    }

    // Consolidation C1 (issue #1201, epic #1151 R1): backtest-on-
    // screen's production entry — walk-forward over live Yahoo daily
    // history (services/screeningRuntime.executeScreenBacktest). A
    // symbol without fetchable history is excluded by the engine
    // with its reason; nothing is fabricated.
    if (path.endsWith("/screening/backtest") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const body = (await request.json().catch(() => null)) as {
        symbols?: unknown;
        folds?: number;
        holdingBars?: number;
        capital?: number;
      } | null;
      if (!body || typeof body !== "object" || !Array.isArray(body.symbols) || body.symbols.length === 0) {
        return Response.json(
          { error: "symbols must be a non-empty array of ticker strings." },
          { status: 400 }
        );
      }
      if (body.symbols.some((s) => typeof s !== "string" || !/^[A-Z0-9./-]{1,16}$/i.test(s))) {
        return Response.json(
          { error: "symbols must be an array of valid ticker strings." },
          { status: 400 }
        );
      }
      const { executeScreenBacktest } = await import("../../services/screeningRuntime");
      // Issue #1331: backtest bars through the platform — route-
      // resolved + outcome-tracked under a per-request run id.
      // Issue #1661: the route ctx now carries a blob handle
      // (getStorage), so this binding writes capture rows when
      // present and keeps the outcome-only contract otherwise.
      const { resolveYahooHistoryDeps } = await import("../../trading");
      // Issue #1331 (fix): resolution failure degrades to undefined
      // deps, so fetchLivePriceBars returns null and the engine
      // excludes the symbol with its reason — the route never 500s
      // on a history outage. See resolveYahooHistoryDeps.
      const historyDeps = await resolveYahooHistoryDeps({
        sql: ctx.getOrm() as any,
        env: ctx.env as any,
        userLogin,
        runId: crypto.randomUUID(),
        blobStorage: ctx.getStorage?.(),
      });
      const result = await executeScreenBacktest({
        symbols: body.symbols as string[],
        historyDeps,
        ...(typeof body.folds === "number" ? { folds: body.folds } : {}),
        ...(typeof body.holdingBars === "number" ? { holdingBars: body.holdingBars } : {}),
        ...(typeof body.capital === "number" ? { capital: body.capital } : {}),
      });
      const { recordScreeningActivity } = await import("../../services/screeningActivity");
      recordScreeningActivity(ctx.getOrm() as any, {
        userLogin,
        kind: "screen_run",
        summary:
          `Backtest-on-screen — ${(body.symbols as string[]).length} symbol(s), ` +
          `${result.aggregate.totalTrades} trade(s), net $${result.aggregate.totalNetPnl} ` +
          `(provenance ${result.provenance}).`,
        detail: { symbols: body.symbols, aggregate: result.aggregate, provenance: result.provenance },
        actor: sessionId,
      });
      return Response.json({ success: true, ...result });
    }
  return null;
}

