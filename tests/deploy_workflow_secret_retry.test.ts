/**
 * Issue #590: the deploy job died with exit 139 (SIGSEGV) in
 * "Set core secrets on Cloudflare Worker". The retry wrapper added for
 * #560/#561 called itself instead of the wrangler secret command, so bash
 * recursed until it crashed — and the body existed three times, once per
 * secret step.
 *
 * These assertions pin the follow-up shape: one shared helper instead of
 * three drifting copies, secrets in their own non-blocking job so a
 * Cloudflare blip cannot read as a code-deploy failure, and a fail-closed
 * rule for secrets the deployment cannot run without.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf-8"
);
const helper = readFileSync(
  new URL("../scripts/ci/put-secret.sh", import.meta.url),
  "utf-8"
);

/** Any `wrangler <subcommand> put "$name"` invocation. */
const BROKER_PUT = /npx wrangler [a-z-]+ put "\$name"/;

function section(start: string, end: string): string {
  const from = workflow.indexOf(start);
  const to = workflow.indexOf(end, from + start.length);
  expect(from, `missing section start: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing section end: ${end}`).toBeGreaterThan(from);
  return workflow.slice(from, to);
}

describe("deploy.yml — secret sync (#590)", () => {
  it("keeps no inline wrapper: every secret step sources the shared helper", () => {
    expect(workflow).not.toContain("put_secret() {");
    // Six steps: core, E*TRADE, Alpaca, gateways, Google OAuth, Threads.
    expect(workflow.match(/source scripts\/ci\/put-secret\.sh/g) ?? []).toHaveLength(6);
  });

  it("runs secrets in their own non-blocking job after the code deploy", () => {
    const job = section("\n  sync-secrets:", "\n  # ── Step 3:");
    expect(job).toContain("continue-on-error: true");
    expect(job).toContain("needs: [load-environment, deploy]");
    expect(job).toContain("timeout-minutes: 20");
  });

  it("keeps the code deploy job free of secret pushes", () => {
    const deploy = section("\n  deploy:", "\n  # ── Step 2b:");
    expect(deploy).toContain("npx wrangler deploy");
    expect(deploy).not.toContain("source scripts/ci/put-secret.sh");
  });

  it("fails when an expected secret is empty and reports optional absences", () => {
    // Hard dependencies: without these the app cannot authenticate or boot.
    expect(workflow).toContain("require_secret GITHUB_CLIENT_ID");
    expect(workflow).toContain("require_secret GITHUB_CLIENT_SECRET");
    expect(workflow).toContain("require_secret SESSION_SECRET");
    expect(workflow).toContain("require_secret ET_API_KEY");
    expect(workflow).toContain("require_secret ET_API_SECRET");
    // Optional, but never silently skipped.
    expect(workflow).toContain('optional_secret SCREENER_SLACK_CHANNEL "$S_SCREENER_SLACK_CHANNEL"');
    // The old silent-skip idiom must be gone from every call site.
    expect(workflow).not.toMatch(/if \[ -n "\$[A-Z_]+" \]; then printf/);
  });
});

describe("deploy.yml — Threads secret sync", () => {
  it("pushes the Threads token the social publisher reads", () => {
    // src/agents/social/publisher.ts resolves threads' credential from
    // THREADS_ACCESS_TOKEN. A token the Worker reads but CI never pushes is a
    // channel that can never publish, so the push is pinned beside the read.
    expect(workflow).toMatch(
      /S_THREADS_ACCESS_TOKEN:\s*\$\{\{\s*secrets\.THREADS_ACCESS_TOKEN\s*\}\}/
    );
    expect(workflow).toMatch(
      /optional_secret THREADS_ACCESS_TOKEN "\$S_THREADS_ACCESS_TOKEN"/
    );
  });
});

describe("deploy.yml — email principals secret sync (#1518)", () => {
  it("pushes CHANNEL_EMAIL_PRINCIPALS for omnichannel email intake", () => {
    expect(workflow).toMatch(
      /S_CHANNEL_EMAIL_PRINCIPALS:\s*\$\{\{\s*secrets\.CHANNEL_EMAIL_PRINCIPALS\s*\}\}/
    );
    expect(workflow).toMatch(
      /optional_secret CHANNEL_EMAIL_PRINCIPALS "\$S_CHANNEL_EMAIL_PRINCIPALS"/
    );
  });
});

