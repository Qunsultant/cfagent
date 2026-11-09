/**
 * Post-deploy QA smoke test for cfagent.
 *
 * Ported from cfpay's scripts/qa-smoke.mjs (battle-tested).
 * Runs against the deployed Worker after a successful deploy.
 *
 * Exit code is the contract: 0 means every check that RAN passed.
 * A check that could not run is reported as SKIP, never silently passing.
 *
 * Plain .mjs (not vitest): must talk to live production over HTTP,
 * and must not be collected by `vitest run`.
 */

const BASE_URL = (process.env.BASE_URL || "https://agent.openaimp.com").replace(/\/$/, "");
const API_KEY = process.env.DASHBOARD_API_KEY || "";
// #1754: POST /api/qa/investigate requires a session or the dedicated
// QA_INVESTIGATE_TOKEN service token. The smoke script has no session,
// so it presents the token when the workflow provides it; without it
// the endpoint answers 401 and postInvestigationComment logs [WARN]
// (the smoke still passes — only the AI-diagnosis comment is lost).
const QA_INVESTIGATE_TOKEN = process.env.QA_INVESTIGATE_TOKEN || "";

/**
 * Issue #3891 — assert the deployed client bundle is the one this deploy
 * built. The bundle embeds its short commit sha (window.__BUILD_COMMIT__,
 * substituted by the `define` in vite.config.ts); the deploy job hands
 * qa-smoke the built asset path + commit (EXPECTED_CLIENT_ASSET /
 * EXPECTED_COMMIT). A 404 or an older marker means the published version
 * differs from the built artifact — the exact failure the 13084a0 deploy
 * reported as success while serving the aa751785-era bundle.
 *
 * Retries briefly: a fresh deploy can take a minute to propagate. After
 * the attempts are exhausted the check FAILS (never a silent pass).
 */
