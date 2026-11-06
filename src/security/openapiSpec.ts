/**
 * OpenAPI + Swagger spike (issue #1024 Phase 1 — no framework change).
 *
 * Generates an OpenAPI 3.x document from the IAAA-UI API catalog
 * (src/client/iaaaEndpointCatalog.ts), which is static code knowledge
 * derived by reading src/server.ts. The hand-rolled router stays; this
 * module only DESCRIBES it.
 *
 * Honesty rule (same as the catalog): hand-written schemas exist for
 * the pilot set only (GET /api/me, GET /health + /health alias,
 * GET /api/iaaa/overview) AND for the stock set (issue #2860 Factor
 * 13: POST/GET /api/market-data/screen, GET /api/reports,
 * GET /api/reports/{id}, POST /api/reports/replay, the
 * /api/screener/presets CRUD, GET /api/screener/report.pdf|xlsx|csv,
 * POST /api/screener/report/regenerate — shapes read from the
 * handlers). Every other path carries an explicit
 * "schema: not yet specified (spike pilot coverage)" marker — never
 * an invented request/response schema. WebSocket routes are listed
 * with an x-transport marker and no invented REST operation.
 *
 * Stock-set boundary: the stock set covers the canonical stock
 * routes above. The AgentDB projection read GET /api/reports/list
 * and the operator seed POST /api/reports/seed-canonical stay
 * marked not-yet-specified (projection / operator surfaces, not
 * the canonical stock-programme routes); the goal spec remains a
 * record, not an executable API path (G7 dated decision — goal
 * execution stays goal-owned).
 *
 * Layering note (spike provisional): this server-side module imports
 * a client-side catalog. The catalog module itself imports only pure
 * data (src/client/mcpEndpointsData.ts has no component or CSS
 * imports), so the worker bundle is unaffected — but the #1024 design
 * should give the catalog a shared home instead of a client import.
 *
 * Version: package.json ("1.0.0") — the repo's version marker.
 * Servers: the production origin from wrangler.jsonc routes.
 */

import {
  API_ENDPOINT_CATALOG,
  type ApiEndpointEntry,
} from "../client/iaaaEndpointCatalog";

export const OPENAPI_NOT_SPECIFIED =
  "schema: not yet specified (spike pilot coverage)";

/** Pilot endpoints with hand-written schemas (shapes read from the handlers). */
const PILOT_PATHS = new Set(["/api/me", "/health", "/api/health", "/api/iaaa/overview"]);

/** Catalog auth kinds that require the session cookie for the operation. */
const SESSION_AUTH = new Set(["session", "session-or-apikey", "platform-admin"]);

type Operation = Record<string, unknown>;
type PathItem = Record<string, unknown>;

const errorResponse = {
  description: "Error (the handler returns { error: string }).",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
  },
};

function operationFor(
  entry: ApiEndpointEntry,
  path: string,
): Operation {
  const isPilot = PILOT_PATHS.has(path);
  const base: Operation = {
    description: entry.authNote,
  };
  if (entry.method === "ANY" && isPilot) {
    // The handler does not restrict the method (catalog method: ANY).
    // GET is the documented contract: /health is fetched with GET by
    // scripts/qa-smoke.mjs, and /api/me is read with a browser GET by
    // the owner (activation flow). No other method is claimed.
    base.description +=
      "\n\nNote: the handler does not restrict the method (catalog method: ANY); " +
      "GET is the documented contract.";
  }
  if (SESSION_AUTH.has(entry.auth)) {
    base.security = [{ sessionCookie: [] }];
  }
  if (isPilot) {
    base.responses = pilotResponses(entry, path);
    return base;
  }
  base.description =
    `${entry.authNote}\n\n${OPENAPI_NOT_SPECIFIED}`;
  base.responses = {
    "200": {
      description: "Response schema not yet specified (spike pilot coverage).",
    },
  };
  return base;
}

function pilotResponses(entry: ApiEndpointEntry, path: string): Record<string, unknown> {
  if (path === "/api/me") {
    return {
      "200": {
        description:
          "Caller session status. Unauthenticated callers get { authenticated: false } " +
          "with HTTP 200 (this handler does not 401). login/name/avatar are present " +
          "only when authenticated; internalUserId only for wired sessions.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/MeResponse" } },
        },
      },
    };
  }
  if (path === "/health" || path === "/api/health") {
    return {
      "200": {
        description: "Public worker health (no session required).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
        },
      },
    };
  }
  if (path === "/api/iaaa/overview") {
    return {
      "200": {
        description:
          "Caller memberships, tenant genesis status, and recent tenant audit events. " +
          "Only a live platform-admin membership returns 200.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/IaaaOverviewResponse" } },
        },
      },
      "401": errorResponse,
      "403": errorResponse,
      "405": errorResponse,
      "500": errorResponse,
    };
  }
  return {
    "200": { description: "Response schema not yet specified (spike pilot coverage)." },
  };
}

