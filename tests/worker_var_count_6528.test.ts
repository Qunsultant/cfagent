// @vitest-environment node
/**
 * #6528 Phase 1 (Config: census + pins) — the Worker var-count pin.
 *
 * Reuses #6491's pin design (test (1) only — the var-count test; #6491's
 * own fix, consolidating the text vars into ONE JSON config var plus
 * hydration code, is SUPERSEDED by the owner's fork decision of
 * 2026-11-25, the config-file route: the JSON file
 * (`environment.config.json`, extended) IS the context carrier, NOT the
 * JSON-var packing — see `docs/architecture/survey/target-state-counts.md`
 * and #6528's Related section). #6491's test (2), the hydration-fidelity
 * test, belongs to the superseded fix and is NOT reused: there is no
 * hydration step on the file route.
 *
 * Seed (re-derived on the PR base, main `e5541ff`, 2026-11-25 — NOT the
 * `3e516f1c` survey numbers):
 * - `wrangler.jsonc` `vars` block: 53 keys = 51 live text vars + 2
 *   `_comment_*` documentation pairs (`_comment_wallet`,
 *   `_comment_stripe`). Cloudflare counts every key-value pair, so the
 *   deploy counts 53; this pin's ceilings count the 51 LIVE vars (the
 *   recount, `~/workspace/6528-recount.md` §4: the survey's own §1.5
 *   inventory sums to 51, and the issue's "52" most likely counts the
 *   commented-out `"STOCK_COPILOT_CADENCE"` line, which is not live).
 * - Recorded Worker secrets: 40 (deployed count per Cloudflare error
 *   10055, run 45546276362; 93 total − 53 vars = 40). Secrets are NOT in
 *   the repo — no test can count them from code, and no test may read
 *   secret values. The 40 is recorded data with provenance (see
 *   `docs/architecture/survey/6528-census-seed.md`); if it drifts from
 *   reality, the deploy error — not this pin — is the detector.
 * - Deployed total as this pin counts it: 51 live + 40 recorded = 91.
 *   As Cloudflare counts it (all 53 keys + 40): 93.
 * - Free-plan cap: 64 (Cloudflare Workers Free limit, error 10055).
 *
 * SHRINK-ONLY CEILING, NOT the hard cap (the decision, and why):
 * a hard assertion `live + secrets <= 64` is RED on main at landing
 * (91 > 64) and stays red until Phase 3 moves the vars into
 * `environment.config.json` — which conflicts with gitops §7 rule 2
 * ("No red pins merge") and §10 (a red pin on main is a stop-the-line
 * event). So this PR lands the shrink-only ceiling (`<=` the seeded
 * totals: no PR can grow the count silently while the programme runs),
 * and the hard `<= 64` assertion replaces the ceiling in the Phase 3
 * PR that moves the vars into the file — the PR that can actually turn
 * it green. This `it` file asserts the cap CONSTANT (64), not the total.
 *
 * `keep_vars: true` trap (`wrangler.jsonc:14`, #4708 comment): the pin
 * measures the FILE; deleting vars from `wrangler.jsonc` does NOT drop
 * the deployed count while `keep_vars: true` is set — the deployed
 * count only drops when vars are removed out-of-band (dashboard / API,
 * or one `keep_vars: false` deploy). File-count green ≠
 * deployed-count green; live proof remains a deploy reaching
 * Post-deploy QA (#6491's acceptance).
 *
 * Hermeticity: the pin reads FILES only — never env, never the network,
 * never git — so CI's injected variables cannot move it. It parses
 * JSONC (comment-stripped, then `JSON.parse`); a naive `JSON.parse` of
 * the raw file fails on comments, and a line-grep would miss multi-line
 * values. `CF_DEPLOY_VERSION` is a real deployed var (the deploy step
 * `sed`-replaces its `<DEPLOY_VERSION>` placeholder) and IS counted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FREE_PLAN_VAR_CAP = 64;
const RECORDED_SECRETS_COUNT = 40;
const LIVE_VAR_CEILING = 51;
const ALL_KEYS_CEILING = 53;
const DEPLOYED_TOTAL_CEILING = 91;

/** Live text vars in `wrangler.jsonc` `vars`, alphabetical — the seed list. */
const VAR_BASELINE: string[] = [
  "AGENT_CAPABILITIES_DISABLED",
  "AGENT_CONFIG_PINS",
  "AI_MODEL",
  "AI_SEARCH_CACHE_MAX_ENTRIES",
  "AI_SEARCH_CACHE_TTL_MS",
  "AI_SEARCH_CORPUS_INDEXING_ENABLED",
  "AI_SEARCH_INSTANCE",
  "AI_SEARCH_REPORT_INDEXING_ENABLED",
  "APP_NAME",
  "CF_DEPLOY_VERSION",
  "CF_WALLET_FACILITATOR",
  "CF_WALLET_NETWORK",
  "CHAT_AUTO_REFRESH_FLOOR_S",
  "CHAT_NLQ_MODE",
  "COMMERCIAL_STORE_OPERATORS",
  "COPILOT_CHANNELS",
  "COPILOT_VOICE_BACKEND",
  "FEATURE_GOAL_WORKFLOW",
  "FEATURE_MONETIZATION",
  "FEATURE_OPTIONS_SCREENER",
  "FEATURE_PAYMENT_ASSURANCE",
  "FEATURE_SANDBOX",
  "FEATURE_SCREENER",
  "FEATURE_WORKSPACE",
  "GOAL_TRACK_DEADLINE_MS",
  "GOAL_TRACK_POLL_MS",
  "IAAA_BOOTSTRAP_ADMINS",
  "IAAA_ENABLED_PROVIDERS",
  "IAAA_GRANT_DEFAULT_EXPIRY_DAYS",
  "IAAA_MEMBERSHIP_INDEX_REPAIR_MODE",
  "IAAA_PDP_ENABLED",
  "IAAA_STALE_CLEANUP_MODE",
  "IAAA_WIRED_FRESHNESS_MS",
  "IAAA_WIRING_ENABLED",
  "KNOWLEDGE_SERVING_ENABLED",
  "MAS_MAX_STEPS",
  "OPTIONS_FLOWS_POLL_MS",
  "OPTIONS_LATEST_POLL_MS",
  "QUOTES_REST_FALLBACK_MS",
  "QUOTES_WS_RECONNECT_BASE_MS",
  "QUOTES_WS_RECONNECT_CAP_MS",
  "SCREENER_ND_MODE",
  "SERVICE_USER_LOGIN",
  "SOCIAL_AUTONOMOUS_CHANNELS",
  "SOCIAL_LIVE_PUBLISHING",
  "SOCIAL_POSTING_ENABLED",
  "STOCK_COPILOT_AROUND_THE_CLOCK",
  "STOCK_COPILOT_PAPER_ENABLED",
  "TICKER_PUSH_INTERVAL_S",
  "TICKER_PUSH_STALE_AFTER_INTERVALS",
  "WORKSPACE_ROOT",
];

