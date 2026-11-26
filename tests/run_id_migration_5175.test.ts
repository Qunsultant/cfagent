// @vitest-environment node
/**
 * Issue #5175 slice 3 — migrate the legacy run-id call sites to the one
 * leaf minter (user ruling 2026-11-17, comment 6962347431). Slice 1
 * built the minters (`src/services/executionTreeIds.ts`); slice 2 built
 * the `mas_runs` registry. This slice moves the fresh-entropy mint
 * points — 27 of them — onto the leaf, and leaves the deterministic /
 * idempotency-load-bearing sites for the resolve-or-mint follow-up
 * (they keep their legacy strings in use, unchanged; no alias rows
 * are written by this slice).
 *
 * Pins:
 *  - 5175-S3-P01 the engine's default run-id minter routes through
 *    leaf `newRunId` (same `run:<time36>-<counter36>` format).
 *  - 5175-S3-P02 async-job ids mint as `job:<uuid>` through the leaf
 *    (both the submit path and the bridge path).
 *  - 5175-S3-P03 the discovery-run stores' default idFactory mints
 *    `run:` ids (both adapters; an injected idFactory still wins).
 *  - 5175-S3-P04 goal / scenario / outcome row ids mint as
 *    `goal:` / `scen:` / `outc:` through the leaf (both adapters agree
 *    id for id — the in-memory twin is the behavioral witness).
 *  - 5175-S3-P05 `shardScanRunId` lives in the leaf (same
 *    `shard-scan:<chainId>:<symbol>` format); the engine re-exports
 *    it and the consumers import it from the leaf.
 *  - 5175-S3-P06 no legacy mint remains at any migrated site (the
 *    migrated template literals are gone from the listed files).
 *  - 5175-S3-P07 the saga entry mint is `run:`; a client-supplied
 *    sagaId still wins.
 *  - 5175-S3-P08 the migrated report-row sites derive the generation
 *    from the leaf-minted run id (`gen:<run body>`), never reusing
 *    the run id as the generation — except the two deferred dual
 *    identities, which this pin names explicitly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseId, generationId, newRunId, shardScanRunId } from "../src/services/executionTreeIds";
import { InMemoryDiscoveryRunStore } from "../src/data/inMemoryDiscoveryRunAdapter";
import { InMemoryGoalScenarioStore } from "../src/data/inMemoryGoalScenarioAdapter";
import { validateSagaEntryBody } from "../src/agents/routes/sagaEntry";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

describe("5175 slice 3 — run-id migration", () => {
  it("P01 engine default routes through leaf newRunId", () => {
    const src = read("src/services/jobPipelineEngine.ts");
    expect(src).toContain('import { newRunId, runIdBody, stageIdBody, stepExecutionId } from "./executionTreeIds"');
    expect(src).toContain("deps.newRunId ?? newRunId");
    // The inline closure it replaced is gone (no ad-hoc time36/counter).
    expect(src).not.toContain("Date.now().toString(36)");
    expect(src).not.toContain("let counter = 0;");
  });

  it("P02 async-job ids mint as job:<uuid> through the leaf", () => {
    const src = read("src/agents/orchestrator/asyncJobs.ts");
    expect(src).toContain('import { newAsyncJobId } from "../../services/executionTreeIds"');
    const mints = src.match(/const jobId = newAsyncJobId\(\);/g) ?? [];
    expect(mints.length).toBe(2);
    expect(src).not.toContain("job:${crypto.randomUUID()}");
    expect(src).not.toContain("job:${");
    // The read path accepts the new form: get_async_job's schema
    // (and get_scan_job's, which returns the same receipt id) admits
    // `job:<uuid>` AND the legacy bare UUID.
    const commands = read("src/mcps/openaimp/commands.ts");
    expect(commands).toContain('v.startsWith("job:")');
    expect(commands).toContain("jobId must be a UUID or a job:<uuid> id");
    const scanner = read("src/mcps/scanner/cloudflareWalletsScanner.ts");
    expect(scanner).toContain('v.startsWith("job:")');
    expect(scanner).not.toContain("z.string().uuid().describe(\"Job ID returned by screen_options\")");
  });

  it("P03 discovery-run store default idFactory mints run: ids", async () => {
    const sqlSrc = read("src/data/doSqliteDiscoveryRunAdapter.ts");
    const memSrc = read("src/data/inMemoryDiscoveryRunAdapter.ts");
    for (const src of [sqlSrc, memSrc]) {
      expect(src).toContain("this.idFactory = options.idFactory ?? newRunId");
      expect(src).not.toContain("() => crypto.randomUUID()");
    }
    const store = new InMemoryDiscoveryRunStore();
    const run = await store.save({
      createdAt: new Date().toISOString(),
      trigger: "manual-trigger",
      inputModel: "saved-request",
      requests: [],
      outcomes: [],
    });
    expect(parseId(run.id).type).toBe("run");
  });

  it("P04 goal / scen / outc row ids mint through the leaf", () => {
    for (const rel of [
      "src/data/doSqliteGoalScenarioAdapter.ts",
      "src/data/inMemoryGoalScenarioAdapter.ts",
    ]) {
      const src = read(rel);
      expect(src).toContain('from "../services/executionTreeIds"');
      expect(src).not.toContain("crypto.randomUUID()");
    }
    const store = new InMemoryGoalScenarioStore();
    const goal = store.createGoal({ userLogin: "u1", kind: "income", title: "g" });
    expect(parseId(goal.id).type).toBe("goal");
    const scen = store.createScenario({
      userLogin: "u1",
      goalId: goal.id,
      portfolioRef: { kind: "real" },
    });
    expect(scen).not.toBeNull();
    expect(parseId(scen!.id).type).toBe("scen");
    const outc = store.recordOutcome({
      userLogin: "u1",
      goalId: goal.id,
      scenarioId: scen!.id,
      kind: "paper",
    });
    expect(outc).not.toBeNull();
    expect(parseId(outc!.id).type).toBe("outc");
  });

  it("P05 shardScanRunId lives in the leaf with the same format", () => {
    expect(shardScanRunId("chain-x", "AAPL")).toBe("shard-scan:chain-x:AAPL");
    expect(parseId(shardScanRunId("chain-x", "AAPL")).type).toBe("shard-scan");
    const engine = read("src/workflows/optionsScreenEngine.ts");
    expect(engine).toContain('import { newRunId, shardScanRunId } from "../services/executionTreeIds"');
    expect(engine).toContain("export { shardScanRunId };");
    expect(engine).not.toContain("function shardScanRunId");
    expect(engine).not.toContain("`shard-scan:${chainId}:${symbol}`");
    for (const rel of [
      "src/services/optionsChainPipelineJobs.ts",
      "src/services/shardExecutors.ts",
    ]) {
      expect(read(rel)).toContain('import { shardScanRunId } from "./executionTreeIds"');
    }
  });

  it("P06 no legacy mint remains at any migrated site", () => {
    const scheduled = read("src/services/scheduledTasks.ts");
    for (const legacy of [
      "options_scanner:${timestamp}:${targetThesis}",
      "stock_scanner:${timestamp}",
      "goal_screen:${timestamp}",
      "discovery:${timestamp}",
      "discovery:profile-derived:",
      "discovery:no-view:",
      "options-panel:scheduled:",
      // Backtick + ${ form: the comment above the :1977 mint names the
      // legacy shape in prose, so the pin matches the template literal
      // only, not the comment.
      "`screener:scheduled:${",
      "discovery:${args.run.id}",
    ]) {
      expect(scheduled).not.toContain(legacy);
    }
    expect(scheduled).toContain("runId: newRunId()");
    expect(scheduled).toContain("generationId(args.run.id)");
    expect(scheduled).toContain("generationId(reportRunId)");

    const premium = read("src/agents/routes/premium.ts");
    expect(premium).not.toContain("options_scanner:${timestamp}");
    expect(premium).toContain("const runId = newRunId();");
    expect(premium).toContain("generationId: generationId(runId)");

    const etrade = read("src/agents/routes/etradeOptionsScreen.ts");
    expect(etrade).not.toContain("options_scanner:unified:");
    expect(etrade).not.toContain("options_scanner:${generatedAt}");
    expect(etrade).not.toContain("options_strategy:${action}:${symbol}:${generatedAt}");
    expect(etrade).toContain("generationId: strategyGenerationId");
    // Deliberately DEFERRED, not missed: :180 is a dual run+generation
    // identity threaded through the host/sync dispatch pair and the
    // manual-screen canonical leg — splitting it is leg-contract work
    // for the resolve-or-mint follow-up. The pin records the deferral.
    expect(etrade).toContain("options_scanner:manual:${new Date().toISOString()}");

    const nlq = read("src/agents/nlqOptionsStrategy.ts");
    expect(nlq).not.toContain("nlq-panel:${crypto.randomUUID()}");
    expect(nlq).not.toContain("nlq-scan:${crypto.randomUUID()}");
    expect(nlq).toContain("const panelRunId = newRunId();");
    expect(nlq).toContain("const scanPipelineRunId = newRunId();");

    const retention = read("src/security/storageRetention.ts");
    expect(retention).not.toContain("retention:${cutoffIso}");
    expect(retention).toContain("generationId: generationId(runId)");

    const saga = read("src/agents/routes/sagaEntry.ts");
    expect(saga).not.toContain("`saga-${");
    expect(saga).toContain("newRunId()");

    const engine = read("src/workflows/optionsScreenEngine.ts");
    expect(engine).not.toContain("options-screen:plain:");
  });

  it("P07 saga entry mints run:; a client-supplied sagaId still wins", () => {
    const body = {
      screenerCommand: { jobId: "j1", userLogin: "u1" },
      tradeIntent: { kind: "stock", symbol: "AAPL", action: "buy", quantity: 1 },
      email: "u1@example.com",
    };
    const minted = validateSagaEntryBody(body, "u1");
    expect(parseId(minted.sagaId).type).toBe("run");
    const supplied = validateSagaEntryBody({ ...body, sagaId: "client-1" }, "u1");
    expect(supplied.sagaId).toBe("client-1");
  });

  it("P08 migrated report rows derive gen: from the leaf-minted run", () => {
    // The leaf derivation itself: gen:<run body>, never the run id.
    const runId = newRunId();
    expect(generationId(runId)).toBe(`gen:${runId.slice("run:".length)}`);
    expect(generationId(runId)).not.toBe(runId);
    // Each migrated report-row site calls the leaf derivation.
    expect(read("src/services/scheduledTasks.ts")).toContain("generationId(reportRunId)");
    expect(read("src/agents/routes/premium.ts")).toContain("generationId(runId)");
    expect(read("src/security/storageRetention.ts")).toContain("generationId(runId)");
    expect(read("src/agents/routes/etradeOptionsScreen.ts")).toContain("generationId(runId)");
    // The dual run==generation pattern is gone at the migrated rows...
    expect(read("src/services/scheduledTasks.ts")).not.toContain("const generationId = reportRunId");
    expect(read("src/agents/routes/etradeOptionsScreen.ts")).not.toContain("runId: generationId,\n      generationId,");
    // ...and survives ONLY at the deferred :180 pair (see P06).
  });
});