function methodsFor(entry: ApiEndpointEntry, path: string): string[] {
  // Pilot ANY endpoints get their documented GET contract (see
  // operationFor). Non-pilot ANY endpoints keep a description-only
  // path item — no operation is invented for them.
  if (entry.method === "ANY" && PILOT_PATHS.has(path)) return ["get"];
  switch (entry.method) {
    case "GET":
      return ["get"];
    case "POST":
      return ["post"];
    case "DELETE":
      return ["delete"];
    case "GET|POST":
      return ["get", "post"];
    default:
      return [];
  }
}

/**
 * Issue #2860 (Factor 13, API-First) — hand-written schemas for the
 * stock routes, beyond the pilot set. Shapes are read from the
 * handlers (not invented): market-data screen from
 * src/agents/routes/marketDataResearch.ts, reports list/detail/
 * replay from src/agents/routes/reports.ts, presets from
 * src/agents/routes/screenerPresets.ts, report artifacts +
 * regenerate from src/agents/routes/screenerResearch.ts.
 * The stock routes are NOT in the IAAA-UI catalog (the spec's
 * generator source), so they are declared here explicitly, like the
 * /openapi.json + /api/docs spike routes below — never silently
 * merged into the catalog. Auth: every stock operation requires
 * the caller's login (x-user-login header, else the session id);
 * the two list/detail reads scope by the login when present and
 * fall back to legacy unfiltered reads when it is absent (#584
 * EP-003), which the descriptions say plainly.
 */
export const STOCK_SPEC_PATHS = new Set([
  "/api/market-data/screen",
  "/api/reports",
  "/api/reports/{id}",
  "/api/reports/replay",
  "/api/screener/presets",
  "/api/screener/presets/{id}",
  "/api/screener/report.pdf",
  "/api/screener/report.xlsx",
  "/api/screener/report.csv",
  "/api/screener/report/regenerate",
]);

const stockSecurity = [{ sessionCookie: [] }];

