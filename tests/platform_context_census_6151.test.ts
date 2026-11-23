// @vitest-environment node
/**
 * #6151 item 7 — the per-concern-resolver census pin (the
 * "resolved once, used throughout" assurance, enforced by CI).
 *
 * The one shared resolution is `resolvePlatformContext`
 * (src/security/platformContext.ts): it composes the
 * per-concern resolvers as internals. No other file may call
 * one directly — a surface that needs broker, tier, or run
 * context consumes the one resolution (slices 2–3, #6172/#6173),
 * never re-derives its own slice.
 *
 * This pin re-runs that measurement over src/ and holds the
 * result SHRINK-ONLY against the baseline recorded below,
 * seeded from main at 587518809 (2026-11-23, slice 0):
 *
 *  - a file x resolver row that is NOT in the baseline fails;
 *  - a row whose matching-call count EXCEEDS its baseline
 *    count fails;
 *  - decreases and vanished rows pass — that is the shrink the
 *    programme wants, and retiring a direct call means
 *    lowering or removing its baseline entry in the same PR.
 *
 * Adding or raising a baseline entry is a deliberate, reviewed
 * act: it requires the new row's census disposition and reason,
 * stated in the PR that does it.
 *
 * Dispositions:
 * - INTEGRATION — an existing direct caller, the migration
 *   backlog: slices 2–3 wire these handlers to consume
 *   resolvePlatformContext, and each migration lowers its
 *   baseline entry in the same PR.
 * - INTERNAL — a definition module's own composition: the
 *   run-broker concern calls the broker concern, the identity
 *   composition calls the tier concern, the tier module's own
 *   transition calls the tier rule. These are the resolvers
 *   calling each other, not surfaces re-deriving a slice.
 * - RESOLVER — the one allowed composer:
 *   src/security/platformContext.ts.
 *
 * Counting rules (the durable lessons):
 * - // line comments and block comments are stripped before
 *   counting — a counted literal inside a comment is not a
 *   call.
 * - `export [async] function <name>(` definition lines are
 *   excluded — defining a resolver is not calling it.
 * - The pin reads FILES only — never env, never the network,
 *   never git. Scope is src/ (.ts/.tsx); tests/ is out of
 *   scope (mocks legitimately name the resolvers there).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PATTERNS = [
  "resolveTenantBroker",
  "resolveScreenProviderForRun",
  "resolveEffectiveTier",
  "resolveRunBrokerContext",
] as const;

type Disposition = "INTEGRATION" | "INTERNAL" | "RESOLVER";

/** [file, resolver, count, disposition] — shrink-only baseline. */
const BASELINE: Array<[string, string, number, Disposition]> = [
  ["src/agents/orchestrator/asyncJobs.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "resolveRunBrokerContext", 1, "INTEGRATION"],
  ["src/agents/orchestrator/meshScreenDoor.ts", "resolveScreenProviderForRun", 1, "INTEGRATION"],
  ["src/agents/orchestrator/nlqPorts.ts", "resolveScreenProviderForRun", 1, "INTEGRATION"],
  ["src/agents/orchestrator/researchPublish.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/routes/adsRevenueReferrals.ts", "resolveEffectiveTier", 1, "INTEGRATION"],
  ["src/agents/routes/agenticPayments.ts", "resolveEffectiveTier", 6, "INTEGRATION"],
  ["src/agents/routes/brokerOptions.ts", "resolveTenantBroker", 2, "INTEGRATION"],
  ["src/agents/routes/brokerOrders.ts", "resolveTenantBroker", 5, "INTEGRATION"],
  ["src/agents/routes/brokerReads.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/routes/brokerRisk.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/routes/brokerScreen.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/routes/copilotChannels.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/routes/etradeOptions.ts", "resolveTenantBroker", 3, "INTEGRATION"],
  ["src/agents/routes/etradeOptionsRuns.ts", "resolveTenantBroker", 4, "INTEGRATION"],
  ["src/agents/routes/mcpChatNlq.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/agents/routes/meter.ts", "resolveEffectiveTier", 1, "INTEGRATION"],
  ["src/agents/routes/premium.ts", "resolveEffectiveTier", 2, "INTEGRATION"],
  ["src/agents/routes/tradingIntegrations.ts", "resolveTenantBroker", 2, "INTEGRATION"],
  ["src/data/subscriptionPorts.ts", "resolveEffectiveTier", 2, "INTERNAL"],
  ["src/security/platformContext.ts", "resolveRunBrokerContext", 1, "RESOLVER"],
  ["src/security/platformContext.ts", "resolveScreenProviderForRun", 1, "RESOLVER"],
  ["src/security/platformContext.ts", "resolveTenantBroker", 1, "RESOLVER"],
  ["src/services/accountBindings.ts", "resolveTenantBroker", 1, "INTEGRATION"], // #6301: fire-time guard (DO alarm context — no session, no PDP permission) — migration to resolvePlatformContext belongs to #6151 slices 2–3.
  ["src/services/brokerOrderCancel.ts", "resolveTenantBroker", 4, "INTEGRATION"],
  ["src/services/brokerOrderPreview.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/services/brokerOrderReplace.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/services/paidScreenSubmission.ts", "resolveEffectiveTier", 1, "INTEGRATION"],
  ["src/services/platformIdentity.ts", "resolveEffectiveTier", 1, "INTERNAL"],
  ["src/services/provisioningWelcome.ts", "resolveEffectiveTier", 1, "INTEGRATION"],
  ["src/services/runBrokerContext.ts", "resolveTenantBroker", 1, "INTERNAL"],
  ["src/services/scheduledTasks.ts", "resolveRunBrokerContext", 2, "INTEGRATION"],
  ["src/services/scheduledTasks.ts", "resolveTenantBroker", 7, "INTEGRATION"],
  ["src/services/upgradeOffers.ts", "resolveEffectiveTier", 1, "INTEGRATION"],
  ["src/trading/channelBroker.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/trading/options/unifiedOptionsService.ts", "resolveTenantBroker", 1, "INTEGRATION"],
  ["src/workflows/runStockScreenViaEngine.ts", "resolveScreenProviderForRun", 1, "INTEGRATION"],
];

function stripComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*.*?\*\//gs, "");
  return withoutBlocks
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      if (/https?:\/\//.test(line.slice(0, idx + 1))) return line;
      return line.slice(0, idx);
    })
    .join("\n");
}

