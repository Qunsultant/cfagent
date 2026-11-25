// @vitest-environment node
/**
 * #6528 Phase 1 (Config: census + pins) — the Worker var-count pin,
 * as landed by #6550 Phase 3 (Config: move the vars into the file).
 *
 * Phase 1 seeded the shrink-only ceilings (51 live / 53 keys / 91
 * deployed) because a hard `<= 64` assertion was red on main until
 * Phase 3 moved the vars. Phase 3 (#6550) is the PR that can turn it
 * green, so this file now asserts the HARD cap.
 *
 * Phase 3 state (re-derived on the PR base, main `423be698`,
 * 2026-11-25 — NOT the `3e516f1c` survey numbers):
 * - `wrangler.jsonc` `vars` block: 1 live key, `CF_DEPLOY_VERSION`.
 *   The other 50 live text vars moved into `environment.config.json`
 *   (`defaults.*`) and now survive in `wrangler.jsonc` only as `//`
 *   comments (name + old value + file location, per the 2026-11-24
 *   owner ruling). The 2 `_comment_*` documentation pairs became real
 *   `//` comments. WORKSPACE_ROOT moved too, at the owner's direction
 *   (reserved for a future PortThink agent capability — see the
 *   `_workspaceComment` in the file) — it is NOT dropped.
 * - Recorded Worker secrets: 40 (deployed count per Cloudflare error
 *   10055, run 45546276362; 93 total − 53 vars = 40). Secrets are NOT in
 *   the repo — no test can count them from code, and no test may read
 *   secret values. The 40 is recorded data with provenance (see
 *   `docs/architecture/survey/6528-census-seed.md`); if it drifts from
 *   reality, the deploy error — not this pin — is the detector.
 * - Deployed total as this pin counts it: 1 live + 40 recorded = 41.
 *   B1 CORRECTION (#6550): the deployed total is 41, NOT 40 — the
 *   issue's arithmetic missed `CF_DEPLOY_VERSION`, a live text var
 *   that counts toward the 64 cap (see below). Headroom: 23.
 * - Free-plan cap: 64 (Cloudflare Workers Free limit, error 10055).
 *
 * `CF_DEPLOY_VERSION` counts (the evidence): `.github/workflows/
 * deploy.yml` step "Stamp deploy version into wrangler.jsonc" takes
 * `DEPLOY_SHA` from `github.event.workflow_run.head_sha || github.sha`,
 * `sed`-replaces the `<DEPLOY_VERSION>` placeholder in `wrangler.jsonc`
 * (hard failure if the SHA is absent afterwards), and the deploy then
 * runs `npx wrangler deploy`, which uploads the `vars` block — so
 * `CF_DEPLOY_VERSION` IS a plain deployed Worker var. It stays in env
 * by construction (the issue says so) and it counts.
 *
 * `keep_vars: false` (`wrangler.jsonc`, #6550): the pin measures the
 * FILE; with `keep_vars: true` the deploy would preserve the
 * previously-deployed vars server-side and the file count would lie.
 * Phase 3 flips it to false (secrets are unaffected — the
 * `sync-secrets` job re-puts them after the deploy). File-count green
 * ≠ deployed-count green until a deploy with `keep_vars: false`
 * reaches Post-deploy QA (#6491's acceptance).
 *
 * Hermeticity: the pin reads FILES only — never env, never the network,
 * never git — so CI's injected variables cannot move it. It parses
 * JSONC (comment-stripped, then `JSON.parse`); a naive `JSON.parse` of
 * the raw file fails on comments, and a line-grep would miss multi-line
 * values.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FREE_PLAN_VAR_CAP = 64;
const RECORDED_SECRETS_COUNT = 40;
// Phase 3 (#6550): the hard cap replaces the Phase 1 shrink-only
// ceilings (51 live / 53 keys / 91 deployed). Deployed total 41.
const LIVE_VAR_COUNT = 1;
const ALL_KEYS_COUNT = 1;
const DEPLOYED_TOTAL = 41;

/** Live text vars in `wrangler.jsonc` `vars` — Phase 3: only the deploy-stamped var remains. */
const VAR_BASELINE: string[] = ["CF_DEPLOY_VERSION"];

/** Documentation-only pairs in the `vars` block — Phase 3: none; the two `_comment_*` pairs became real `//` comments. */
const COMMENT_KEYS: string[] = [];

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

  it("the live text var count is exactly one (CF_DEPLOY_VERSION)", () => {
    expect(
      live,
      "only CF_DEPLOY_VERSION may live in wrangler.jsonc vars: every other " +
        "text var belongs in environment.config.json — see #6550",
    ).toEqual(["CF_DEPLOY_VERSION"]);
    expect(live.length).toBe(LIVE_VAR_COUNT);
  });

  it("the total key count is exactly one (no _comment_* pairs remain)", () => {
    expect(keys).toEqual(["CF_DEPLOY_VERSION"]);
    expect(keys.length).toBe(ALL_KEYS_COUNT);
  });

  it("the deployed var total is 41, under the Free-plan hard cap of 64", () => {
    const total = live.length + RECORDED_SECRETS_COUNT;
    expect(total).toBe(DEPLOYED_TOTAL);
    expect(
      total,
      `deployed var total ${total} exceeds the Free-plan cap ${FREE_PLAN_VAR_CAP} ` +
        `(live text vars ${live.length} + recorded secrets ${RECORDED_SECRETS_COUNT})`,
    ).toBeLessThanOrEqual(FREE_PLAN_VAR_CAP);
  });

  it("the Free-plan cap is 64 and the deployed total is 41 (headroom 23)", () => {
    expect(FREE_PLAN_VAR_CAP).toBe(64);
    expect(live.length + RECORDED_SECRETS_COUNT).toBe(41);
    expect(FREE_PLAN_VAR_CAP - (live.length + RECORDED_SECRETS_COUNT)).toBe(23);
  });

  it("the var baseline is well-formed (CF_DEPLOY_VERSION counted)", () => {
    expect(new Set(VAR_BASELINE).size).toBe(VAR_BASELINE.length);
    for (const key of VAR_BASELINE) {
      expect(key.length).toBeGreaterThan(0);
    }
    expect(live).toContain("CF_DEPLOY_VERSION");
    expect(VAR_BASELINE.length).toBe(LIVE_VAR_COUNT);
  });
});