function stockOperation(
  description: string,
  responses: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Operation {
  return { description, security: stockSecurity, responses, ...extra };
}

/** Hand-written path items for the stock set. */
export function stockPaths(): Record<string, PathItem> {
  return {
    "/api/market-data/screen": {
      description:
        "Run a stock screen over a named universe through the research screener (Yahoo feed). GET takes the filters as query parameters; POST takes them as a JSON body. Requires the caller's login (x-user-login); 401 without it.",
      get: stockOperation(
        "Run a stock screen (GET — filters as query parameters). A universe of ALL shards across universes. async=1 enqueues a workflow run (202) instead of screening synchronously.",
        {
          "200": {
            description: "Synchronous screen result, or the sharded result when universe=ALL.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/StockScreenResponse" },
                    { $ref: "#/components/schemas/ShardedScreenResponse" },
                  ],
                },
              },
            },
          },
          "202": {
            description: "Async screen accepted — the workflow run was enqueued.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/WorkflowAcceptedResponse" } },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "429": {
            description: "Already running (retryable, names the in-flight run) or quota exceeded.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AlreadyRunningResponse" } },
            },
          },
          "502": errorResponse,
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "sector", in: "query", schema: { type: "string" }, description: "Sector filter (ALL when absent)." },
            { name: "search", in: "query", schema: { type: "string" }, description: "Symbol/name search text." },
            { name: "universe", in: "query", schema: { type: "string", description: "Universe id (NASDAQ100, SP500, SP100, RUSSELL2000, TECH, ETF, LEV_ETF, ALL)." } },
            { name: "minRsi", in: "query", schema: { type: "number" } },
            { name: "maxRsi", in: "query", schema: { type: "number" } },
            { name: "maxPeRatio", in: "query", schema: { type: "number" } },
            { name: "gainersOnly", in: "query", schema: { type: "boolean" } },
            { name: "losersOnly", in: "query", schema: { type: "boolean" } },
            { name: "async", in: "query", schema: { type: "string", enum: ["1"] }, description: "1 enqueues the screen as a workflow run (202)." },
          ],
        },
      ),
      post: stockOperation(
        "Run a stock screen (POST — filters as a JSON body). The body IS the filter object; `async: true` enqueues a workflow run (202). `screenMode`/`screenIntent` are the #2530 dual-mode admission fields: non-deterministic mode requires the SCREENER_ND_MODE gate and a non-blank intent, else 400.",
        {
          "200": {
            description: "Synchronous screen result, or the sharded result when universe=ALL.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/StockScreenResponse" },
                    { $ref: "#/components/schemas/ShardedScreenResponse" },
                  ],
                },
              },
            },
          },
          "202": {
            description: "Async screen accepted — the workflow run was enqueued.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/WorkflowAcceptedResponse" } },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "429": {
            description: "Already running (retryable, names the in-flight run) or quota exceeded.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AlreadyRunningResponse" } },
            },
          },
          "502": errorResponse,
          "500": errorResponse,
        },
        {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/StockScreenRequest" } },
            },
          },
        },
      ),
    },
    "/api/reports": {
      description:
        "List the caller's persisted canonical reports (mas_reports), newest first. Tenant scoping from the caller's login (#584 EP-003): strict when the login is known, legacy unfiltered when it is not.",
      get: stockOperation(
        "List persisted reports. ?q= token search, ?source= screener|options_scanner|iv_collection filter, ?limit= 1..100 (default 50).",
        {
          "200": {
            description: "Report list (metadata only — bodies stay in the canonical store).",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReportsListResponse" } },
            },
          },
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "q", in: "query", schema: { type: "string" }, description: "Token search over title/summary/body." },
            { name: "source", in: "query", schema: { type: "string" }, description: "Source filter (screener, options_scanner, iv_collection)." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          ],
        },
      ),
    },
    "/api/reports/{id}": {
      description:
        "One persisted report by canonical row id, owner-scoped (#584 EP-003: hidden from another owner when the caller login is known).",
      get: stockOperation(
        "Report detail, including the stored body (attachmentBase64 blanked when present).",
        {
          "200": {
            description: "The stored report with its body.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReportDetailResponse" } },
            },
          },
          "404": errorResponse,
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Canonical mas_reports row id." },
          ],
        },
      ),
    },
    "/api/reports/replay": {
      description:
        "Replay one persisted report from stored data only (#2863): the same report from any given day, zero live re-fetch, no re-charge, provenance to the original run. Requires the caller's login; a report the caller does not own is 404, never a leak.",
      post: stockOperation(
        "Replay a report. Lookup keys, in order: reportId (exact canonical row id, owner-scoped), runId / generationId (stored run_id, owner-scoped), symbol (newest stored research report for that symbol).",
        {
          "200": {
            description: "Replay envelope (stock-screen or research), with replay provenance.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReplayResponse" } },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "404": {
            description: "Report not found or not owned by the caller.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
          "422": {
            description: "Persisted body is not replayable (no full set) — loud failure, never a fabricated report.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
          "500": errorResponse,
        },
        {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReplayRequest" } },
            },
          },
        },
      ),
    },
    "/api/screener/presets": {
      description:
        "The caller's stored screener presets (per-user DO/SQLite, mas_screener_presets). Criteria are validated by the same strict parsers the run path uses, so a stored preset can never hold criteria a run would reject.",
      get: stockOperation(
        "List the caller's presets.",
        {
          "200": {
            description: "The caller's presets.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PresetsListResponse" } },
            },
          },
          "500": errorResponse,
        },
      ),
      post: stockOperation(
        "Create a preset (201). Validates name (<=100 chars), asset class, and criteria; unknown fields are rejected, never silently dropped.",
        {
          "201": {
            description: "The created preset.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PresetCreateResponse" } },
            },
          },
          "400": errorResponse,
          "500": errorResponse,
        },
        {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PresetCreateRequest" } },
            },
          },
        },
      ),
    },
    "/api/screener/presets/{id}": {
      description:
        "Delete one of the caller's presets. Deleting another user's id returns 404, the same as missing — no existence oracle.",
      delete: stockOperation(
        "Delete an own preset.",
        {
          "200": {
            description: "Deletion confirmation.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PresetDeleteResponse" } },
            },
          },
          "404": errorResponse,
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Preset id." },
          ],
        },
      ),
    },
    "/api/screener/report.pdf": {
      description:
        "Downloadable PDF report of the latest screener run (or ?key= for a stored run's PDF). Requires the owner's login.",
      get: stockOperation(
        "PDF bytes as an attachment download; 404 JSON when no report is available yet.",
        {
          "200": {
            description: "PDF bytes (Content-Type application/pdf, Content-Disposition attachment).",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          "401": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "key", in: "query", schema: { type: "string" }, description: "Stored artifact key; absent serves the latest run's PDF." },
          ],
        },
      ),
    },
    "/api/screener/report.xlsx": {
      description:
        "Downloadable XLSX report of the screener run (multi-tab: Screened Stocks + Formulas & Methodology). Requires the owner's login.",
      get: stockOperation(
        "XLSX bytes as an attachment download; 404 JSON when no report is available yet.",
        {
          "200": {
            description: "XLSX bytes (Content-Type application/vnd.openxmlformats-officedocument.spreadsheetml.sheet).",
            content: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "401": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "key", in: "query", schema: { type: "string" }, description: "Stored artifact key; absent serves the latest run's XLSX." },
          ],
        },
      ),
    },
    "/api/screener/report.csv": {
      description:
        "Downloadable CSV report of the screener run (mirrors the XLSX route; the key must be screener:csv:-namespaced, so this route cannot serve a PDF/XLSX blob as CSV). Requires the owner's login.",
      get: stockOperation(
        "CSV bytes as an attachment download; 404 JSON when no report is available yet.",
        {
          "200": {
            description: "CSV bytes (Content-Type text/csv).",
            content: { "text/csv": { schema: { type: "string", format: "binary" } } },
          },
          "401": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
        },
        {
          parameters: [
            { name: "key", in: "query", schema: { type: "string" }, description: "Stored artifact key; absent serves the latest run's CSV." },
          ],
        },
      ),
    },
    "/api/screener/report/regenerate": {
      description:
        "Regenerate the latest run's PDF (#1278: the recovery path for a run whose PDF generation failed). No re-screen — the ScreenerAgent re-runs the report pipeline for its stored latest run.",
      post: stockOperation(
        "Regenerate the latest run's PDF. 200 when generated, 502 when regeneration itself failed, 404 when there is no run to regenerate.",
        {
          "200": {
            description: "Regeneration outcome (generated).",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RegenerateReportResponse" } },
            },
          },
          "401": errorResponse,
          "404": errorResponse,
          "502": {
            description: "Regeneration failed.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RegenerateReportResponse" } },
            },
          },
          "500": errorResponse,
        },
      ),
    },
  };
}

