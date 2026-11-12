/**
 * Route inventory pin for Qunsultant/cfagent#2902 (server.ts refactor by domain).
 *
 * Contract: docs/architecture/server-refactor-contract.md section 5.
 * This pin asserts, in dispatch order, every path branch of the Worker entry
 * (src/server.ts handleFetch + src/server/routes/*.ts handlers), reconstructed
 * by walking handleFetch and expanding each delegation call in place into its
 * module's branch conditions. A route added, removed, reordered, re-authed
 * (method guard changed), or silently moved without updating this pin fails.
 *
 * Baseline: 148 descriptors, scanned from origin/main 5627c72b (2026-11-05),
 * src/server.ts 7,431 lines / 360,983 bytes, before Slice 2. The list is the
 * contract section 3 inventory re-baselined: it adds the routes the contract
 * table missed (the /auth/login/<id> + /auth/callback/<id> provider family,
 * /api/user/email-destination, the WebSocket upgrade dispatch paths, the
 * /api/schedules forward alongside /api/schedule/*, the full IAAA lifecycle
 * block) and records the method guards the table only implied (POST|GET
 * trading-options, GET|POST market quotes source, OPTIONS premium preflight).
 * Moves only: this list must not change across Slices 2-9 except by a route
 * change approved in its own issue (recorded here with that issue number).
 *
 * Slice 2 decisions recorded here (see also the Slice 2 progress comment on
 * #2902):
 * - A2A / .well-known / /api/features are Core (contract section 3 wins over
 *   the #2902 body, which listed them under Platform; file order supports it).
 * - /api/etrade/* OAuth routes are Auth (Slice 3), not Trading.
 * - Browser-snapshot placement (contract open question Q2) is Platform
 *   (Slice 7), moved as a whole, never split across slices.
 * - The <800-line server.ts pin (contract section 2) is a proposal only: it
 *   is NOT set here, because Slice 2 cannot meet it while all domain code
 *   still lives in server.ts. Slice 9 sets the pin the slice actually
 *   achieves; a pin is never loosened to fit.
 * - Wrangler entrypoint exports (contract open question Q3): the code
 *   comments in server.ts state wrangler requires every bound DO class to be
 *   exported from the entrypoint; Slice 9 re-checks and keeps any required
 *   re-export with per-class justification.
 *
 * Slice 3 decisions recorded here:
 * - Auth & IAAA live in src/server/routes/auth.ts as three handlers in
 *   dispatch order: handleAuthLoginRoutes (/login, /auth/login/<id>,
 *   /auth/callback/<id>, /auth/logout, E*TRADE + public OAuth families),
 *   handleAuthMeRoutes (/api/me, /api/user/email-destination,
 *   /api/iaaa/overview, /api/governance/seed-halt), handleAuthIaaaRoutes
 *   (access-request + full IAAA lifecycle + /api/api-keys). The delegation
 *   -order assertion below grows by slice; the 148-descriptor EXPECTED list
 *   is unchanged (verified identical by the scanner before and after).
 *
 * Slice 4 decisions recorded here:
 * - Privacy & compliance live in src/server/routes/privacy.ts as three
 *   handlers in dispatch order: handlePrivacyRoutes
 *   (/api/privacy/status, /api/privacy/preferences, /api/privacy/export,
 *   /api/privacy/erasure), handlePrivacyChainsRoutes (/api/chains/status,
 *   /api/chains/reconcile, /api/jobs/history, /api/traces,
 *   /api/agents/registry, /api/products/catalog, /api/jobs/reconcile,
 *   /api/retention/purge), handlePrivacyReportsRoutes
 *   (/api/audit/history, /api/reports/list,
 *   /api/reports/seed-canonical). The delegation-order assertion below
 *   grows to the nine delegations in dispatch order; the 148-descriptor
 *   EXPECTED list is unchanged (verified identical by the scanner before
 *   and after).
 *
 * Slice 6 decisions recorded here:
 * - Messaging & social live in src/server/routes/messaging.ts as three
 *   handlers in dispatch order: handleMessagingSagaRoutes
 *   (/api/saga/*, the three NLQ webhook spellings, /api/qa/investigate,
 *   /api/memory/search), handleMessagingSocialRoutes (/api/social/*),
 *   handleMessagingSlackRoutes (/slack/*). handleNlqWebhookRequest and
 *   NLQ_WEBHOOK_SERVICE_LOGIN move with this slice (contract §2.5).
 *   The saga handler takes the handleFetch ingress `throttle`, which
 *   the NLQ branch passes to handleNlqWebhookRequest.
 * - The AuthLogin/CoreHealth delegations sat between the NLQ and QA
 *   branches inside the moved saga region, so they now run nested
 *   inside handleMessagingSagaRoutes, in the same position; they no
 *   longer appear in server.ts's own delegation list below, and the
 *   scanner's scanFunction now follows such nested route-module
 *   delegations (with a seen-set against cycles/duplicates) so the
 *   148-descriptor list is unchanged. Delegations to handlers outside
 *   src/server/routes/* (e.g. the saga agent-route handlers) are
 *   implementations, not route branches, and are ignored.
 *
 * Slice 7 decisions recorded here:
 * - Platform & commerce live in src/server/routes/platform.ts as five
 *   handlers in dispatch order: handlePlatformTelemetryRoutes
 *   (/api/telemetry/*), handlePlatformRetrievalRoutes
 *   (/api/retrieval/populate-market-graph), handlePlatformMcpRoutes
 *   (/mcp, /api/mcp, /mcp/scanner, /mcp/scanner/*),
 *   handlePlatformPaymentsRoutes (the OPTIONS preflight,
 *   /api/payments/agentic/* + /payments/agentic/commercial/*,
 *   /api/premium/*, /api/payments/webhook + /payments/webhook),
 *   handlePlatformBrowserRoutes (POST /api/browser/snapshot,
 *   /browser/snapshot, /api/browser/transaction-snap,
 *   /browser/transaction-snap, /api/browser/snap/transaction). The
 *   delegation-order assertion below grows to the nineteen delegations
 *   in dispatch order; the 148-descriptor EXPECTED list is unchanged
 *   (verified identical by the scanner before and after).
 * - PREMIUM_GATEWAY_INSTANCE moves with the payments handler (its only
 *   use in the entry); it is defined in routes/platform.ts and
 *   re-exported from src/server.ts at its old position, so the pin's
 *   handleFetch end marker now matches that re-export line and the
 *   existing `import { PREMIUM_GATEWAY_INSTANCE } from "../src/server"`
 *   keeps working.
 *
 * Slice 8 decisions recorded here:
 * - Queue / scheduled consumers live in src/server/routes/queue.ts as
 *   two handlers: handleScheduledEvent (the every-30-minutes tick,
 *   03:00 UTC token renewal, 04:00 UTC retention) and
 *   handleQueueBatch (screener-events-delivery, screener-events,
 *   options_analysis fallthrough), plus the module-level dedup sets
 *   and the shared dispatchOptionsAnalysisQueueWork helper. They are
 *   NOT HTTP routes: the 148-descriptor EXPECTED list is unchanged,
 *   and the delegation-order assertion below stays at the nineteen
 *   handleFetch delegations (scheduled/queue are default-export
 *   members, not handleFetch delegations). Q4 is answered here:
 *   the consumer wiring moves as one queue module, not split across
 *   messaging/trading route modules; ownership stays with the domain
 *   ports it calls (screener-events → Messaging, options_analysis
 *   dispatch → Trading schedule surface, stage executors → owning
 *   ScreenerAgent DO, scheduled tick cross-domain by design).
 * - ensureBreakerDurability moves to src/server/routes/core.ts
 *   (contract §2.5 Core prelude) so fetch and the queue/scheduled
 *   handlers can all call it without a server.ts cycle; it is still
 *   called at the top of fetch, scheduled, and queue.
 *
 * Slice 9 decisions recorded here:
 * - Cleanup: the agent/DO/workflow exports move to
 *   src/server/exports.ts (per-class justifications travel with
 *   them); server.ts re-exports them per line from
 *   "./server/exports" (same names, same order; Q3 answered YES —
 *   wrangler requires the entrypoint exports, contract §8.3).
 *   PREMIUM_GATEWAY_INSTANCE keeps its own re-export line after
 *   handleFetch, so the handleFetch end marker above still matches.
 *   The 148-descriptor EXPECTED list and the nineteen-delegation
 *   order below are unchanged.
 * - Dead imports pruned (contract §2.3): 309 bindings in 128 import
 *   declarations removed per tsc --noUnusedLocals; server.ts 669
 *   lines / 32,317 B → 291 lines / 17,464 B. The size pin below is
 *   set to 291, the number this slice actually achieves; a pin is
 *   never loosened to fit.
 *
 * Slice 5 decisions recorded here:
 * - Trading & market live in src/server/routes/trading.ts as four
 *   handlers in dispatch order: handleTradingScheduleRoutes
 *   (/api/schedule/*), handleTradingOmniRoutes
 *   (/api/trading/email/*, /api/trading/slack/*, /api/trading/voice/*,
 *   /api/trading/options/*, /trading/options/*, /api/schedules forward),
 *   handleTradingQuotesRoutes (/api/market-data/quotes,
 *   /api/market/quotes, /api/foss/quotes, /api/market/quotes/source),
 *   handleTradingApproveRoutes (/trade/approve, /clear, /reset,
 *   /api/clear, /api/reset, /api/options/flows/*). The delegation-order
 *   assertion below grows to the thirteen delegations in dispatch order;
 *   the 148-descriptor EXPECTED list is unchanged (verified identical by
 *   the scanner before and after). The WebSocket upgrade dispatch
 *   (dispatchWsUpgrade) is NOT a route branch and stays inline in
 *   server.ts between the schedules forward and the quotes branches, in
 *   its original position; the scanner does not see it (no path
 *   condition) and the pin does not cover it. No options behaviour
 *   change: the /api/options/flows/* block moves as a whole.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";

// --- Static inventory reconstruction (mirrors scripts logic, in-test) ---

function regexLiterals(cond: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < cond.length; i++) {
    if (cond[i] !== "/") continue;
    const prev = cond.slice(0, i).trimEnd().slice(-1);
    if (prev && !"( |,=!:&?".includes(prev)) continue;
    let j = i + 1;
    let inClass = false;
    let ok = false;
    while (j < cond.length) {
      const ch = cond[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        ok = true;
        break;
      }
      j++;
    }
    if (!ok) continue;
    let k = j + 1;
    while (k < cond.length && /[a-z]/.test(cond[k])) k++;
    const lit = cond.slice(i, j + 1) + cond.slice(j + 1, k);
    const rest = cond.slice(k);
    if (rest.startsWith(".test(path)") || rest.startsWith(".test (path)") || cond.includes("path.match(")) {
      out.push(lit);
    }
    i = j;
  }
  return out;
}

function conditionTokens(cond: string): string[] {
  const methods = [...new Set([...cond.matchAll(/request\.method === "([A-Z]+)"/g)].map((m) => m[1]))];
  const method = methods.length ? methods.join("|") : "ANY";
  const toks: { index: number; text: string }[] = [];
  for (const m of cond.matchAll(/path === "([^"]+)"/g)) {
    toks.push({ index: m.index ?? 0, text: `${method} ${m[1]}` });
  }
  for (const m of cond.matchAll(/path\.startsWith\("([^"]+)"\)/g)) {
    toks.push({ index: m.index ?? 0, text: `${method} PREFIX ${m[1]}` });
  }
  for (const lit of regexLiterals(cond)) {
    toks.push({ index: cond.indexOf(lit), text: `${method} REGEX ${lit}` });
  }
  toks.sort((a, b) => a.index - b.index);
  return toks.map((t) => t.text);
}

// Matches a route-handler delegation call. Hoisted to module scope so
// scanFunction can follow nested delegations too (Slice 6).
const delegationRe = /(?:await )?(handle\w+Routes)\(request, env, url, path(?:, [^)]*)?\)/;

function scanFunction(
  lines: string[],
  indent: number,
  modules?: Record<string, string>,
  seen?: Set<string>,
): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Nested delegation (Slice 6): a handler may itself delegate to
    // another route-module handler at its own top level —
    // handleMessagingSagaRoutes calls handleAuthLoginRoutes and
    // handleCoreHealthRoutes between the NLQ and QA branches, exactly
    // where handleFetch used to call them. Expand it in place so the
    // inventory stays 1:1. Only top-level (indent-4) statements are
    // followed: deeper calls are sub-handler implementations (e.g. the
    // saga agent-route handlers), not route branches, and a target
    // outside src/server/routes/* is ignored rather than unresolved.
    // `seen` guards against cycles and duplicate expansion.
    if (modules && seen && line.startsWith(pad) && !line.startsWith(pad + " ")) {
      const del = line.match(delegationRe);
      if (del) {
        const func = del[1];
        if (!seen.has(func)) {
          for (const src of Object.values(modules)) {
            if (src.includes(`function ${func}(`)) {
              seen.add(func);
              out.push(...scanFunction(handlerBody(src, func), 4, modules, seen));
              break;
            }
          }
        }
        continue;
      }
    }
    if (line.startsWith(pad + "return ") && line.includes("fetchStaticAsset")) {
      out.push("FALLBACK static");
      continue;
    }
    if (line.startsWith(pad + "const ") && line.includes("path.match(")) {
      for (const lit of regexLiterals(line)) out.push(`ANY REGEX ${lit}`);
      continue;
    }
    if (!line.startsWith(pad + "if (")) continue;
    let cond = line.slice(line.indexOf("if (") + 4);
    let depth = 1;
    let j = i;
    let done = false;
    while (j < lines.length && !done) {
      const l = j === i ? cond : lines[j];
      for (const ch of l) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            done = true;
            break;
          }
        }
      }
      if (!done) {
        cond += "\n" + lines[j + 1];
        j++;
      }
    }
    if (cond.includes("path")) out.push(...conditionTokens(cond));
    i = j;
  }
  return out;
}

function handlerBody(src: string, funcName: string): string[] {
  const lines = src.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(`function ${funcName}(`));
  if (startIdx < 0) throw new Error(`handler ${funcName} not found`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("export async function ") || lines[i].startsWith("export function ")) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx);
}

function reconstruct(): string[] {
  const serverSrc = readFileSync("src/server.ts", "utf8");
  const serverLines = serverSrc.split("\n");
  const start = serverLines.findIndex((l) => l.includes("async function handleFetch("));
  // Slice 7 (#2902): PREMIUM_GATEWAY_INSTANCE is defined in
  // routes/platform.ts and re-exported from server.ts at its old
  // position, so the handleFetch end marker matches either spelling.
  let end = serverLines.findIndex((l) => l.startsWith("export const PREMIUM_GATEWAY_INSTANCE") || l.startsWith('export { PREMIUM_GATEWAY_INSTANCE }'));
  if (end < 0) end = serverLines.length;
  const regionLines = serverLines.slice(start, end);
  const modules: Record<string, string> = {};
  const routesDir = "src/server/routes";
  if (existsSync(routesDir)) {
    for (const f of readdirSync(routesDir).filter((x) => x.endsWith(".ts"))) {
      modules[f.replace(/\.ts$/, "")] = readFileSync(`${routesDir}/${f}`, "utf8");
    }
  }
  const result: string[] = [];
  const seen = new Set<string>();
  let preludeApiSeen = false;
  for (let i = 0; i < regionLines.length; i++) {
    const line = regionLines[i];
    const del = line.match(delegationRe);
    if (del) {
      const func = del[1];
      let found = false;
      for (const src of Object.values(modules)) {
        if (src.includes(`function ${func}(`)) {
          seen.add(func);
          result.push(...scanFunction(handlerBody(src, func), 4, modules, seen));
          found = true;
          break;
        }
      }
      if (!found) result.push(`DELEGATION-UNRESOLVED ${func}`);
      continue;
    }
    if (line.startsWith("    const ") && line.includes("path.match(")) {
      for (const lit of regexLiterals(line)) result.push(`ANY REGEX ${lit}`);
      continue;
    }
    if (line.startsWith("    return ") && line.includes("fetchStaticAsset")) {
      result.push("FALLBACK static");
      continue;
    }
    if (line.startsWith("    if (")) {
      let cond = line.slice(line.indexOf("if (") + 4);
      let depth = 1;
      let j = i;
      let done = false;
      while (j < regionLines.length && !done) {
        const l = j === i ? cond : regionLines[j];
        for (const ch of l) {
          if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              done = true;
              break;
            }
          }
        }
        if (!done) {
          cond += "\n" + regionLines[j + 1];
          j++;
        }
      }
      if (cond.includes("path")) {
        for (const tok of conditionTokens(cond)) {
          if (tok === "ANY PREFIX /api/" && !preludeApiSeen) {
            result.push("PRELUDE-PREFIX /api/");
            preludeApiSeen = true;
          } else {
            result.push(tok);
          }
        }
      }
      i = j;
      continue;
    }
  }
  return result;
}

const EXPECTED_ROUTES: string[] = [
  "PRELUDE-PREFIX /api/",
  "ANY /.well-known/oauth-client-id-metadata-document",
  "ANY PREFIX /a2a/",
  "ANY PREFIX /.well-known/",
  "GET /api/features",
  "ANY /api/privacy/status",
  "ANY /api/privacy/preferences",
  "ANY /api/privacy/export",
  "ANY /api/privacy/erasure",
  "ANY /api/saga/journey-gates",
  "ANY /api/saga/journey-decision",
  "ANY /api/saga/start",
  "ANY REGEX /^\\/api\\/saga\\/[^/]+\\/status$/",
  "POST /nlq/webhook",
  "POST /api/trading/nlq/webhook",
  "POST /api/nlq/webhook",
  "GET /login",
  "ANY REGEX /^\\/auth\\/login\\/([^/]+)$/",
  "ANY REGEX /^\\/auth\\/callback\\/([^/]+)$/",
  "ANY /auth/logout",
  "ANY /auth/etrade/start",
  "ANY /api/etrade/oauth/start",
  "ANY /auth/etrade/callback",
  "ANY /api/etrade/oauth/status",
  "ANY /api/etrade/diagnostics",
  "POST /api/etrade/oauth/verifier",
  "POST /api/etrade/oauth/renew",
  "POST /api/etrade/oauth/revoke",
  "ANY /auth/public/start",
  "ANY /auth/public/callback",
  "ANY /api/public/status",
  "POST /api/public/connect",
  "POST /api/public/disconnect",
  "ANY /health",
  "ANY /api/health",
  "POST /api/qa/investigate",
  "POST /api/memory/search",
  "GET /api/ledger/runs",
  "ANY PREFIX /api/schedule/",
  "ANY /api/social/brief",
  "ANY /api/social/approval",
  "ANY /api/social/approvals",
  "ANY /api/social/posts",
  "ANY /api/social/token-health",
  "ANY /api/me",
  "ANY /api/user/email-destination",
  "ANY /api/iaaa/overview",
  "ANY /api/governance/seed-halt",
  "ANY /api/chains/status",
  "ANY /api/chains/reconcile",
  "ANY /api/jobs/history",
  "ANY /api/traces",
  "ANY /api/agents/registry",
  "ANY /api/products/catalog",
  "ANY /api/jobs/reconcile",
  "ANY /api/retention/purge",
  "ANY /api/telemetry/summary",
  "ANY /api/telemetry/decisions",
  "ANY /api/telemetry/reconcile",
  "ANY REGEX /^\\/api\\/telemetry\\/decisions\\/[^/]+\\/(decide|apply|supersede|expire)$/",
  "ANY /api/audit/history",
  "ANY /api/reports/list",
  "ANY /api/reports/seed-canonical",
  "ANY /api/ops/run-ledger-reconcile",
  "ANY /api/retrieval/populate-market-graph",
  "ANY /api/iaaa/access-request",
  "ANY /api/iaaa/access-requests",
  "ANY /api/iaaa/access-request/decision",
  "ANY /api/iaaa/membership/grant",
  "ANY /api/iaaa/membership/revoke",
  "ANY /api/iaaa/membership/edit",
  "ANY /api/iaaa/permission/deny",
  "ANY /api/iaaa/permission/clear",
  "ANY /api/iaaa/role-grants",
  "ANY /api/iaaa/role-grants/grant",
  "ANY /api/iaaa/role-grants/revoke",
  "ANY /api/iaaa/logged-in-users",
  "ANY /api/iaaa/logged-in-users/revoke",
  "ANY /api/iaaa/quota-usage",
  "ANY /api/iaaa/quota-usage/override",
  "ANY /api/iaaa/policy-proposals",
  "ANY /api/iaaa/policy-proposals/active",
  "ANY /api/iaaa/policy-proposals/propose",
  "ANY /api/iaaa/policy-proposals/approve",
  "ANY /api/iaaa/policy-proposals/reject",
  "ANY /api/iaaa/policy-proposals/promote",
  "ANY /api/iaaa/policy-proposals/preview",
  "ANY /api/iaaa/bootstrap-proposals",
  "ANY /api/iaaa/bootstrap-proposals/current",
  "ANY /api/iaaa/bootstrap-proposals/propose",
  "ANY /api/iaaa/bootstrap-proposals/approve",
  "ANY /api/iaaa/bootstrap-proposals/reject",
  "ANY /api/iaaa/bootstrap-proposals/confirm-applied",
  "ANY /api/iaaa/memberships",
  "ANY /api/iaaa/deactivate",
  "ANY /api/iaaa/offboard",
  "ANY /api/api-keys",
  "ANY PREFIX /api/api-keys/",
  "ANY /mcp",
  "ANY /api/mcp",
  "ANY /mcp/scanner",
  "ANY PREFIX /mcp/scanner/",
  "OPTIONS PREFIX /api/premium/",
  "OPTIONS PREFIX /api/payments/agentic/",
  "OPTIONS PREFIX /payments/agentic/commercial/",
  "ANY PREFIX /api/payments/agentic/",
  "ANY PREFIX /payments/agentic/commercial/",
  "ANY PREFIX /api/premium/",
  "ANY PREFIX /api/payments/webhook",
  "ANY /payments/webhook",
  "POST /api/trading/email/inbound",
  "GET /api/trading/email/approve",
  "POST /api/trading/slack/test",
  "POST /api/trading/slack/link",
  "POST /api/trading/voice/turn",
  "POST /api/trading/voice/test",
  "GET /api/trading/voice/greeting",
  "POST|GET PREFIX /api/trading/options/",
  "POST|GET PREFIX /trading/options/",
  "ANY PREFIX /api/schedules",
  "ANY /api/schedules",
  "GET /api/market-data/quotes",
  "GET /api/market/quotes",
  "GET /api/foss/quotes",
  "GET|POST /api/market/quotes/source",
  "POST /api/browser/snapshot",
  "POST /browser/snapshot",
  "POST /api/browser/transaction-snap",
  "POST /browser/transaction-snap",
  "POST /api/browser/snap/transaction",
  "POST /slack/commands",
  "POST /slack/slash",
  "POST /slack",
  "POST /slack/events",
  "POST /slack/interactions",
  "ANY /slack/install",
  "ANY /slack/oauth_callback",
  "ANY /trade/approve",
  "ANY /clear",
  "ANY /reset",
  "ANY /api/clear",
  "ANY /api/reset",
  "ANY PREFIX /api/options/flows/",
  "ANY /openapi.json",
  "ANY /api/docs",
  "ANY PREFIX /api/",
  "ANY /checkout/sandbox",
  "ANY /",
  "ANY /index.html",
  "FALLBACK static",
];

describe("server route inventory pin (#2902)", () => {
  it("reconstructs the full ordered route inventory 1:1", () => {
    expect(reconstruct()).toEqual(EXPECTED_ROUTES);
  });

  it("delegates Core + Privacy + Messaging + Trading + Platform branches in handleFetch in the original order", () => {
    const serverSrc = readFileSync("src/server.ts", "utf8");
    const calls = [...serverSrc.matchAll(/(?:await )?(handle\w+Routes)\(request, env, url, path/g)].map((m) => m[1]);
    // Slice 2 landed the three Core delegations; Slice 3 (#2902) adds the
    // three Auth delegations in their original dispatch positions, between
    // the Core ones. Slice 4 (#2902) adds the three Privacy delegations in
    // their original dispatch positions. Slice 5 (#2902) adds the four
    // Trading delegations in their original dispatch positions; the
    // WebSocket upgrade dispatch stays inline between the schedules
    // forward and the quotes branches (it is not a delegation). Slice 6
    // (#2902) adds the three Messaging delegations in their original
    // dispatch positions. The AuthLogin/CoreHealth delegations sat
    // between the NLQ and QA branches inside the moved saga region, so
    // they now run nested inside handleMessagingSagaRoutes and no longer
    // appear in this server.ts list; the scanner follows them there.
    // Slice 7 (#2902) adds the five Platform delegations in their
    // original dispatch positions: telemetry after the chains
    // delegation, retrieval after the reports delegation, MCP and
    // payments after the IAAA delegation, browser snapshots after the
    // quotes delegation. Later slices extend this list in dispatch order.
    // #3311 adds the schedule webhook delegation right after the
    // Messaging Saga delegation (the webhook family it belongs to).
    expect(calls).toEqual([
      "handleCoreEarlyRoutes",
      "handlePrivacyRoutes",
      "handleMessagingSagaRoutes",
      "handleScheduleWebhookRoutes",
      "handleTradingScheduleRoutes",
      "handleMessagingSocialRoutes",
      "handleAuthMeRoutes",
      "handlePrivacyChainsRoutes",
      "handlePlatformTelemetryRoutes",
      "handlePrivacyReportsRoutes",
      "handlePlatformRetrievalRoutes",
      "handleAuthIaaaRoutes",
      "handlePlatformMcpRoutes",
      "handlePlatformPaymentsRoutes",
      "handleTradingOmniRoutes",
      "handleTradingQuotesRoutes",
      "handlePlatformBrowserRoutes",
      "handleMessagingSlackRoutes",
      "handleTradingApproveRoutes",
      "handleCoreLateRoutes",
    ]);
  });

  it("shared auth lives once in src/server/auth.ts, not in server.ts", () => {
    const authSrc = readFileSync("src/server/auth.ts", "utf8");
    expect(authSrc).toContain("export function isAllowedOrigin");
    expect(authSrc).toContain("export async function requireAuth");
    expect(authSrc).toContain("export async function authenticateRequest");
    const serverSrc = readFileSync("src/server.ts", "utf8");
    expect(serverSrc).not.toContain("function isAllowedOrigin(");
    expect(serverSrc).not.toContain("function requireAuth(");
    expect(serverSrc).not.toContain("function authenticateRequest(");
    expect(serverSrc).toContain('from "./server/auth"');
  });

  it("server.ts stays at the Slice 9 achieved size (320 lines, contract §2)", () => {
    // Slice 9 (#2902 Cleanup) sets the pin the slice actually achieves:
    // server.ts 669 lines → 291 lines (dead imports pruned per
    // tsc --noUnusedLocals, exports moved to src/server/exports.ts).
    // The <800 proposal was never a final number. A pin is never
    // loosened to fit: if the dispatcher legitimately grows, update
    // this number deliberately with the reason recorded here.
    // #3534 records one deliberate growth: +1 line re-exporting
    // JobPipelineWorkflow, the fifth ThinkWorkflow class, alongside
    // the other four workflow re-exports (291 → 292).
    // #3515 S3 batch 1 records a second deliberate growth: +12 lines
    // for the structured-logger seam (7-line module logger boilerplate
    // + the .catch(console.warn) voice-connection handler rewritten as
    // a structuredLog.warn call, 5 lines) (292 → 304). The dispatcher
    // gains no new route or responsibility — the growth is the logger
    // the S3 console.* migration adopts in every migrated file.
    // #3490 records a third deliberate growth: +10 lines for the
    // email channel's second dispatch branch (1 import line +
    // the `email` handler's agent-channel gate: agent-addressed
    // mail routes through routeAgentEmail, everything else falls
    // through to the NLQ handler) (304 → 314). The routing logic
    // itself lives in src/actors/agentEmailRouting.ts, not here.
    // #3311 records a fourth deliberate growth: +6 lines for the
    // schedule webhook delegation (1 import line + a 3-line comment
    // + the 2-line dispatch branch) (314 → 320).
    const src = readFileSync("src/server.ts", "utf8");
    const lines = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
    expect(lines).toBeLessThanOrEqual(320);
  });
});

// --- Dispatch smoke: moved Core branches answer exactly as before ---

const fetchWorker = async (path: string, method = "GET") => {
  const res = await worker.fetch(new Request(`https://agent.test${path}`, { method }), {} as any);
  return res;
};

describe("core dispatch smoke (#2902 Slice 2)", () => {
  it("default export still exposes the email/scheduled/queue entry points (Slice 8)", () => {
    // Slice 8 moves the scheduled/queue bodies to routes/queue.ts; the
    // entry keeps one-line delegations, so the shape wrangler invokes
    // (fetch + email + scheduled + queue) is unchanged.
    expect(typeof (worker as unknown as { email: unknown }).email).toBe("function");
    expect(typeof (worker as unknown as { scheduled: unknown }).scheduled).toBe("function");
    expect(typeof (worker as unknown as { queue: unknown }).queue).toBe("function");
  });

  it("GET /health and /api/health are public and healthy", async () => {
    for (const p of ["/health", "/api/health"]) {
      const res = await fetchWorker(p);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("healthy");
    }
  });

  it("GET /.well-known/oauth-client-id-metadata-document is public", async () => {
    const res = await fetchWorker("/.well-known/oauth-client-id-metadata-document");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("GET /checkout/sandbox stays public (KEEP PUBLIC, #2052)", async () => {
    const res = await fetchWorker("/checkout/sandbox");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Payment Terminal");
  });

  it("GET /openapi.json and /api/docs still 401 without a session", async () => {
    expect((await fetchWorker("/openapi.json")).status).toBe(401);
    expect((await fetchWorker("/api/docs")).status).toBe(401);
  });

  it("unknown /api/* still 401s at the fallthrough without a session", async () => {
    expect((await fetchWorker("/api/no-such-route-2902")).status).toBe(401);
  });

  it("GET / still serves the landing page without a session", async () => {
    const res = await fetchWorker("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("GET /api/features still answers without a session (session optional)", async () => {
    const res = await fetchWorker("/api/features");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features?: unknown };
    expect(body.features).toBeDefined();
  });

  it("inline routes still answer as before without a session (no route dropped by the Core move)", async () => {
    // /api/me answers 200 { authenticated: false } by design (not a 401).
    const me = await fetchWorker("/api/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(false);
    expect((await fetchWorker("/api/privacy/status")).status).toBe(401);
  });

  it("moved Slice 4 routes answer exactly as before the move without a session", async () => {
    // Statuses measured on clean main 57364bdb before the move: the read
    // routes 401 via their handlers (session null); the admin-pattern
    // writes reach their own gates instead of the /api/* fallthrough
    // (chains/reconcile hits the unbound DO stub -> 500; jobs/reconcile,
    // retention/purge and reports/seed-canonical hit the unbound-AgentDB
    // check -> 503). A dropped route would 401 at the fallthrough, so
    // these values pin the dispatch, not just the auth.
    const expected: Array<[string, number]> = [
      ["/api/chains/status", 401],
      ["/api/chains/reconcile", 500],
      ["/api/jobs/history", 401],
      ["/api/traces", 401],
      ["/api/agents/registry", 401],
      ["/api/products/catalog", 401],
      ["/api/jobs/reconcile", 503],
      ["/api/retention/purge", 503],
      ["/api/audit/history", 401],
      ["/api/reports/list", 401],
      ["/api/reports/seed-canonical", 503],
    ];
    for (const [p, status] of expected) {
      expect((await fetchWorker(p)).status).toBe(status);
    }
  });

  it("moved Slice 5 routes answer exactly as before the move without a session", async () => {
    // Statuses measured on clean main ab336f60 before the move. Most
    // routes 401 via requireAuth; the exceptions pin the dispatch: the
    // batch quotes are public by the recorded #1725 M10 decision (200),
    // /api/trading/email/approve answers 200 without a session (its
    // approval-link forward has no session gate on this path), and bare
    // /trade/approve 400s on the missing orderId before any session
    // check. A dropped route would 401 at the /api/* fallthrough (or
    // 404 at the Core late tail for /trade/approve, /clear, /reset),
    // so these values pin the dispatch, not just the auth.
    const expected: Array<[string, string, number]> = [
      ["GET", "/api/schedule/goals", 401],
      ["GET", "/api/schedule/operations", 401],
      ["GET", "/api/schedule/ticks", 401],
      ["GET", "/api/schedule/runs", 401],
      ["GET", "/api/schedule/systems", 401],
      ["POST", "/api/trading/email/inbound", 401],
      ["GET", "/api/trading/email/approve", 200],
      ["POST", "/api/trading/slack/test", 401],
      ["POST", "/api/trading/slack/link", 401],
      ["POST", "/api/trading/voice/turn", 401],
      ["POST", "/api/trading/voice/test", 401],
      ["GET", "/api/trading/voice/greeting", 401],
      ["GET", "/api/trading/options/status", 401],
      ["POST", "/api/trading/options/status", 401],
      ["GET", "/api/schedules", 401],
      ["GET", "/api/market-data/quotes", 200],
      ["GET", "/api/market/quotes", 200],
      ["GET", "/api/foss/quotes", 200],
      ["GET", "/api/market/quotes/source", 401],
      ["POST", "/api/market/quotes/source", 401],
      ["GET", "/trade/approve", 400],
      ["GET", "/clear", 401],
      ["GET", "/reset", 401],
      ["GET", "/api/clear", 401],
      ["GET", "/api/reset", 401],
      ["GET", "/api/options/flows/live", 401],
    ];
    for (const [method, p, status] of expected) {
      expect((await fetchWorker(p, method)).status).toBe(status);
    }
  });

  it("moved Slice 6 routes answer exactly as before the move without a session", async () => {
    // Statuses measured on clean main 08159218 before the move. The
    // session-gated families 401 via requireAuth; the NLQ webhooks
    // 503 on the unconfigured INBOUND_NLQ_WEBHOOK_SECRET (throttle
    // passes, secret check fires before signature verification); the
    // Slack webhook routes 503 on the unconfigured SLACK_SIGNING_SECRET
    // (loud 503 per #147, never a silent pass-through); /slack/install
    // and /slack/oauth_callback 500 in this harness. A dropped route
    // would 401 at the /api/* fallthrough (or 404 at the Core late
    // tail for the non-/api/ paths), so these values pin the dispatch,
    // not just the auth.
    const expected: Array<[string, string, number]> = [
      ["GET", "/api/saga/journey-gates", 401],
      ["GET", "/api/saga/journey-decision", 401],
      ["GET", "/api/saga/start", 401],
      ["GET", "/api/saga/abc/status", 401],
      ["POST", "/nlq/webhook", 503],
      ["POST", "/api/trading/nlq/webhook", 503],
      ["POST", "/api/nlq/webhook", 503],
      ["POST", "/api/schedules/webhook/followup", 503],
      ["POST", "/api/qa/investigate", 401],
      ["POST", "/api/memory/search", 401],
      ["GET", "/api/social/brief", 401],
      ["POST", "/api/social/brief", 401],
      ["GET", "/api/social/approval", 401],
      ["POST", "/api/social/approval", 401],
      ["GET", "/api/social/approvals", 401],
      ["GET", "/api/social/posts", 401],
      ["GET", "/api/social/token-health", 401],
      ["POST", "/slack/commands", 503],
      ["POST", "/slack/slash", 503],
      ["POST", "/slack", 503],
      ["POST", "/slack/events", 503],
      ["POST", "/slack/interactions", 503],
      ["GET", "/slack/install", 500],
      ["GET", "/slack/oauth_callback", 500],
    ];
    for (const [method, p, status] of expected) {
      expect((await fetchWorker(p, method)).status).toBe(status);
    }
  });

  it("moved Slice 7 routes answer exactly as before the move without a session", async () => {
    // Statuses measured on clean main c5de0aaa before the move. The
    // session-gated families 401 via requireAuth; the telemetry
    // reconcile/decide writes and the retrieval populate reach the
    // unbound-AgentDB 503 before any auth check (their handlers check
    // the store first), while the telemetry reads 401 through their
    // handlers; the MCP and scanner OPTIONS preflights answer 200
    // with CORS and no auth; /mcp and /api/mcp 401 without a session
    // or API key; the scanner and the premium/webhook forwards hit
    // the unbound DO stub in this harness (500). A dropped route
    // would 401 at the /api/* fallthrough (or 404 at the Core late
    // tail for the non-/api/ paths), so these values pin the dispatch,
    // not just the auth.
    const expected: Array<[string, string, number]> = [
      ["GET", "/api/telemetry/summary", 401],
      ["GET", "/api/telemetry/decisions", 401],
      ["POST", "/api/telemetry/reconcile", 503],
      ["POST", "/api/telemetry/decisions/abc/decide", 503],
      ["POST", "/api/retrieval/populate-market-graph", 503],
      ["GET", "/mcp", 401],
      ["GET", "/api/mcp", 401],
      ["OPTIONS", "/mcp", 200],
      ["GET", "/mcp/scanner", 500],
      ["OPTIONS", "/mcp/scanner", 200],
      ["POST", "/mcp/scanner", 500],
      ["OPTIONS", "/api/premium/foo", 200],
      ["OPTIONS", "/api/payments/agentic/foo", 200],
      ["OPTIONS", "/payments/agentic/commercial/foo", 200],
      ["GET", "/api/payments/agentic/balance", 401],
      ["GET", "/payments/agentic/commercial/balance", 401],
      ["GET", "/api/premium/foo", 500],
      ["POST", "/api/payments/webhook", 500],
      ["POST", "/payments/webhook", 500],
      ["POST", "/api/browser/snapshot", 401],
      ["POST", "/browser/snapshot", 401],
      ["POST", "/api/browser/transaction-snap", 401],
      ["POST", "/browser/transaction-snap", 401],
      ["POST", "/api/browser/snap/transaction", 401],
    ];
    for (const [method, p, status] of expected) {
      expect((await fetchWorker(p, method)).status).toBe(status);
    }
  });
});
