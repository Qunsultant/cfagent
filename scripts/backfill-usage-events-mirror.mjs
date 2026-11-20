/**
 * Issue #3185 (bridge slice) — one-off backfill driver for the
 * usage-events D1 mirror.
 *
 * Drives POST /api/ops/usage-events-reconcile once per DO
 * instance, in order, until every instance reports zero new
 * rows. The route itself is the mechanism (the sweep projects +
 * backfills + prunes one instance per call); this script is only
 * the operator's driver across instances — it holds no
 * projection logic of its own.
 *
 * Instances (no enumeration exists, so the operator names them):
 *  - shared_orchestrator (the default: the saga half),
 *  - one per-login Orchestrator instance per login (the
 *    research_run half; each call fans out to that login's
 *    ResearchAgent instance, so the research_evaluation half
 *    reconciles in the same call).
 * Anonymous x402/MPP payer rows and legacy default* logins have
 * no instance to name: their rows project only when the
 * instance that holds them is reconciled, and they stay
 * NULL-tenant (never invented).
 *
 * Usage:
 *   node scripts/backfill-usage-events-mirror.mjs \
 *     --base https://agent.openaimp.com \
 *     --cookie 'session=...' \
 *     --login alice --login bob [--limit 100]
 *   node scripts/backfill-usage-events-mirror.mjs --help
 *
 * Auth: the route is platform-admin gated behind the signed-in
 * session (requireAuth → live platform-admin membership), so the
 * operator passes their session cookie. Without it the route
 * answers 401/403 and the script reports the refusal (never a
 * silent pass).
 *
 * Exit code is the contract: 0 means every invoked instance
 * reconciled clean (zero errors, no refusal); 1 means at least
 * one instance errored, refused, or was unreachable. A second
 * run reconciles zero new rows when everything is already
 * current — re-run it until the totals stop moving.
 *
 * Plain .mjs (not vitest): must talk to the live deployment
 * over HTTP, and must not be collected by `vitest run`.
 */

const BASE_URL = (process.env.BASE_URL || "https://agent.openaimp.com").replace(/\/$/, "");
const COOKIE = process.env.SESSION_COOKIE || "";
const DEFAULT_LIMIT = 100;

function usage() {
  return [
    "backfill-usage-events-mirror.mjs — drive the usage-events mirror backfill, once per DO instance.",
    "",
    "  node scripts/backfill-usage-events-mirror.mjs --cookie 'session=...' --login alice [--login bob] [--limit 100] [--base URL]",
    "",
    "  --cookie   signed-in session cookie (or SESSION_COOKIE env). Required: the route is platform-admin gated.",
    "  --login    a login whose per-user Orchestrator instance to reconcile (repeatable).",
    "             Omit --login to reconcile only the shared_orchestrator instance (the saga half).",
    "  --limit    rows per reconcile call (default 100, the sweep's hard bound).",
    "  --base     deployment base URL (default BASE_URL env or https://agent.openaimp.com).",
    "  --help     this text.",
    "",
    "Re-run until every instance reports reconciled=0 and alreadyCurrent covers its rows.",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = { base: BASE_URL, cookie: COOKIE, logins: [], limit: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, ...args };
    if (arg === "--base") args.base = argv[++i] ?? args.base;
    else if (arg === "--cookie") args.cookie = argv[++i] ?? args.cookie;
    else if (arg === "--login") args.logins.push(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i] ?? DEFAULT_LIMIT);
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.base = args.base.replace(/\/$/, "");
  if (!args.cookie) throw new Error("a session cookie is required (--cookie or SESSION_COOKIE env).");
  if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error("--limit must be a positive number.");
  return args;
}

export async function reconcileInstance({ fetchFn = fetch, base, cookie, instance, limit }) {
  const res = await fetchFn(`${base}/api/ops/usage-events-reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ instance, limit }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

export function summarizeInstance(instance, { status, body }) {
  if (status !== 200 || !body || typeof body !== "object") {
    return { instance, ok: false, detail: `HTTP ${status}: ${JSON.stringify(body) ?? ""}`.slice(0, 300) };
  }
  if (typeof body.refused === "string") {
    return { instance, ok: false, detail: `refused: ${body.refused}` };
  }
  const errors = Array.isArray(body.errors) ? body.errors.length : 0;
  const ok = errors === 0;
  const detail = [
    `checked=${body.checked ?? "?"}`,
    `reconciled=${body.reconciled ?? "?"}`,
    `alreadyCurrent=${body.alreadyCurrent ?? "?"}`,
    `tenant deterministic=${body.tenantDeterministic ?? "?"} approximate=${body.tenantApproximate ?? "?"} unattributed=${body.tenantUnattributed ?? "?"}`,
    `pruned do=${body.prunedDo ?? "?"} mirror=${body.prunedMirror ?? "?"}`,
    `errors=${errors}`,
  ].join(" ");
  return { instance, ok, detail };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`usage: ${err.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  // The shared instance first (the saga half), then each named
  // login's instance (research_run + ResearchAgent halves).
  const instances = ["shared_orchestrator", ...args.logins];
  let failed = 0;
  for (const instance of instances) {
    let outcome;
    try {
      outcome = await reconcileInstance({
        base: args.base,
        cookie: args.cookie,
        instance,
        limit: args.limit,
      });
    } catch (err) {
      console.log(`[FAIL] ${instance}: unreachable: ${err.message}`);
      failed++;
      continue;
    }
    const summary = summarizeInstance(instance, outcome);
    console.log(`[${summary.ok ? "OK  " : "FAIL"}] ${instance}: ${summary.detail}`);
    if (!summary.ok) failed++;
  }
  if (failed > 0) {
    console.log(`\n${failed} instance(s) failed or refused — diagnose before re-running.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll instances reconciled clean. Re-run until reconciled=0 everywhere to confirm the drain.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