describe("deploy.yml — Think webhook secret sync (#3474, #3821)", () => {
  it("pushes THINK_WEBHOOK_SECRET for webhook channel ingress", () => {
    expect(workflow).toMatch(
      /S_THINK_WEBHOOK_SECRET:\s*\$\{\{\s*secrets\.THINK_WEBHOOK_SECRET\s*\}\}/
    );
    expect(workflow).toMatch(
      /optional_secret THINK_WEBHOOK_SECRET "\$S_THINK_WEBHOOK_SECRET"/
    );
  });
});

describe("deploy.yml — Alpaca secret sync (#3277)", () => {
  it("pushes the dual-mode paper and live Alpaca secrets", () => {
    for (const secret of [
      "ALPACA_LIVE_API_KEY",
      "ALPACA_LIVE_SECRET_KEY",
      "ALPACA_LIVE_URL",
      "ALPACA_MARKET_URL",
      "ALPACA_PAPER_API_KEY",
      "ALPACA_PAPER_SECRET_KEY",
      "ALPACA_PAPER_URL",
    ]) {
      expect(workflow).toContain(`require_secret ${secret} "$S_${secret}"`);
    }
  });
});

describe("scripts/ci/put-secret.sh (#590)", () => {
  it("pushes through the broker with a bounded, backed-off retry", () => {
    expect(helper).toMatch(BROKER_PUT);
    expect(helper).toContain("timeout 90");
    expect(helper).toContain("max=3");
    expect(helper).toContain("backoff=$((attempts * 10))");
  });

  it("refuses an empty value instead of pushing one", () => {
    expect(helper).toContain('payload="$(cat)"');
    expect(helper).toMatch(/if \[ -z "\$payload" \]/);
    expect(helper).toContain("refusing to push an empty");
  });

  it("names the failing secret in the check annotation", () => {
    expect(helper).toMatch(/::error title=[^:]+::\$name/);
  });

  it("defines each helper exactly once", () => {
    for (const fn of ["put_secret()", "require_secret()", "optional_secret()", "summary()"]) {
      expect(helper.split(fn).length - 1, fn).toBe(1);
    }
  });

  it("writes pushed, missing and skipped secrets to the job summary", () => {
    // Every outcome is recorded: a green job never hides an absent secret.
    expect(helper).toContain("pushed");
    expect(helper).toContain("missing");
    expect(helper).toContain("not configured (skipped)");
    expect(helper).toContain("GITHUB_STEP_SUMMARY");
  });
});

// ---------------------------------------------------------------------------
// Slack credentials (#3952)
// ---------------------------------------------------------------------------

describe("deploy.yml — Slack credentials (#3952)", () => {
  // The whole Slack credential set (#3974, owner direction): synced now so
  // enabling a channel later is configuration only. Presence in the sync
  // list is what makes a GitHub secret reach the deployment at all.
  const WIRED = [
    "SLACK_APP_ID",
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_VERIFICATION_TOKEN",
    "SLACK_WEBHOOK_URL",
    "SLACK_CHANNEL",
  ];

  it("syncs each Slack credential the code reads, as an optional push", () => {
    for (const name of WIRED) {
      expect(workflow, `${name}: no GitHub-secret source`).toContain(`secrets.${name}`);
      expect(workflow, `${name}: not pushed`).toContain(`optional_secret ${name} `);
      // Optional, never required: absence is a reported fail-closed state,
      // not a reason to fail a code deploy.
      expect(workflow, `${name}: must not be required`).not.toContain(`require_secret ${name} `);
    }
  });

  it("keeps the staged names deployed rather than skipped", () => {
    // Three of the seven have no reader yet (#3974). They stay in the sync
    // list deliberately; the doc records that they configure nothing until
    // a reader lands, so the deployment never claims a channel it lacks.
    const doc = readFileSync(
      new URL("../docs/architecture/security/api-security.md", import.meta.url),
      "utf-8",
    );
    expect(doc).toContain("Staged: deployed, no reader yet");
    for (const name of ["SLACK_APP_ID", "SLACK_APP_TOKEN", "SLACK_VERIFICATION_TOKEN"]) {
      expect(doc, `${name} must be recorded as staged`).toContain(name);
    }
  });

  it("keeps the Slack pushes in the existing core-secrets step (no seventh step)", () => {
    const core = section("\n  sync-secrets:", "\n      - name: Set E*TRADE secrets");
    for (const name of WIRED) {
      expect(core, `${name} belongs to the core step`).toContain(`optional_secret ${name} `);
    }
    expect(workflow.match(/source scripts\/ci\/put-secret\.sh/g) ?? []).toHaveLength(6);
  });
});