/** Documentation-only pairs in the `vars` block (counted by Cloudflare, not live vars). */
const COMMENT_KEYS: string[] = ["_comment_stripe", "_comment_wallet"];

/**
 * Strip `//` and `/* *\/` comments from JSONC, preserving newlines and
 * string contents (so a `//` inside a string value cannot start a comment).
 */
function stripJsoncComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      out.push(c);
      i += 1;
      while (i < n) {
        const ch = text[i];
        out.push(ch);
        i += 1;
        if (ch === "\\" && i < n) {
          out.push(text[i]);
          i += 1;
          continue;
        }
        if (ch === c) break;
      }
      continue;
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out.push("\n");
        i += 1;
      }
      i += 2;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/** The `vars` block of `wrangler.jsonc`, brace-matched with string awareness. */
function readVarsBlock(): Record<string, unknown> {
  const text = readFileSync("wrangler.jsonc", "utf-8");
  const varsAt = text.indexOf('"vars"');
  expect(varsAt, "wrangler.jsonc has a \"vars\" block").toBeGreaterThanOrEqual(0);
  let open = text.indexOf("{", varsAt);
  expect(open, "the vars block opens with {").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = open;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  expect(depth, "the vars block closes").toBe(0);
  const parsed = JSON.parse(stripJsoncComments(text.slice(open, i + 1))) as Record<string, unknown>;
  return parsed;
}