function isDefinition(line: string, name: string): boolean {
  return new RegExp(`^\\s*export\\s+(async\\s+)?function\\s+${name}\\s*\\(`).test(
    line,
  );
}

function countCalls(text: string, name: string): number {
  let count = 0;
  for (const line of stripComments(text).split("\n")) {
    if (isDefinition(line, name)) continue;
    const matches = line.match(new RegExp(`\\b${name}\\s*\\(`, "g"));
    count += matches === null ? 0 : matches.length;
  }
  return count;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
}

describe("per-concern resolver census (#6151 item 7)", () => {
  it("holds direct per-concern resolver calls shrink-only", () => {
    const files: string[] = [];
    walk("src", files);
    const baseline = new Map(
      BASELINE.map(([file, name, count]) => [`${file}\0${name}`, count]),
    );
    const violations: string[] = [];
    for (const file of files.sort()) {
      const text = readFileSync(file, "utf-8");
      for (const name of PATTERNS) {
        const count = countCalls(text, name);
        if (count === 0) continue;
        const key = `${file}\0${name}`;
        const allowed = baseline.get(key);
        if (allowed === undefined) {
          violations.push(
            `${file} calls ${name} ${count} time(s) but has no baseline row — ` +
              `consume resolvePlatformContext instead, or add a reviewed baseline entry`,
          );
        } else if (count > allowed) {
          violations.push(
            `${file} calls ${name} ${count} time(s), above its baseline of ${allowed} — ` +
              `consume resolvePlatformContext instead, or raise the baseline in a reviewed PR`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