export async function checkClientBundle({
  fetchFn = fetch,
  baseUrl,
  expectedAsset,
  expectedCommit,
  maxAttempts = 10,
  delayMs = 30000,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const url = `${baseUrl}${expectedAsset}`;
  let detail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetchFn(url);
    } catch (err) {
      detail = `fetch failed: ${err.message}`;
      if (attempt < maxAttempts) await sleepFn(delayMs);
      continue;
    }
    if (res.status !== 200) {
      detail = `live asset ${expectedAsset} returned ${res.status} (attempt ${attempt}/${maxAttempts})`;
      if (attempt < maxAttempts) await sleepFn(delayMs);
      continue;
    }
    const body = await res.text();
    if (body.includes(expectedCommit)) {
      return {
        ok: true,
        attempts: attempt,
        detail: `live asset carries commit ${expectedCommit} (attempt ${attempt}/${maxAttempts})`,
      };
    }
    const liveMarker = body.match(/__BUILD_COMMIT__="([^"]+)"/)?.[1];
    detail = liveMarker
      ? `live asset carries commit ${liveMarker}, expected ${expectedCommit} — stale deploy (attempt ${attempt}/${maxAttempts})`
      : `live asset carries no build marker, expected commit ${expectedCommit} (attempt ${attempt}/${maxAttempts})`;
    if (attempt < maxAttempts) await sleepFn(delayMs);
  }
  return { ok: false, attempts: maxAttempts, detail: `${detail} after ${maxAttempts} attempts` };
}

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`  [SKIP] ${name} - ${why}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
}

async function main() {
  console.log(`Post-deploy QA against ${BASE_URL}\n`);

  // 1. Worker responds at all
  try {
    const { res } = await fetchJson(`${BASE_URL}/health`);
    record("worker responds on /health", res.ok, `status=${res.status}`);
    if (!res.ok) { await finish(); return; }
  } catch (err) {
    record("worker responds on /health", false, err.message);
    await finish();
    return;
  }

  // 2. Deployed client bundle matches this deploy (#3891).
  //    The deploy job hands qa-smoke the built asset path + short commit
  //    (EXPECTED_CLIENT_ASSET / EXPECTED_COMMIT). Without them the check
  //    cannot run and is skipped visibly, never silently passed.
  const expectedAsset = process.env.EXPECTED_CLIENT_ASSET || "";
  const expectedCommit = process.env.EXPECTED_COMMIT || "";
  if (expectedAsset && expectedCommit) {
    try {
      const bundle = await checkClientBundle({
        baseUrl: BASE_URL,
        expectedAsset,
        expectedCommit,
      });
      record("deployed client bundle", bundle.ok, bundle.detail);
    } catch (err) {
      record("deployed client bundle", false, err.message);
    }
  } else {
    skip(
      "deployed client bundle",
      "EXPECTED_CLIENT_ASSET/EXPECTED_COMMIT not provided by the deploy job",
    );
  }

  // 3. A2A agent card (public discovery)
  try {
    const { res, json } = await fetchJson(`${BASE_URL}/.well-known/agent-card.json`);
    const ok = res.ok && json && Array.isArray(json.agents);
    record("A2A agent card", ok, ok ? `${json.agents.length} agents` : `status=${res.status}`);
  } catch (err) {
    record("A2A agent card", false, err.message);
  }

  // 4. A2A dispatch gate is up (issue #1097).
  //    The old check probed POST /a2a/scheduled-agent, but scheduled-agent
  //    is not an A2A agent: it has no agent card, no catalog entry, no
  //    handleA2A, and its hyphenated name cannot match the edge route
  //    pattern (^/a2a/(\w+)$). Its 503 was the #291 A5 edge-auth gate
  //    failing closed on an unset A2A_API_TOKEN — and with the token set,
  //    the same unauthenticated probe would return 401 and still fail,
  //    so the old check could never pass. This probe instead exercises
  //    the gate itself on a real agent path (/a2a/search) with no
  //    credentials, mirroring the search check's 401-means-alive rule:
  //    401 = gate up and enforcing auth (pass); 503 = dispatch not
  //    configured in production (visible skip, not a failure — enabling
  //    dispatch is a separate owner decision to set A2A_API_TOKEN);
  //    404 = not exposed via /a2a yet (skip); anything else non-ok
  //    (e.g. 500) = fail. This check deliberately does NOT claim
  //    ScheduledAgent reachability: that DO is cron-driven with no
  //    public HTTP surface, so no deploy-time HTTP probe can observe it.
  try {
    const { res } = await fetchJson(`${BASE_URL}/a2a/search`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "qa-gate", method: "search.query", params: {} }),
    });
    if (res.status === 401) {
      record("A2A dispatch gate", true, "gate up, auth required");
    } else if (res.status === 503) {
      skip("A2A dispatch gate", "A2A dispatch not configured in production");
    } else if (res.status === 404) {
      skip("A2A dispatch gate", "not exposed via /a2a yet");
    } else {
      record("A2A dispatch gate", res.ok, `status=${res.status}`);
    }
  } catch (err) {
    record("A2A dispatch gate", false, err.message);
  }

  // 5. Search agent responds (core capability)
  try {
    const { res, json } = await fetchJson(`${BASE_URL}/api/search`, {
      method: "POST",
      body: JSON.stringify({ query: "qa smoke test", limit: 1 }),
    });
    // Accept 200 or 401 (auth required) as "alive"; 500 is a failure
    const alive = res.status !== 500;
    record("search endpoint alive", alive, `status=${res.status}`);
  } catch (err) {
    record("search endpoint alive", false, err.message);
  }

  await finish();
}

async function finish() {
  await fileSelfHealIssues();
  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const passed = ran - failed;
  console.log(
    `\n${passed}/${ran} checks passed` +
      (skipped ? `, ${skipped} skipped` : "") +
      (failed ? `, ${failed} FAILED` : ""),
  );
  process.exit(failed > 0 ? 1 : 0);
}

// File one GitHub issue per failing check (dedup by check name)
async function fileSelfHealIssues() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("  [SKIP] filing self-heal issues - GITHUB_TOKEN not set");
    return;
  }
  const failures = results.filter((r) => !r.ok && !r.skipped);
  if (failures.length === 0) return;

  for (const f of failures) {
    const title = `[QA self-heal] ${f.name}`;
    const body = [
      `**Check:** ${f.name}`,
      `**Detail:** ${f.detail || "(none)"}`,
      `**When:** ${new Date().toISOString()}`,
      `**Base URL:** ${BASE_URL}`,
      "",
      "What happens next: diagnose from the above, branch, and open a fix PR referencing this issue.",
      "This issue auto-closes when the check passes again on a deploy.",
    ].join("\n");

    try {
      // Check for existing open issue with same title (dedup)
      const searchRes = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:OpenAIMP/cfagent "${title}" state:open`)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
      );
      const searchJson = await searchRes.json();
      if (searchJson.total_count > 0) {
        console.log(`  [SKIP] issue already open for: ${f.name}`);
        continue;
      }

      const createRes = await fetch(`https://api.github.com/repos/OpenAIMP/cfagent/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body, labels: ["QA self-heal"] }),
      });
      if (createRes.ok) {
        const created = await createRes.json().catch(() => ({}));
        console.log(`  [ISSUE] filed for: ${f.name} (#${created.number || "?"})`);
        // Issue #162: trigger the supervised-fix investigation and post the
        // AI diagnosis as an issue comment for human review.
        if (created.number) {
          await postInvestigationComment(token, created.number, f);
        }
      } else {
        console.log(`  [WARN] failed to file issue for ${f.name}: ${createRes.status}`);
      }
    } catch (err) {
      console.log(`  [WARN] issue filing error for ${f.name}: ${err.message}`);
    }
  }
}