function measure(): { keys: string[]; live: string[] } {
  const vars = readVarsBlock();
  const keys = Object.keys(vars).sort();
  const live = keys.filter((k) => !k.startsWith("_comment_"));
  return { keys, live };
}

describe("Worker var count (#6528 Phase 1, reusing #6491's pin design)", () => {
  const { keys, live } = measure();

  it("the measurement actually ran (the vars block parses)", () => {
    expect(keys.length).toBeGreaterThan(0);
    expect(live.length).toBeGreaterThan(0);
  });

  it("no unlisted text var exists in wrangler.jsonc", () => {
    const allowed = new Set([...VAR_BASELINE, ...COMMENT_KEYS]);
    const offenders = keys.filter((k) => !allowed.has(k));
    expect(
      offenders,
      "new Worker text var(s) must reuse an existing var, move the setting " +
        "into environment.config.json (Phase 3), or be baselined with a census " +
        "disposition + reason in the same PR — see #6528",
    ).toEqual([]);
  });

  it("the live text var count only shrinks (shrink-only ceiling)", () => {
    expect(
      live.length,
      `live text vars ${live.length} exceeds the seeded ceiling ${LIVE_VAR_CEILING}: ` +
        "remove a var, or move the setting into environment.config.json (Phase 3, #6528)",
    ).toBeLessThanOrEqual(LIVE_VAR_CEILING);
  });

  it("the total key count only shrinks (the _comment_* pairs included)", () => {
    expect(keys.length).toBeLessThanOrEqual(ALL_KEYS_CEILING);
  });

  it("the deployed var total only shrinks (shrink-only ceiling)", () => {
    const total = live.length + RECORDED_SECRETS_COUNT;
    expect(
      total,
      `deployed var total ${total} exceeds the seeded ceiling ${DEPLOYED_TOTAL_CEILING} ` +
        `(live text vars ${live.length} + recorded secrets ${RECORDED_SECRETS_COUNT}): ` +
        "remove a var, or move the setting into environment.config.json (Phase 3, #6528)",
    ).toBeLessThanOrEqual(DEPLOYED_TOTAL_CEILING);
  });

  it("the Free-plan cap is recorded as the target (64)", () => {
    // The HARD `<= 64` assertion on the deployed total lands with the
    // Phase 3 PR that moves the vars into environment.config.json — the
    // PR that can actually turn it green. Today the total is 91 > 64, so
    // asserting it here would land red and violate gitops §7 rule 2.
    // This `it` asserts the constant, not the total.
    expect(FREE_PLAN_VAR_CAP).toBe(64);
    expect(live.length + RECORDED_SECRETS_COUNT).toBeGreaterThan(FREE_PLAN_VAR_CAP);
  });

  it("the var baseline is well-formed (unique keys, CF_DEPLOY_VERSION counted)", () => {
    expect(new Set([...VAR_BASELINE, ...COMMENT_KEYS]).size).toBe(
      VAR_BASELINE.length + COMMENT_KEYS.length,
    );
    for (const key of [...VAR_BASELINE, ...COMMENT_KEYS]) {
      expect(key.length).toBeGreaterThan(0);
    }
    expect(live).toContain("CF_DEPLOY_VERSION");
    expect(VAR_BASELINE.length).toBe(LIVE_VAR_CEILING);
  });
});