/** Component schemas for the stock set (shapes read from the handlers). */
export function stockSchemas(): Record<string, unknown> {
  return {
    StockScreenRequest: {
      type: "object",
      description:
        "The market-data screen request body. The body IS the filter object (plus the stripped envelope fields). The full filter vocabulary is StockScreenerFilter (src/types.ts); the fields below are the ones this route reads directly — the shared spec builder validates the rest and rejects unknown/invalid values (400), never silently dropping them.",
      properties: {
        sector: { type: "string", description: "Sector filter (ALL when absent)." },
        search: { type: "string", description: "Symbol/name search text." },
        universe: {
          type: "string",
          enum: ["NASDAQ100", "SP500", "SP100", "RUSSELL2000", "TECH", "ETF", "LEV_ETF", "ALL"],
          description: "Universe to screen; ALL shards across universes.",
        },
        minPrice: { type: "number" },
        maxPrice: { type: "number" },
        exchange: { type: "string", enum: ["ALL", "NASDAQ", "NYSE", "AMEX"] },
        minMarketCap: { type: "number", description: "Minimum market cap (billions or absolute)." },
        maxPeRatio: { type: "number" },
        minRsi: { type: "number" },
        maxRsi: { type: "number" },
        gainersOnly: { type: "boolean" },
        losersOnly: { type: "boolean" },
        async: { type: "boolean", description: "True enqueues the screen as a workflow run (202); stripped before spec building." },
        checkoutEmail: { type: "string", description: "Checkout contact for the paid path only (monetization ON); stripped like async." },
        screenMode: { type: "string", enum: ["deterministic", "non-deterministic"], description: "Per-run mode (#2530 dual-mode admission)." },
        screenIntent: { type: "string", description: "Non-deterministic intent; requires SCREENER_ND_MODE open and a non-blank intent, else 400." },
      },
      additionalProperties: true,
    },
    StockRow: {
      type: "object",
      description:
        "One screened row as stored (ScreenerRunResult.allStocks) — quotes, enrichment, indicators/scores as persisted. The row vocabulary is the persisted run shape, not a fixed column list, so no required fields are claimed here.",
      additionalProperties: true,
    },
    StockStandout: {
      type: "object",
      description: "One standout opportunity as stored (ScreenerRunResult.opportunities).",
      additionalProperties: true,
    },
    StockScreenResponse: {
      type: "object",
      required: ["universe", "provider", "totalScanned", "matchedCount", "opportunities", "stocks"],
      properties: {
        universe: { type: "string" },
        provider: { type: "string", example: "yahoo" },
        totalScanned: { type: "integer" },
        matchedCount: { type: "integer" },
        opportunities: { type: "array", items: { $ref: "#/components/schemas/StockStandout" } },
        stocks: { type: "array", items: { $ref: "#/components/schemas/StockRow" }, description: "The full scanned set." },
        results: { type: "array", items: { $ref: "#/components/schemas/StockRow" }, description: "Alias of stocks." },
        filterApplied: { $ref: "#/components/schemas/StockScreenRequest", description: "The filters this run applied." },
        filterSummary: { type: "string" },
        discoveryMessage: { type: "string" },
        scannedAt: { type: "string", format: "date-time" },
        pdfKey: { type: "string" },
        pdfStatus: { type: "string" },
        pdfError: { type: "string" },
        reportUrl: { type: "string", description: "/api/screener/report.pdf?key=… when a PDF exists." },
        xlsxKey: { type: "string" },
        xlsxStatus: { type: "string" },
        xlsxUrl: { type: "string", description: "/api/screener/report.xlsx?key=… when an XLSX exists." },
      },
    },
    StockScreenUniverseResult: {
      type: "object",
      required: ["universe", "totalScanned", "matchedCount", "success"],
      properties: {
        universe: { type: "string" },
        provider: { type: "string", example: "yahoo" },
        totalScanned: { type: "integer" },
        matchedCount: { type: "integer" },
        opportunities: { type: "array", items: { $ref: "#/components/schemas/StockStandout" } },
        stocks: { type: "array", items: { $ref: "#/components/schemas/StockRow" } },
        results: { type: "array", items: { $ref: "#/components/schemas/StockRow" }, description: "Alias of stocks." },
        discoveryMessage: { type: "string" },
        scannedAt: { type: "string", format: "date-time" },
        reportUrl: { type: "string" },
        success: { type: "boolean" },
        error: { type: "string" },
      },
    },
    ShardedScreenResponse: {
      type: "object",
      required: ["sharded", "provider", "universes"],
      properties: {
        sharded: { type: "boolean", example: true },
        provider: { type: "string", example: "yahoo" },
        universes: { type: "array", items: { $ref: "#/components/schemas/StockScreenUniverseResult" } },
      },
    },
    WorkflowAcceptedResponse: {
      type: "object",
      required: ["jobId", "workflowId", "status", "statusUrl"],
      properties: {
        jobId: { type: "string" },
        workflowId: { type: "string" },
        status: { type: "string", enum: ["queued"] },
        existing: { type: "boolean", description: "True when the run adopted an existing workflow instance (idempotent retry)." },
        statusUrl: { type: "string" },
      },
    },
    AlreadyRunningResponse: {
      type: "object",
      required: ["error", "retryable"],
      properties: {
        error: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean", example: true },
        runId: { type: "string", description: "The in-flight run's id (already-running only)." },
        status: { type: "string", description: "The in-flight run's status (already-running only)." },
        limit: { type: "number", description: "Quota limit (quota-exceeded only)." },
        usage: { type: "number", description: "Quota usage (quota-exceeded only)." },
        window: { type: "string", description: "Quota window (quota-exceeded only)." },
        resetAt: { type: "string", format: "date-time" },
        resetAtMs: { type: "number" },
      },
    },
    ReportListItem: {
      type: "object",
      required: ["id", "runId", "title", "source", "summary", "createdAt"],
      properties: {
        id: { type: "string", description: "Canonical mas_reports row id." },
        runId: { type: "string", description: "Stored run_id (screener: `screener:<timestamp>` generation)." },
        title: { type: "string" },
        source: { type: "string", description: "screener, research_report, options_scanner, iv_collection." },
        summary: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        reportUrl: { type: "string", description: "Generated PDF download URL when the stored body carries one." },
      },
    },
    ReportsListResponse: {
      type: "object",
      required: ["count", "reports", "timestamp"],
      properties: {
        count: { type: "integer" },
        reports: { type: "array", items: { $ref: "#/components/schemas/ReportListItem" } },
        timestamp: { type: "string", format: "date-time" },
      },
    },
    ReportDetailResponse: {
      type: "object",
      required: ["id", "runId", "title", "source", "summary", "createdAt"],
      properties: {
        id: { type: "string" },
        runId: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        summary: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        reportUrl: { type: "string" },
        hasAttachment: { type: "boolean" },
        body: { type: "object", description: "The stored canonical body (attachmentBase64 blanked when present).", additionalProperties: true },
      },
    },
    ReplayRequest: {
      type: "object",
      description: "At least one lookup key is required; reportId wins over runId, runId over symbol.",
      properties: {
        reportId: { type: "string", description: "Exact canonical row id (owner-scoped)." },
        runId: { type: "string", description: "Stored run_id (owner-scoped)." },
        generationId: { type: "string", description: "Alias of runId." },
        symbol: { type: "string", description: "Newest stored research report for this symbol." },
      },
    },
    ReplayArtifacts: {
      type: "object",
      properties: {
        pdfKey: { type: "string" },
        xlsxKey: { type: "string" },
        csvKey: { type: "string" },
        reportUrl: { type: "string" },
      },
    },
    ReplayProvenance: {
      type: "object",
      required: ["originalRunId", "generationId", "source"],
      properties: {
        originalRunId: { type: "string" },
        generationId: { type: "string" },
        source: { type: "string", enum: ["persisted canonical report"] },
      },
    },
    StockReplayEnvelope: {
      type: "object",
      required: ["kind", "reportKind", "charged", "liveFetch", "originalRunId", "generationId", "replayedAt", "totalScanned", "matchedCount", "rows", "standouts", "artifacts", "partial", "partialReasons", "provenance"],
      properties: {
        kind: { type: "string", enum: ["replay"] },
        reportKind: { type: "string", enum: ["stock-screen"] },
        charged: { type: "boolean", example: false },
        liveFetch: { type: "boolean", example: false },
        originalRunId: { type: "string" },
        generationId: { type: "string" },
        replayedAt: { type: "string", format: "date-time" },
        timestamp: { type: "string", format: "date-time", description: "The original run's timestamp." },
        universe: { type: "string" },
        sector: { type: "string" },
        provider: { type: "string" },
        trigger: { type: "string" },
        success: { type: "boolean" },
        criteria: { type: "object", nullable: true, description: "The run's criteria when recorded; null when not recorded (partial gap).", additionalProperties: true },
        patternRef: { type: "object", description: "Pinned pattern reference (string legacy form or { patternId, version }).", additionalProperties: true },
        presetRef: { type: "object", description: "Resolved preset reference (string legacy form or { presetId, resolvedAt }).", additionalProperties: true },
        patternQualifications: { type: "array", items: { type: "string" } },
        totalScanned: { type: "integer" },
        matchedCount: { type: "integer" },
        rows: { type: "array", items: { $ref: "#/components/schemas/StockRow" }, description: "The full persisted scanned set." },
        standouts: { type: "array", items: { $ref: "#/components/schemas/StockStandout" } },
        artifacts: { $ref: "#/components/schemas/ReplayArtifacts" },
        partial: { type: "boolean" },
        partialReasons: { type: "array", items: { type: "string" } },
        provenance: { $ref: "#/components/schemas/ReplayProvenance" },
      },
    },
    ResearchReplayEnvelope: {
      type: "object",
      required: ["kind", "reportKind", "charged", "liveFetch", "originalRunId", "generationId", "replayedAt", "body", "partial", "partialReasons", "provenance"],
      properties: {
        kind: { type: "string", enum: ["replay"] },
        reportKind: { type: "string", enum: ["research"] },
        charged: { type: "boolean", example: false },
        liveFetch: { type: "boolean", example: false },
        originalRunId: { type: "string" },
        generationId: { type: "string" },
        replayedAt: { type: "string", format: "date-time" },
        body: { type: "object", description: "The stored research report body, verbatim — never regenerated.", additionalProperties: true },
        partial: { type: "boolean", example: false },
        partialReasons: { type: "array", items: { type: "string" }, example: [] },
        provenance: { $ref: "#/components/schemas/ReplayProvenance" },
      },
    },
    ReplayResponse: {
      type: "object",
      required: ["replay"],
      properties: {
        replay: {
          oneOf: [
            { $ref: "#/components/schemas/StockReplayEnvelope" },
            { $ref: "#/components/schemas/ResearchReplayEnvelope" },
          ],
        },
      },
    },
    ScreenerPreset: {
      type: "object",
      required: ["id", "name", "assetClass", "criteria", "createdAt", "updatedAt"],
      properties: {
        id: { type: "string" },
        name: { type: "string", maxLength: 100 },
        assetClass: { type: "string", enum: ["stocks", "options"] },
        criteria: { type: "object", description: "Parser-normalized criteria (StockScreenerFilter for stocks).", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    PresetsListResponse: {
      type: "object",
      required: ["presets"],
      properties: {
        presets: { type: "array", items: { $ref: "#/components/schemas/ScreenerPreset" } },
      },
    },
    PresetCreateRequest: {
      type: "object",
      required: ["name", "assetClass", "criteria"],
      properties: {
        name: { type: "string", maxLength: 100 },
        assetClass: { type: "string", enum: ["stocks", "options"] },
        criteria: { type: "object", description: "Criteria validated by the run path's strict parsers.", additionalProperties: true },
      },
    },
    PresetCreateResponse: {
      type: "object",
      required: ["preset"],
      properties: {
        preset: { $ref: "#/components/schemas/ScreenerPreset" },
      },
    },
    PresetDeleteResponse: {
      type: "object",
      required: ["deleted"],
      properties: {
        deleted: { type: "boolean", example: true },
      },
    },
    RegenerateReportResponse: {
      type: "object",
      required: ["pdfStatus", "timestamp"],
      properties: {
        pdfStatus: { type: "string", description: "\"generated\" on success." },
        pdfKey: { type: "string" },
        pdfError: { type: "string" },
        timestamp: { type: "string", format: "date-time", description: "The regenerated run's timestamp." },
        reportUrl: { type: "string", description: "/api/screener/report.pdf?key=… when a PDF exists." },
      },
    },
  };
}

/**
 * Build the full OpenAPI document. Pure function of the catalog (plus
 * the two spike routes, which the catalog predates and therefore does
 * not contain — they are added explicitly, with their real behavior).
 */
export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, PathItem> = {};

  for (const entry of API_ENDPOINT_CATALOG) {
    if (entry.kind === "catchall" || entry.kind === "static") continue;
    const urls = [entry.path, ...entry.aliases];
    if (entry.kind === "websocket") {
      for (const url of urls) {
        paths[url] = {
          description:
            `${entry.authNote}\n\nTransport: WebSocket upgrade (not a REST operation).` +
            `\n\n${OPENAPI_NOT_SPECIFIED}`,
          "x-transport": "websocket",
        };
      }
      continue;
    }
    for (const url of urls) {
      // Merge, never overwrite: two catalog entries can share one path
      // (e.g. GET + POST /api/schedule/goals, list + mint /api/api-keys).
      // Each operation keeps its own entry's gating note.
      const item: PathItem = paths[url] ?? {};
      const methods = methodsFor(entry, url);
      for (const method of methods) {
        item[method] = operationFor(entry, url);
      }
      if (methods.length === 0 && !item.description) {
        item.description = `${entry.authNote}\n\n${OPENAPI_NOT_SPECIFIED}`;
      } else if (!item.description && methods.length > 0) {
        // Path-item description mirrors the first operation's description,
        // so the not-yet-specified marker is visible at path level too.
        item.description = (item[methods[0]] as Operation).description as string;
      }
      paths[url] = item;
    }
  }

  // Issue #2860 (Factor 13): the stock set is declared explicitly
  // (stockPaths, above) — the catalog carries no stock routes, so
  // nothing here collides with a catalog entry; a future catalog
  // entry for one of these paths must reuse these schemas, not
  // re-declare them.
  for (const [p, item] of Object.entries(stockPaths())) {
    paths[p] = item;
  }

  // Spike routes themselves (issue #1024 Phase 1). Provisional gating:
  // both require an authenticated session (see the route comments in
  // src/server.ts) — the docs-exposure design decision is still open.
  // The operation descriptions lead with the catalog authNote so the
  // spec stays generated from the catalog, not hand-diverged from it.
  const specEntry = API_ENDPOINT_CATALOG.find((e) => e.path === "/openapi.json");
  const docsEntry = API_ENDPOINT_CATALOG.find((e) => e.path === "/api/docs");
  paths["/openapi.json"] = {
    description:
      "This generated OpenAPI document as JSON. Requires an authenticated session " +
      "(provisional spike gating; the #1024 docs-exposure decision is still open).",
    get: {
      description: `${specEntry?.authNote ?? "Requires an authenticated session."}\n\nReturns this OpenAPI document.`,
      security: [{ sessionCookie: [] }],
      responses: {
        "200": {
          description: "The generated OpenAPI document.",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "401": errorResponse,
        "405": errorResponse,
      },
    },
  };
  paths["/api/docs"] = {
    description:
      "Swagger UI page for trying the API against /openapi.json. Requires an " +
      "authenticated session (provisional spike gating; the #1024 docs-exposure " +
      "decision is still open).",
    get: {
      description: `${docsEntry?.authNote ?? "Requires an authenticated session."}\n\nServes the Swagger UI HTML page.`,
      security: [{ sessionCookie: [] }],
      responses: {
        "200": {
          description: "Swagger UI HTML page (loads Swagger UI from CDN).",
          content: { "text/html": { schema: { type: "string" } } },
        },
        "401": errorResponse,
        "405": errorResponse,
      },
    },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "ai-search-agent",
      version: "1.0.0",
      description:
        "OpenAPI + Swagger spike (issue #1024 Phase 1). Spec generated from the " +
        "IAAA-UI API catalog; hand-written schemas cover the pilot set " +
        "(/api/me, /health, /api/iaaa/overview) and the stock set " +
        "(#2860 Factor 13: /api/market-data/screen, /api/reports, " +
        "/api/reports/{id}, /api/reports/replay, /api/screener/presets, " +
        "/api/screener/report.pdf|xlsx|csv, /api/screener/report/regenerate). " +
        "Every other path is marked not yet specified — the marker, not an invented schema, is the honest state.",
    },
    servers: [{ url: "https://agent.openaimp.com" }],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "session_id",
          description:
            "Worker session cookie (src/security/session.ts COOKIE_NAME). " +
            "Same-origin requests from the Swagger UI page carry it automatically " +
            "when withCredentials is enabled (see SWAGGER_UI_HTML).",
        },
      },
      schemas: {
        ...stockSchemas(),
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        MeResponse: {
          type: "object",
          required: ["authenticated"],
          properties: {
            authenticated: { type: "boolean" },
            login: { type: "string", description: "Present only when authenticated." },
            name: { type: "string", description: "Present only when authenticated." },
            avatar: { type: "string", description: "Present only when authenticated." },
            internalUserId: {
              type: "string",
              description:
                "Present only for wired (post-Phase-1) sessions; absent for legacy sessions.",
            },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["status", "service", "version", "timestamp", "environment", "runtime", "telemetry"],
          properties: {
            status: { type: "string", example: "healthy" },
            service: { type: "string", example: "cfagent-multi-agent-studio" },
            version: { type: "string", example: "1.0.0" },
            timestamp: { type: "string", format: "date-time" },
            environment: { type: "string", description: "Worker environment (e.g. PROD)." },
            runtime: { type: "string", example: "cloudflare-workers" },
            telemetry: {
              type: "object",
              required: ["durableObjects", "mcp", "apiFirst", "fifteenFactorCompliant"],
              properties: {
                durableObjects: { type: "string", example: "healthy" },
                mcp: { type: "string", example: "available" },
                apiFirst: { type: "boolean" },
                fifteenFactorCompliant: { type: "boolean" },
              },
            },
          },
        },
        RoleBinding: {
          type: "object",
          required: ["role", "scope", "grantedBy"],
          properties: {
            role: {
              type: "string",
              enum: ["platform-admin", "tenant-admin", "workspace-admin", "member", "approver", "auditor"],
            },
            scope: { type: "string", enum: ["platform", "tenant", "workspace", "resource"] },
            workspaceId: { type: "string" },
            resourceId: { type: "string" },
            grantedBy: { type: "string" },
            expiresAtMs: { type: "number" },
          },
        },
        Membership: {
          type: "object",
          required: ["membershipId", "internalUserId", "tenantId", "roleBindings", "createdBy", "createdAtMs"],
          properties: {
            membershipId: { type: "string" },
            internalUserId: { type: "string" },
            tenantId: { type: "string" },
            workspaceId: { type: "string" },
            roleBindings: { type: "array", items: { $ref: "#/components/schemas/RoleBinding" } },
            createdBy: { type: "string" },
            createdAtMs: { type: "number" },
            revokedAtMs: { type: "number" },
          },
        },
        AdminAuditEventView: {
          type: "object",
          required: [
            "id",
            "timestamp",
            "type",
            "actorPrincipalId",
            "initiatingPrincipalId",
            "action",
            "decision",
            "outcome",
            "correlationId",
          ],
          properties: {
            id: { type: "string" },
            timestamp: { type: "number", description: "Epoch milliseconds." },
            type: { type: "string" },
            actorPrincipalId: { type: "string" },
            initiatingPrincipalId: { type: "string" },
            action: { type: "string" },
            decision: { type: "string" },
            outcome: { type: "string" },
            correlationId: { type: "string" },
            resourceId: { type: "string" },
            errorCode: { type: "string" },
          },
        },
        IaaaOverviewResponse: {
          type: "object",
          required: [
            "allowed",
            "tenantId",
            "callerInternalUserId",
            "memberships",
            "genesis",
            "recentAuditEvents",
          ],
          properties: {
            allowed: { type: "boolean", description: "Always true on the 200 shape." },
            tenantId: { type: "string" },
            callerInternalUserId: { type: "string" },
            memberships: { type: "array", items: { $ref: "#/components/schemas/Membership" } },
            genesis: {
              type: "object",
              required: ["platformGenesisOccurred"],
              properties: { platformGenesisOccurred: { type: "boolean" } },
            },
            recentAuditEvents: {
              type: "array",
              items: { $ref: "#/components/schemas/AdminAuditEventView" },
            },
          },
        },
      },
    },
  };
}

/**
 * Swagger UI page for GET /api/docs. Swagger UI itself loads from CDN
 * (no new dependency, nothing vendored). The worker sets no
 * Content-Security-Policy (verified by grep over src/ at spike time),
 * so CDN loading is not blocked by a worker CSP; if a CSP is added
 * later, cdn.jsdelivr.net must be allowlisted for scripts, styles,
 * and fonts, or the page breaks — recorded as a spike finding.
 *
 * withCredentials is enabled so the session cookie (same-origin) is
 * carried on /openapi.json fetches and on try-it requests; without a
 * live session the try-it console gets 401s, which is the correct
 * fail-closed behavior for the provisional gating.
 */
export const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ai-search-agent API docs (spike)</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = function () {
  SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    withCredentials: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  });
};
</script>
</body>
</html>
`;