// Issue #162: ask the worker to investigate the failure, then post the
// AI diagnosis as an issue comment so a human can supervise the fix.
async function postInvestigationComment(token, issueNumber, failure) {
  try {
    const invRes = await fetch(`${BASE_URL}/api/qa/investigate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(QA_INVESTIGATE_TOKEN ? { Authorization: `Bearer ${QA_INVESTIGATE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        operation: failure.name,
        errorClass: failure.errorClass || "check_failed",
        detail: failure.detail || "(no detail captured)",
        runLink: process.env.GITHUB_SERVER_URL
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : undefined,
      }),
    });
    if (!invRes.ok) {
      console.log(`  [WARN] investigation endpoint returned ${invRes.status}`);
      return;
    }
    const { investigation } = await invRes.json();
    if (!investigation) return;
    const comment = [
      `## 🔍 Automated investigation (model: ${investigation.model})`,
      ``,
      `**Diagnosis:** ${investigation.diagnosis}`,
      ``,
      `**Likely cause:** ${investigation.likelyCause}`,
      ``,
      `**Proposed fix:** ${investigation.proposedFix}`,
      ``,
      `*Confidence: ${Math.round((investigation.confidence || 0) * 100)}% — a human should verify before opening a fix PR.*`,
    ].join("\n");
    const commentRes = await fetch(
      `https://api.github.com/repos/OpenAIMP/cfagent/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: comment }),
      }
    );
    console.log(
      commentRes.ok
        ? `  [INVESTIGATE] diagnosis posted on #${issueNumber}`
        : `  [WARN] failed to post diagnosis: ${commentRes.status}`
    );
  } catch (err) {
    console.log(`  [WARN] investigation error for ${failure.name}: ${err.message}`);
  }
}

// Exported for tests (tests/qa_smoke_client_bundle_3891.test.ts): importing
// this module must not run the live checks — the #411 netblock would fail
// them and process.exit would kill the test worker. Same isMain guard as
// scripts/ci/deploy-worker.mjs.
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("qa-smoke.mjs") ||
    process.argv[1].endsWith("qa-smoke.js"));

if (isMain) {
  main().catch((err) => {
    console.error("QA script crashed:", err);
    process.exit(2);
  });
}
